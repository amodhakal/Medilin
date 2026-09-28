import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  async headers() {
    return [
      {
        // A route segment's own `headers()` export is not applied to a
        // dynamically rendered page, so the token-bearing /spectate and
        // /track pages cannot set these for themselves. Verified against a
        // running build: neither header appeared on /track.
        source: "/:path*",
        headers: [
          // The spectate and tracking pages link onward to themselves with the
          // sealed token in the href. A leaked Referer would hand a bearer
          // credential to anything the page ever links to, so the policy has
          // to be right even though the token is opaque.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
