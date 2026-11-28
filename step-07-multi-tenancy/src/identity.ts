// Minimal ambient type for this is in async-hooks.d.ts - see that file for
// why it's declared by hand instead of pulling in @types/node.
import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantContext } from "./tenant";

// Bridges the verified caller's tenant context from the Worker's own fetch
// handler (where requireMcpAuth hands it to us, see index.ts) down into
// tool handlers running deep inside createMcpHandler's dispatch. There's
// no per-request option on the Workers wrapper for this (its factory only
// gets protocol era/request info, not arbitrary caller data), so this is
// an explicit, request-scoped alternative - nothing here is shared between
// concurrent requests, same guarantee createMcpHandler's own per-request
// factory gives tool registration.
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext {
  const context = tenantStorage.getStore();
  if (!context) {
    throw new Error("getTenantContext() called outside an authenticated /mcp request.");
  }
  return context;
}
