import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RelayClient } from './relay-client.js';
import type { StatusResponsePayload, TokenUsage } from '@ccrelay/shared';
import {
  createTask,
  getTask,
  getRunningTasks,
  getAllTasks,
  waitForTask,
  cancelTask as cancelTrackedTask,
  type TrackedTask,
} from './task-tracker.js';

function formatTask(t: TrackedTask, includeProgress: boolean = false): string {
  const status = t.status === 'running' ? '⟳ running'
    : t.status === 'completed' ? '✓ done'
    : t.status === 'failed' ? '✗ failed'
    : '⊘ cancelled';
  const elapsed = ((t.completedAt || Date.now()) - t.createdAt) / 1000;

  let text = `[${t.id.slice(0, 8)}] ${t.worker} — ${status} (${elapsed.toFixed(0)}s)\n`;
  text += `  prompt: ${t.prompt.slice(0, 100)}\n`;

  if (includeProgress && t.progress.length > 0) {
    // Show last 15 progress entries
    const recent = t.progress.slice(-15);
    if (t.progress.length > 15) {
      text += `  ... ${t.progress.length - 15} earlier entries ...\n`;
    }
    for (const p of recent) {
      text += `  ${p}\n`;
    }
  }

  if (t.status === 'completed' && t.result) {
    text += `  result: ${t.result.slice(0, 500)}\n`;
  }
  if (t.status === 'failed' && t.error) {
    text += `  error: ${t.error}\n`;
  }
  if (t.usage) {
    text += `  tokens: ${t.usage.inputTokens} in / ${t.usage.outputTokens} out`;
    if (t.usage.cacheReadInputTokens > 0) text += ` / ${t.usage.cacheReadInputTokens} cached`;
    text += '\n';
  }

  return text;
}

export function createMcpServer(relay: RelayClient): McpServer {
  const server = new McpServer(
    { name: 'ccrelay', version: '0.2.0' },
    { capabilities: { logging: {} } },
  );

  // === list_workers ===
  server.tool(
    'list_workers',
    'List all connected workers and any running tasks on each',
    {},
    async () => {
      relay.requestWorkersList();
      await new Promise((r) => setTimeout(r, 500));
      const workers = relay.getWorkers();
      const running = getRunningTasks();

      if (workers.length === 0) {
        return { content: [{ type: 'text', text: 'No workers connected.' }] };
      }

      let text = `${workers.length} worker(s) online:\n\n`;
      for (const w of workers) {
        const workerTasks = running.filter((t) => t.worker === w.name);
        text += `• ${w.name} (${w.status})`;
        if (workerTasks.length > 0) {
          text += ` — ${workerTasks.length} running task(s):\n`;
          for (const t of workerTasks) {
            const lastProgress = t.progress.slice(-3).join(', ');
            text += `    [${t.id.slice(0, 8)}] ${t.prompt.slice(0, 60)}`;
            if (lastProgress) text += ` | ${lastProgress}`;
            text += '\n';
          }
        } else {
          text += ' — idle\n';
        }
      }

      return { content: [{ type: 'text', text }] };
    },
  );

  // === worker_status ===
  server.tool(
    'worker_status',
    'Get detailed status from a worker (git info, CWD, system info) without invoking Claude',
    { worker: z.string().describe('Worker name') },
    async ({ worker }) => {
      try {
        const status = await relay.sendAndWait<StatusResponsePayload>(
          worker, 'status_request', { fields: ['git', 'cwd', 'system'] }, 15_000,
        );
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // === send_command (non-blocking) ===
  server.tool(
    'send_command',
    'Send a command to a worker. Returns immediately with a task ID. Use check_tasks to see progress, get_result to wait for completion.',
    {
      worker: z.string().describe('Worker name'),
      prompt: z.string().describe('The prompt/command to send'),
      model: z.string().optional().describe('Model override'),
      cwd: z.string().optional().describe('Working directory override'),
      timeout: z.number().optional().describe('Timeout in ms (default: 300000)'),
    },
    async ({ worker, prompt, model, cwd, timeout }) => {
      try {
        const envelopeId = await relay.fireCommand(worker, {
          prompt,
          options: { model, cwd, timeout },
        });
        createTask(envelopeId, worker, prompt);
        return {
          content: [{
            type: 'text',
            text: `Task ${envelopeId.slice(0, 8)} dispatched to ${worker}. Use check_tasks to see progress or get_result to wait for completion.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // === dispatch (send to multiple workers at once) ===
  server.tool(
    'dispatch',
    'Send a command to multiple workers at once. Returns immediately with task IDs for each.',
    {
      prompt: z.string().describe('The prompt/command to send to all workers'),
      workers: z.array(z.string()).optional().describe('Worker names (default: all online workers)'),
    },
    async ({ prompt, workers: workerNames }) => {
      const targets = workerNames || relay.getWorkers().map((w) => w.name);
      if (targets.length === 0) {
        return { content: [{ type: 'text', text: 'No workers available.' }], isError: true };
      }

      const results: string[] = [];
      for (const worker of targets) {
        try {
          const envelopeId = await relay.fireCommand(worker, { prompt });
          createTask(envelopeId, worker, prompt);
          results.push(`${worker}: task ${envelopeId.slice(0, 8)}`);
        } catch (err) {
          results.push(`${worker}: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Dispatched to ${targets.length} worker(s):\n${results.map((r) => `• ${r}`).join('\n')}\n\nUse check_tasks to monitor progress.`,
        }],
      };
    },
  );

  // === check_tasks (the key visibility tool) ===
  server.tool(
    'check_tasks',
    'Show status and live progress of all running and recent tasks. Call this repeatedly to see what workers are doing in real-time.',
    {
      worker: z.string().optional().describe('Filter by worker name'),
    },
    async ({ worker }) => {
      const running = getRunningTasks();
      const all = getAllTasks().slice(0, 20);

      let tasks = worker ? all.filter((t) => t.worker === worker) : all;
      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: 'No tasks.' }] };
      }

      // Show running tasks with progress, completed tasks without
      let text = '';
      const runningTasks = tasks.filter((t) => t.status === 'running');
      const doneTasks = tasks.filter((t) => t.status !== 'running').slice(0, 5);

      if (runningTasks.length > 0) {
        text += `=== Running (${runningTasks.length}) ===\n\n`;
        for (const t of runningTasks) {
          text += formatTask(t, true) + '\n';
        }
      }

      if (doneTasks.length > 0) {
        text += `=== Recent (${doneTasks.length}) ===\n\n`;
        for (const t of doneTasks) {
          text += formatTask(t, false) + '\n';
        }
      }

      return { content: [{ type: 'text', text }] };
    },
  );

  // === get_result (blocking wait) ===
  server.tool(
    'get_result',
    'Wait for a specific task to complete and return its full result. If already done, returns immediately.',
    {
      task_id: z.string().describe('Task ID (or first 8 chars)'),
      timeout: z.number().optional().describe('Timeout in ms (default: 300000)'),
    },
    async ({ task_id, timeout }) => {
      // Support short IDs
      let task = getTask(task_id);
      if (!task) {
        const all = getAllTasks();
        task = all.find((t) => t.id.startsWith(task_id));
      }
      if (!task) {
        return {
          content: [{ type: 'text', text: `Unknown task: ${task_id}` }],
          isError: true,
        };
      }

      if (task.status === 'running') {
        try {
          task = await waitForTask(task.id, timeout || 300_000);
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: `Timeout waiting for task ${task_id}. Current progress:\n\n${formatTask(task, true)}`,
            }],
            isError: true,
          };
        }
      }

      return {
        content: [{ type: 'text', text: formatTask(task, true) }],
        isError: task.status === 'failed',
      };
    },
  );

  // === cancel_command ===
  server.tool(
    'cancel_command',
    'Cancel a running task on a worker',
    {
      task_id: z.string().describe('Task ID to cancel'),
    },
    async ({ task_id }) => {
      let task = getTask(task_id);
      if (!task) {
        const all = getAllTasks();
        task = all.find((t) => t.id.startsWith(task_id));
      }
      if (!task) {
        return { content: [{ type: 'text', text: `Unknown task: ${task_id}` }], isError: true };
      }

      try {
        await relay.sendCancel(task.worker, task.id);
        cancelTrackedTask(task.id);
        return {
          content: [{ type: 'text', text: `Cancelled task ${task.id.slice(0, 8)} on ${task.worker}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function startMcpServer(relay: RelayClient): Promise<void> {
  const server = createMcpServer(relay);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
