#!/usr/bin/env bun
import os from "node:os";
import { dirname, resolve } from "node:path";

/** systemd --user unit file name for the bot. */
export const UNIT = "telegram-claude.service";

export interface ServicePaths {
  bunPath: string;
  configDir: string;
  entryPath: string;
  envFile: string;
  home: string;
  pathDirs: string[];
  repoDir: string;
  unitPath: string;
  user: string;
}

/**
 * Absolute dir of a binary on PATH, or undefined.
 * Skips the per-invocation `/tmp/bun-node-*` trampoline that `Bun.which`
 * returns for bun-shimmed tools — those paths do not survive a reboot.
 */
const resolveBinDir = (name: string) => {
  const p = Bun.which(name);
  if (!p || p.startsWith("/tmp/")) {
    return;
  }
  return dirname(p);
};

/**
 * Detect every absolute path the systemd unit needs.
 * bun comes from `process.execPath` (stable, unlike the `Bun.which` /tmp shim);
 * the repo root is resolved from this script's own location (scripts/ → repo),
 * never `process.cwd()` which under `bun run` is the caller's directory.
 */
export const detectPaths = (): ServicePaths => {
  const bunPath = process.execPath;
  const repoDir = resolve(import.meta.dir, "..");
  const home = os.homedir();
  const user = os.userInfo().username;
  const configDir =
    process.env.XDG_CONFIG_HOME?.trim() || resolve(home, ".config");
  const pathDirs = [
    ...new Set(
      [
        dirname(bunPath),
        resolve(home, ".bun/bin"),
        resolve(home, ".local/bin"),
        resolveBinDir("claude"),
        resolveBinDir("codex"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].filter((d): d is string => Boolean(d))
    ),
  ];
  return {
    bunPath,
    repoDir,
    entryPath: resolve(repoDir, "src/index.ts"),
    envFile: resolve(repoDir, ".env"),
    user,
    home,
    configDir,
    pathDirs,
    unitPath: resolve(configDir, "systemd/user", UNIT),
  };
};

/**
 * Render the systemd --user unit from detected paths. Every value is an
 * absolute path with no shell metacharacters, since systemd does not expand
 * `$VAR`/`~`. `EnvironmentFile` is `-`-prefixed so a missing `.env` is non-fatal.
 */
export const renderUnit = (p: ServicePaths) =>
  `[Unit]
Description=Telegram Claude Bot
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${p.repoDir}
EnvironmentFile=-${p.envFile}
ExecStart=${p.bunPath} run ${p.entryPath}
Restart=on-failure
RestartSec=5
Environment=PATH=${p.pathDirs.join(":")}

[Install]
WantedBy=default.target
`;
