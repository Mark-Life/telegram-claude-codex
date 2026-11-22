#!/usr/bin/env bun

// Regenerate `src/provider-settings.generated.ts` from the pinned provider
// versions: the versions themselves, and `CodexConfig`, every top-level key of
// Codex's `config.toml` that holds one scalar value, typed from the
// `config.schema.json` Codex publishes at the release tag of the installed
// `@openai/codex`. Claude needs no file: the SDK's own `Settings` type is the
// pinned schema. Run it after every provider bump; a setting the bot offers
// that the new version dropped or retyped then fails the typecheck at its key
// in `src/provider-settings.ts`.
//
// `--check` only compares the versions in the file with the installed ones,
// offline. Exit 0 when they match, 1 otherwise.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { Array as Arr, Order, Predicate, Schema } from "effect";

const GENERATED = path.join(
  import.meta.dirname,
  "../src/provider-settings.generated.ts"
);

/** How deep a type may nest references before the key is left out. */
const MAX_DEPTH = 8;

const VERSION_KEYS = ["claudeCli", "claudeSdk", "codex"] as const;

/** The pinned versions, by `VERSION_KEYS`. */
interface Versions {
  readonly claudeCli: string;
  readonly claudeSdk: string;
  readonly codex: string;
}

const schemaUrl = (version: string) =>
  `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/core/config.schema.json`;

const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      claudeCodeVersion: Schema.optional(Schema.String),
      version: Schema.String,
    })
  )
);

const readPackage = (from: string, name: string) =>
  decodePackage(
    readFileSync(createRequire(from).resolve(`${name}/package.json`), "utf-8")
  );

/** The versions the installed packages pin, the way runs resolve them. */
const installedVersions = (): Versions => {
  const claude = readPackage(
    import.meta.filename,
    "@anthropic-ai/claude-agent-sdk"
  );
  // Found the way `vendoredCodex` finds the binary runs start.
  const codex = readPackage(
    import.meta.resolve("@openai/codex-sdk"),
    "@openai/codex"
  );
  if (claude.claudeCodeVersion === undefined) {
    throw new Error("The Claude Agent SDK names no claudeCodeVersion");
  }
  return {
    claudeCli: claude.claudeCodeVersion,
    claudeSdk: claude.version,
    codex: codex.version,
  };
};

/** The part of a JSON Schema node this script reads. */
interface SchemaNode {
  readonly $ref?: string;
  readonly allOf?: readonly SchemaNode[];
  readonly anyOf?: readonly SchemaNode[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly SchemaNode[];
  readonly type?: string | readonly string[];
}

const Node: Schema.Codec<SchemaNode> = Schema.Struct({
  $ref: Schema.optional(Schema.String),
  allOf: Schema.optional(Schema.Array(Schema.suspend(() => Node))),
  anyOf: Schema.optional(Schema.Array(Schema.suspend(() => Node))),
  description: Schema.optional(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.Unknown)),
  oneOf: Schema.optional(Schema.Array(Schema.suspend(() => Node))),
  type: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)])
  ),
});

const decodeConfigSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    definitions: Schema.Record(Schema.String, Node),
    properties: Schema.Record(Schema.String, Node),
  })
);

type ConfigSchema = ReturnType<typeof decodeConfigSchema>;

/** A JSON Schema scalar as its TypeScript type; "" for anything else. */
const scalarOf = (type: string) => {
  switch (type) {
    case "boolean": {
      return "boolean";
    }
    case "integer":
    case "number": {
      return "number";
    }
    case "string": {
      return "string";
    }
    default: {
      return "";
    }
  }
};

/** A union written once per member, in first-seen order. */
const union = (types: readonly string[]) =>
  [...new Set(types.flatMap((type) => type.split(" | ")))].join(" | ");

/**
 * A node as a TypeScript type, or "" when any part of it is not a scalar (a
 * table, an array, a reference loop): such a key is left out.
 */
const typeOf = (schema: ConfigSchema, node: SchemaNode, depth = 0): string => {
  if (depth > MAX_DEPTH) {
    return "";
  }
  if (node.$ref !== undefined) {
    const target = schema.definitions[node.$ref.replace("#/definitions/", "")];
    return target === undefined ? "" : typeOf(schema, target, depth + 1);
  }
  if (node.enum !== undefined) {
    return node.enum.every(Predicate.isString)
      ? node.enum.map((value) => JSON.stringify(value)).join(" | ")
      : "";
  }
  const parts = node.allOf ?? node.oneOf ?? node.anyOf;
  if (parts !== undefined) {
    const types = parts.map((part) => typeOf(schema, part, depth + 1));
    const single = node.allOf === undefined || parts.length === 1;
    return single && types.every((type) => type.length > 0) ? union(types) : "";
  }
  const types = (
    Predicate.isString(node.type) ? [node.type] : (node.type ?? [])
  )
    .filter((type) => type !== "null")
    .map(scalarOf);
  return types.length > 0 && types.every((type) => type.length > 0)
    ? union(types)
    : "";
};

/** The first sentence of a description, as one comment line. */
const summary = (node: SchemaNode) =>
  (node.description ?? "")
    .split("\n")[0]
    ?.split(/(?<=\.)\s/u)[0]
    ?.replaceAll("*/", "* /")
    .trim() ?? "";

const render = (versions: Versions, schema: ConfigSchema) => {
  const fields = Arr.sort(Object.keys(schema.properties), Order.String).flatMap(
    (key) => {
      const node = schema.properties[key];
      const type = node === undefined ? "" : typeOf(schema, node);
      if (node === undefined || type.length === 0) {
        return [];
      }
      const doc = summary(node);
      return [
        ...(doc.length === 0 ? [] : [`  /** ${doc} */`]),
        `  readonly ${key}?: ${type};`,
      ];
    }
  );
  return `// Generated by \`bun run provider-settings:sync\` from the pinned provider
// versions. Do not edit: run the script again after a provider bump.

/** The provider versions this file was generated from. */
export const PINNED_VERSIONS = {
  claudeCli: ${JSON.stringify(versions.claudeCli)},
  claudeSdk: ${JSON.stringify(versions.claudeSdk)},
  codex: ${JSON.stringify(versions.codex)},
} as const;

/**
 * Codex's \`config.toml\` keys that hold one scalar value, from
 * \`codex-rs/core/config.schema.json\` at \`rust-v${versions.codex}\`.
 */
export interface CodexConfig {
${fields.join("\n")}
}
`;
};

const check = async (versions: Versions) => {
  const { PINNED_VERSIONS } =
    await import("../src/provider-settings.generated");
  const stale = VERSION_KEYS.filter(
    (key) => PINNED_VERSIONS[key] !== versions[key]
  );
  for (const key of stale) {
    console.error(
      `${key}: installed ${versions[key]}, generated ${PINNED_VERSIONS[key]}`
    );
  }
  if (stale.length > 0) {
    console.error("Run `bun run provider-settings:sync`.");
    return 1;
  }
  console.log("Provider settings types match the pinned versions.");
  return 0;
};

const sync = async (versions: Versions) => {
  const response = await fetch(schemaUrl(versions.codex));
  if (!response.ok) {
    throw new Error(
      `No Codex config schema for ${versions.codex}: HTTP ${response.status}`
    );
  }
  const schema = decodeConfigSchema(await response.json());
  writeFileSync(GENERATED, render(versions, schema));
  console.log(
    `Wrote ${path.relative(process.cwd(), GENERATED)} for Claude Code ${versions.claudeCli} and Codex ${versions.codex}.`
  );
  return 0;
};

const versions = installedVersions();
process.exitCode = process.argv.includes("--check")
  ? await check(versions)
  : await sync(versions);
