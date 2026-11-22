import {
  bwrapWorks,
  pinSandbox,
  socketPathFits,
  sweepSocketDirs,
} from "@workspace/agent/sandbox";
import { AppConfig } from "@workspace/env/bot";
import { Duration, Effect, Option } from "effect";

import { resolveBin } from "./provider-bin";

/**
 * Find `bwrap` and `socat` at boot and pin what works here. With `bwrap`,
 * every run but full access runs inside a view; with `socat` too, the view has
 * its own network and reaches only its provider's hosts through the bot's
 * proxy. Without `bwrap`, light runs keep what the provider's own sandbox
 * gives, as before; without `socat`, views keep the host's network. The log
 * says which.
 */

/** How long the boot waits for each test view. */
const CHECK_TIMEOUT_MS = 5000;
const CHECK_TIMEOUT = Duration.millis(CHECK_TIMEOUT_MS);

/** Whether a test view with `command` starts, false on a hang or a failure. */
const viewWorks = (
  bin: string,
  check: { command: readonly string[]; isolated: boolean }
) =>
  Effect.tryPromise(
    async (signal) => await bwrapWorks(bin, { ...check, signal })
  ).pipe(
    Effect.timeoutOrElse({
      duration: CHECK_TIMEOUT,
      orElse: () => Effect.succeed(false),
    }),
    Effect.catch(() => Effect.succeed(false))
  );

/**
 * The egress proxy the operator set for the bot, if any. The view's proxy
 * dials its hosts directly and would bypass it, so the view keeps the host
 * network and the run gets the operator's proxy through its env.
 */
const egressProxy = () =>
  ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].find(
    (name) => (process.env[name] ?? "") !== ""
  );

/** The `socat` that runs inside a view with its own network, if any works. */
const isolatedSocat = Effect.fn("Sandbox.socat")(function* (bwrap: string) {
  const cfg = yield* AppConfig;
  const proxy = egressProxy();
  if (proxy !== undefined) {
    yield* Effect.logWarning(
      `${proxy} is set — sandbox views keep the host network and its egress proxy, and Claude refuses members`
    );
    return Option.none<string>();
  }
  const socat = resolveBin({
    command: "socat",
    homeBinDirs: [],
    override: Option.getOrUndefined(cfg.socatBin),
  });
  if (socat === undefined) {
    yield* Effect.logWarning(
      "socat not found — sandbox views keep the host network and Claude refuses members; install socat"
    );
    return Option.none<string>();
  }
  const works = yield* viewWorks(bwrap, {
    command: [socat, "-V"],
    isolated: true,
  });
  if (!works) {
    yield* Effect.logWarning(
      `no isolated network view with ${socat} — sandbox views keep the host network and Claude refuses members`
    );
    return Option.none<string>();
  }
  return Option.some(socat);
});

export const pinHostSandbox = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  sweepSocketDirs();
  if (!socketPathFits()) {
    yield* Effect.logError(
      "the repo path is too long for a unix socket under .data/relay — sandboxed runs that need a relay or the network proxy will fail; move the repo to a shorter path"
    );
  }
  const bin = resolveBin({
    command: "bwrap",
    homeBinDirs: [],
    override: Option.getOrUndefined(cfg.bwrapBin),
  });
  if (bin === undefined) {
    pinSandbox({});
    return yield* Effect.logWarning(
      "bwrap not found — light runs get no sandbox view and Claude refuses members; install bubblewrap"
    );
  }
  const works = yield* viewWorks(bin, { command: ["true"], isolated: false });
  if (!works) {
    pinSandbox({});
    return yield* Effect.logWarning(
      `bwrap at ${bin} cannot build a view here — light runs get no sandbox view and Claude refuses members`
    );
  }
  const socat = yield* isolatedSocat(bin);
  pinSandbox({ bwrap: bin, socat: Option.getOrUndefined(socat) });
  return yield* Effect.log(
    Option.match(socat, {
      onNone: () => `Sandbox view: ${bin}, host network`,
      onSome: (path) => `Sandbox view: ${bin}, network through ${path}`,
    })
  );
}).pipe(Effect.withSpan("Sandbox.pin"));
