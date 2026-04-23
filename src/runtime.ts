/**
 * Minimal runtime store, shaped the same way as openclaw-vk's `runtime.ts`.
 *
 * The real OpenClaw host provides a `PluginRuntime` object via `api.runtime`
 * in `register(api)`. Other modules in this plugin can call `getKapsoRuntime()`
 * to access it without threading it through every call.
 *
 * We intentionally don't depend on `openclaw/plugin-sdk/runtime-store` here so
 * that the plugin boots even if that submodule is unavailable (old host).
 * The shape mirrors `createPluginRuntimeStore` though, so swapping in the
 * official helper is a one-liner.
 */

export type PluginRuntime = Record<string, unknown>;

let current: PluginRuntime | null = null;

export function setKapsoRuntime(rt: PluginRuntime): void {
  current = rt;
}

export function getKapsoRuntime(): PluginRuntime {
  if (!current) {
    throw new Error("Kapso runtime not initialized — plugin not registered");
  }
  return current;
}

/** Test-only: clear the stored runtime between tests. */
export function __resetKapsoRuntime(): void {
  current = null;
}
