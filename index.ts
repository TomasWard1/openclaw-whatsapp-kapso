/**
 * CommonJS register-entry consumed by the OpenClaw host.
 *
 * Follows the same pattern as openclaw-vk: the host calls `register(api)` with
 * a `PluginRuntime`, we stash it in a module-level store and register our
 * channel via `api.registerChannel`.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { kapsoPlugin } = require("./src/channel.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setKapsoRuntime } = require("./src/runtime.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require("./openclaw.plugin.json") as {
  configSchema: Record<string, unknown>;
};

interface PluginApi {
  runtime: Record<string, unknown>;
  registerChannel: (args: { plugin: unknown }) => void;
}

function register(api: PluginApi): void {
  setKapsoRuntime(api.runtime);
  api.registerChannel({ plugin: kapsoPlugin });
}

module.exports = {
  id: "whatsapp-kapso",
  name: "WhatsApp (Kapso)",
  description: "Native OpenClaw channel plugin for WhatsApp via Kapso",
  // Keep the register-entry in sync with the manifest so registry UIs that
  // read either source see the real schema, not an empty no-op.
  configSchema: manifest.configSchema,
  register,
};
