import path from "node:path";

import { config } from "dotenv";

import { findMonorepoRoot } from "./paths";

/**
 * Loads .env and .env.local from the monorepo root into process.env.
 * Existing values take precedence; a missing root or file is a no-op.
 */
const root = findMonorepoRoot();

if (root !== null) {
  config({ override: false, path: path.resolve(root, ".env"), quiet: true });
  config({
    override: false,
    path: path.resolve(root, ".env.local"),
    quiet: true,
  });
}
