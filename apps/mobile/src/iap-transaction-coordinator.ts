export type IapTransactionWork<Result> = {
  apply: (result: Result) => Promise<void>;
  finish?: () => Promise<void>;
  transactionId: string;
  verify: () => Promise<Result>;
};

type TransactionEntry<Result> = {
  applied: boolean;
  applyPromise?: Promise<void>;
  finished: boolean;
  finishPromise?: Promise<void>;
  hasVerifiedResult: boolean;
  verifiedResult?: Result;
  verifyPromise?: Promise<Result>;
};

export function createIapTransactionCoordinator<Result>() {
  const entries = new Map<string, TransactionEntry<Result>>();

  return {
    async run(work: IapTransactionWork<Result>) {
      const entry = getOrCreateEntry(entries, work.transactionId);
      const result = await verifyOnce(entry, work.verify);
      await applyOnce(entry, () => work.apply(result));
      if (work.finish) {
        await finishOnce(entry, work.finish);
      }
      return result;
    },
  };
}

function getOrCreateEntry<Result>(
  entries: Map<string, TransactionEntry<Result>>,
  transactionId: string,
) {
  const existing = entries.get(transactionId);
  if (existing) return existing;

  const created: TransactionEntry<Result> = {
    applied: false,
    finished: false,
    hasVerifiedResult: false,
  };
  entries.set(transactionId, created);
  return created;
}

async function verifyOnce<Result>(
  entry: TransactionEntry<Result>,
  verify: () => Promise<Result>,
) {
  if (entry.hasVerifiedResult) return entry.verifiedResult as Result;
  if (!entry.verifyPromise) {
    entry.verifyPromise = Promise.resolve()
      .then(verify)
      .then((result) => {
        entry.hasVerifiedResult = true;
        entry.verifiedResult = result;
        return result;
      })
      .finally(() => {
        entry.verifyPromise = undefined;
      });
  }
  return entry.verifyPromise;
}

async function applyOnce<Result>(
  entry: TransactionEntry<Result>,
  apply: () => Promise<void>,
) {
  if (entry.applied) return;
  if (!entry.applyPromise) {
    entry.applyPromise = Promise.resolve()
      .then(apply)
      .then(() => {
        entry.applied = true;
      })
      .finally(() => {
        entry.applyPromise = undefined;
      });
  }
  await entry.applyPromise;
}

async function finishOnce<Result>(
  entry: TransactionEntry<Result>,
  finish: () => Promise<void>,
) {
  if (entry.finished) return;
  if (!entry.finishPromise) {
    entry.finishPromise = Promise.resolve()
      .then(finish)
      .then(() => {
        entry.finished = true;
      })
      .finally(() => {
        entry.finishPromise = undefined;
      });
  }
  await entry.finishPromise;
}
