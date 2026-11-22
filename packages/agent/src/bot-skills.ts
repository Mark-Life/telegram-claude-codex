import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dataPath } from "@workspace/env/paths";
import { Effect } from "effect";

import { logOutside } from "./log-sink";
import type { RunAccess } from "./types";

/**
 * `packages/agent`, which is also a Claude plugin named `bot`
 * (`.claude-plugin/plugin.json`). Its `skills/` holds how a run uses the
 * helper scripts beside it, plus links to the repo's self-update and
 * upstream-sync skills, and is the root Codex adds to its own list.
 */
const BOT_PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The `name` in `.claude-plugin/plugin.json`: Claude lists `bot:<skill>`. */
const BOT_PLUGIN = "bot";

/** The bot's skills root, as Codex is given it. */
const BOT_SKILLS_DIR = path.join(BOT_PLUGIN_DIR, "skills");

/** Skills every operator run is offered: the owner's and an executor's. */
const OPERATOR_SKILLS = [
  "bot-api-keys",
  "bot-send-file",
  "bot-send-voice",
  "bot-tasks",
] as const;

/** Skills only the owner's runs are offered: they change what others see. */
const OWNER_SKILLS = [
  "bot-access",
  "bot-profile",
  "self-update",
  "upstream-sync",
] as const;

/** Every skill the bot offers; a fork's own under the root are not among them. */
export const BOT_SKILLS = [...OPERATOR_SKILLS, ...OWNER_SKILLS] as const;

type BotSkill = (typeof BOT_SKILLS)[number];

/** A skill's file, through the link when the skill lives in `.agents/skills`. */
export const botSkillFile = (skill: BotSkill) =>
  path.join(BOT_SKILLS_DIR, skill, "SKILL.md");

/**
 * Whether a run works on the operator profile: the owner's, or an executor's
 * (workspace memory granted). Only those runs have the whole machine, so only
 * they can read the bot's repo at all.
 */
export const isOperatorRun = (access: RunAccess) =>
  access.adminScripts || access.workspaceMemory === "executor";

/**
 * The bot's skills a run is offered: all for the owner, the operator ones for
 * an executor. `bot-api-keys` only with the Telegram account: only such a run
 * is told whom it works for (`BOT_TASK_AUTHOR_ID`, `run-env.ts`), which the
 * apikeys CLI needs. The workspace forum and a task without the account use
 * `/apikeys` in the private chat instead.
 */
export const botSkillsFor = (access: RunAccess): readonly BotSkill[] => {
  if (!isOperatorRun(access)) {
    return [];
  }
  const skills = access.adminScripts ? BOT_SKILLS : OPERATOR_SKILLS;
  return access.telegramAccount
    ? skills
    : skills.filter((skill) => skill !== "bot-api-keys");
};

/** The skill directories under `dir`: each one holding a `SKILL.md`. */
const skillsIn = (dir: string) => {
  try {
    return readdirSync(dir).filter((entry) =>
      existsSync(path.join(dir, entry, "SKILL.md"))
    );
  } catch {
    return [];
  }
};

/** A skill's `SKILL.md` with every link resolved. */
const realSkillFile = (dir: string, skill: string) =>
  realpathSync(path.join(dir, skill, "SKILL.md"));

/** The skills roots a Codex run adds to its server: the bot's, when offered any. */
export const codexSkillRoots = (access: RunAccess) =>
  botSkillsFor(access).length > 0 ? [BOT_SKILLS_DIR] : [];

/**
 * The skills under the bot's root a Codex run must not offer, a fork's own
 * included, by real path: Codex tells skills apart by the file a link
 * resolves to, and lists a plugin's skills under a prefixed name. A run with
 * no root has nothing to hide.
 */
export const codexHiddenSkills = (access: RunAccess) => {
  const offered: readonly string[] = botSkillsFor(access);
  if (offered.length === 0) {
    return [];
  }
  return skillsIn(BOT_SKILLS_DIR)
    .filter((skill) => !offered.includes(skill))
    .map((skill) => realSkillFile(BOT_SKILLS_DIR, skill));
};

/**
 * The skill files a pi run loads with `--skill`, which still load under
 * `--no-skills`: exactly the bot's skills it is offered, none otherwise.
 */
export const piSkillFiles = (access: RunAccess) =>
  botSkillsFor(access).map(botSkillFile);

/** The plugin name Claude lists the user's workspace skills under. */
const WORKSPACE_PLUGIN = "workspace";

/** Where the user keeps their own skills, relative to the run's directory. */
export const WORKSPACE_SKILLS = ".agents/skills";

/**
 * What the Claude CLI turns into `-` in a plugin skill's name, which it takes
 * from the folder: the filter has to name the skill the same way.
 */
const NOT_IN_SKILL_NAME = /[^A-Za-z0-9_-]/gu;

/** How many hex digits of the workspace's hash name its plugin directory. */
const PLUGIN_KEY_LENGTH = 16;

/**
 * A plugin that lists the user's workspace skills to Claude, which loads no
 * skill of its own accord (`settingSources: []`). Codex finds them in the
 * run's directory by itself. The plugin is a directory in `.data` per
 * workspace: a manifest naming it `workspace` and a link to the skills, made
 * once and left for later runs.
 */
const workspacePluginRoot = (skillsDir: string) => {
  const key = createHash("sha256").update(skillsDir).digest("hex");
  const root = dataPath(
    path.join("claude-plugins", key.slice(0, PLUGIN_KEY_LENGTH))
  );
  const manifest = path.join(root, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) {
    mkdirSync(path.dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name: WORKSPACE_PLUGIN }));
  }
  const link = path.join(root, "skills");
  const target = path.resolve(skillsDir);
  try {
    symlinkSync(target, link);
  } catch {
    // Made already, perhaps by a run that started at the same moment; one
    // that points elsewhere is made again. Anything else throws here.
    if (readlinkSync(link) !== target) {
      unlinkSync(link);
      symlinkSync(target, link);
    }
  }
  return root;
};

/**
 * The workspace's own skills as a Claude plugin, the bot's own left out: a
 * run in the bot's repo finds them there too, and they are offered through
 * the bot's plugin or not at all. A workspace whose plugin cannot be made
 * costs the run those skills, never the run.
 */
const workspaceSkills = (projectDir: string) => {
  const workspaceDir = path.join(projectDir, WORKSPACE_SKILLS);
  try {
    const botFiles = new Set(
      skillsIn(BOT_SKILLS_DIR).map((skill) =>
        realSkillFile(BOT_SKILLS_DIR, skill)
      )
    );
    const found = skillsIn(workspaceDir).filter(
      (skill) => !botFiles.has(realSkillFile(workspaceDir, skill))
    );
    if (found.length === 0) {
      return { plugins: [], skills: [] };
    }
    return {
      plugins: [
        {
          path: workspacePluginRoot(workspaceDir),
          skipMcpDiscovery: true,
          type: "local" as const,
        },
      ],
      skills: found.map(
        (skill) =>
          `${WORKSPACE_PLUGIN}:${skill.replaceAll(NOT_IN_SKILL_NAME, "-")}`
      ),
    };
  } catch (error) {
    logOutside(
      Effect.logWarning("workspace skills left out", {
        error: String(error),
        workspaceDir,
      })
    );
    return { plugins: [], skills: [] };
  }
};

/**
 * What a Claude run loads to list its skills natively: the bot's plugin and
 * the workspace's, and the skills filter naming exactly those it is offered,
 * since the CLI loads every skill a plugin has and the filter alone decides
 * what the model sees. A run off the operator profile loads neither.
 */
export const claudeBotSkills = (access: RunAccess, projectDir: string) => {
  const offered = botSkillsFor(access);
  if (offered.length === 0) {
    return { plugins: [], skills: [] };
  }
  const plugins = [
    { path: BOT_PLUGIN_DIR, skipMcpDiscovery: true, type: "local" as const },
  ];
  const skills = offered.map((skill) => `${BOT_PLUGIN}:${skill}`);
  const workspace = workspaceSkills(projectDir);
  return {
    plugins: [...plugins, ...workspace.plugins],
    skills: [...skills, ...workspace.skills],
  };
};

/**
 * Whether a skill the CLI reports at init came from one of these plugins. It
 * reports every skill a plugin holds, the filtered ones too.
 */
export const isPluginSkill = (skill: string) =>
  skill.startsWith(`${BOT_PLUGIN}:`) ||
  skill.startsWith(`${WORKSPACE_PLUGIN}:`);
