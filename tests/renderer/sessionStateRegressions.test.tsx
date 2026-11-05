import { act, cleanup, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readSessionPrefs, sanitizePrefs } from '../../src/renderer/state/sessionPrefs';
import { MAIN_SESSION_ID, renderApp, takeOverMain } from './helpers';

describe('fast mode and background-task state', () => {
  it('keeps fast mode per conversation: sent to the live session, reported back, remembered and sent on the next open', async () => {
    expect(sanitizePrefs({ fastMode: true })).toEqual({ fastMode: true });
    expect(sanitizePrefs({ fastMode: 'yes' })).toBeUndefined();

    const first = await renderApp();
    const handleId = await takeOverMain(first);
    const key = first.controller.currentView()!.key;
    expect(first.controller.currentView()?.fast).toEqual({ state: 'off', reason: 'sdk_opt_in_required' });
    const setFast = vi.spyOn(first.api.engine, 'setFastMode');
    await act(async () => {
      await first.controller.setFastMode(key, true);
    });
    expect(setFast).toHaveBeenCalledWith(handleId, true);
    await waitFor(() => expect(first.controller.currentView()?.fast).toEqual({ state: 'on' }));
    expect(first.controller.currentView()?.fastMode).toBe(true);
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toEqual({ fastMode: true });
    cleanup();

    const second = await renderApp({ fastBlockedReason: 'extra_usage_disabled' });
    const open = vi.spyOn(second.api.engine, 'open');
    await takeOverMain(second);
    expect(open.mock.calls[0]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID, fastMode: true });
    await waitFor(() => expect(second.controller.currentView()?.fast).toEqual({ state: 'off', reason: 'extra_usage_disabled' }));

    // A side chat starts with the same choice.
    const side = await act(async () => second.controller.startSideChat(second.controller.currentView()!.key, 'look at this'));
    expect(second.controller.state.views[side as string]?.fastMode).toBe(true);
  });

  it('reverts and does not remember a refused fast mode switch', async () => {
    const rendered = await renderApp();
    await takeOverMain(rendered);
    const key = rendered.controller.currentView()!.key;
    vi.spyOn(rendered.api.engine, 'setFastMode').mockRejectedValueOnce(new Error('fast refused'));
    await act(async () => {
      await rendered.controller.setFastMode(key, true);
    });
    expect(rendered.controller.currentView()?.fastMode).toBeUndefined();
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toBeUndefined();
    expect(rendered.controller.state.toasts.at(-1)?.text).toContain('fast refused');
  });

  it('sends an explicit remembered Fast off choice on cold resume rather than inheriting native Fast on', async () => {
    const first = await renderApp();
    await takeOverMain(first);
    const key = first.controller.currentView()!.key;
    await act(async () => { await first.controller.setFastMode(key, true); await first.controller.setFastMode(key, false); });
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toEqual({ fastMode: false });
    cleanup();
    const second = await renderApp();
    const open = vi.spyOn(second.api.engine, 'open');
    await takeOverMain(second);
    expect(open.mock.calls[0]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID, fastMode: false });
  });

  it('stops a task and reads its output only on a live view, and opens the pane with the detached list', async () => {
    const rendered = await renderApp();
    const stop = vi.spyOn(rendered.api.engine, 'stopTask');
    const output = vi.spyOn(rendered.api.engine, 'taskOutput');
    const background = vi.spyOn(rendered.api.handoff, 'backgroundAgents');
    act(() => rendered.controller.toggleTasksPane(true));
    expect(rendered.controller.state.ui.tasksPane).toBe(true);
    await waitFor(() => expect(background).toHaveBeenCalledTimes(1));
    act(() => rendered.controller.toggleTasksPane());
    expect(rendered.controller.state.ui.tasksPane).toBe(false);

    const handleId = await takeOverMain(rendered);
    const key = rendered.controller.currentView()!.key;
    await act(async () => {
      await rendered.controller.stopTask(key, 'b1');
    });
    expect(stop).toHaveBeenCalledWith(handleId, 'b1');
    expect(await rendered.controller.taskOutput(key, 'b1')).toContain('VITE ready');
    expect(await rendered.controller.subagentTranscript(key, 'a1')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'assistant' })]));
    expect(await rendered.controller.taskOutput('no-such-view', 'b1')).toBeNull();
    expect(output).toHaveBeenCalledTimes(1);

    vi.spyOn(rendered.api.app, 'revealFile').mockRejectedValueOnce(new Error('The file no longer exists.'));
    await act(async () => {
      await rendered.controller.revealFile('D:\\gone.py');
    });
    expect(rendered.controller.state.toasts.at(-1)?.text).toContain('no longer exists');
  });
});
