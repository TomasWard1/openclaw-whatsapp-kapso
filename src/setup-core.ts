/**
 * Setup wizard helpers. The OpenClaw CLI drives the wizard via a structural
 * `ChannelSetupAdapter` interface; we expose the minimum pieces needed to
 * collect Kapso credentials and tell the user the webhook URL.
 */

import { KapsoAccountSchema } from "./config-schema.js";

export interface KapsoSetupAnswers {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string;
  apiBaseUrl?: string;
}

export function validateAnswers(answers: unknown): {
  ok: true; value: KapsoSetupAnswers;
} | {
  ok: false; issues: string[];
} {
  const parsed = KapsoAccountSchema.safeParse(answers);
  if (parsed.success) return { ok: true, value: parsed.data as KapsoSetupAnswers };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
  };
}

/**
 * Compose the webhook URL the user must paste into the Kapso dashboard when
 * registering a Kapso-native webhook for this phone number.
 *
 * The default path `/webhooks/whatsapp-kapso/{accountId}` matches the
 * convention OpenClaw uses when mounting plugin webhook handlers.
 */
export function kapsoWebhookUrl(publicBaseUrl: string, accountId: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/webhooks/whatsapp-kapso/${encodeURIComponent(accountId)}`;
}

export const kapsoSetupPlugin = {
  id: "whatsapp-kapso",
  meta: {
    id: "whatsapp-kapso",
    label: "WhatsApp (Kapso)",
    blurb:
      "Connect WhatsApp Business via Kapso. Needs: Kapso project API key, phone_number_id, and a webhook shared secret.",
  },
  setupWizard: {
    questions: [
      {
        key: "apiKey",
        label: "Kapso project API key",
        help: "Dashboard → Project Settings → API Keys",
        type: "string" as const,
        secret: true,
      },
      {
        key: "phoneNumberId",
        label: "WhatsApp phone_number_id",
        help: "Digits-only Meta ID for the WhatsApp number (e.g. 647015955153740)",
        type: "string" as const,
      },
      {
        key: "webhookSecret",
        label: "Webhook shared secret",
        help:
          "Generate a random 32+ char string. You'll paste this into Kapso when registering the webhook.",
        type: "string" as const,
        secret: true,
      },
      {
        key: "apiBaseUrl",
        label: "Kapso API base URL (optional)",
        help: "Defaults to https://api.kapso.ai. Only override for self-hosted Kapso.",
        type: "string" as const,
        optional: true,
      },
    ],
    validate: validateAnswers,
    nextSteps: (ctx: { publicBaseUrl: string; accountId: string }) => [
      `Register a Kapso-native webhook pointed at: ${kapsoWebhookUrl(
        ctx.publicBaseUrl,
        ctx.accountId,
      )}`,
      "Events: whatsapp.message.received",
      "Paste the same webhook secret into Kapso's 'Secret Key' field.",
    ],
  },
};
