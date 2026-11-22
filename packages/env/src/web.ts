import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

import "./load-root-env";

export const env = createEnv({
  client: {
    // Add client env vars here (must be prefixed with NEXT_PUBLIC_)
    // NEXT_PUBLIC_APP_URL: z.string().url(),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    // Map all declared vars to process.env here
    // DATABASE_URL: process.env.DATABASE_URL,
    // NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  server: {
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    // Add server env vars here
    // DATABASE_URL: z.string().url(),
  },
  /**
   * Skip validation in docker builds or CI where env vars aren't available.
   * Set SKIP_ENV_VALIDATION=1 to bypass.
   */
  skipValidation: (process.env.SKIP_ENV_VALIDATION ?? "") !== "",
});
