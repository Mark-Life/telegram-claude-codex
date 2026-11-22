import { loadClaudeSdk } from "./claude-sdk";

/**
 * How the SDK's `deleteSession` reports that no project directory holds the
 * id ("Session <id> not found in any project directory", "... not found (no
 * projects directory)"). Any other error is a real failure.
 */
const SESSION_NOT_FOUND = /^Session \S+ not found\b/u;

/**
 * Delete a Claude session's transcript, in whichever project directory it
 * lies. A run kept only so a restart could resume it (a fresh task fire that
 * waited on background work) leaves nothing behind once it ended. A session
 * already gone is no error; a delete that failed (EACCES, EBUSY, EIO) throws,
 * so a caller can keep its note and retry.
 */
export const discardClaudeSession = async (sessionId: string) => {
  const { deleteSession } = await loadClaudeSdk();
  try {
    await deleteSession(sessionId);
  } catch (error) {
    if (error instanceof Error && SESSION_NOT_FOUND.test(error.message)) {
      return;
    }
    throw error;
  }
};
