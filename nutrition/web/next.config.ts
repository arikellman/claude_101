import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This project sits inside a larger repo that has its own lockfile. Pin the root so
  // Turbopack does not infer the parent directory and warn on every build.
  turbopack: { root: import.meta.dirname },
  // Next 16 writes its own AGENTS.md + CLAUDE.md on first dev run. This repo already
  // maintains CLAUDE.md by hand at the root, and a generated one here would shadow it
  // for anything working in this directory. Opt out.
  agentRules: false,
  async headers() {
    return [
      {
        // The service worker must not be cached, or an update never reaches the phone.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
