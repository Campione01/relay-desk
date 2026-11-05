import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeUsageObservation } from '../../src/main/native/usage';
import { createTranslator } from '../../src/renderer/i18n';
import { MOCK_USAGE, NOW } from '../../src/renderer/mock/fixtures';
import { COUNTDOWN_TICK_MS, formatCountdown, formatReset, windowLabel } from '../../src/renderer/components/prompt/UsagePopover';
import { actionAvailability } from '../../src/renderer/state/availability';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

afterEach(() => {
  vi.useRealTimers();
});

async function openReadOnly(rendered: Rendered): Promise<void> {
  await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
  await screen.findByTestId('readonly-note');
}

function ring(): HTMLElement {
  return within(screen.getByTestId('prompt-footer')).getByRole('button', { name: /^Usage · / });
}

function row(popover: HTMLElement, label: string): HTMLElement {
  return within(popover).getByRole('progressbar', { name: label }).closest<HTMLElement>('.rd-usage__row')!;
}

describe('usage popover (U1)', () => {
  it('the ring opens the popover with the mock session and weekly windows and the context row', async () => {
    const rendered = await renderApp();
    const get = vi.spyOn(rendered.api.usage, 'get');
    await takeOverMain(rendered);
    expect(ring()).toHaveAttribute('aria-expanded', 'false');
    await rendered.user.click(ring());
    const popover = await screen.findByRole('dialog', { name: 'Usage' });
    expect(ring()).toHaveAttribute('aria-expanded', 'true');
    expect(get).toHaveBeenCalledWith('default', false);
    const session = await waitFor(() => row(popover, 'Session limit'));
    expect(session).toHaveTextContent('69% used');
    expect(within(session).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '69');
    expect(session).not.toHaveAttribute('data-limit');
    const resets = rendered.controller.state.usage.default!.windows[0]!.resetsAt!;
    expect(session).toHaveTextContent(`Resets ${formatReset(resets, 'en')}`);
    const weekly = row(popover, 'Weekly');
    expect(weekly).toHaveTextContent('7% used');
    expect(within(weekly).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '7');
    const context = row(popover, 'Context');
    expect(context).toHaveTextContent('22% used');
    expect(context).toHaveTextContent('184.9k / 850k tokens');
    expect(within(screen.getByTestId('prompt-footer')).queryByRole('img', { name: 'Usage limit reached' })).not.toBeInTheDocument();
  });

  it('Esc closes the popover and returns focus to the ring', async () => {
    const rendered = await renderApp();
    await openReadOnly(rendered);
    await rendered.user.click(ring());
    const popover = await screen.findByRole('dialog', { name: 'Usage' });
    expect(popover).toHaveFocus();
    await rendered.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Usage' })).not.toBeInTheDocument();
    expect(rendered.controller.state.ui.footerMenu).toBeNull();
    expect(ring()).toHaveFocus();
    expect(ring()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a window at its limit or rejected turns its bar, the ring and the effort mark red', async () => {
    const rendered = await renderApp({
      usage: {
        available: true,
        windows: [
          { id: 'five_hour', percent: 0, resetsAt: null },
          { id: 'seven_day', percent: 100, resetsAt: Date.now() + 50 * HOUR },
          { id: 'seven_day_opus', percent: 40, resetsAt: Date.now() + 50 * HOUR, status: 'rejected' },
        ],
      },
    });
    await openReadOnly(rendered);
    // The usage fetched at start already shows the limit before the popover opens.
    expect(within(screen.getByTestId('prompt-footer')).getByRole('img', { name: 'Usage limit reached' })).toBeInTheDocument();
    await rendered.user.click(ring());
    const popover = await screen.findByRole('dialog', { name: 'Usage' });
    const session = await waitFor(() => row(popover, 'Session limit'));
    expect(session).toHaveTextContent('0% used');
    expect(session).toHaveTextContent('Starts when a message is sent');
    expect(session).not.toHaveAttribute('data-limit');
    expect(row(popover, 'Weekly')).toHaveAttribute('data-limit');
    expect(row(popover, 'Weekly · Opus')).toHaveAttribute('data-limit');
    const footer = screen.getByTestId('prompt-footer');
    expect(within(footer).getByRole('img', { name: 'Usage limit reached' })).toBeInTheDocument();
    expect(footer.querySelector('.rd-ring')).toHaveAttribute('data-limit', 'true');
    expect(ring()).toHaveAccessibleName(/Usage limit reached/);
  });

  it('shows extra usage when enabled and the not-available note for other sign-in methods', async () => {
    const rendered = await renderApp({
      usage: { ...MOCK_USAGE, extraUsage: { enabled: true, percent: 40, usedCredits: null, monthlyLimit: null, currency: null } },
    });
    await openReadOnly(rendered);
    await rendered.user.click(ring());
    let popover = await screen.findByRole('dialog', { name: 'Usage' });
    expect(await waitFor(() => row(popover, 'Extra usage'))).toHaveTextContent('40% used');
    await rendered.user.keyboard('{Escape}');
    vi.spyOn(rendered.api.usage, 'get').mockResolvedValue({ profileId: 'default', available: false, windows: [], fetchedAt: Date.now() });
    await act(async () => { await rendered.controller.refreshUsage('default', true); });
    await rendered.user.click(ring());
    popover = await screen.findByRole('dialog', { name: 'Usage' });
    expect(within(popover).getByText('Plan usage is not available for this sign-in method.')).toBeInTheDocument();
    expect(within(popover).queryByRole('progressbar', { name: 'Session limit' })).not.toBeInTheDocument();
    expect(row(popover, 'Context')).toHaveTextContent('Context usage appears once the session is open.');
  });

  it('distinguishes an unreported native reset from an SDK window that starts on send', async () => {
    const native = nativeUsageObservation({ rateLimits: [{ kind: 'five_hour', percentUsed: 35 }] }, 'default', Date.now()).planUsage!;
    const rendered = await renderApp({ usage: { ...native, windows: [
      ...native.windows, { id: 'seven_day', percent: 0, resetsAt: null },
    ] } });
    await openReadOnly(rendered);
    await rendered.user.click(ring());
    const popover = await screen.findByRole('dialog', { name: 'Usage' });
    const unknown = await waitFor(() => row(popover, 'Session limit'));
    expect(unknown).toHaveTextContent('35% used');
    expect(unknown).toHaveTextContent('Reset time unknown');
    expect(unknown).not.toHaveTextContent('Starts when a message is sent');
    expect(unknown.querySelector('.rd-usage__countdown')).toBeNull();
    const notStarted = row(popover, 'Weekly');
    expect(notStarted).toHaveTextContent('Starts when a message is sent');
    expect(notStarted).not.toHaveTextContent('Reset time unknown');
    expect(notStarted.querySelector('.rd-usage__countdown')).toBeNull();
  });

  it('a failed fetch shows the error with a forced retry, and a stale cache is fetched with force', async () => {
    const rendered = await renderApp();
    await openReadOnly(rendered);
    const get = vi.spyOn(rendered.api.usage, 'get')
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ ...MOCK_USAGE, profileId: 'default', fetchedAt: Date.now() - 2 * 60_000 });
    await rendered.user.click(ring());
    const popover = await screen.findByRole('dialog', { name: 'Usage' });
    const alert = await within(popover).findByRole('alert');
    expect(alert).toHaveTextContent('Could not get usage: probe failed');
    expect(get).toHaveBeenLastCalledWith('default', false);
    await rendered.user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(get).toHaveBeenLastCalledWith('default', true);
    await waitFor(() => expect(row(popover, 'Session limit')).toHaveTextContent('69% used'));
    await rendered.user.keyboard('{Escape}');
    await rendered.user.click(ring());
    await screen.findByRole('dialog', { name: 'Usage' });
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenLastCalledWith('default', true);
  });

  it('the usage shortcut chip shows its icon and opens the popover; the action needs no session', async () => {
    const rendered = await renderApp();
    expect(actionAvailability('ui.usagePopover', null, 'default')).toEqual({ ok: true });
    await openReadOnly(rendered);
    act(() => rendered.controller.setShortcutGroup('commands'));
    const chip = within(screen.getByTestId('shortcut-bar')).getByRole('button', { name: 'Usage panel' });
    expect(chip).not.toHaveAttribute('aria-disabled');
    expect(chip.querySelector('.lucide-chart-pie')).not.toBeNull();
    await rendered.user.click(chip);
    expect(await screen.findByRole('dialog', { name: 'Usage' })).toBeInTheDocument();
    expect(ring()).toHaveAttribute('aria-expanded', 'true');
  });

  it('labels windows and formats reset times in the UI language', () => {
    const t = createTranslator('en');
    expect(t('usage.resetUnknown')).toBe('Reset time unknown');
    expect(createTranslator('zh-TW')('usage.resetUnknown')).toBe('重置時間未知');
    expect(windowLabel('five_hour', t)).toBe('Session limit');
    expect(windowLabel('seven_day', t)).toBe('Weekly');
    expect(windowLabel('seven_day_sonnet', t)).toBe('Weekly · Sonnet');
    expect(windowLabel('seven_day_oauth_apps', t)).toBe('Weekly · OAuth apps');
    // Server-named weekly buckets keep the server's spelling (rate_limits.model_scoped).
    expect(windowLabel('model_scoped:Fable', t)).toBe('Weekly · Fable');
    expect(windowLabel('five_hour', createTranslator('zh-TW'))).toBe('工作階段上限');
    // Always the full date, even for a reset later today.
    expect(formatReset(new Date(2026, 9, 17, 22, 0).getTime(), 'en')).toBe('Sat, Oct 17, 10:00 PM');
    expect(formatReset(new Date(2026, 9, 20, 22, 0).getTime(), 'en')).toBe('Tue, Oct 20, 10:00 PM');
    expect(formatReset(new Date(2026, 10, 4, 23, 59).getTime(), 'en')).toBe('Wed, Nov 4, 11:59 PM');
    expect(formatReset(new Date(2026, 9, 20, 22, 0).getTime(), 'zh-TW')).toBe('10月20日週二 下午10:00');
  });

  it('counts down to a reset in days and hours, or hours and minutes, rounding minutes up', () => {
    const t = createTranslator('en');
    const now = new Date(2026, 9, 18, 9, 0).getTime();
    expect(formatCountdown(now + 2 * DAY + 13 * HOUR + 58 * MIN, now, t)).toBe('in 2d 13h');
    expect(formatCountdown(now + 3 * DAY, now, t)).toBe('in 3d 0h');
    expect(formatCountdown(now + DAY - 1, now, t)).toBe('in 1d 0h');
    expect(formatCountdown(now + DAY - MIN - 1, now, t)).toBe('in 23h 59m');
    expect(formatCountdown(now + 3 * HOUR + 11 * MIN + 10_000, now, t)).toBe('in 3h 12m');
    expect(formatCountdown(now + 2 * HOUR, now, t)).toBe('in 2h 0m');
    expect(formatCountdown(now + HOUR + 5 * MIN, now, t)).toBe('in 1h 5m');
    expect(formatCountdown(now + 59 * MIN, now, t)).toBe('in 59m');
    expect(formatCountdown(now + 30_000, now, t)).toBe('in 1m');
    expect(formatCountdown(now, now, t)).toBeNull();
    expect(formatCountdown(now - 5 * MIN, now, t)).toBeNull();
    const zh = createTranslator('zh-TW');
    expect(formatCountdown(now + 4 * DAY + 17 * HOUR, now, zh)).toBe('還有 4 天 17 小時');
    expect(formatCountdown(now + 3 * HOUR + 29 * MIN, now, zh)).toBe('還有 3 小時 29 分');
    expect(formatCountdown(now + 42 * MIN, now, zh)).toBe('還有 42 分鐘');
  });

  it('each reset line shows the full date with a countdown that keeps time while the popover is open', async () => {
    const rendered = await renderApp();
    await openReadOnly(rendered);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const timers = vi.getTimerCount();
    await rendered.user.click(ring());
    const popover = await screen.findByRole('dialog', { name: 'Usage' });
    expect(vi.getTimerCount()).toBe(timers + 1);
    const session = await waitFor(() => row(popover, 'Session limit'));
    const countdown = (r: HTMLElement): string | null => r.querySelector('.rd-usage__countdown')?.textContent ?? null;
    expect(session).toHaveTextContent(`Resets ${formatReset(NOW + 3 * HOUR + 29 * MIN, 'en')}`);
    expect(countdown(session)).toBe('in 3h 29m');
    expect(countdown(row(popover, 'Weekly'))).toBe('in 4d 17h');
    expect(countdown(row(popover, 'Weekly · Fable'))).toBe('in 4d 17h');
    act(() => { vi.advanceTimersByTime(COUNTDOWN_TICK_MS); });
    expect(countdown(session)).toBe('in 3h 29m');
    act(() => { vi.advanceTimersByTime(4 * COUNTDOWN_TICK_MS); });
    expect(countdown(session)).toBe('in 3h 28m');
    act(() => { vi.advanceTimersByTime(3 * HOUR + 28 * MIN); });
    // Past the reset the date stays and the countdown goes until the next fetch.
    expect(countdown(session)).toBeNull();
    expect(session).toHaveTextContent(`Resets ${formatReset(NOW + 3 * HOUR + 29 * MIN, 'en')}`);
    expect(countdown(row(popover, 'Weekly'))).toBe('in 4d 13h');
    await rendered.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Usage' })).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(timers);
  });
});

describe('permission label before the CLI reports a mode (EC-1)', () => {
  it('shows the settings default with nothing checked, then the reported mode', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const footer = screen.getByTestId('prompt-footer');
    expect(rendered.controller.currentView()?.permissionMode).toBeUndefined();
    await rendered.user.click(within(footer).getByRole('button', { name: 'Settings default' }));
    const menu = await screen.findByRole('menu', { name: 'Permission mode' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(6);
    for (const item of items) expect(item).toHaveAttribute('aria-checked', 'false');
    await rendered.user.keyboard('{Escape}');
    act(() => rendered.api.mock.emitEngine({ type: 'init', handleId, sessionId: rendered.controller.currentView()!.sessionId!, model: 'opus', permissionMode: 'plan', slashCommands: [], tools: [], cwd: 'D:\\demos\\relay-desk' }));
    expect(within(footer).getByRole('button', { name: 'Plan' })).toBeInTheDocument();
  });
});
