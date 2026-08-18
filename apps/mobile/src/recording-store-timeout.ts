export class RecordingStoreTimeoutError extends Error {
  constructor(message = "recording store operation timed out") {
    super(message);
    this.name = "RecordingStoreTimeoutError";
  }
}

export function withRecordingStoreTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new RecordingStoreTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
