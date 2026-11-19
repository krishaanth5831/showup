import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The local development database (Postgres compiled to WebAssembly) and the Postgres
  // driver must be loaded by Node itself, not bundled.
  // Lets a phone on the same Wi-Fi open the development server through the computer's
  // network address. Without it the page loads but its buttons stay dead. Development only.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*"],
  serverExternalPackages: ["@electric-sql/pglite", "pg", "undici"],
  experimental: {
    // Screenshots are shrunk in the browser first; this is the ceiling for the upload.
    serverActions: { bodySizeLimit: "4mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
