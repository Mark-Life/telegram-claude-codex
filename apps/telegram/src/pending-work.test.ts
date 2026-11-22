import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { PendingWork } from "./pending-work";

/** Run `body` against a fresh tracker whose scope closes afterwards. */
const withPending = async (
  body: (pending: PendingWork["Service"]) => Promise<void>
) => {
  await Effect.runPromise(
    Effect.flatMap(PendingWork, (pending) =>
      Effect.promise(async () => {
        await body(pending);
      })
    ).pipe(Effect.provide(PendingWork.layer))
  );
};

const idle = async (pending: PendingWork["Service"], ms = 1000) =>
  await Effect.runPromise(pending.awaitIdleFor(ms));

describe("pending work", () => {
  test("waits for tracked work and becomes idle afterwards", async () => {
    await withPending(async (pending) => {
      const { promise: work, resolve: finish } = Promise.withResolvers<true>();

      void pending.track(work);
      expect(pending.size()).toBe(1);

      let drained = false;
      const waiting = idle(pending).then((result) => {
        drained = result;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      finish(true);
      await waiting;
      expect(drained).toBe(true);
      expect(pending.size()).toBe(0);
    });
  });

  test("also waits for work registered during the drain", async () => {
    await withPending(async (pending) => {
      const first = Promise.withResolvers<true>();
      const second = Promise.withResolvers<true>();
      void pending.track(first.promise);

      const waiting = idle(pending);
      void pending.track(second.promise);
      first.resolve(true);
      await Bun.sleep(0);
      expect(pending.size()).toBe(1);

      second.resolve(true);
      expect(await waiting).toBe(true);
      expect(pending.size()).toBe(0);
    });
  });

  test("a rejected operation is removed and remains observable by its caller", async () => {
    await withPending(async (pending) => {
      const failed = pending.track(Promise.reject(new Error("boom")));

      let message = "";
      try {
        await failed;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("boom");
      expect(await idle(pending)).toBe(true);
      expect(pending.size()).toBe(0);
    });
  });

  test("a bounded drain reports work that did not finish", async () => {
    await withPending(async (pending) => {
      void pending.track(Promise.withResolvers<true>().promise);

      expect(await idle(pending, 5)).toBe(false);
      expect(pending.size()).toBe(1);
    });
  });
});
