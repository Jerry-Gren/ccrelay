import type { TokenUsage } from '@ccrelay/shared';

export interface TrackedTask {
  id: string;
  worker: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress: string[];  // live stream of what the worker is doing
  result?: string;
  error?: string;
  usage?: TokenUsage;
  cumulativeUsage?: TokenUsage;
  createdAt: number;
  completedAt?: number;
  resolve?: (value: TrackedTask) => void;  // for get_result blocking
}

const tasks = new Map<string, TrackedTask>();

export function createTask(id: string, worker: string, prompt: string): TrackedTask {
  const task: TrackedTask = {
    id,
    worker,
    prompt,
    status: 'running',
    progress: [],
    createdAt: Date.now(),
  };
  tasks.set(id, task);
  return task;
}

export function addProgress(taskId: string, chunk: string): void {
  const task = tasks.get(taskId);
  if (task && task.status === 'running') {
    task.progress.push(chunk);
  }
}

export function completeTask(
  taskId: string,
  result: {
    status: 'success' | 'error' | 'aborted';
    result?: string;
    error?: string;
    usage?: TokenUsage;
    cumulativeUsage?: TokenUsage;
  },
): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.status = result.status === 'success' ? 'completed' : 'failed';
  task.result = result.result;
  task.error = result.error;
  task.usage = result.usage;
  task.cumulativeUsage = result.cumulativeUsage;
  task.completedAt = Date.now();

  // Wake up anyone waiting on get_result
  if (task.resolve) {
    task.resolve(task);
    task.resolve = undefined;
  }
}

export function getTask(taskId: string): TrackedTask | undefined {
  return tasks.get(taskId);
}

export function getTasksByWorker(worker: string): TrackedTask[] {
  return Array.from(tasks.values()).filter((t) => t.worker === worker);
}

export function getRunningTasks(): TrackedTask[] {
  return Array.from(tasks.values()).filter((t) => t.status === 'running');
}

export function getAllTasks(): TrackedTask[] {
  return Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Wait for a task to complete. Returns immediately if already done. */
export function waitForTask(taskId: string, timeoutMs: number = 300_000): Promise<TrackedTask> {
  const task = tasks.get(taskId);
  if (!task) return Promise.reject(new Error(`Unknown task: ${taskId}`));
  if (task.status !== 'running') return Promise.resolve(task);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      task.resolve = undefined;
      reject(new Error(`Timeout waiting for task ${taskId}`));
    }, timeoutMs);

    task.resolve = (t) => {
      clearTimeout(timer);
      resolve(t);
    };
  });
}

export function cancelTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (task && task.status === 'running') {
    task.status = 'cancelled';
    task.completedAt = Date.now();
    if (task.resolve) {
      task.resolve(task);
      task.resolve = undefined;
    }
    return true;
  }
  return false;
}
