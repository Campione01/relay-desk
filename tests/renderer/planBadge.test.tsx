import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus } from '@shared/types';
import { createMockApi, type MockRelayApi } from '../../src/renderer/mock/api';
import { MOCK_AUTH, MOCK_USAGE } from '../../src/renderer/mock/fixtures';
import { AppController } from '../../src/renderer/state/controller';
import { createTranslator } from '../../src/renderer/i18n';
import { currentPlan, nextAuthSince, normalizePlan, planDisplay, tierLabel } from '../../src/renderer/state/plan';
import { renderApp, sidebar, takeOverMain } from './helpers';

const status = (subscriptionType: string | undefined, checkedAt: number, loggedIn = true): AuthStatus => ({
  profileId: 'default',
  loggedIn,
  authMethod: 'claude.ai',
  checkedAt,
  ...(subscriptionType ? { subscriptionType } : {}),
});

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

async function boot(): Promise<{ api: MockRelayApi; controller: AppController; stop: () => void }> {
  const api = createMockApi({ settings: { language: 'en' } });
  window.relay = api;
  const controller = new AppController(api);
  const stop = controller.start();
  // Polls with setTimeout: waitFor would stall while setInterval is faked.
  for (let i = 0; i < 200 && !(controller.state.sessionsState === 'loaded' && Object.keys(controller.state.auth).length === 2); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(controller.state.sessionsState).toBe('loaded');
  expect(Object.keys(controller.state.auth)).toHaveLength(2);
  return { api, controller, stop };
}

afterEach(() => {
  delete (document as { visibilityState?: string }).visibilityState;
  vi.useRealTimers();
});

describe('plan merge (R4-plan)', () => {
  it('a newer session or usage report replaces the stored plan; re-checks of the cached plan do not', () => {
    const auth = status('pro', 2_000);
    expect(currentPlan(auth, { authSince: 1_000 }, undefined)).toBe('pro');
    expect(currentPlan(auth, { authSince: 1_000, session: { subscriptionType: 'max', at: 1_500 } }, undefined)).toBe('max');
    expect(currentPlan(auth, { authSince: 1_000, session: { subscriptionType: 'max', at: 900 } }, undefined)).toBe('pro');
    const usage = { profileId: 'default', available: true, windows: [], subscriptionType: 'team', fetchedAt: 1_800 };
    expect(currentPlan(auth, { authSince: 1_000, session: { subscriptionType: 'max', at: 1_500 } }, usage)).toBe('team');
    expect(currentPlan(auth, { authSince: 1_000, session: { subscriptionType: 'max', at: 1_900 } }, usage)).toBe('max');
    expect(currentPlan(auth, undefined, { ...usage, fetchedAt: 1_999 })).toBe('pro');
    expect(currentPlan(auth, { authSince: 1_000 }, { ...usage, subscriptionType: undefined })).toBe('pro');
    expect(currentPlan(status('pro', 2_000, false), { session: { subscriptionType: 'max', at: 3_000 } }, undefined)).toBeUndefined();
  });

  it('keeps the time the status first reported its plan while re-checks repeat it', () => {
    expect(nextAuthSince(undefined, undefined, status('pro', 100))).toBe(100);
    expect(nextAuthSince(status('pro', 100), 100, status('pro', 200))).toBe(100);
    expect(nextAuthSince(status('pro', 100), undefined, status('pro', 200))).toBe(100);
    expect(nextAuthSince(status('pro', 100), 100, status('max', 300))).toBe(300);
    expect(nextAuthSince(status('pro', 100, false), 100, status('pro', 400))).toBe(400);
  });
});

describe('account status refresh (R4-plan)', () => {
  it('re-checks every account on window focus and when the window becomes visible, never while hidden', async () => {
    const { api, stop } = await boot();
    const check = vi.spyOn(api.accounts, 'status');
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(check.mock.calls).toEqual([['default', false], ['profile-work', false]]);
    setVisibility('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(check).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(check).toHaveBeenCalledTimes(4);
    stop();
    window.dispatchEvent(new Event('focus'));
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('re-checks every 10 minutes while visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, stop } = await boot();
    const check = vi.spyOn(api.accounts, 'status');
    vi.advanceTimersByTime(9 * 60_000);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(check.mock.calls).toEqual([['default', false], ['profile-work', false]]);
    setVisibility('hidden');
    vi.advanceTimersByTime(10 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    setVisibility('visible');
    vi.advanceTimersByTime(30 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('plan Claude Code fetched after an upgrade', () => {
  const upgraded = (cli: string | undefined, loggedIn = true): AuthStatus => ({
    ...status(cli, 2_000, loggedIn),
    profilePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  });

  it('shows the fetched plan with its tier and the plan Claude Code still works with when they differ', () => {
    expect(planDisplay(upgraded('pro'), undefined, undefined, undefined)).toEqual({ label: 'Max 20x', plan: 'Max', cliPlan: 'Pro' });
    // A live session names the profile's plan ("Claude Max 20x") while Claude Code still works with the stored one.
    const session = { authSince: 1_000, session: { subscriptionType: 'Claude Max 20x', at: 3_000 } };
    expect(planDisplay(upgraded('pro'), session, undefined, undefined)).toEqual({ label: 'Max 20x', plan: 'Max', cliPlan: 'Pro' });
    // Signed in again: the stored plan is Max too, so there is nothing to note.
    expect(planDisplay(upgraded('max'), session, undefined, undefined)).toEqual({ label: 'Max 20x', plan: 'Max' });
    // Usage reports the stored plan as well; a newer report counts.
    const usage = { profileId: 'default', available: true, windows: [], subscriptionType: 'max', fetchedAt: 3_000 };
    expect(planDisplay(upgraded('pro'), { authSince: 1_000 }, usage, undefined)).toEqual({ label: 'Max 20x', plan: 'Max' });
    expect(planDisplay(upgraded('pro'), { authSince: 1_000 }, { ...usage, fetchedAt: 500 }, undefined)).toEqual({ label: 'Max 20x', plan: 'Max', cliPlan: 'Pro' });
    expect(planDisplay(upgraded(undefined), undefined, undefined, undefined)).toEqual({ label: 'Max 20x', plan: 'Max' });
    expect(planDisplay({ ...upgraded('pro'), profilePlan: { subscriptionType: 'team' } }, undefined, undefined, undefined)).toEqual({ label: 'Team', plan: 'Team', cliPlan: 'Pro' });
    expect(planDisplay(status('pro', 2_000), undefined, undefined, undefined)).toEqual({ label: 'Pro', plan: 'Pro' });
    expect(planDisplay(status(undefined, 2_000), undefined, undefined, undefined)).toEqual({});
    expect(planDisplay(upgraded('pro', false), undefined, undefined, undefined)).toEqual({});
  });

  it('keeps the plan Claude Code reports while the shared settings may belong to another account', () => {
    const drift = { email: 'desktop@example.com', drift: { label: 'desktop@example.com', remembered: 'me@example.com' } };
    expect(planDisplay(upgraded('pro'), undefined, undefined, drift)).toEqual({ label: 'Pro', plan: 'Pro' });
    expect(planDisplay(upgraded('pro'), undefined, undefined, { email: 'desktop@example.com', undecided: true })).toEqual({ label: 'Pro', plan: 'Pro' });
    expect(planDisplay(upgraded('pro'), undefined, undefined, { email: 'me@example.com' })).toEqual({ label: 'Max 20x', plan: 'Max', cliPlan: 'Pro' });
  });

  it('only strictly newer usage can replace the CLI plan, even across a one-millisecond boundary', () => {
    const auth = upgraded('pro');
    const usage = { ...MOCK_USAGE, profileId: 'default', fetchedAt: auth.checkedAt };
    expect(planDisplay(auth, undefined, usage, undefined)).toEqual({ label: 'Max 20x', plan: 'Max', cliPlan: 'Pro' });
    expect(planDisplay(auth, undefined, { ...usage, fetchedAt: auth.checkedAt + 1 }, undefined)).toEqual({ label: 'Max 20x', plan: 'Max' });
  });

  it('reads tiers and plan names the way Claude Code writes them', () => {
    expect(tierLabel('default_claude_max_20x')).toBe('20x');
    expect(tierLabel('default_claude_max_5x')).toBe('5x');
    expect(tierLabel('default_claude_ai')).toBeUndefined();
    expect(tierLabel(undefined)).toBeUndefined();
    expect(normalizePlan(' Claude Pro ')).toBe('pro');
    expect(normalizePlan('max')).toBe('max');
    expect(normalizePlan('Claude Max 20x')).toBe('max');
    expect(normalizePlan('  ')).toBeUndefined();
  });

  it('the chip shows Max; the account menu, the environment card and the Accounts card show Max 20x and say Claude Code still works as Pro', async () => {
    const rendered = await renderApp({
      auth: { ...MOCK_AUTH, default: { ...MOCK_AUTH.default!, subscriptionType: 'pro', profilePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } } },
      // Bootstrap usage must agree with the CLI plan; the default Max fixture can otherwise win by one millisecond.
      usage: { ...MOCK_USAGE, subscriptionType: 'pro' },
    });
    await waitFor(() => expect(rendered.controller.state.usage.default?.subscriptionType).toBe('pro'));
    const chip = within(sidebar()).getByRole('button', { name: /^Account:/ });
    // The tier would push the account name into an ellipsis in the narrow chip.
    await waitFor(() => expect(chip).toHaveTextContent(/· Max$/));
    await rendered.user.click(chip);
    const menu = await screen.findByRole('menu', { name: 'Accounts' });
    expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveTextContent(/Max 20x$/);
    await rendered.user.keyboard('{Escape}');
    act(() => rendered.controller.revealCard('accounts'));
    const row = screen.getAllByTestId('account-row')[0]!;
    expect(row).toHaveTextContent('· Max 20x');
    expect(within(row).getByTestId('account-plan-stale')).toHaveTextContent(
      'Claude Code still records Pro, the plan at sign-in; until you sign in again, it behaves as on Pro wherever the plan matters: ' +
        'for example, it tells Claude not to spawn agents unless you ask, and dynamic workflows are off by default.',
    );
    await takeOverMain(rendered);
    expect(screen.getByTestId('card-environment')).toHaveTextContent('Max 20x');
  });

  it('says it in Traditional Chinese, with the agents example only for Pro', () => {
    const t = createTranslator('zh-TW');
    expect(t('accounts.planStalePro', { cli: 'Pro' })).toBe(
      'Claude Code 仍記錄登入時的方案 Pro；在你重新登入前，凡是依方案決定的行為都會照 Pro，例如會叮嚀 Claude 除非你要求，否則不要派出子代理，動態工作流程也預設關閉。',
    );
    expect(t('accounts.planStale', { cli: 'Max' })).toBe('Claude Code 仍記錄登入時的方案 Max；在你重新登入前，凡是依方案決定的行為都會照 Max。');
    expect(t('accounts.planHint')).toContain('請在該帳號的「⋯」選單選「登入 → 訂閱帳號」');
  });

  it('notes a plan Claude Code still records other than Pro without the agents example', async () => {
    const rendered = await renderApp({ auth: { ...MOCK_AUTH, default: { ...MOCK_AUTH.default!, subscriptionType: 'max', profilePlan: { subscriptionType: 'pro' } } } });
    act(() => rendered.controller.revealCard('accounts'));
    const row = (await screen.findAllByTestId('account-row'))[0]!;
    await waitFor(() => expect(row).toHaveTextContent('· Pro'));
    expect(within(row).getByTestId('account-plan-stale')).toHaveTextContent(
      'Claude Code still records Max, the plan at sign-in; until you sign in again, it behaves as on Max wherever the plan matters.',
    );
  });
});

describe('plan badge (R4-plan)', () => {
  it('the sidebar chip and the Accounts card follow a newer plan from a live session or a usage fetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const rendered = await renderApp({ auth: { ...MOCK_AUTH, default: { ...MOCK_AUTH.default!, subscriptionType: 'pro' } } });
    const { api, controller } = rendered;
    const chip = within(sidebar()).getByRole('button', { name: /^Account:/ });
    await waitFor(() => expect(chip).toHaveTextContent('· Pro'));
    act(() => controller.revealCard('accounts'));
    const row = (): HTMLElement => screen.getAllByTestId('account-row')[0]!;
    expect(row()).toHaveTextContent('· Pro');
    expect(screen.getByText(/After an upgrade, Claude Code keeps the plan from the last sign-in\./)).toBeInTheDocument();
    expect(screen.queryByTestId('account-plan-stale')).not.toBeInTheDocument();

    vi.setSystemTime(20_000);
    const handleId = await takeOverMain(rendered);
    expect(chip).toHaveTextContent('· Pro');
    vi.setSystemTime(30_000);
    act(() => api.mock.emitEngine({ type: 'account', handleId, email: 'me@example.com', subscriptionType: 'max' }));
    expect(chip).toHaveTextContent('· Max');
    expect(row()).toHaveTextContent('· Max');

    act(() => api.mock.pushAuthStatus({ ...status('pro', 40_000), email: 'me@example.com' }));
    expect(chip).toHaveTextContent('· Max');

    act(() => api.mock.pushAuthStatus({ ...status('team', 50_000), email: 'me@example.com' }));
    expect(chip).toHaveTextContent('· Team');

    act(() => api.mock.emitEngine({ type: 'usage', usage: { ...MOCK_USAGE, profileId: 'default', subscriptionType: 'max', fetchedAt: 60_000 } }));
    expect(chip).toHaveTextContent('· Max');
    expect(row()).toHaveTextContent('· Max');
  });
});
