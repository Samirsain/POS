import type { NextConfig } from "next";

// Nothing to configure. The agent — and its native serial dependency — lives in
// agent/ with its own package.json, so the deployed app is plain Next.js.
const nextConfig: NextConfig = {};

export default nextConfig;
