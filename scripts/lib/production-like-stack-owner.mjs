import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function claimLegacyStackOwner({
  ownerFile,
  dockerEngineId,
  stageIdentity,
}) {
  if (
    !path.isAbsolute(ownerFile) ||
    ownerFile === path.parse(ownerFile).root ||
    !/^[A-Za-z0-9._:-]{8,160}$/.test(dockerEngineId) ||
    !/^[a-f0-9]{12}$/.test(stageIdentity)
  ) {
    throw new Error("Legacy production-like ownership arguments are invalid.");
  }

  const ownerDirectory = path.dirname(ownerFile);
  fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
  const directoryStats = fs.lstatSync(ownerDirectory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Legacy production-like ownership directory is unsafe.");
  }
  fs.chmodSync(ownerDirectory, 0o700);

  if (!fs.existsSync(ownerFile)) {
    const candidate = {
      format: "ownminutes-production-like-legacy-owner:v1",
      dockerEngineId,
      stageIdentity,
      claimedAt: new Date().toISOString(),
    };
    const temporaryPath = `${ownerFile}.${process.pid}.${stageIdentity}.tmp`;
    const descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(candidate, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(temporaryPath, ownerFile);
      fsyncDirectory(ownerDirectory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  const stats = fs.lstatSync(ownerFile);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new Error("Legacy production-like ownership marker is unsafe.");
  }
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  } catch {
    throw new Error("Legacy production-like ownership marker is invalid.");
  }
  if (
    owner?.format !== "ownminutes-production-like-legacy-owner:v1" ||
    owner?.dockerEngineId !== dockerEngineId ||
    owner?.stageIdentity !== stageIdentity
  ) {
    throw new Error(
      "Legacy production-like resources are owned by a different worktree; refusing to operate on them.",
    );
  }
  return owner;
}

export function legacyStackOwnerFile({ dockerEngineId, homeDirectory }) {
  if (
    !/^[A-Za-z0-9._:-]{8,160}$/.test(dockerEngineId) ||
    !path.isAbsolute(homeDirectory)
  ) {
    throw new Error("Legacy production-like ownership location is invalid.");
  }
  const engineHash = crypto
    .createHash("sha256")
    .update(dockerEngineId)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    homeDirectory,
    ".ownminutes",
    "local-stack-ownership",
    `legacy-owner-${engineHash}.json`,
  );
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
