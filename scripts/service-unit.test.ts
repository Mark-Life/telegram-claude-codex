import { expect, test } from "bun:test";
import {
  BACKUP_UNIT,
  detectPaths,
  renderBackupTimer,
  renderBackupUnit,
  renderUnit,
  UNIT,
} from "./service-unit";

const SHELL_VAR = /\$\{?[A-Za-z]/;
const HOME_TILDE = /(^|[^/])~\//;

test("detectPaths yields absolute paths", () => {
  const p = detectPaths();
  expect(p.bunPath.startsWith("/")).toBe(true);
  expect(p.repoDir.startsWith("/")).toBe(true);
  expect(p.entryPath.endsWith("/src/index.ts")).toBe(true);
  expect(p.unitPath.endsWith(`systemd/user/${UNIT}`)).toBe(true);
  expect(p.pathDirs.every((d) => d.startsWith("/"))).toBe(true);
});

test("renderUnit has no shell placeholders and optional env file", () => {
  const unit = renderUnit(detectPaths());
  expect(unit).not.toMatch(SHELL_VAR);
  expect(unit).not.toMatch(HOME_TILDE);
  expect(unit).toContain("EnvironmentFile=-");
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).toContain("Type=simple");
});

test("backup units render a daily oneshot with absolute paths", () => {
  const p = detectPaths();
  const unit = renderBackupUnit(p);
  expect(unit).not.toMatch(SHELL_VAR);
  expect(unit).toContain("Type=oneshot");
  expect(unit).toContain(`ExecStart=${p.bunPath} run ${p.backupScriptPath}`);
  expect(p.backupScriptPath.endsWith("/scripts/backup-db.ts")).toBe(true);

  const timer = renderBackupTimer();
  expect(timer).toContain("OnCalendar=daily");
  expect(timer).toContain("Persistent=true");
  expect(timer).toContain(`Unit=${BACKUP_UNIT}`);
  expect(timer).toContain("WantedBy=timers.target");
});

test("renderUnit PATH contains the bun bin dir", () => {
  const p = detectPaths();
  const bunDir = p.bunPath.slice(0, p.bunPath.lastIndexOf("/"));
  expect(renderUnit(p)).toContain(`Environment=PATH=${bunDir}`);
});
