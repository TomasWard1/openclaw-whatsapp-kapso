/**
 * ESM register-entry consumed by the OpenClaw host.
 *
 * The host calls `register(api)` with a `PluginRuntime`; we stash it in a
 * module-level store and register our channel via `api.registerChannel`.
 *
 * Shipped as compiled ESM .js because Node refuses to strip TypeScript types
 * for files inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 */

import { kapsoPlugin } from "./src/channel.js";
import { setKapsoRuntime } from "./src/runtime.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

interface PluginApi {
  runtime: Record<string, unknown>;
  registerChannel: (args: { plugin: unknown }) => void;
}

export function register(api: PluginApi): void {
  setKapsoRuntime(api.runtime);
  api.registerChannel({ plugin: kapsoPlugin });
}

export const id = "whatsapp-kapso";
export const name = "WhatsApp (Kapso)";
export const description = "Native OpenClaw channel plugin for WhatsApp via Kapso";
export const configSchema = (manifest as { configSchema: Record<string, unknown> }).configSchema;

export default {
  id,
  name,
  description,
  configSchema,
  register,
};
