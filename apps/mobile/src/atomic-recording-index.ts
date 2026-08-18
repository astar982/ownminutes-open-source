export type AtomicIndexPaths = {
  backup: string;
  backupTemporary: string;
  primary: string;
  temporary: string;
};

export type AtomicTextStore = {
  copy(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
};

export type AtomicIndexReadResult<T> = {
  records: T[];
  source: "backup" | "empty" | "primary" | "temporary" | "unrecoverable";
};

type IndexCandidate<T> = {
  path: string;
  records: T[];
  source: "backup" | "primary" | "temporary";
};

export function createSerialExecutor() {
  let tail = Promise.resolve();

  return function runSerially<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export async function readAtomicArrayIndex<T>(
  store: AtomicTextStore,
  paths: AtomicIndexPaths,
  isItem: (value: unknown) => value is T,
): Promise<AtomicIndexReadResult<T>> {
  const primary = await readCandidate(store, paths.primary, "primary", isItem);
  if (primary) {
    try {
      await refreshBackup(store, paths, isItem);
    } catch {
      // The primary remains authoritative; a later load or write can finish refreshing the backup.
    }
    await removeQuietly(store, paths.temporary);
    return { records: primary.records, source: "primary" };
  }

  const temporary = await readCandidate(store, paths.temporary, "temporary", isItem);
  const backupTemporary = await readCandidate(store, paths.backupTemporary, "backup", isItem);
  const backup = await readCandidate(store, paths.backup, "backup", isItem);
  const recovery = temporary ?? backupTemporary ?? backup;

  if (recovery) {
    await restorePrimary(store, paths, recovery, isItem);
    return { records: recovery.records, source: recovery.source };
  }

  const anyIndexFileExists = await anyExists(store, [
    paths.primary,
    paths.temporary,
    paths.backupTemporary,
    paths.backup,
  ]);
  return {
    records: [],
    source: anyIndexFileExists ? "unrecoverable" : "empty",
  };
}

export async function writeAtomicArrayIndex<T>(
  store: AtomicTextStore,
  paths: AtomicIndexPaths,
  records: T[],
  isItem: (value: unknown) => value is T,
) {
  const contents = JSON.stringify(records, null, 2);
  await store.remove(paths.temporary);
  await store.write(paths.temporary, contents);
  await assertValidIndexFile(store, paths.temporary, isItem);

  await store.remove(paths.primary);
  await store.move(paths.temporary, paths.primary);
  await assertValidIndexFile(store, paths.primary, isItem);
  await refreshBackup(store, paths, isItem);
}

async function restorePrimary<T>(
  store: AtomicTextStore,
  paths: AtomicIndexPaths,
  candidate: IndexCandidate<T>,
  isItem: (value: unknown) => value is T,
) {
  await store.remove(paths.primary);
  await store.copy(candidate.path, paths.primary);
  await refreshBackup(store, paths, isItem);
  await removeQuietly(store, paths.temporary);
  await removeQuietly(store, paths.backupTemporary);
}

async function refreshBackup<T>(
  store: AtomicTextStore,
  paths: AtomicIndexPaths,
  isItem: (value: unknown) => value is T,
) {
  await store.remove(paths.backupTemporary);
  await store.copy(paths.primary, paths.backupTemporary);
  await assertValidIndexFile(store, paths.backupTemporary, isItem);
  await store.remove(paths.backup);
  await store.move(paths.backupTemporary, paths.backup);
}

async function readCandidate<T>(
  store: AtomicTextStore,
  path: string,
  source: IndexCandidate<T>["source"],
  isItem: (value: unknown) => value is T,
): Promise<IndexCandidate<T> | null> {
  if (!(await store.exists(path))) return null;
  try {
    const contents = await store.read(path);
    const parsed = parseIndex(contents, isItem);
    return parsed ? { path, records: parsed, source } : null;
  } catch {
    return null;
  }
}

async function assertValidIndexFile<T>(
  store: AtomicTextStore,
  path: string,
  isItem: (value: unknown) => value is T,
) {
  const parsed = parseIndex(await store.read(path), isItem);
  if (!parsed) throw new Error("Recording index verification failed.");
}

function parseIndex<T>(contents: string, isItem: (value: unknown) => value is T): T[] | null {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isItem)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function anyExists(store: AtomicTextStore, paths: string[]) {
  for (const path of paths) {
    if (await store.exists(path)) return true;
  }
  return false;
}

async function removeQuietly(store: AtomicTextStore, path: string) {
  try {
    await store.remove(path);
  } catch {
    // A stale journal is harmless once the primary index is valid.
  }
}
