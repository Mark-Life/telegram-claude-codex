#!/usr/bin/env bun
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  BACKUP_TIMER,
  BACKUP_UNIT,
  detectPaths,
  renderBackupTimer,
  renderBackupUnit,
  renderUnit,
  type ServicePaths,
  UNIT,
} from "./service-unit";

const args = process.argv.slice(2);
const command = args[0];

/** True when `flag` is present anywhere in argv. */
const hasFlag = (flag: string) => args.includes(flag);

/** Read a `--flag value` pair from argv; undefined when absent. */
const readFlag = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Sc {
  code: number;
  stderr: string;
  stdout: string;
}

/** Run a command, capturing trimmed stdout/stderr. */
const sc = (cmd: string[]): Sc => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return {
    code: r.exitCode,
    stdout: dec.decode(r.stdout).trim(),
    stderr: dec.decode(r.stderr).trim(),
  };
};

/** Run a command streaming its output straight to this terminal. */
const scInherit = (cmd: string[]) =>
  Bun.spawnSync(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).exitCode;

/** Invoke `systemctl --user <args>`, capturing output. */
const systemctl = (...a: string[]) => sc(["systemctl", "--user", ...a]);

/** Whether linger is enabled for the user (survives logout / boots at start). */
const isLingerOn = (user: string) =>
  sc(["loginctl", "show-user", user, "--property=Linger"]).stdout.includes(
    "Linger=yes"
  );

/**
 * Write a rendered unit to `path`, but only when its content changed (or a
 * prior symlink install is found). Returns whether the file was rewritten.
 */
const writeUnit = async (path: string, content: string) => {
  let existing: string | undefined;
  let wasSymlink = false;
  try {
    wasSymlink = (await lstat(path)).isSymbolicLink();
    existing = await readFile(path, "utf8");
  } catch {
    // no existing unit — first install
  }
  if (!(existing !== content || wasSymlink || hasFlag("--force"))) {
    console.log(`Unit already up to date: ${path}`);
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  // rename replaces a pre-existing regular file OR symlink atomically,
  // converging old symlink-based installs to a plain generated file.
  await rename(tmp, path);
  console.log(existing ? `Updated ${path}` : `Wrote ${path}`);
  return true;
};

/** Install the daily snapshot unit + timer and enable the timer. */
const installBackup = async (p: ServicePaths) => {
  await writeUnit(p.backupUnitPath, renderBackupUnit(p));
  await writeUnit(p.backupTimerPath, renderBackupTimer());
  systemctl("daemon-reload");
  const en = systemctl("enable", "--now", BACKUP_TIMER);
  if (en.code === 0) {
    console.log(`Enabled ${BACKUP_TIMER} (daily, catches up after downtime)`);
    return 0;
  }
  console.error(en.stderr || en.stdout);
  return 1;
};

/**
 * Idempotent install: detect paths, render the unit, write it only when the
 * content changed (or a prior symlink install is found), daemon-reload,
 * `enable --now`, restart when a running unit's definition changed, and enable
 * linger. `--with-backup` adds the daily database snapshot timer. Safe to
 * re-run; converges to the same state.
 */
const install = async () => {
  const p = detectPaths();
  const unit = renderUnit(p);

  if (hasFlag("--dry-run")) {
    console.log(unit);
    if (hasFlag("--with-backup")) {
      console.log(renderBackupUnit(p));
      console.log(renderBackupTimer());
    }
    return 0;
  }

  const wasActive = systemctl("is-active", UNIT).stdout === "active";
  const changed = await writeUnit(p.unitPath, unit);

  systemctl("daemon-reload");
  const en = systemctl("enable", "--now", UNIT);
  if (en.code !== 0) {
    console.error(en.stderr || en.stdout);
    return 1;
  }
  if (changed && wasActive) {
    systemctl("restart", UNIT);
    console.log("Restarted service (unit changed)");
  }

  if (hasFlag("--with-backup") && (await installBackup(p)) !== 0) {
    return 1;
  }

  if (!(hasFlag("--no-linger") || isLingerOn(p.user))) {
    const lg = sc(["loginctl", "enable-linger", p.user]);
    if (lg.code === 0) {
      console.log(`Enabled linger for ${p.user}`);
    } else {
      console.warn(
        `Could not enable linger (needs privilege). Run: sudo loginctl enable-linger ${p.user}`
      );
    }
  }

  console.log("Done. Check: bun run service:status");
  return 0;
};

/** Report service state; `--json` emits a script-friendly object. */
const status = () => {
  const p = detectPaths();
  const active = systemctl("is-active", UNIT).stdout;
  const enabled = systemctl("is-enabled", UNIT).stdout;
  const linger = isLingerOn(p.user);
  const backupTimer = systemctl("is-enabled", BACKUP_TIMER).stdout;

  if (hasFlag("--json")) {
    const mainPid =
      Number(systemctl("show", UNIT, "--property=MainPID", "--value").stdout) ||
      0;
    console.log(
      JSON.stringify(
        {
          active,
          backupTimer,
          enabled,
          linger,
          mainPid,
          unitPath: p.unitPath,
          bunPath: p.bunPath,
          repoDir: p.repoDir,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(
    `active: ${active}   enabled: ${enabled}   linger: ${linger ? "yes" : "no"}   backup timer: ${backupTimer}`
  );
  return scInherit([
    "systemctl",
    "--user",
    "status",
    UNIT,
    "--no-pager",
    "-n",
    "20",
  ]);
};

/** Follow (or tail) the service journal. `-n <N>` window, `--no-follow` to tail once. */
const logs = () => {
  const n = readFlag("-n") ?? "200";
  const cmd = ["journalctl", "--user", "-u", UNIT, "-n", n, "--no-pager"];
  if (!hasFlag("--no-follow")) {
    cmd.push("-f");
  }
  return scInherit(cmd);
};

/** Thin `systemctl --user <verb>` wrapper for start/stop/restart. */
const simple = (verb: string) => {
  const r = systemctl(verb, UNIT);
  if (r.code === 0) {
    console.log(`${UNIT} ${verb}: ok`);
  } else {
    console.error(r.stderr || r.stdout);
  }
  return r.code;
};

/**
 * Run one snapshot through the installed unit, then show what it logged. Uses
 * systemd rather than the script directly, so it exercises the real unit.
 */
const backupNow = () => {
  const r = systemctl("start", BACKUP_UNIT);
  if (r.code !== 0) {
    console.error(r.stderr || r.stdout);
    console.error(
      "Backup units not installed. Run: bun run service:install --with-backup (or `bun run backup` for a direct snapshot)."
    );
    return 1;
  }
  return scInherit([
    "journalctl",
    "--user",
    "-u",
    BACKUP_UNIT,
    "-n",
    "20",
    "--no-pager",
  ]);
};

/**
 * Stop, disable, remove the generated units (bot plus backup timer); leaves
 * linger, `.env` and existing snapshots alone.
 */
const uninstall = async () => {
  const p = detectPaths();
  systemctl("disable", "--now", UNIT);
  systemctl("disable", "--now", BACKUP_TIMER);
  for (const path of [p.unitPath, p.backupUnitPath, p.backupTimerPath]) {
    try {
      await rm(path);
      console.log(`Removed ${path}`);
    } catch {
      // already gone
    }
  }
  systemctl("daemon-reload");
  console.log("Uninstalled. Linger and .env left untouched.");
  return 0;
};

const usage = `Usage: bun run service:<command>
  install [--force] [--dry-run] [--no-linger] [--with-backup]
  status  [--json]
  logs    [-n <N>] [--no-follow]
  backup
  start | stop | restart
  uninstall`;

const offline =
  command === undefined ||
  command === "help" ||
  (command === "install" && hasFlag("--dry-run"));
if (!offline && process.platform !== "linux") {
  console.error("This CLI manages a Linux systemd --user service only.");
  process.exit(1);
}

let code = 0;
switch (command) {
  case "install":
    code = await install();
    break;
  case "status":
    code = status();
    break;
  case "logs":
    code = logs();
    break;
  case "backup":
    code = backupNow();
    break;
  case "start":
    code = simple("start");
    break;
  case "stop":
    code = simple("stop");
    break;
  case "restart":
    code = simple("restart");
    break;
  case "uninstall":
    code = await uninstall();
    break;
  case undefined:
  case "help":
    console.log(usage);
    break;
  default:
    console.error(`Unknown command: ${command}\n\n${usage}`);
    code = 1;
}
process.exit(code);
