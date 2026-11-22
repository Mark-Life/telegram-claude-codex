import { describe, expect, test } from "bun:test";

import { Effect, Option } from "effect";

import { GroupMemoryRepo } from "./group-memory";
import { makeTestDb } from "./testing";

describe("GroupMemoryRepo", () => {
  test("keeps messages isolated by chat and in chronological order", async () => {
    const db = makeTestDb();
    try {
      const lists = await db.run(
        Effect.gen(function* lists() {
          const memory = yield* GroupMemoryRepo;
          yield* memory.record({
            chatId: -100,
            createdAt: 20,
            from: "Anton",
            messageId: 2,
            text: "second",
          });
          yield* memory.record({
            chatId: -100,
            createdAt: 10,
            from: "Ivan",
            messageId: 1,
            text: "first",
          });
          yield* memory.record({
            chatId: -200,
            createdAt: 15,
            from: "Other",
            messageId: 1,
            text: "private to another chat",
          });
          const first = yield* memory.list(-100, 10);
          const second = yield* memory.list(-200, 10);
          return { first: first.map((message) => message.text), second };
        }).pipe(Effect.provide(GroupMemoryRepo.layer))
      );
      expect(lists.first).toEqual(["first", "second"]);
      expect(lists.second).toHaveLength(1);
    } finally {
      db.cleanup();
    }
  });

  test("redelivery updates one message instead of duplicating it", async () => {
    const db = makeTestDb();
    try {
      const texts = await db.run(
        Effect.gen(function* texts() {
          const memory = yield* GroupMemoryRepo;
          const message = {
            chatId: -100,
            createdAt: 10,
            from: "Ivan",
            messageId: 1,
            text: "draft",
          };
          yield* memory.record(message);
          yield* memory.record({ ...message, text: "edited" });
          const listed = yield* memory.list(-100, 10);
          return listed.map((entry) => entry.text);
        }).pipe(Effect.provide(GroupMemoryRepo.layer))
      );
      expect(texts).toEqual(["edited"]);
    } finally {
      db.cleanup();
    }
  });

  test("stores one curated fact sheet per chat", async () => {
    const db = makeTestDb();
    try {
      const sheets = await db.run(
        Effect.gen(function* sheets() {
          const memory = yield* GroupMemoryRepo;
          yield* memory.setFactSheet({
            chatId: -100,
            chatTitle: "India",
            content: "Tickets bought",
          });
          yield* memory.setFactSheet({
            chatId: -200,
            chatTitle: "Bulgaria",
            content: "Car booked",
          });
          const india = yield* memory.getFactSheet(-100);
          const bulgaria = yield* memory.getFactSheet(-200);
          return {
            bulgaria: bulgaria.pipe(Option.map((sheet) => sheet.content)),
            india: india.pipe(Option.map((sheet) => sheet.content)),
          };
        }).pipe(Effect.provide(GroupMemoryRepo.layer))
      );
      expect(sheets).toEqual({
        bulgaria: Option.some("Car booked"),
        india: Option.some("Tickets bought"),
      });
    } finally {
      db.cleanup();
    }
  });
});
