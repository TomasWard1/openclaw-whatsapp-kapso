import { KapsoAccountSchema, type KapsoConfig } from "./config-schema.js";
import type { KapsoAccountConfig, ResolvedKapsoAccount } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

function pickTopLevel(cfg: KapsoConfig): Partial<KapsoAccountConfig> {
  const { accounts: _accounts, ...rest } = cfg;
  return rest as Partial<KapsoAccountConfig>;
}

export function listKapsoAccountIds(cfg: KapsoConfig): string[] {
  const ids = new Set<string>();
  const top = pickTopLevel(cfg);
  if (top.apiKey && top.phoneNumberId && top.webhookSecret) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  if (cfg.accounts) {
    for (const k of Object.keys(cfg.accounts)) ids.add(k);
  }
  return Array.from(ids);
}

export function resolveDefaultKapsoAccountId(cfg: KapsoConfig): string | undefined {
  const ids = listKapsoAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0];
}

export function resolveKapsoAccount(
  cfg: KapsoConfig,
  accountId: string = DEFAULT_ACCOUNT_ID,
): ResolvedKapsoAccount | undefined {
  const top = pickTopLevel(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (!top.apiKey || !top.phoneNumberId || !top.webhookSecret) return undefined;
    const parsed = KapsoAccountSchema.safeParse(top);
    if (!parsed.success) return undefined;
    return { accountId, config: parsed.data };
  }
  const sub = cfg.accounts?.[accountId];
  if (!sub) return undefined;
  // Overlay: inherit top-level fields as fallback for the sub-account.
  const merged = { ...top, ...sub };
  const parsed = KapsoAccountSchema.safeParse(merged);
  if (!parsed.success) return undefined;
  return { accountId, config: parsed.data };
}
