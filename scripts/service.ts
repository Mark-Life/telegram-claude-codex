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
import { detectPaths, renderUnit, UNIT } from "./service-unit";

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
 * Idempotent install: detect paths, render the unit, write it only when the
 * content changed (or a prior symlink install is found), daemon-reload,
 * `enable --now`, restart when a running unit's definition changed, and enable
 * linger. Safe to re-run; converges to the same state.
 */
const install = async () => {
  const p = detectPaths();
  const unit = renderUnit(p);

  if (hasFlag("--dry-run")) {
    console.log(unit);
    return 0;
  }

  let existing: string | undefined;
  let wasSymlink = false;
  try {
    wasSymlink = (await lstat(p.unitPath)).isSymbolicLink();
    existing = await readFile(p.unitPath, "utf8");
  } catch {
    // no existing unit — first install
  }
  const changed = existing !== unit || wasSymlink || hasFlag("--force");
  const wasActive = systemctl("is-active", UNIT).stdout === "active";

  await mkdir(dirname(p.unitPath), { recursive: true });
  if (changed) {
    const tmp = `${p.unitPath}.tmp`;
    await writeFile(tmp, unit, "utf8");
    // rename replaces a pre-existing regular file OR symlink atomically,
    // converging old symlink-based installs to a plain generated file.
    await rename(tmp, p.unitPath);
    console.log(existing ? `Updated ${p.unitPath}` : `Wrote ${p.unitPath}`);
  } else {
    console.log(`Unit already up to date: ${p.unitPath}`);
  }

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

  if (hasFlag("--json")) {
    const mainPid =
      Number(systemctl("show", UNIT, "--property=MainPID", "--value").stdout) ||
      0;
    console.log(
      JSON.stringify(
        {
          active,
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
    `active: ${active}   enabled: ${enabled}   linger: ${linger ? "yes" : "no"}`
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

/** Stop, disable, remove the generated unit; leaves linger and `.env` alone. */
const uninstall = async () => {
  const p = detectPaths();
  systemctl("disable", "--now", UNIT);
  try {
    await rm(p.unitPath);
    console.log(`Removed ${p.unitPath}`);
  } catch {
    // already gone
  }
  systemctl("daemon-reload");
  console.log("Uninstalled. Linger and .env left untouched.");
  return 0;
};

const usage = `Usage: bun run service:<command>
  install [--force] [--dry-run] [--no-linger]
  status  [--json]
  logs    [-n <N>] [--no-follow]
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
