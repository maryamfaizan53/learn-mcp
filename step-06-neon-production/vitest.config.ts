import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

const NODE_BUILTINS = builtinModules.filter((name) => !name.includes("/"));

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
  // pg's CommonJS dynamic require() (require('./client') inside its own
  // index.js) isn't something @cloudflare/vitest-plugin's module loader
  // resolves on its own - Cloudflare's own known-issues page documents
  // this exact fix: pre-bundle the dependency instead of loading it as-is.
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["pg"],
          // Vite's own pre-bundle step for `pg` walks into every Node
          // built-in pg or its transitive deps (pgpass, split2) touch -
          // fs, crypto, dns, and more - and fails trying to resolve
          // them itself, outside the Workers runtime that actually
          // supplies them via nodejs_compat. Excluding the whole set
          // (node:module's own builtinModules list) from the bundling
          // step lets it leave them alone and trust the runtime.
          exclude: NODE_BUILTINS,
        },
      },
    },
  },
});
