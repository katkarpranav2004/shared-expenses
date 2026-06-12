import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // A stray package-lock.json exists in the user home directory; without this
  // Next guesses the workspace root wrong.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
