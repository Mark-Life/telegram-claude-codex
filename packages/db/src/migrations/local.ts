import type { Migration } from "./runner";

/**
 * This fork's own migrations, one `steps/<YYYYMMDD-slug>.ts` file each. Empty
 * upstream: upstream lists its own in `index.ts`, so a merge from upstream
 * never touches this file. When upstream adopts one of these under the same
 * name, drop it from here; the name is already applied and does not run again.
 */
export const LOCAL_MIGRATIONS: readonly Migration[] = [];
