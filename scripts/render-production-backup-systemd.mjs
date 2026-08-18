#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const serviceUser = argument("--user") || process.env.OWNMINUTES_SYSTEMD_USER || "ownminutes";
const workingDirectory = path.resolve(argument("--working-directory") || process.env.OWNMINUTES_SYSTEMD_WORKING_DIRECTORY || root);
const envFile = path.resolve(argument("--production-env-file") || process.env.OWNMINUTES_PRODUCTION_ENV_FILE || path.join(workingDirectory, "deploy", ".env.production"));
const outputDirectory = path.resolve(argument("--output-dir") || process.env.OWNMINUTES_SYSTEMD_OUTPUT_DIR || path.join(root, ".data", "production-systemd"));
const npmPath = path.resolve(argument("--npm") || process.env.OWNMINUTES_SYSTEMD_NPM_PATH || findNpm());
const schedule = argument("--schedule") || process.env.OWNMINUTES_BACKUP_SYSTEMD_SCHEDULE || "*-*-* 02:15:00";
const randomizedDelay = argument("--randomized-delay") || process.env.OWNMINUTES_BACKUP_SYSTEMD_RANDOMIZED_DELAY || "30m";

validate();
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(outputDirectory, 0o700);

const service = `[Unit]
Description=OwnMinutes encrypted database and object backup
Documentation=${systemdValue(path.join(workingDirectory, "docs", "self-hosted-production-runbook.md"))}
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=${serviceUser}
WorkingDirectory=${systemdValue(workingDirectory)}
Environment=${systemdValue(`OWNMINUTES_PRODUCTION_ENV_FILE=${envFile}`)}
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=4h
ExecStart=${systemdCommand(npmPath, "run", "production:backup")}
ExecStart=${systemdCommand(npmPath, "run", "production:backup:verify")}
ExecStart=${systemdCommand(npmPath, "run", "production:backup:replicate")}
ExecStart=${systemdCommand(npmPath, "run", "production:backup:freshness")}

[Install]
WantedBy=multi-user.target
`;

const timer = `[Unit]
Description=Run OwnMinutes encrypted off-site backup daily

[Timer]
OnCalendar=${schedule}
Persistent=true
RandomizedDelaySec=${randomizedDelay}
AccuracySec=1m
Unit=ownminutes-backup.service

[Install]
WantedBy=timers.target
`;

const servicePath = path.join(outputDirectory, "ownminutes-backup.service");
const timerPath = path.join(outputDirectory, "ownminutes-backup.timer");
fs.writeFileSync(servicePath, service, { mode: 0o644 });
fs.writeFileSync(timerPath, timer, { mode: 0o644 });
console.log(
  JSON.stringify(
    {
      ok: true,
      servicePath,
      timerPath,
      schedule,
      randomizedDelay,
      next: [
        "Review the generated units on the Linux host.",
        "Copy them to /etc/systemd/system/.",
        "Run systemctl daemon-reload && systemctl enable --now ownminutes-backup.timer.",
        "Run systemctl start ownminutes-backup.service and inspect systemctl status before launch.",
      ],
      secretsPrinted: false,
    },
    null,
    2,
  ),
);

function validate() {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(serviceUser)) throw new Error("Systemd service user is invalid.");
  for (const [label, value] of [["working directory", workingDirectory], ["environment file", envFile], ["npm path", npmPath]]) {
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`Systemd ${label} must be an absolute single-line path.`);
  }
  if (!fs.existsSync(npmPath) || !fs.statSync(npmPath).isFile()) throw new Error("Systemd npm executable does not exist.");
  if (!fs.existsSync(workingDirectory) || !fs.statSync(workingDirectory).isDirectory() || !fs.existsSync(path.join(workingDirectory, "package.json"))) {
    throw new Error("Systemd working directory must contain the OwnMinutes package.json.");
  }
  if (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile() || (fs.statSync(envFile).mode & 0o077) !== 0) {
    throw new Error("Systemd production environment file must exist and use mode 0600.");
  }
  if (/[^0-9*,:/ .-]/.test(schedule) || schedule.length > 80) throw new Error("Systemd backup schedule contains unsupported characters.");
  if (!/^\d+(s|m|h|d)$/.test(randomizedDelay)) throw new Error("Systemd randomized delay must use a value such as 30m.");
}

function findNpm() {
  const result = spawnSync("which", ["npm"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Unable to locate npm.");
  return result.stdout.trim();
}

function systemdCommand(executable, ...args) {
  return [executable, ...args].map(systemdValue).join(" ");
}

function systemdValue(value) {
  if (/^[a-zA-Z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
