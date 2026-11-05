import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliGlobalConfigPath, MAX_CONFIG_BYTES, parseCliProfilePlan, readCliProfilePlan } from '../../src/main/system/cliProfile';

const SMALL_LIMIT = 4096;

// Synthetic home and config folders in a temp dir only; the real ~/.claude.json is never read.
let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'relay-cli-profile-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const config = (oauthAccount: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ numStartups: 3, projects: { 'D:/work': { history: [] } }, ...(oauthAccount ? { oauthAccount } : {}), ...extra });

const UPGRADED = {
  accountUuid: 'acc-1',
  emailAddress: 'me@example.com',
  organizationUuid: 'org-1',
  organizationType: 'claude_max',
  organizationRateLimitTier: 'default_claude_max_20x',
  billingType: 'google_play_subscription',
  displayName: 'Me',
};

describe('Claude Code profile plan (the account profile the CLI fetched after sign-in)', () => {
  it('maps the organization type to the plan the CLI uses and keeps the tier, and nothing else', () => {
    expect(parseCliProfilePlan(config(UPGRADED))).toEqual({ email: 'me@example.com', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });
    for (const [type, plan] of [['claude_pro', 'pro'], ['claude_team', 'team'], ['claude_enterprise', 'enterprise']] as const) {
      expect(parseCliProfilePlan(config({ ...UPGRADED, organizationType: type, organizationRateLimitTier: undefined }))).toEqual({
        email: 'me@example.com',
        subscriptionType: plan,
      });
    }
    expect(parseCliProfilePlan(`\uFEFF${config(UPGRADED)}`)?.subscriptionType).toBe('max');
  });

  it('reads nothing from a profile without a known plan, an email, or valid JSON', () => {
    expect(parseCliProfilePlan(config(undefined))).toBeUndefined();
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationType: 'claude_free' }))).toBeUndefined();
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationType: 42 }))).toBeUndefined();
    expect(parseCliProfilePlan(config({ ...UPGRADED, emailAddress: '  ' }))).toBeUndefined();
    expect(parseCliProfilePlan(config({ ...UPGRADED, emailAddress: `${'x'.repeat(250)}@example.com` }))).toBeUndefined();
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationRateLimitTier: 'Max 20x!' }))).toEqual({ email: 'me@example.com', subscriptionType: 'max' });
    expect(parseCliProfilePlan('{"oauthAccount": [1]}')).toBeUndefined();
    expect(parseCliProfilePlan('not json')).toBeUndefined();
    expect(parseCliProfilePlan('[]')).toBeUndefined();
  });

  it('drops the plan of a personal organization that belongs to another email, which the CLI leaves when it refreshes only the email', () => {
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationName: "me@example.com's Organization" }))).toMatchObject({ subscriptionType: 'max' });
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationName: ' ME@Example.com’s organization ' }))).toMatchObject({ subscriptionType: 'max' });
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationName: "desktop@example.com's Organization" }))).toBeUndefined();
    // A team or renamed organization does not say whose plan it is.
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationName: 'Acme Research' }))).toMatchObject({ subscriptionType: 'max' });
    expect(parseCliProfilePlan(config({ ...UPGRADED, organizationName: 42 }))).toMatchObject({ subscriptionType: 'max' });
  });

  it('finds the global config as the CLI does: home for the default profile, the config folder otherwise, a legacy file first', async () => {
    const dir = join(home, 'profiles', 'work');
    await mkdir(dir, { recursive: true });
    expect(await cliGlobalConfigPath(null, home)).toBe(join(home, '.claude.json'));
    expect(await cliGlobalConfigPath(dir, home)).toBe(join(dir, '.claude.json'));
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.config.json'), '');
    expect(await cliGlobalConfigPath(null, home)).toBe(join(home, '.claude.json'));
    await writeFile(join(home, '.claude', '.config.json'), config(UPGRADED));
    expect(await cliGlobalConfigPath(null, home)).toBe(join(home, '.claude', '.config.json'));
    await writeFile(join(dir, '.config.json'), config(UPGRADED));
    expect(await cliGlobalConfigPath(dir, home)).toBe(join(dir, '.config.json'));
  });

  it('reads the profile plan of a folder, and nothing when the file is missing, unreadable or too large', async () => {
    expect(await readCliProfilePlan(null, home)).toBeUndefined();
    await writeFile(join(home, '.claude.json'), config(UPGRADED));
    expect(await readCliProfilePlan(null, home)).toEqual({ email: 'me@example.com', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });
    await writeFile(join(home, '.claude.json'), '{broken');
    expect(await readCliProfilePlan(null, home)).toBeUndefined();
    // The size check with a small limit, so the test does not write megabytes.
    expect(MAX_CONFIG_BYTES).toBe(16 * 1024 * 1024);
    await writeFile(join(home, '.claude.json'), config(UPGRADED, { padding: 'x'.repeat(SMALL_LIMIT) }));
    expect(await readCliProfilePlan(null, home, SMALL_LIMIT)).toBeUndefined();
    expect(await readCliProfilePlan(null, home, SMALL_LIMIT * 2)).toMatchObject({ subscriptionType: 'max' });
    await rm(join(home, '.claude.json'));
    await mkdir(join(home, '.claude.json'));
    expect(await readCliProfilePlan(null, home)).toBeUndefined();
  });
});
