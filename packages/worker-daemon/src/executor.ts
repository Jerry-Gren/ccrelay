import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TokenUsage } from '@ccrelay/shared';

// Session persistence: worker name -> sessionId for resume
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
      }

      // Stream tool activity as progress
      if (ev['type'] === 'tool_progress' && options?.onProgress) {
        const toolName = ev['tool_name'] as string | undefined;
        if (toolName) {
          options.onProgress(`[using ${toolName}]`);
        }
      }

      // Stream assistant text as progress
      if (ev['type'] === 'assistant' && options?.onProgress) {
        const content = ev['content'] as string | undefined;
        if (content) {
          options.onProgress(content);
        }
      }

      // Sub-agent activity
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && options?.onProgress) {
        const desc = ev['description'] as string | undefined;
        if (desc) {
          options.onProgress(`[started sub-agent: ${desc}]`);
        }
      }

      // Final result
      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage — try multiple field name patterns
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
