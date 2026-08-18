import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RegularFileSnapshot = {
  data: string;
  stats: fs.Stats;
};

export function readRegularFileSnapshot(filePath: string): RegularFileSnapshot {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("Expected a regular file.");
    return { data: fs.readFileSync(descriptor, "utf8"), stats };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPrivateTextFile(
  filePath: string,
  options: { allowReadOnlyContainerSecret?: boolean } = {},
) {
  const snapshot = readRegularFileSnapshot(filePath);
  const ownerOnly = (snapshot.stats.mode & 0o077) === 0;
  const readOnlyContainerSecret =
    options.allowReadOnlyContainerSecret === true &&
    filePath.startsWith(`${path.sep}run${path.sep}secrets${path.sep}`) &&
    (snapshot.stats.mode & 0o222) === 0;
  if (!ownerOnly && !readOnlyContainerSecret) {
    throw new Error("Private file permissions are too broad.");
  }
  return snapshot.data;
}

export function readOrCreatePrivateSecret(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${crypto.randomBytes(32).toString("base64url")}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return readPrivateTextFile(filePath).trim();
}
