import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TokenUsage } from '@ccrelay/shared';

// --- Colors ---
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
};

// Session persistence: sender name -> sessionId for resume
const sessions = new Map<string, string>();

// Cumulative usage tracking across all commands
let cumulativeUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
};

interface ExecutionResult {
  text: string | null;
  sessionId?: string;
  usage?: TokenUsage;
  cumulativeUsage?: TokenUsage;
  aborted?: boolean;
}

// Active abort controllers for cancellation
const activeAborts = new Map<string, AbortController>();

// Active task descriptions for status reporting
const activeTasks = new Map<string, string>();

async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

export async function executeCommand(
  taskId: string,
  prompt: string,
  options?: {
    model?: string;
    cwd?: string;
    timeout?: number;
    sessionId?: string;
    onProgress?: (chunk: string) => void;
  },
): Promise<ExecutionResult> {
  const resumeSessionId = options?.sessionId || sessions.get(taskId);
  const abortController = new AbortController();
  activeAborts.set(taskId, abortController);
  activeTasks.set(taskId, prompt.slice(0, 80));

  // Timeout handling
  let timeoutTimer: NodeJS.Timeout | undefined;
  if (options?.timeout) {
    timeoutTimer = setTimeout(() => abortController.abort(), options.timeout);
  }

  let resultText: string | null = null;
  let newSessionId: string | undefined;
  let usage: TokenUsage | undefined;

  try {
    for await (const event of query({
      prompt: singleTurn(prompt),
      options: {
        cwd: options?.cwd || process.cwd(),
        resume: resumeSessionId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: options?.model,
        abortController,
      },
    })) {
      const ev = event as Record<string, unknown>;

      // Track session ID
      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        const resumed = resumeSessionId ? `${c.green}resumed${c.reset}` : `${c.yellow}new${c.reset}`;
        console.log(`\n${c.cyan}${c.bold}━━━ Session ${newSessionId?.slice(0, 8)} (${resumed}${c.cyan}${c.bold}) ━━━${c.reset}`);
      }

      // Tool use calls
      if (ev['type'] === 'assistant') {
        const message = ev['message'] as Record<string, unknown> | undefined;
        const content = message?.['content'] as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block['type'] === 'tool_use') {
              const name = block['name'] as string;
              const input = block['input'] as Record<string, unknown> | undefined;
              const detail = input?.['command'] || input?.['pattern'] || input?.['file_path'] || input?.['query'] || '';
              const detailStr = detail ? `${c.gray} ${String(detail).slice(0, 100)}${c.reset}` : '';
              console.log(`  ${c.yellow}>${c.reset} ${c.bold}${name}${c.reset}${detailStr}`);
              options?.onProgress?.(`[${name}${detail ? ': ' + String(detail).slice(0, 60) : ''}]`);
            }
          }
        }
      }

      // Sub-agent activity
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started') {
        const desc = ev['description'] as string | undefined;
        if (desc) {
          console.log(`  ${c.magenta}+${c.reset} ${c.magenta}agent:${c.reset} ${desc}`);
          options?.onProgress?.(`[agent: ${desc}]`);
        }
      }

      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification') {
        const summary = ev['summary'] as string | undefined;
        const status = ev['status'] as string | undefined;
        const statusColor = status === 'completed' ? c.green : c.yellow;
        console.log(`  ${c.magenta}-${c.reset} ${statusColor}${status}:${c.reset} ${summary?.slice(0, 120)}`);
      }

      // Final result
      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage
        const evUsage = (ev['usage'] ?? ev['token_usage']) as Record<string, number> | undefined;
        const costUsd = (ev['total_cost_usd'] ?? ev['costUsd'] ?? ev['cost_usd'] ?? 0) as number;

        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? evUsage['inputTokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? evUsage['outputTokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? evUsage['cacheReadInputTokens'] ?? 0,
            totalCostUsd: costUsd,
          };
        }

        // Print result preview
        if (resultText) {
          const preview = resultText.slice(0, 300).replace(/\n/g, '\n  ');
          console.log(`\n  ${c.green}${c.bold}Result:${c.reset}`);
          console.log(`  ${c.white}${preview}${c.reset}${resultText.length > 300 ? `${c.dim}...${c.reset}` : ''}`);
        }

        // Print usage
        if (usage) {
          const parts = [];
          if (usage.inputTokens > 0) parts.push(`${usage.inputTokens} in`);
          parts.push(`${usage.outputTokens} out`);
          if (usage.cacheReadInputTokens > 0) parts.push(`${c.green}${usage.cacheReadInputTokens} cached${c.reset}`);
          console.log(`  ${c.dim}tokens: ${parts.join(' / ')}${c.reset}`);
        }
        console.log(`${c.cyan}${c.bold}━━━ Done ━━━${c.reset}\n`);
      }
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    activeAborts.delete(taskId);
    activeTasks.delete(taskId);
  }

  // Persist session for future resume
  if (newSessionId) {
    sessions.set(taskId, newSessionId);
  }

  // Update cumulative usage
  if (usage) {
    cumulativeUsage.inputTokens += usage.inputTokens;
    cumulativeUsage.outputTokens += usage.outputTokens;
    cumulativeUsage.cacheReadInputTokens += usage.cacheReadInputTokens;
    cumulativeUsage.totalCostUsd += usage.totalCostUsd;
  }

  if (abortController.signal.aborted) {
    return { text: null, sessionId: newSessionId, usage, cumulativeUsage: { ...cumulativeUsage }, aborted: true };
  }

  return { text: resultText, sessionId: newSessionId, usage, cumulativeUsage: { ...cumulativeUsage } };
}

export function cancelTask(taskId: string): boolean {
  const controller = activeAborts.get(taskId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

export function getSessionId(taskId: string): string | undefined {
  return sessions.get(taskId);
}

export function getCumulativeUsage(): TokenUsage {
  return { ...cumulativeUsage };
}

export function getActiveTasks(): Map<string, string> {
  return new Map(activeTasks);
}
