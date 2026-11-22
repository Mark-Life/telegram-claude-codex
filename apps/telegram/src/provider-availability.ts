import {
  getProvider,
  PROVIDER_IDS,
  Providers,
  resolveRoles,
  snapshotOf,
} from "@workspace/agent";
import type { EffectiveProviders, ProviderSnapshot } from "@workspace/agent";
import type { ProviderAvailability, ProviderId } from "@workspace/agent/types";
import { AppConfig } from "@workspace/env/bot";
import { Clock, Duration, Effect, Layer, Option, Ref } from "effect";

import { resolveBin } from "./provider-bin";

/**
 * Which providers this host can run, found by looking rather than configured:
 * a provider is installed when its CLI resolves (`provider-bin.ts`), and ready
 * when that CLI says its account is logged in. Every registered provider is
 * checked in parallel while the layer builds; `default` and `light` come
 * from that one snapshot and change again only after a login, so a
 * conversation never moves to another provider under the people in it. A
 * later check refreshes the statuses and the helpers, which hold no session.
 */

/** How long one provider's check may take before it reads `unknown`. */
const PROBE_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT = Duration.millis(PROBE_TIMEOUT_MS);

/** A background re-check of one provider runs at most this often. */
const REPROBE_COOLDOWN_MS = 60_000;

/** The operator's explicit CLI path per provider, when one is set. */
const binOverrides = (cfg: AppConfig["Service"]) =>
  ({
    claude: Option.getOrUndefined(cfg.claudeBin),
    codex: Option.getOrUndefined(cfg.codexBin),
    pi: Option.getOrUndefined(cfg.piBin),
  }) satisfies Record<ProviderId, string | undefined>;

/** Check one provider: find its CLI, then ask it about its account. */
const probe = (id: ProviderId, override: string | undefined) =>
  Effect.gen(function* () {
    const provider = getProvider(id);
    const bin = resolveBin({
      command: provider.command,
      homeBinDirs: provider.homeBinDirs,
      override,
    });
    const status: ProviderAvailability =
      bin === undefined
        ? "missing"
        : yield* Effect.tryPromise({
            catch: () => "unknown" as const,
            try: async (signal) => await provider.availability(bin, signal),
          }).pipe(
            Effect.timeoutOrElse({
              duration: PROBE_TIMEOUT,
              orElse: () => Effect.succeed("unknown" as const),
            }),
            Effect.catch((error) => Effect.succeed(error))
          );
    const checkedAt = yield* Clock.currentTimeMillis;
    const snapshot: ProviderSnapshot = { bin, checkedAt, id, status };
    return snapshot;
  }).pipe(Effect.withSpan("Providers.probe", { attributes: { provider: id } }));

/** One boot-log line per provider; a missing CLI is a warning. */
const logSnapshot = (snapshot: ProviderSnapshot) => {
  const { command, displayName } = getProvider(snapshot.id);
  const line = Effect.annotateLogs(
    snapshot.status === "missing"
      ? Effect.logWarning(
          `${displayName} CLI not found — install ${command} to use it`
        )
      : Effect.log(`${displayName} CLI: ${snapshot.bin}`),
    { provider: snapshot.id, status: snapshot.status }
  );
  return line;
};

const make = Effect.gen(function* () {
  const overrides = binOverrides(yield* AppConfig);
  const probeAll = (ids: readonly ProviderId[]) =>
    Effect.forEach(ids, (id) => probe(id, overrides[id]), {
      concurrency: "unbounded",
    });

  const first = yield* probeAll(PROVIDER_IDS);
  yield* Effect.forEach(first, logSnapshot, { discard: true });
  const snapshots: Partial<Record<ProviderId, ProviderSnapshot>> = {};
  for (const snapshot of first) {
    snapshots[snapshot.id] = snapshot;
  }
  const initial: EffectiveProviders = {
    ...resolveRoles(snapshots),
    snapshots,
  };
  yield* Effect.annotateLogs(Effect.log("providers.roles"), {
    default: initial.default,
    helpers: JSON.stringify(initial.helpers),
    light: initial.light,
  });
  const state = yield* Ref.make(initial);
  /** When each provider was last asked, so the cooldown spans checks in flight. */
  const asked = new Map<ProviderId, number>(
    first.map((snapshot) => [snapshot.id, snapshot.checkedAt])
  );

  const reprobe = Effect.fn("Providers.reprobe")(function* (input: {
    readonly ids?: readonly ProviderId[];
    readonly roles: boolean;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const due = (input.ids ?? PROVIDER_IDS).filter(
      (id) => input.roles || now - (asked.get(id) ?? 0) >= REPROBE_COOLDOWN_MS
    );
    if (due.length === 0) {
      return yield* Ref.get(state);
    }
    for (const id of due) {
      asked.set(id, now);
    }
    const fresh = yield* probeAll(due);
    const [before, after] = yield* Ref.modify(state, (current) => {
      const merged = { ...current.snapshots };
      for (const snapshot of fresh) {
        merged[snapshot.id] = snapshot;
      }
      const fresher = resolveRoles(merged);
      const roles = input.roles ? fresher : current;
      const next: EffectiveProviders = {
        default: roles.default,
        helpers: fresher.helpers,
        light: roles.light,
        snapshots: merged,
      };
      return [[current, next] as const, next];
    });
    const statusBefore = (id: ProviderId) =>
      snapshotOf(before.snapshots, id).status;
    yield* Effect.forEach(
      fresh.filter((snapshot) => statusBefore(snapshot.id) !== snapshot.status),
      (snapshot) =>
        Effect.annotateLogs(Effect.log("providers.status"), {
          from: statusBefore(snapshot.id),
          provider: snapshot.id,
          to: snapshot.status,
        }),
      { discard: true }
    );
    if (before.default !== after.default || before.light !== after.light) {
      yield* Effect.annotateLogs(Effect.logWarning("providers.roles"), {
        from: before.default,
        to: after.default,
      });
    }
    return after;
  });

  return { current: Ref.get(state), reprobe } satisfies Providers["Service"];
});

/**
 * `Providers` as this host finds them. Building it spawns each installed
 * provider's status check once, at most `PROBE_TIMEOUT` each, in parallel.
 */
export const ProvidersLive = Layer.effect(Providers, make);
