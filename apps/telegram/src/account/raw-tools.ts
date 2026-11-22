import type { tl } from "@mtcute/bun";
import type { AccountActionPayload, TaskStamp } from "@workspace/db";
import { Context, Effect, Layer } from "effect";
import { absurd } from "effect/Function";

import { TelegramAccount } from "../telegram/telegram-account";
import { AccountActions, describeAction } from "./actions";
import { badInput } from "./inputs";
import { MAX_WRITE_CHARS, boundedLimit } from "./present";
import { buildCall, normalizeParams } from "./raw-params";
import { RAW_NAMESPACES, verdictOf } from "./raw-policy";
import { rawAnswer } from "./raw-result";
import {
  RawSchema,
  camel,
  cleanComment,
  isOptional,
  namespaceOf,
  returnLabel,
  signature,
  typeLabel,
} from "./raw-schema";
import type { RawEntry, RawIndex } from "./raw-schema";
import type { ArgsOf } from "./tool-call-schema";
import { writeAnswer } from "./write-tools";

/**
 * The raw API escape hatch: any Telegram method the typed tools do not
 * cover, found with `tg_search_methods`, read with `tg_describe` and called
 * with `tg_call`. What a call may do is `raw-policy.ts`'s verdict: a denied
 * method is refused, a read runs at once, a read mark runs at once like
 * `mark_read`, and a write always waits for the owner's button, whatever the
 * writes mode, with a confirmation `raw-confirm.ts` draws.
 */

const DEFAULT_HITS = 10;
const MAX_HITS = 30;
/** Most constructors one description lists. */
const MAX_CONSTRUCTORS = 40;
const DESCRIPTION_CHARS = 1000;

/** One argument as `tg_describe` shows it: camelCase, as `tg_call` takes it. */
const describeArgument = (argument: RawEntry["arguments"][number]) => ({
  comment: cleanComment(argument.comment),
  name: camel(argument.name),
  optional: isOptional(argument),
  type: typeLabel(argument),
});

const argumentsOf = (entry: RawEntry) =>
  entry.arguments
    .filter((argument) => argument.type !== "#")
    .map(describeArgument);

/** The constructors of a type, each with its signature, capped. */
const constructorsOf = (index: RawIndex, type: string) => {
  const all = index.constructorsByType.get(type) ?? [];
  return {
    constructors: all.slice(0, MAX_CONSTRUCTORS).map((entry) => ({
      name: entry.name,
      signature: signature(entry),
      summary: cleanComment(entry.comment, { firstLine: true }),
    })),
    more: Math.max(0, all.length - MAX_CONSTRUCTORS),
  };
};

const describeMethod = (index: RawIndex, entry: RawEntry) => {
  const verdict = verdictOf(entry);
  return {
    arguments: argumentsOf(entry),
    class: verdict.class,
    denied_because: verdict.reason ?? null,
    description: cleanComment(entry.comment, { max: DESCRIPTION_CHARS }),
    errors: (index.errorsByMethod.get(entry.name) ?? []).map((error) => ({
      ...error,
      description: cleanComment(error.description),
    })),
    kind: "method",
    name: entry.name,
    returns: {
      description: cleanComment(index.unionComments.get(entry.type)),
      type: returnLabel(entry),
      ...constructorsOf(index, entry.type),
    },
    signature: signature(entry),
  };
};

const describeType = (index: RawIndex, type: string) => ({
  description: cleanComment(index.unionComments.get(type), {
    max: DESCRIPTION_CHARS,
  }),
  kind: "type",
  name: type,
  ...constructorsOf(index, type),
});

const describeConstructor = (entry: RawEntry) => ({
  arguments: argumentsOf(entry),
  description: cleanComment(entry.comment, { max: DESCRIPTION_CHARS }),
  kind: "constructor",
  name: entry.name,
  signature: signature(entry),
  type: entry.type,
});

/** How many query tokens a method's name holds, or null if one matches none. */
const matchScore = (entry: RawEntry, tokens: readonly string[]) => {
  const name = entry.name.toLowerCase();
  const comment = cleanComment(entry.comment, {
    max: DESCRIPTION_CHARS,
  }).toLowerCase();
  let inName = 0;
  for (const token of tokens) {
    if (name.includes(token)) {
      inName += 1;
    } else if (!comment.includes(token)) {
      return null;
    }
  }
  return inName;
};

const make = Effect.gen(function* () {
  const account = yield* TelegramAccount;
  const actions = yield* AccountActions;
  const { index: loadIndex } = yield* RawSchema;

  const searchMethods = Effect.fnUntraced(function* (
    input: ArgsOf<"tg_search_methods">
  ) {
    const tokens = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) {
      return yield* badInput("query must not be blank.");
    }
    const { namespace } = input;
    if (namespace !== undefined && !RAW_NAMESPACES.has(namespace)) {
      return yield* badInput(
        `No namespace ${namespace}. Namespaces: ${[...RAW_NAMESPACES.keys()].join(", ")}.`
      );
    }
    const index = yield* loadIndex;
    const scored = [...index.methods.values()].flatMap((entry) => {
      if (
        entry.available === "bot" ||
        (namespace !== undefined && namespaceOf(entry.name) !== namespace)
      ) {
        return [];
      }
      const score = matchScore(entry, tokens);
      return score === null ? [] : [{ entry, score }];
    });
    scored.sort(
      (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)
    );
    const limit = boundedLimit(input.limit, DEFAULT_HITS, MAX_HITS);
    return {
      peerId: null,
      value: {
        hits: scored.slice(0, limit).map(({ entry }) => ({
          class: verdictOf(entry).class,
          method: entry.name,
          signature: signature(entry),
          summary: cleanComment(entry.comment, { firstLine: true }),
        })),
        layer: index.layer,
        total: scored.length,
      },
    };
  });

  const describe = Effect.fnUntraced(function* (input: ArgsOf<"tg_describe">) {
    const name = input.name.trim();
    const index = yield* loadIndex;
    const method = index.methods.get(name);
    if (method !== undefined) {
      return { peerId: null, value: describeMethod(index, method) };
    }
    if (index.constructorsByType.has(name)) {
      return { peerId: null, value: describeType(index, name) };
    }
    const constructor = index.classes.get(name);
    if (constructor !== undefined) {
      return { peerId: null, value: describeConstructor(constructor) };
    }
    return yield* badInput(
      `No method, type or constructor named ${name} in layer ${index.layer}. Find one with tg_search_methods.`
    );
  });

  /** A read or a read mark: called now, its answer pruned. */
  const callDirect = Effect.fnUntraced(function* (input: {
    readonly entry: RawEntry;
    readonly index: RawIndex;
    readonly params: ArgsOf<"tg_call">["params"];
    readonly verdict: "mark" | "read";
  }) {
    const { entry } = input;
    const call = yield* buildCall({
      account,
      entry,
      index: input.index,
      params: input.params,
    });
    // The answer is pruned as it arrives: what Telegram sent is parsed there.
    const value = yield* account.use(`raw:${entry.name}`, async (client) =>
      rawAnswer({
        class: input.verdict,
        method: entry.name,
        result: await client.call<tl.RpcMethod>(call),
      })
    );
    return {
      ledger: {
        access: input.verdict === "read" ? "read" : "local",
        tool: `tg_call:${entry.name}`,
      },
      peerId: null,
      value,
    } as const;
  });

  /** A write: checked, resolved, shown to the owner, never run directly. */
  const callWrite = Effect.fnUntraced(function* (input: {
    readonly entry: RawEntry;
    readonly index: RawIndex;
    readonly params: ArgsOf<"tg_call">["params"];
    readonly requester: TaskStamp;
  }) {
    const { entry } = input;
    const normalized = yield* normalizeParams({
      account,
      entry,
      index: input.index,
      params: input.params,
    });
    const payload: AccountActionPayload = {
      bytes: normalized.bytes,
      kind: "raw",
      method: entry.name,
      params: normalized.params,
      peers: normalized.peers,
      summary: cleanComment(entry.comment, { firstLine: true }),
    };
    const shown = describeAction({ ...payload, requestedBy: input.requester });
    if (shown.length > MAX_WRITE_CHARS) {
      return yield* badInput(
        `The confirmation would be ${shown.length} characters: too large to show the owner; use a typed tool or fewer arguments.`
      );
    }
    const outcome = yield* actions.request(payload, input.requester);
    return {
      peerId: normalized.peers[0]?.peer.id ?? null,
      value: { class: "write", method: entry.name, ...writeAnswer(outcome) },
    };
  });

  const call = Effect.fnUntraced(function* (
    input: ArgsOf<"tg_call">,
    requester: TaskStamp
  ) {
    const name = input.method.trim();
    const index = yield* loadIndex;
    const entry = index.methods.get(name);
    if (entry === undefined) {
      return yield* badInput(
        `No method ${name} in layer ${index.layer}. Find one with tg_search_methods; a constructor or type is not callable.`
      );
    }
    const verdict = verdictOf(entry);
    switch (verdict.class) {
      case "deny": {
        return yield* badInput(
          `${name} is denied by policy: ${verdict.reason ?? "not allowed"}. Use a typed tool, or tell the person it cannot be done.`
        );
      }
      case "read":
      case "mark": {
        return yield* callDirect({
          entry,
          index,
          params: input.params,
          verdict: verdict.class,
        });
      }
      case "write": {
        return yield* callWrite({
          entry,
          index,
          params: input.params,
          requester,
        });
      }
      default: {
        return absurd<never>(verdict.class);
      }
    }
  });

  return { call, describe, searchMethods } as const;
});

/** The raw API tools: `tg_search_methods`, `tg_describe` and `tg_call`. */
export class RawTools extends Context.Service<
  RawTools,
  Effect.Success<typeof make>
>()("@workspace/RawTools") {
  static readonly layer = Layer.effect(RawTools, make);
}
