import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoContinueState } from '@shared/types';
import { formatResetTime } from '../../src/renderer/components/flows/AutoContinueNote';
import { formatReset } from '../../src/renderer/components/prompt/UsagePopover';
import { applyEngineEvent, createView } from '../../src/renderer/state/sessionReducer';
import { renderApp, takeOverMain, type Rendered } from './helpers';

const NOON = new Date(2026, 9, 20, 12, 0).getTime();
const TODAY_1530 = new Date(2026, 9, 20, 15, 30).getTime();
const TOMORROW_0905 = new Date(2026, 9, 21, 9, 5).getTime();

const waiting = (attempt: number, resetsAt = TODAY_1530): AutoContinueState => ({
  phase: 'waiting',
  resetsAt,
  fireAt: resetsAt + 60_000,
  attempt,
});

async function openSettings({ controller }: Rendered): Promise<HTMLSelectElement> {
  act(() => controller.openSettings(true));
  const dialog = await screen.findByTestId('settings-dialog');
  return within(dialog).getByRole('combobox', { name: 'Continue automatically at usage limit' }) as HTMLSelectElement;
}

const note = (): HTMLElement | null => screen.queryByTestId('auto-continue-note');

describe('autoContinue in the session reducer', () => {
  const open = createView({ key: 'k', profileId: 'default', cwd: 'D:\\work', title: 't', handleId: 'h1', engineState: 'idle' });

  it('stores a wait or a missed reset and clears it on idle', () => {
    const state = waiting(2);
    const view = applyEngineEvent(open, { type: 'autoContinue', handleId: 'h1', state }, NOON);
    expect(view.autoContinue).toEqual(state);
    const stale = applyEngineEvent(view, { type: 'autoContinue', handleId: 'h1', state: { phase: 'stale', resetsAt: TODAY_1530 } }, NOON);
    expect(stale.autoContinue).toEqual({ phase: 'stale', resetsAt: TODAY_1530 });
    const idle = applyEngineEvent(stale, { type: 'autoContinue', handleId: 'h1', state: { phase: 'idle' } }, NOON);
    expect(idle.autoContinue).toBeUndefined();
    // Idle on a view without a wait changes nothing.
    expect(applyEngineEvent(open, { type: 'autoContinue', handleId: 'h1', state: { phase: 'idle' } }, NOON)).toBe(open);
  });

  it('clears the wait when the handle closes and ignores a late one afterwards', () => {
    const view = applyEngineEvent(open, { type: 'autoContinue', handleId: 'h1', state: waiting(1) }, NOON);
    const closed = applyEngineEvent(view, { type: 'state', handleId: 'h1', state: 'closed' }, NOON);
    expect(closed.engineState).toBe('closed');
    expect(closed.autoContinue).toBeUndefined();
    expect(applyEngineEvent(closed, { type: 'autoContinue', handleId: 'h1', state: waiting(1) }, NOON).autoContinue).toBeUndefined();
  });
});

describe('reset time of the note', () => {
  it('shows the time alone today and adds the date on another day, in the app language', () => {
    expect(formatResetTime(TODAY_1530, 'en', NOON)).toBe('3:30 PM');
    expect(formatResetTime(TODAY_1530, 'zh-TW', NOON)).toBe('下午3:30');
    expect(formatResetTime(TOMORROW_0905, 'en', NOON)).toBe('Wed, Oct 21, 9:05 AM');
    expect(formatResetTime(TOMORROW_0905, 'en', NOON)).toBe(formatReset(TOMORROW_0905, 'en'));
  });
});

describe('waiting note above the composer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves native wait text without a fabricated schedule and offers Continue only on the native stale affordance', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const native: AutoContinueState = { phase: 'native-waiting', message: 'Continuing automatically when it resets', canContinue: false, schedule: 'unreported' };
    act(() => rendered.api.mock.emitEngine({ type: 'autoContinue', handleId, state: native }));
    const shown = await screen.findByTestId('auto-continue-note');
    expect(shown).toHaveTextContent('Native CLI: Continuing automatically when it resets');
    expect(shown).not.toHaveTextContent('of 3');
    expect(within(shown).queryByRole('button', { name: 'Continue the task now' })).not.toBeInTheDocument();
    expect(within(shown).getByRole('button', { name: 'Cancel automatic continue' })).toBeEnabled();
    const resume = vi.spyOn(rendered.api.engine, 'continueAfterLimit');
    act(() => rendered.api.mock.emitEngine({ type: 'autoContinue', handleId,
      state: { ...native, message: 'Your usage limit has reset \u00b7 Press enter to continue', canContinue: true } }));
    await rendered.user.click(within(shown).getByRole('button', { name: 'Continue the task now' }));
    expect(resume).toHaveBeenCalledWith(handleId);
    await waitFor(() => expect(note()).toBeNull());
  });

  it('says when the task continues, adds the run count only after the first continue, and cancels the wait', async () => {
    const rendered = await renderApp();
    const { api, user } = rendered;
    const handleId = await takeOverMain(rendered);
    expect(note()).toBeNull();

    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(1) }));
    const shown = await screen.findByTestId('auto-continue-note');
    expect(shown).toHaveAttribute('role', 'status');
    expect(shown.querySelector('p')).toHaveTextContent(/^Usage limit reached · continues automatically after the reset at 3:30 PM$/);
    expect(note()).not.toHaveTextContent('of 3');

    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(2) }));
    expect(note()).toHaveTextContent('Usage limit reached · continues automatically after the reset at 3:30 PM (automatic continue 2 of 3)');

    const cancel = vi.spyOn(api.engine, 'cancelAutoContinue');
    const button = within(note()!).getByRole('button', { name: 'Cancel automatic continue' });
    expect(button).toHaveTextContent('Cancel');
    await user.click(button);
    expect(cancel).toHaveBeenCalledWith(handleId);
    await waitFor(() => expect(note()).toBeNull());
  });

  it('shows when the prompt goes out for a continue armed after its reset passed', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const state: AutoContinueState = { phase: 'waiting', resetsAt: NOON - 60_000, fireAt: NOON + 4 * 60_000, attempt: 2 };
    act(() => rendered.api.mock.emitEngine({ type: 'autoContinue', handleId, state }));
    expect(await screen.findByTestId('auto-continue-note')).toHaveTextContent('after the reset at 12:04 PM (automatic continue 2 of 3)');
  });

  it('adds the date when the reset is not today', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => rendered.api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(1, TOMORROW_0905) }));
    expect(await screen.findByTestId('auto-continue-note')).toHaveTextContent('after the reset at Wed, Oct 21, 9:05 AM');
  });

  it('offers Continue and Dismiss after a reset the computer slept through', async () => {
    const rendered = await renderApp();
    const { api, user } = rendered;
    const handleId = await takeOverMain(rendered);
    const resume = vi.spyOn(api.engine, 'continueAfterLimit');
    const cancel = vi.spyOn(api.engine, 'cancelAutoContinue');
    const stale: AutoContinueState = { phase: 'stale', resetsAt: TODAY_1530 };

    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: stale }));
    const shown = await screen.findByTestId('auto-continue-note');
    expect(shown).toHaveTextContent('The usage limit reset at 3:30 PM while the computer was asleep, so the task did not continue');
    await user.click(within(shown).getByRole('button', { name: 'Continue the task now' }));
    expect(resume).toHaveBeenCalledWith(handleId);
    expect(cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(note()).toBeNull());

    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: stale }));
    await user.click(within(await screen.findByTestId('auto-continue-note')).getByRole('button', { name: 'Dismiss' }));
    expect(cancel).toHaveBeenCalledWith(handleId);
    expect(resume).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(note()).toBeNull());
  });

  it('keeps the note and says why when Continue fails', async () => {
    const rendered = await renderApp();
    const { api, user } = rendered;
    const handleId = await takeOverMain(rendered);
    vi.spyOn(api.engine, 'continueAfterLimit').mockRejectedValueOnce(new Error('Nothing is waiting'));
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: { phase: 'stale', resetsAt: TODAY_1530 } }));
    await user.click(within(await screen.findByTestId('auto-continue-note')).getByRole('button', { name: 'Continue the task now' }));
    expect(await screen.findByText('Nothing is waiting')).toBeInTheDocument();
    expect(note()).not.toBeNull();
  });

  it('speaks Taiwan Mandarin with the local time', async () => {
    const rendered = await renderApp({ settings: { language: 'zh-TW' } });
    const { api, controller } = rendered;
    await act(async () => {
      await controller.newSession('D:\\work\\fresh');
    });
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const handleId = controller.currentView()!.handleId!;
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(3) }));
    const shown = await screen.findByTestId('auto-continue-note');
    expect(shown).toHaveTextContent('已達用量上限，額度在 下午3:30 重置後自動接續（連續第 3/3 次）');
    expect(within(shown).getByRole('button', { name: '取消自動接續' })).toHaveTextContent('取消');
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: { phase: 'stale', resetsAt: TODAY_1530 } }));
    expect(shown).toHaveTextContent('額度已在 下午3:30 重置，但當時電腦在睡眠，所以沒有自動接續');
    expect(within(shown).getByRole('button', { name: '現在繼續這項工作' })).toHaveTextContent('繼續');
    expect(within(shown).getByRole('button', { name: '略過' })).toBeInTheDocument();
  });

  it('clears its own wait after a call that succeeded, but not a newer one, and blocks repeated clicks meanwhile', async () => {
    const rendered = await renderApp();
    const { api, user } = rendered;
    const handleId = await takeOverMain(rendered);
    let finish!: () => void;
    // Main answers without an idle event here: the note still goes.
    vi.spyOn(api.engine, 'cancelAutoContinue').mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(1) }));
    const button = within(await screen.findByTestId('auto-continue-note')).getByRole('button', { name: 'Cancel automatic continue' });
    await user.click(button);
    expect(button).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(note()).toBeNull());

    // A wait that started while the call ran is not the one it ended.
    const resume = vi.spyOn(api.engine, 'continueAfterLimit').mockImplementationOnce(async () => {
      api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(2) });
    });
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: { phase: 'stale', resetsAt: TODAY_1530 } }));
    await user.click(within(await screen.findByTestId('auto-continue-note')).getByRole('button', { name: 'Continue the task now' }));
    expect(resume).toHaveBeenCalledWith(handleId);
    await waitFor(() => expect(note()).toHaveAttribute('data-phase', 'waiting'));
    expect(note()).toHaveTextContent('(automatic continue 2 of 3)');
    expect(within(note()!).getByRole('button', { name: 'Cancel automatic continue' })).toBeEnabled();
  });

  it('shows nothing for an idle state', async () => {
    const rendered = await renderApp();
    const { controller } = rendered;
    await takeOverMain(rendered);
    const key = controller.state.currentKey!;
    act(() =>
      controller.store.set((state) => ({
        ...state,
        views: { ...state.views, [key]: { ...state.views[key]!, autoContinue: { phase: 'idle' } } },
      })),
    );
    expect(controller.currentView()?.autoContinue).toEqual({ phase: 'idle' });
    expect(note()).toBeNull();
  });

  it('goes away when the session closes', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const handleId = await takeOverMain(rendered);
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(1) }));
    await screen.findByTestId('auto-continue-note');
    await act(async () => controller.closeSession(controller.state.currentKey!));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('closed'));
    expect(note()).toBeNull();
  });
});

describe('Continue automatically at usage limit setting (desktop parity)', () => {
  it('is on by default, saves a change and applies it to open sessions at once', async () => {
    const rendered = await renderApp();
    const { api, controller, user } = rendered;
    const save = vi.spyOn(api.app, 'setSettings');
    const live = vi.spyOn(api.engine, 'setAutoContinue');
    const open = vi.spyOn(api.engine, 'open');
    const handleId = await takeOverMain(rendered);
    expect(open.mock.calls[0]![0]).not.toHaveProperty('autoContinue');

    const select = await openSettings(rendered);
    expect(select.value).toBe('on');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['On', 'Off']);
    expect(screen.getByTestId('settings-dialog')).toHaveTextContent(
      'A task stopped by a usage limit continues on its own once the limit resets. There is no wait for a weekly limit or a reset more than 24 hours away; at most 3 times in a row, and a message you send starts the count again.',
    );

    // Saying "on" while it is on by default changes nothing for the open sessions.
    await act(async () => controller.updateSettings({ autoContinue: true }));
    expect(live).not.toHaveBeenCalled();

    await user.selectOptions(select, 'off');
    await waitFor(() => expect(live).toHaveBeenCalledWith(handleId, false));
    expect(save).toHaveBeenLastCalledWith({ autoContinue: false });
    expect(controller.state.settings.autoContinue).toBe(false);
    expect(select.value).toBe('off');
    expect(live).toHaveBeenCalledTimes(1);

    await act(async () => controller.updateSettings({ autoContinue: false }));
    expect(live).toHaveBeenCalledTimes(1);

    await user.selectOptions(select, 'on');
    await waitFor(() => expect(live).toHaveBeenLastCalledWith(handleId, true));
    expect(save).toHaveBeenLastCalledWith({ autoContinue: true });

    await user.selectOptions(select, 'off');
    await waitFor(() => expect(live).toHaveBeenLastCalledWith(handleId, false));
    act(() => controller.openSettings(false));
    await act(async () => {
      await controller.newSession('D:\\work\\fresh');
    });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open.mock.calls[1]![0]).toMatchObject({ autoContinue: false });
  });

  it('keeps a side chat from continuing on its own, at open and when the choice changes', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const mainHandle = await takeOverMain(rendered);
    const key = controller.currentView()!.key;
    const open = vi.spyOn(api.engine, 'open');
    const live = vi.spyOn(api.engine, 'setAutoContinue');
    const sideKey = (await act(async () => controller.startSideChat(key, 'Mock reply')))!;
    await act(async () => {
      await controller.openEngine(sideKey, true);
    });
    expect(open.mock.calls[0]![0]).toMatchObject({ ephemeral: true, autoContinue: false });
    expect(controller.state.views[sideKey]?.handleId).toBeDefined();
    expect(live).not.toHaveBeenCalled();
    await act(async () => controller.updateSettings({ autoContinue: false }));
    await act(async () => controller.updateSettings({ autoContinue: true }));
    expect(live.mock.calls).toEqual([
      [mainHandle, false],
      [mainHandle, true],
    ]);
  });

  it('ends a wait when it is turned off', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const handleId = await takeOverMain(rendered);
    act(() => api.mock.emitEngine({ type: 'autoContinue', handleId, state: waiting(1) }));
    await screen.findByTestId('auto-continue-note');
    await act(async () => controller.updateSettings({ autoContinue: false }));
    await waitFor(() => expect(note()).toBeNull());
  });

  it('opens with autoContinue false only when the saved setting is off', async () => {
    const off = await renderApp({ settings: { autoContinue: false, activeProfileId: 'default' } });
    const openOff = vi.spyOn(off.api.engine, 'open');
    const liveOff = vi.spyOn(off.api.engine, 'setAutoContinue');
    await takeOverMain(off);
    expect(openOff.mock.calls[0]![0]).toMatchObject({ autoContinue: false });
    expect(liveOff).not.toHaveBeenCalled();
    expect((await openSettings(off)).value).toBe('off');
  });

  it('sends nothing extra when the saved setting is on', async () => {
    const on = await renderApp({ settings: { autoContinue: true, activeProfileId: 'default' } });
    const openOn = vi.spyOn(on.api.engine, 'open');
    const liveOn = vi.spyOn(on.api.engine, 'setAutoContinue');
    await takeOverMain(on);
    expect(openOn.mock.calls[0]![0]).not.toHaveProperty('autoContinue');
    expect(liveOn).not.toHaveBeenCalled();
  });

  it('brings a session that was still opening when the choice changed up to date', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const open = api.engine.open.bind(api.engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const opens = vi.spyOn(api.engine, 'open').mockImplementationOnce(async (request) => {
      await gate;
      return open(request);
    });
    const live = vi.spyOn(api.engine, 'setAutoContinue');
    let opened!: Promise<void>;
    act(() => {
      opened = controller.newSession('D:\\work\\fresh');
    });
    await act(async () => controller.updateSettings({ autoContinue: false }));
    expect(live).not.toHaveBeenCalled();
    release();
    await act(async () => {
      await opened;
    });
    expect(opens.mock.calls[0]![0]).not.toHaveProperty('autoContinue');
    expect(live).toHaveBeenCalledWith(controller.currentView()!.handleId, false);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('does not sync an unsaved choice into a session that finishes opening while the save fails', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const open = api.engine.open.bind(api.engine);
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
    vi.spyOn(api.engine, 'open').mockImplementationOnce(async (request) => {
      await openGate;
      return open(request);
    });
    let opened!: Promise<void>;
    act(() => {
      opened = controller.newSession('D:\\work\\fresh');
    });
    // Let the folder's own save finish first, so nothing but this save is pending.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    let failSave!: (error: Error) => void;
    vi.spyOn(api.app, 'setSettings').mockImplementationOnce(() => new Promise((_resolve, reject) => (failSave = reject)));
    const live = vi.spyOn(api.engine, 'setAutoContinue');
    let saving!: Promise<void>;
    act(() => {
      saving = controller.updateSettings({ autoContinue: false });
    });
    expect(controller.state.settings.autoContinue).toBe(false);
    releaseOpen();
    await act(async () => {
      await opened;
    });
    expect(controller.currentView()?.handleId).toBeTruthy();
    expect(live).not.toHaveBeenCalled();
    failSave(new Error('disk full'));
    await act(async () => {
      await saving;
    });
    expect(controller.state.settings.autoContinue).toBeUndefined();
    expect(live).not.toHaveBeenCalled();
  });

  it('keeps the saved choice and says so when an open session refuses it', async () => {
    const rendered = await renderApp();
    const { api, controller, user } = rendered;
    await takeOverMain(rendered);
    vi.spyOn(api.engine, 'setAutoContinue').mockRejectedValueOnce(new Error('The session refused the setting'));
    await user.selectOptions(await openSettings(rendered), 'off');
    expect(await screen.findByText('The session refused the setting')).toBeInTheDocument();
    expect(controller.state.settings.autoContinue).toBe(false);
  });

  it('touches no session when saving the choice fails', async () => {
    const rendered = await renderApp();
    const { api, controller, user } = rendered;
    await takeOverMain(rendered);
    vi.spyOn(api.app, 'setSettings').mockRejectedValueOnce(new Error('disk full'));
    const live = vi.spyOn(api.engine, 'setAutoContinue');
    const select = await openSettings(rendered);
    await user.selectOptions(select, 'off');
    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(controller.state.settings.autoContinue).toBeUndefined();
    expect(select.value).toBe('on');
    expect(live).not.toHaveBeenCalled();
  });
});
