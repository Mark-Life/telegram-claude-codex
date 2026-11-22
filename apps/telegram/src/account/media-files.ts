import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isInside, isProtectedFile } from "@workspace/agent/protected-files";
import type { AccountMediaKind } from "@workspace/db";
import type { AppConfig } from "@workspace/env/bot";
import { dataPath } from "@workspace/env/paths";
import { Effect, Option } from "effect";

import { badInput } from "./inputs";
import { BYTES_PER_MB, MS_PER_HOUR, pruneOlderThan, swallow } from "./scratch";

/**
 * The files `send_media` sends as the owner. A path must be a file a run made
 * or the user sent: under the working directory (or `PROJECTS_DIR`) or the
 * system temp dir, and never one of the bot's protected files
 * (`@workspace/agent/protected-files`, the deny list `send-file-to-user`
 * applies too). Each file is copied into `.data/account-outbox/<uuid>/` when
 * the write is asked, and that copy is what the preview shows and what is
 * sent, so a file changed after the owner looked never goes out. The copy is
 * removed once the write ended, was cancelled or expired.
 */

/** Staged copies of `media` writes, one directory per write. */
const OUTBOX_DIR = dataPath("account-outbox");

/** Largest file the Bot API preview can carry, and so the largest sent. */
const MAX_FILE_MB = 50;
const MAX_FILE_BYTES = MAX_FILE_MB * BYTES_PER_MB;
/** Largest photo Telegram takes as a photo; a bigger one goes as a document. */
const MAX_PHOTO_MB = 10;
const MAX_PHOTO_BYTES = MAX_PHOTO_MB * BYTES_PER_MB;
/** A staged copy outlives its write's 24 h expiry by an hour, then goes. */
const OUTBOX_KEEP_HOURS = 25;
const OUTBOX_KEEP_MS = OUTBOX_KEEP_HOURS * MS_PER_HOUR;

const KIND_BY_EXTENSION = new Map<string, AccountMediaKind>([
  [".flac", "audio"],
  [".jpeg", "photo"],
  [".jpg", "photo"],
  [".m4a", "audio"],
  [".mov", "video"],
  [".mp3", "audio"],
  [".mp4", "video"],
  [".oga", "voice"],
  [".ogg", "voice"],
  [".opus", "voice"],
  [".png", "photo"],
  [".wav", "audio"],
  [".webm", "video"],
  [".webp", "photo"],
]);

/** How a file goes out when the run did not say: by its extension. */
const kindOfFile = (name: string): AccountMediaKind =>
  KIND_BY_EXTENSION.get(path.extname(name).toLowerCase()) ?? "document";

/** The settings that name where a run works. */
type WorkDirs = Pick<AppConfig["Service"], "projectsDir" | "workDir">;

/**
 * Where `send_media` may take a file from, canonical: the run's working
 * directory and the temp dir. A root that does not exist is left out.
 */
const allowedRoots = async (cfg: WorkDirs) => {
  const roots = [
    Option.getOrElse(cfg.workDir, () => cfg.projectsDir),
    tmpdir(),
  ];
  const resolved = await Promise.all(
    roots.map(async (root) => await realpath(root).catch(() => null))
  );
  return resolved.filter((root) => root !== null);
};

/** A file the run named, checked and ready to stage. */
interface CheckedFile {
  readonly as: AccountMediaKind;
  readonly name: string;
  readonly size: number;
  readonly source: string;
}

/**
 * One path from the run: inside an allowed root, not protected, a regular
 * non-empty file within the size limit. Its `as` defaults by extension.
 */
export const checkFile = Effect.fnUntraced(function* (input: {
  readonly as: AccountMediaKind | undefined;
  readonly cfg: WorkDirs;
  readonly path: string;
}) {
  if (!path.isAbsolute(input.path)) {
    return yield* badInput(`files: give an absolute path (got ${input.path}).`);
  }
  const source = yield* Effect.promise(
    async () => await realpath(input.path).catch(() => null)
  );
  if (source === null) {
    return yield* badInput(`files: no such file: ${input.path}`);
  }
  const roots = yield* Effect.promise(
    async () => await allowedRoots(input.cfg)
  );
  const allowed =
    roots.some((root) => isInside(root, source)) &&
    !(yield* Effect.promise(async () => await isProtectedFile(source)));
  if (!allowed) {
    return yield* badInput(
      `files: ${input.path} may not be sent. Only a file this run made or the user sent, under the working directory or the temp dir, and never one of the bot's own files.`
    );
  }
  const info = yield* Effect.promise(
    async () => await stat(source).catch(() => null)
  );
  if (info === null || !info.isFile()) {
    return yield* badInput(`files: ${input.path} is not a regular file.`);
  }
  if (info.size === 0) {
    return yield* badInput(`files: ${input.path} is empty.`);
  }
  if (info.size > MAX_FILE_BYTES) {
    return yield* badInput(
      `files: ${input.path} is larger than ${MAX_FILE_MB} MB.`
    );
  }
  const name = path.basename(source);
  const as = input.as ?? kindOfFile(name);
  if (as === "photo" && info.size > MAX_PHOTO_BYTES) {
    return yield* badInput(
      `files: ${input.path} is larger than ${MAX_PHOTO_MB} MB, too big for a photo; send it as "document".`
    );
  }
  return { as, name, size: info.size, source } satisfies CheckedFile;
});

/**
 * Which files may share one album, as Telegram allows it: a voice note goes
 * alone; photos and videos mix; documents only with documents; audio only
 * with audio.
 */
export const checkAlbum = (kinds: readonly AccountMediaKind[]) => {
  if (kinds.length <= 1) {
    return Effect.void;
  }
  if (kinds.includes("voice")) {
    return Effect.fail(badInput("files: a voice note goes alone."));
  }
  const visual = kinds.every((kind) => kind === "photo" || kind === "video");
  const same = kinds.every((kind) => kind === kinds[0]);
  return visual || same
    ? Effect.void
    : Effect.fail(
        badInput(
          "files: one album holds photos and videos, or only documents, or only audio. Send the rest in another call."
        )
      );
};

/**
 * Copy each checked file into a new outbox directory of its own; the items as
 * a `media` write keeps them, with the staged paths.
 */
export const stageFiles = (files: readonly CheckedFile[]) =>
  Effect.tryPromise({
    catch: () =>
      badInput("files: could not copy the files to send; nothing was sent."),
    try: async () => {
      // Retention is best effort; it never fails the write it precedes.
      await pruneOlderThan(OUTBOX_DIR, OUTBOX_KEEP_MS);
      const dir = path.join(OUTBOX_DIR, randomUUID());
      await mkdir(dir, { recursive: true });
      return await Promise.all(
        files.map(async (file, index) => {
          // The index keeps two files of one name apart.
          const staged = path.join(dir, `${index}-${file.name}`);
          await copyFile(file.source, staged);
          const { size } = await stat(staged);
          return { as: file.as, name: file.name, path: staged, size };
        })
      );
    },
  });

/**
 * Remove the staged copies of one write, best effort: only directories inside
 * the outbox, so a stored path can never point the removal elsewhere.
 */
export const discardStaged = (paths: readonly string[]) =>
  Effect.promise(async () => {
    const dirs = new Set(paths.map((file) => path.dirname(file)));
    await Promise.all(
      [...dirs].flatMap((dir) =>
        dir !== OUTBOX_DIR && isInside(OUTBOX_DIR, dir)
          ? [rm(dir, { force: true, recursive: true }).catch(swallow)]
          : []
      )
    );
  });
