import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliProfilePlan } from '@shared/types';

/**
 * Claude Code keeps the plan from the sign-in in its credentials and re-reads the account profile on a token refresh only
 * when a field is missing, so after an upgrade `claude auth status` and the SDK keep reporting the old plan. The profile it
 * fetched from the server later (`oauthAccount` in its global config) has the current one. Only the profile's email, plan
 * fields and organization name are kept; credentials (.credentials.json) are never opened.
 */

/** Claude Code's organization types and the plan names it derives from them (CLI 2.1.302). */
const PLANS: Readonly<Record<string, string>> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_team: 'team',
  claude_enterprise: 'enterprise',
};

/** The global config grows with project history; anything larger than this is not a config file worth parsing. */
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const TIER = /^[a-z0-9_]{1,64}$/;
/**
 * The name the server gives a personal organization. The CLI writes the organization name together with the plan fields
 * but refreshes the email apart from them (CLI 2.1.302), so after another account used the same config folder the plan
 * fields may still be that account's; for a personal organization the name says whose they are.
 */
const PERSONAL_ORG = /^(.+)['’]s organization$/i;

/**
 * The file Claude Code reads as its global config for a profile: a non-empty legacy `.config.json` in the config folder,
 * else `.claude.json` in CLAUDE_CONFIG_DIR, or in the home folder for the default profile.
 */
export async function cliGlobalConfigPath(configDir: string | null, home = homedir()): Promise<string> {
  const legacy = join(configDir ?? join(home, '.claude'), '.config.json');
  try {
    const info = await stat(legacy);
    if (info.isFile() && info.size > 0) return legacy;
  } catch {
    // No legacy file: the usual one.
  }
  return join(configDir ?? home, '.claude.json');
}

/** Pure: the plan fields of the profile in a global config's text, or undefined when they are missing or malformed. */
export function parseCliProfilePlan(text: string): CliProfilePlan | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  const account = isRecord(parsed) && isRecord(parsed.oauthAccount) ? parsed.oauthAccount : undefined;
  if (!account) return undefined;
  const email = typeof account.emailAddress === 'string' ? account.emailAddress.trim() : '';
  const plan = typeof account.organizationType === 'string' ? PLANS[account.organizationType] : undefined;
  if (!email || email.length > 256 || !plan) return undefined;
  const owner = typeof account.organizationName === 'string' ? PERSONAL_ORG.exec(account.organizationName.trim())?.[1] : undefined;
  if (owner !== undefined && owner.trim().toLowerCase() !== email.toLowerCase()) return undefined;
  const tier = account.organizationRateLimitTier;
  return { email, subscriptionType: plan, ...(typeof tier === 'string' && TIER.test(tier) ? { rateLimitTier: tier } : {}) };
}

/** The profile plan for a Relay profile's config folder; undefined when there is no readable one. Never throws. */
export async function readCliProfilePlan(
  configDir: string | null,
  home = homedir(),
  maxBytes = MAX_CONFIG_BYTES,
): Promise<CliProfilePlan | undefined> {
  try {
    const file = await cliGlobalConfigPath(configDir, home);
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return parseCliProfilePlan(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
