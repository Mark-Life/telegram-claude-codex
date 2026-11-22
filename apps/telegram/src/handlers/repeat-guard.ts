/**
 * A Telegram client on a bad connection can send one message twice: two
 * messages with their own ids and the same words, seconds apart. In a private
 * chat with topics each one opens a topic of its own, so each becomes a
 * separate conversation, and both runs would make the same writes. A message
 * whose words match one the same chat sent within the window is that copy.
 */
export const REPEAT_WINDOW_MS = 60_000;

/**
 * Words this short ("да", "продолжай") are said again on purpose, often in two
 * topics a minute apart, so they are never taken for a copy.
 */
export const MIN_REPEAT_CHARS = 40;

export const createRepeatGuard = ({
  now = Date.now,
  windowMs = REPEAT_WINDOW_MS,
}: { now?: () => number; windowMs?: number } = {}) => {
  /** When each chat's words first arrived, keyed by chat id and words. */
  const seen = new Map<string, number>();

  return {
    /**
     * Whether `text` repeats words `chatId` sent within the window. Words that
     * are not a repeat are remembered; a repeat does not extend the window.
     */
    isRepeat: ({ chatId, text }: { chatId: number; text: string }) => {
      const words = text.trim();
      if (words.length < MIN_REPEAT_CHARS) {
        return false;
      }
      const at = now();
      for (const [key, firstAt] of seen) {
        if (at - firstAt >= windowMs) {
          seen.delete(key);
        }
      }
      const key = `${chatId}\n${words}`;
      if (seen.has(key)) {
        return true;
      }
      seen.set(key, at);
      return false;
    },
  };
};
