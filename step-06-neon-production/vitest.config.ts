import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// @cloudflare/vitest-plugin reads CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_
// STRING_HYPERDRIVE from real process.env, not from .dev.vars the way
// `wrangler dev` does - confirmed by testing: a line in .dev.vars alone
// wasn't enough, only `export`ing it first worked. Loading .dev.vars
// here means `npm test` works the same way without a manual export.
if (existsSync(".dev.vars")) {
  process.loadEnvFile(".dev.vars");
}

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
