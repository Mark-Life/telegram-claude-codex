import type { NextConfig } from "next";
import "@workspace/env/web";

const nextConfig: NextConfig = {
  experimental: {
    // Enable filesystem caching for `next build`
    turbopackFileSystemCacheForBuild: true,
    // Enable filesystem caching for `next dev`
    turbopackFileSystemCacheForDev: true,
  },
  reactCompiler: true,
  transpilePackages: ["@workspace/ui", "@workspace/env"],
  typedRoutes: true,
};

export default nextConfig;
