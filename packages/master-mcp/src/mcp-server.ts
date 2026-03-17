import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RelayClient } from './relay-client.js';
import type { ResultPayload, StatusResponsePayload, Task } from '@ccrelay/shared';

// Task tracking
const tasks = new Map<string, Task>();

export function createMcpServer(relay: RelayClient): McpServer {
  const server = new McpServer(
    { name: 'ccrelay', version: '0.1.0' },
    { capabilities: { logging: {} } },
  );

  // === list_workers ===
  server.tool(
    'list_workers',
    'List all connected workers with their status, name, and last heartbeat time',
    {},
    async () => {
      relay.requestWorkersList();
      // Small delay to allow response
      await new Promise((r) => setTimeout(r, 500));
      const workers = relay.getWorkers();
      return {
        content: [{
          type: 'text',
          text: workers.length === 0
            ? 'No workers connected.'
            : JSON.stringify(workers, null, 2),
        }],
      };
    },
  );

  // === worker_status ===
  server.tool(
    'worker_status',
    'Get status from a worker (git info, CWD, system info) without using any tokens',
    { worker: z.string().describe('Worker name') },
    async ({ worker }) => {
      try {
        const status = await relay.sendAndWait<StatusResponsePayload>(
          worker,
          'status_request',
          { fields: ['git', 'cwd', 'system'] },
          15_000,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // === send_command ===
  server.tool(
    'send_command',
    'Send a prompt/command to a worker for execution. Blocks until the worker responds with a result.',
    {
      worker: z.string().describe('Worker name'),
      prompt: z.string().describe('The prompt/command to send to the worker'),
      model: z.string().optional().describe('Model override (e.g., claude-sonnet-4-5)'),
      cwd: z.string().optional().describe('Working directory override'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
    },
    async ({ worker, prompt, model, cwd, timeout }) => {
      try {
        const result = await relay.sendAndWait<ResultPayload>(
          worker,
          'command',
          {
            prompt,
            options: { model, cwd, timeout },
          },
          timeout || 120_000,
        );

        // Track task
        const task: Task = {
          id: result.taskId,
          worker,
          prompt,
          status: result.status === 'success' ? 'completed' : 'failed',
          result: result.result,
          error: result.error,
          usage: result.usage,
          createdAt: Date.now(),
          completedAt: Date.now(),
        };
        tasks.set(task.id, task);

        let text = '';
        if (result.status === 'success') {
          text = result.result || '(no output)';
        } else if (result.status === 'error') {
          text = `Error: ${result.error || 'Unknown error'}`;
        } else if (result.status === 'aborted') {
          text = 'Command was aborted.';
        }

        if (result.usage) {
          text += `\n\n---\nTokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out | Cost: $${result.usage.totalCostUsd.toFixed(4)}`;
        }

        return {
          content: [{ type: 'text', text }],
          isError: result.status === 'error',
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // === cancel_command ===
  server.tool(
    'cancel_command',
    'Cancel a running command on a worker',
    {
      worker: z.string().describe('Worker name'),
      taskId: z.string().describe('Task ID to cancel'),
    },
    async ({ worker, taskId }) => {
      try {
        await relay.send(worker, 'cancel', { taskId });
        const task = tasks.get(taskId);
        if (task) {
          task.status = 'cancelled';
          task.completedAt = Date.now();
        }
        return {
          content: [{ type: 'text', text: `Cancel request sent to '${worker}' for task ${taskId}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // === broadcast_command ===
  server.tool(
    'broadcast_command',
    'Send a command to multiple workers simultaneously and collect results',
    {
      prompt: z.string().describe('The prompt/command to broadcast'),
      workers: z.array(z.string()).optional().describe('Worker names (default: all online workers)'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
    },
    async ({ prompt, workers: workerNames, timeout }) => {
      const targetWorkers = workerNames || relay.getWorkers()
        .filter((w) => w.status === 'online')
        .map((w) => w.name);

      if (targetWorkers.length === 0) {
        return {
          content: [{ type: 'text', text: 'No workers available for broadcast.' }],
          isError: true,
        };
      }

      const results = await Promise.allSettled(
        targetWorkers.map((worker) =>
          relay.sendAndWait<ResultPayload>(
            worker,
            'command',
            { prompt },
            timeout || 120_000,
          ).then((result) => ({ worker, result })),
        ),
      );

      const output = results.map((r, i) => {
        const worker = targetWorkers[i];
        if (r.status === 'fulfilled') {
          const { result } = r.value;
          return `## ${worker}\n${result.result || result.error || '(no output)'}`;
        }
        return `## ${worker}\nError: ${r.reason instanceof Error ? r.reason.message : 'Unknown error'}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: output }],
      };
    },
  );

  // === list_sessions ===
  server.tool(
    'list_sessions',
    'List tracked tasks and their status',
    {},
    async () => {
      const taskList = Array.from(tasks.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
      return {
        content: [{
          type: 'text',
          text: taskList.length === 0
            ? 'No tasks tracked yet.'
            : JSON.stringify(taskList.map((t) => ({
                id: t.id,
                worker: t.worker,
                status: t.status,
                prompt: t.prompt.slice(0, 80),
                createdAt: new Date(t.createdAt).toISOString(),
              })), null, 2),
        }],
      };
    },
  );

  return server;
}

export async function startMcpServer(relay: RelayClient): Promise<void> {
  const server = createMcpServer(relay);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
