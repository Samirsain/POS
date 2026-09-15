import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The connector is a separate program, not part of the web app. It is
    // CommonJS and dependency-free on purpose, because Node's single-executable
    // format needs both — so the app's module rules do not apply to it.
    "connector/**",
    "dist/**",
  ]),
]);

export default eslintConfig;
