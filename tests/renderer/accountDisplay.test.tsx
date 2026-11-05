import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '../../src/renderer/i18n';
import { createMockApi } from '../../src/renderer/mock/api';
import { MOCK_AUTH, MOCK_USAGE } from '../../src/renderer/mock/fixtures';
import { ACCOUNT_LABELS_KEY, loadAccountLabels } from '../../src/renderer/state/accountLabel';
import { AppController } from '../../src/renderer/state/controller';
import { renderApp, sidebar, takeOverMain } from './helpers';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ANCHOR = MOCK_USAGE.windows.find((w) => w.id === 'seven_day')!.resetsAt!;
const DESKTOP_AUTH = { ...MOCK_AUTH, default: { ...MOCK_AUTH.default!, email: 'desktop@example.com' } };
const DRIFT_TEXT =
  'The shared account name changed to desktop@example.com (written by another Claude Code app, e.g. the desktop). ' +
  'Usage shows the same account as before: me@example.com.';

function remember(email: string, weeklyAnchor: number): void {
  window.localStorage.setItem(ACCOUNT_LABELS_KEY, JSON.stringify({ default: { email, weeklyAnchor, seenAt: 1 } }));
}

function chip(): HTMLElement {
  return within(sidebar()).getByRole('button', { name: 'Account: Personal account' });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

afterEach(() => {
  delete (document as { visibilityState?: string }).visibilityState;
  vi.useRealTimers();
});

describe('compact account display', () => {
  it('the chip, the account menu and the environment card show the profile name and plan, never the label email', async () => {
    const rendered = await renderApp();
    await waitFor(() => expect(chip()).toHaveTextContent('Personal account· Max'));
    expect(chip()).not.toHaveTextContent('example.com');
    expect(within(chip()).queryByTestId('account-drift-dot')).not.toBeInTheDocument();
    await rendered.user.click(chip());
    const menu = await screen.findByRole('menu', { name: 'Accounts' });
    expect(within(menu).getByRole('menuitemradio', { name: /Personal account/ })).toHaveTextContent(/^Personal accountMax$/);
    expect(within(menu).getByRole('menuitemradio', { name: /Work account/ })).toHaveTextContent('Not logged in');
    expect(menu).not.toHaveTextContent('example.com');
    await rendered.user.keyboard('{Escape}');

    await takeOverMain(rendered);
    expect(rendered.controller.currentView()?.account?.email).toBe('me@example.com');
    const environment = screen.getByTestId('card-environment');
    expect(environment).toHaveTextContent('Personal accountMax');
    expect(environment).not.toHaveTextContent('example.com');
  });

  it('the Accounts card shows the label email on its own captioned line, only for a logged-in account', async () => {
    const { controller } = await renderApp();
    act(() => controller.revealCard('accounts'));
    const rows = await screen.findAllByTestId('account-row');
    await waitFor(() => expect(within(rows[0]!).getByTestId('account-label')).toHaveTextContent('me@example.com'));
    expect(rows[0]).toHaveTextContent('Personal account · MaxLogged inName in the shared Claude Code settings (other apps can change it)me@example.com');
    expect(within(rows[1]!).queryByTestId('account-label')).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Not logged in');
    expect(rows[1]).not.toHaveTextContent('shared Claude Code settings');
  });
});

describe('account label drift', () => {
  it('a changed label with the same weekly reset keeps the remembered email and shows the note and the chip dot', async () => {
    remember('me@example.com', ANCHOR - WEEK);
    const { api, controller } = await renderApp({ auth: DESKTOP_AUTH });
    const dot = await waitFor(() => within(chip()).getByTestId('account-drift-dot'));
    expect(dot).toHaveAccessibleName(DRIFT_TEXT);
    expect(chip()).toHaveAttribute('data-tip', DRIFT_TEXT);
    expect(chip()).toHaveTextContent('Personal account· Max');
    act(() => controller.revealCard('accounts'));
    const row = (await screen.findAllByTestId('account-row'))[0]!;
    expect(within(row).getByTestId('account-drift')).toHaveTextContent(DRIFT_TEXT);
    expect(within(row).getByTestId('account-label')).toHaveTextContent('desktop@example.com');
    expect(screen.getByTestId('card-accounts')).not.toHaveTextContent(/log in again|sign in again/i);
    expect(loadAccountLabels().default).toEqual({ email: 'me@example.com', weeklyAnchor: ANCHOR - WEEK, seenAt: 1 });

    // A failed usage fetch has no weekly reset: the note stays instead of flickering away.
    vi.spyOn(api.usage, 'get').mockRejectedValueOnce(new Error('probe failed'));
    await act(async () => { await controller.refreshUsage('default', true); });
    expect(controller.state.usage.default?.error).toBe('probe failed');
    expect(within(row).getByTestId('account-drift')).toHaveTextContent(DRIFT_TEXT);
    expect(within(chip()).getByTestId('account-drift-dot')).toBeInTheDocument();
  });

  it('a drifted label keeps the plan Claude Code reports instead of the shared profile\'s plan', async () => {
    remember('me@example.com', ANCHOR - WEEK);
    const upgraded = { ...MOCK_AUTH, default: { ...DESKTOP_AUTH.default!, subscriptionType: 'pro', profilePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } } };
    // A newer default-Max usage sample would legitimately supersede Pro; keep this label-drift fixture consistent.
    const rendered = await renderApp({ auth: upgraded, usage: { ...MOCK_USAGE, subscriptionType: 'pro' } });
    await waitFor(() => expect(within(chip()).getByTestId('account-drift-dot')).toBeInTheDocument());
    expect(chip()).toHaveTextContent('Personal account· Pro');
    act(() => rendered.controller.revealCard('accounts'));
    const row = (await screen.findAllByTestId('account-row'))[0]!;
    expect(row).toHaveTextContent('Personal account · Pro');
    expect(within(row).queryByTestId('account-plan-stale')).not.toBeInTheDocument();
    await takeOverMain(rendered);
    expect(screen.getByTestId('card-environment')).toHaveTextContent('Personal accountPro');
  });

  it('a changed label that usage cannot decide yet is marked undecided and keeps the reported plan', async () => {
    remember('me@example.com', ANCHOR);
    const upgraded = { ...MOCK_AUTH, default: { ...DESKTOP_AUTH.default!, subscriptionType: 'pro', profilePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } } };
    const { controller } = await renderApp({ auth: upgraded }, (api) => {
      vi.spyOn(api.usage, 'get').mockRejectedValue(new Error('probe failed'));
    });
    await waitFor(() => expect(controller.state.labels.default).toEqual({ email: 'desktop@example.com', undecided: true }));
    expect(chip()).toHaveTextContent('Personal account· Pro');
    expect(within(chip()).queryByTestId('account-drift-dot')).not.toBeInTheDocument();
  });

  it('the caption and the drift note read naturally in Traditional Chinese', () => {
    const t = createTranslator('zh-TW');
    expect(t('accounts.labelCaption')).toBe('Claude Code 共用設定中的帳號名稱（其他程式可能改寫）');
    expect(t('accounts.labelDrift', { label: 'desktop@example.com', remembered: 'me@example.com' })).toBe(
      '共用的帳號名稱被改成 desktop@example.com（其他 Claude Code 程式寫入，例如 desktop）。用量顯示仍是同一個帳號：me@example.com。',
    );
  });

  it('a live session reporting another label is checked too', async () => {
    remember('me@example.com', ANCHOR);
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    expect(within(chip()).queryByTestId('account-drift-dot')).not.toBeInTheDocument();
    act(() => rendered.api.mock.emitEngine({ type: 'account', handleId, email: 'desktop@example.com', subscriptionType: 'max' }));
    expect(within(chip()).getByTestId('account-drift-dot')).toHaveAccessibleName(DRIFT_TEXT);
    expect(rendered.controller.state.labels.default).toEqual({
      email: 'desktop@example.com',
      drift: { label: 'desktop@example.com', remembered: 'me@example.com' },
    });
  });

  it('a different weekly reset is a real account change: the record is replaced and nothing is shown', async () => {
    remember('me@example.com', ANCHOR + 3 * DAY);
    const { controller } = await renderApp({ auth: DESKTOP_AUTH });
    await waitFor(() => expect(loadAccountLabels().default?.email).toBe('desktop@example.com'));
    expect(loadAccountLabels().default?.weeklyAnchor).toBe(ANCHOR);
    act(() => controller.revealCard('accounts'));
    const row = (await screen.findAllByTestId('account-row'))[0]!;
    expect(within(row).queryByTestId('account-drift')).not.toBeInTheDocument();
    expect(within(chip()).queryByTestId('account-drift-dot')).not.toBeInTheDocument();
  });

  it('without a weekly reset nothing is decided and the remembered email is kept', async () => {
    remember('me@example.com', ANCHOR);
    const usage = { ...MOCK_USAGE, windows: [{ id: 'five_hour', percent: 1, resetsAt: ANCHOR - DAY }, { id: 'seven_day', percent: 0, resetsAt: null }] };
    const { controller } = await renderApp({ auth: DESKTOP_AUTH, usage });
    await waitFor(() => expect(controller.state.usage.default).toBeDefined());
    await waitFor(() => expect(controller.state.labels.default?.email).toBe('desktop@example.com'));
    expect(controller.state.labels.default?.drift).toBeUndefined();
    expect(within(chip()).queryByTestId('account-drift-dot')).not.toBeInTheDocument();
    expect(loadAccountLabels().default?.email).toBe('me@example.com');
  });

  it('usage that arrives after the label decides then', async () => {
    remember('me@example.com', ANCHOR);
    const { controller } = await renderApp({ auth: DESKTOP_AUTH }, (api) => {
      vi.spyOn(api.usage, 'get').mockRejectedValueOnce(new Error('offline'));
    });
    await waitFor(() => expect(controller.state.usage.default?.error).toBe('offline'));
    await waitFor(() => expect(controller.state.labels.default?.email).toBe('desktop@example.com'));
    expect(within(chip()).queryByTestId('account-drift-dot')).not.toBeInTheDocument();
    await act(async () => { await controller.refreshUsage('default', false); });
    expect(within(chip()).getByTestId('account-drift-dot')).toHaveAccessibleName(DRIFT_TEXT);
  });
});

describe('usage refresh for the label check', () => {
  it('fetches the active account usage at start and every 10 minutes while visible, with main\'s cache', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = createMockApi({ settings: { language: 'en' } });
    window.relay = api;
    const get = vi.spyOn(api.usage, 'get');
    const controller = new AppController(api);
    const stop = controller.start();
    for (let i = 0; i < 200 && !(controller.state.sessionsState === 'loaded' && controller.state.usage.default && Object.keys(controller.state.auth).length === 2); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(get.mock.calls).toEqual([['default', false]]);
    get.mockClear();
    vi.advanceTimersByTime(9 * 60_000);
    expect(get).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(get.mock.calls).toEqual([['default', false]]);
    setVisibility('hidden');
    vi.advanceTimersByTime(10 * 60_000);
    expect(get).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await controller.setActiveProfile('profile-work'); });
    vi.advanceTimersByTime(10 * 60_000);
    expect(get).toHaveBeenCalledTimes(1);
    stop();
    await act(async () => { await controller.setActiveProfile('default'); });
    vi.advanceTimersByTime(30 * 60_000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
