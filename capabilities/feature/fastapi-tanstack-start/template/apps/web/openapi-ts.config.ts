import { defineConfig } from "@hey-api/openapi-ts";

// Generates TypeScript types + a typed fetch client/SDK for the web app from
// the FastAPI OpenAPI spec (apps/api/openapi.json, produced by the `api:gen-openapi`
// target). Regenerate with `bunx nx run fastapi-tanstack-start:gen-types`.
export default defineConfig({
  input: "../api/openapi.json",
  output: {
    path: "src/api/generated",
    // No external formatter/linter on generated output; it's lint/fmt-ignored.
    postProcess: [],
  },
  plugins: [
    "@hey-api/typescript",
    {
      name: "@hey-api/client-fetch",
      // Base URL is injected at runtime from the web env (see api-client-config).
      runtimeConfigPath: "./src/api/client-config.ts",
    },
    "@hey-api/sdk",
  ],
});
