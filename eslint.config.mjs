import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Logging went through bare console.* with whatever was in scope, which
      // is how full patient records reached stdout and therefore the platform
      // log drains. Application logging goes through @/lib/logger, which
      // redacts to an allowlist.
      //
      // `console` stays in globals for the logger itself and for
      // scripts/, which are not served to users.
      "no-console": "error",
    },
  },
  {
    files: ["src/lib/logger/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
