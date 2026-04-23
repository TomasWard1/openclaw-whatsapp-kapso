import { z } from "zod";

/**
 * Zod schema for a single Kapso-backed WhatsApp account.
 *
 * `.strict()` ensures typos in config files fail loudly rather than being
 * silently ignored — the common failure mode for YAML-style configs.
 */
export const KapsoAccountSchema = z
  .object({
    apiKey: z.string().min(1, "apiKey is required"),
    phoneNumberId: z
      .string()
      .min(1, "phoneNumberId is required")
      .regex(/^[0-9]+$/, "phoneNumberId must be a digits-only Meta phone_number_id"),
    webhookSecret: z
      .string()
      .min(16, "webhookSecret must be at least 16 characters (HMAC shared secret)"),
    apiBaseUrl: z.string().url().optional(),
    enabled: z.boolean().optional(),
    name: z.string().optional(),
  })
  .strict();

export const KapsoConfigSchema = KapsoAccountSchema.extend({
  accounts: z.record(z.string(), KapsoAccountSchema).optional(),
})
  .partial({
    apiKey: true,
    phoneNumberId: true,
    webhookSecret: true,
  })
  .strict();

export type KapsoConfig = z.infer<typeof KapsoConfigSchema>;
export type KapsoAccount = z.infer<typeof KapsoAccountSchema>;

export const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai";
export const KAPSO_API_PATH = "/meta/whatsapp/v24.0";
