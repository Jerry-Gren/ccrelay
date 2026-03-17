import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TokenUsage } from '@ccrelay/shared';

// Session persistence: map taskId -> sessionId for resume
const sessions = new Map<string, string>();

interface ExecutionResult {
  text: string | null;
  sessionId?: string;
  usage?: TokenUsage;
  aborted?: boolean;
}

// Active abort controllers for cancellation
const activeAborts = new Map<string, AbortController>();

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

      // Stream progress
      if (ev['type'] === 'assistant' && options?.onProgress) {
        const content = ev['content'] as string | undefined;
        if (content) {
          options.onProgress(content);
        }
      }

      // Final result
      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
          };
        }
      }
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    activeAborts.delete(taskId);
  }

  // Persist session for future resume
  if (newSessionId) {
    sessions.set(taskId, newSessionId);
  }

  if (abortController.signal.aborted) {
    return { text: null, sessionId: newSessionId, usage, aborted: true };
  }

  return { text: resultText, sessionId: newSessionId, usage };
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
