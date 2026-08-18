import type { RecordedAudioChunk } from "@/lib/audio-pipeline";

const databaseName = "ownminutes-browser-recordings";
const databaseVersion = 1;
const sessionStoreName = "sessions";
const chunkStoreName = "chunks";

export type BrowserRecordingSession = {
  meetingId: string;
  userId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  status: "recording" | "stopped" | "finalized";
  mimeType: string;
  totalBytes: number;
  totalChunks: number;
  uploadedChunks: number;
};

export type StoredBrowserAudioChunk = RecordedAudioChunk & {
  id: string;
  meetingId: string;
  uploadedAt?: string;
};

export async function requestPersistentBrowserStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function beginBrowserRecordingSession(meetingId: string, userId: string, title?: string) {
  const now = new Date().toISOString();
  const database = await openDatabase();
  const existing = await requestValue<BrowserRecordingSession>(database.transaction(sessionStoreName).objectStore(sessionStoreName).get(meetingId));
  const session: BrowserRecordingSession = existing ?? {
    meetingId,
    userId,
    title,
    createdAt: now,
    updatedAt: now,
    status: "recording",
    mimeType: "",
    totalBytes: 0,
    totalChunks: 0,
    uploadedChunks: 0,
  };
  session.status = "recording";
  session.updatedAt = now;
  session.title = title || session.title;
  await putValue(database, sessionStoreName, session);
  database.close();
  return session;
}

export async function persistBrowserAudioChunk(meetingId: string, userId: string, chunk: RecordedAudioChunk) {
  const database = await openDatabase();
  const transaction = database.transaction([sessionStoreName, chunkStoreName], "readwrite");
  const sessions = transaction.objectStore(sessionStoreName);
  const chunks = transaction.objectStore(chunkStoreName);
  const id = chunkId(meetingId, chunk.sequence);
  const [existingSession, existingChunk] = await Promise.all([
    requestValue<BrowserRecordingSession>(sessions.get(meetingId)),
    requestValue<StoredBrowserAudioChunk>(chunks.get(id)),
  ]);
  const now = new Date().toISOString();
  const stored: StoredBrowserAudioChunk = {
    ...chunk,
    id,
    meetingId,
    uploadedAt: existingChunk?.uploadedAt,
  };
  chunks.put(stored);
  sessions.put({
    meetingId,
    userId,
    title: existingSession?.title,
    createdAt: existingSession?.createdAt ?? now,
    updatedAt: now,
    status: existingSession?.status === "stopped" ? "stopped" : "recording",
    mimeType: chunk.mimeType || existingSession?.mimeType || "audio/webm",
    totalBytes: Math.max(0, (existingSession?.totalBytes ?? 0) - (existingChunk?.blob.size ?? 0) + chunk.blob.size),
    totalChunks: Math.max(existingSession?.totalChunks ?? 0, chunk.sequence),
    uploadedChunks: existingSession?.uploadedChunks ?? 0,
  } satisfies BrowserRecordingSession);
  await transactionDone(transaction);
  database.close();
}

export async function markBrowserAudioChunkUploaded(meetingId: string, sequence: number, uploadedAt: string) {
  const database = await openDatabase();
  const transaction = database.transaction([sessionStoreName, chunkStoreName], "readwrite");
  const sessions = transaction.objectStore(sessionStoreName);
  const chunks = transaction.objectStore(chunkStoreName);
  const id = chunkId(meetingId, sequence);
  const [session, chunk] = await Promise.all([
    requestValue<BrowserRecordingSession>(sessions.get(meetingId)),
    requestValue<StoredBrowserAudioChunk>(chunks.get(id)),
  ]);
  if (chunk && !chunk.uploadedAt) {
    chunks.put({ ...chunk, uploadedAt });
    if (session) {
      sessions.put({
        ...session,
        updatedAt: new Date().toISOString(),
        uploadedChunks: Math.min(session.totalChunks, session.uploadedChunks + 1),
      });
    }
  }
  await transactionDone(transaction);
  database.close();
}

export async function markBrowserRecordingStopped(meetingId: string) {
  return updateSessionStatus(meetingId, "stopped");
}

export async function markBrowserRecordingFinalized(meetingId: string) {
  return updateSessionStatus(meetingId, "finalized");
}

export async function loadLatestRecoverableBrowserRecording(userId: string) {
  const database = await openDatabase();
  const sessions = (await requestValue<BrowserRecordingSession[]>(database.transaction(sessionStoreName).objectStore(sessionStoreName).getAll())) ?? [];
  const session = sessions
    .filter((item) => item.userId === userId && item.status !== "finalized" && item.totalChunks > 0)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!session) {
    database.close();
    return null;
  }
  const chunks = await readMeetingChunks(database, session.meetingId);
  database.close();
  return chunks.length ? { session, chunks } : null;
}

export async function loadBrowserRecording(meetingId: string) {
  const database = await openDatabase();
  const session = await requestValue<BrowserRecordingSession>(database.transaction(sessionStoreName).objectStore(sessionStoreName).get(meetingId));
  if (!session) {
    database.close();
    return null;
  }
  const chunks = await readMeetingChunks(database, meetingId);
  database.close();
  return chunks.length ? { session, chunks } : null;
}

export async function deleteBrowserRecording(meetingId: string) {
  const database = await openDatabase();
  const transaction = database.transaction([sessionStoreName, chunkStoreName], "readwrite");
  transaction.objectStore(sessionStoreName).delete(meetingId);
  const chunkStore = transaction.objectStore(chunkStoreName);
  const chunks = (await requestValue<StoredBrowserAudioChunk[]>(chunkStore.getAll())) ?? [];
  for (const chunk of chunks) {
    if (chunk.meetingId === meetingId) chunkStore.delete(chunk.id);
  }
  await transactionDone(transaction);
  database.close();
}

export async function deleteBrowserRecordingsForUser(userId: string) {
  const database = await openDatabase();
  const transaction = database.transaction([sessionStoreName, chunkStoreName], "readwrite");
  const sessionStore = transaction.objectStore(sessionStoreName);
  const chunkStore = transaction.objectStore(chunkStoreName);
  const sessions = (await requestValue<BrowserRecordingSession[]>(sessionStore.getAll())) ?? [];
  const meetingIds = new Set(sessions.filter((session) => session.userId === userId).map((session) => session.meetingId));
  for (const meetingId of meetingIds) sessionStore.delete(meetingId);
  const chunks = (await requestValue<StoredBrowserAudioChunk[]>(chunkStore.getAll())) ?? [];
  for (const chunk of chunks) {
    if (meetingIds.has(chunk.meetingId)) chunkStore.delete(chunk.id);
  }
  await transactionDone(transaction);
  database.close();
}

async function updateSessionStatus(meetingId: string, status: BrowserRecordingSession["status"]) {
  const database = await openDatabase();
  const transaction = database.transaction(sessionStoreName, "readwrite");
  const store = transaction.objectStore(sessionStoreName);
  const session = await requestValue<BrowserRecordingSession>(store.get(meetingId));
  if (session) store.put({ ...session, status, updatedAt: new Date().toISOString() });
  await transactionDone(transaction);
  database.close();
}

function chunkId(meetingId: string, sequence: number) {
  return `${meetingId}:${String(sequence).padStart(8, "0")}`;
}

async function readMeetingChunks(database: IDBDatabase, meetingId: string) {
  return ((await requestValue<StoredBrowserAudioChunk[]>(database.transaction(chunkStoreName).objectStore(chunkStoreName).getAll())) ?? [])
    .filter((chunk) => chunk.meetingId === meetingId)
    .sort((left, right) => left.sequence - right.sequence);
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("当前浏览器不支持 IndexedDB，本地录音无法安全落盘。"));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(sessionStoreName)) database.createObjectStore(sessionStoreName, { keyPath: "meetingId" });
      if (!database.objectStoreNames.contains(chunkStoreName)) database.createObjectStore(chunkStoreName, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器本地录音数据库打开失败。"));
    request.onblocked = () => reject(new Error("浏览器本地录音数据库正在被其他页面占用。"));
  });
}

function putValue(database: IDBDatabase, storeName: string, value: unknown) {
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  return transactionDone(transaction);
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器本地录音读取失败。"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("浏览器本地录音写入失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("浏览器本地录音写入已中止。"));
  });
}
