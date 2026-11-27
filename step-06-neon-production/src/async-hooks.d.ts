// `@cloudflare/workers-types` doesn't declare `node:async_hooks` (even
// though nodejs_compat provides the real thing at runtime - already relied
// on by `agents/mcp/server` itself internally), and pulling in all of
// `@types/node` just for this one class risks its globals (fetch, Request,
// Response, ...) conflicting with workers-types' own. Minimal declaration
// of just what identity.ts actually uses, instead.
declare module "node:async_hooks" {
  class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
