/** One follow-up as the provider sends it: an id to track it by, and its text. */
export interface FollowUp {
  readonly id: ReturnType<typeof crypto.randomUUID>;
  readonly text: string;
}

/**
 * Messages a user sends while their run works, for a provider that folds them
 * into the running turn, or while it is parked on background work, which
 * takes one as its next turn. The registry makes one per run and hands it
 * over in `RunContext`. `offer` succeeds only while the provider listens, so
 * a provider that never reads it or a run past its last turn leaves the
 * message to the caller, who queues it.
 */
export interface FollowUps {
  /**
   * Take no more; messages already offered are still yielded. `shutdown`
   * marks the close as the bot's own restart (`shuttingDown`).
   */
  readonly close: (shutdown?: boolean) => void;
  /** The provider's side: every offered message, in order, until `close`. */
  readonly listen: () => AsyncGenerator<FollowUp>;
  /** Hand a message to the run; false when the run takes none now. */
  readonly offer: (text: string) => boolean;
  /** The provider's side: the agent took this message into its work. */
  readonly took: (id: string) => void;
  /**
   * The provider's side, for an agent that cannot say which message it took:
   * every message yielded so far was taken.
   */
  readonly tookYielded: () => void;
  /**
   * The provider's side: the agent answered and waits on work it started in
   * the background, so the next message starts a turn at once. False, and
   * nothing changes, once the inbox is closed.
   */
  readonly park: () => boolean;
  /** The provider's side: the agent works again. */
  readonly resume: () => void;
  /** Whether the inbox takes no more messages. */
  readonly closed: () => boolean;
  /** Whether the run is parked: answered, and waiting on background work. */
  readonly waiting: () => boolean;
  /** Whether the inbox was closed because the bot shuts down. */
  readonly shuttingDown: () => boolean;
  /**
   * How many offered messages the agent never took: the newest ones, which
   * the caller queues again once the run ended. A message it took and then
   * failed on is not among them, so nothing it started runs twice.
   */
  readonly unread: () => number;
}

export const createFollowUps = (): FollowUps => {
  const pending: FollowUp[] = [];
  const yielded: string[] = [];
  const taken = new Set<string>();
  let offered = 0;
  let listening = false;
  let closed = false;
  let parked = false;
  let shutdown = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    close: (forShutdown = false) => {
      shutdown ||= forShutdown;
      closed = true;
      parked = false;
      notify();
    },
    closed: () => closed,
    listen: async function* listen() {
      listening = true;
      while (true) {
        const next = pending.shift();
        if (next !== undefined) {
          yielded.push(next.id);
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        const woken = Promise.withResolvers<undefined>();
        wake = () => {
          woken.resolve();
        };
        // oxlint-disable-next-line no-await-in-loop -- one message at a time, in order
        await woken.promise;
      }
    },
    offer: (text) => {
      if (!listening || closed) {
        return false;
      }
      pending.push({ id: crypto.randomUUID(), text });
      offered += 1;
      notify();
      return true;
    },
    park: () => {
      if (closed) {
        return false;
      }
      parked = true;
      return true;
    },
    resume: () => {
      parked = false;
    },
    shuttingDown: () => shutdown,
    took: (id) => {
      if (yielded.includes(id)) {
        taken.add(id);
      }
    },
    tookYielded: () => {
      for (const id of yielded) {
        taken.add(id);
      }
    },
    unread: () => offered - taken.size,
    waiting: () => parked,
  };
};
