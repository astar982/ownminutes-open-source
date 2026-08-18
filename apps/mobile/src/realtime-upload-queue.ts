export class RealtimeUploadQueueCancelledError extends Error {
  constructor() {
    super("Realtime upload queue was replaced by a newer recording.");
    this.name = "RealtimeUploadQueueCancelledError";
  }
}

export class RealtimeUploadQueue {
  private generation = 0;
  private readonly pendingByGeneration = new Map<number, number>();
  private tail: Promise<void> = Promise.resolve();

  currentGeneration() {
    return this.generation;
  }

  isCurrentGeneration(generation: number) {
    return generation === this.generation;
  }

  pendingCount() {
    return this.pendingByGeneration.get(this.generation) ?? 0;
  }

  enqueue<T>(operation: () => Promise<T>) {
    const generation = this.generation;
    this.pendingByGeneration.set(generation, (this.pendingByGeneration.get(generation) ?? 0) + 1);
    const result = this.tail.then(async () => {
      if (!this.isCurrentGeneration(generation)) throw new RealtimeUploadQueueCancelledError();
      return operation();
    });
    const tracked = result.finally(() => {
      const pending = Math.max(0, (this.pendingByGeneration.get(generation) ?? 1) - 1);
      if (pending === 0) this.pendingByGeneration.delete(generation);
      else this.pendingByGeneration.set(generation, pending);
    });
    this.tail = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  async drain(timeoutMs: number) {
    const pending = this.tail;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    });
    const drained = pending.then(() => true as const);
    const result = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  cancelPending() {
    this.generation += 1;
    this.tail = Promise.resolve();
  }
}

export function isRealtimeUploadQueueCancelledError(error: unknown) {
  return error instanceof RealtimeUploadQueueCancelledError;
}

export function nextRealtimeUploadSequence(currentSequence: number, pendingCount: number, queueLimit: number) {
  const boundedLimit = Math.max(1, Math.round(queueLimit));
  if (Math.max(0, Math.round(pendingCount)) >= boundedLimit) return null;
  return Math.max(0, Math.round(currentSequence)) + 1;
}

export function realtimeFailureCooldownMs(consecutiveFailures: number) {
  const failures = Math.max(1, Math.round(consecutiveFailures));
  return Math.min(60_000, 5_000 * 2 ** Math.min(4, failures - 1));
}

export function realtimeSequenceAfterFailure(currentSequence: number, failedSequence: number) {
  const current = Math.max(0, Math.round(currentSequence));
  const failed = Math.max(1, Math.round(failedSequence));
  return current === failed ? failed - 1 : Math.min(current, failed - 1);
}

export function realtimeCaptureMayResume(now: number, retryNotBefore: number) {
  return Number.isFinite(now) && now >= Math.max(0, retryNotBefore || 0);
}

export async function retryRealtimeUpload<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options: { attempts?: number; baseDelayMs?: number } = {},
) {
  const attempts = clamp(options.attempts ?? 3, 1, 5);
  const baseDelayMs = clamp(options.baseDelayMs ?? 400, 100, 5000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { attempts: attempt, value: await operation() };
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) throw error;
      await wait(Math.min(5000, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  throw lastError;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function wait(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
