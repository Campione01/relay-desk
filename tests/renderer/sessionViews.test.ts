import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryPage, TranscriptItem } from '@shared/types';
import { createMockApi, type MockApiOptions, type MockRelayApi } from '../../src/renderer/mock/api';
import { MAIN_SESSION_ID, MOCK_HISTORY } from '../../src/renderer/mock/fixtures';
import { AppController } from '../../src/renderer/state/controller';
import { createView, mergeHistory } from '../../src/renderer/state/sessionReducer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function boot(options: MockApiOptions = {}): Promise<{ api: MockRelayApi; controller: AppController }> {
  const api = createMockApi({ ...options, settings: { language: 'en', ...options.settings } });
  window.relay = api;
  const controller = new AppController(api);
  controller.start();
  await waitFor(() => expect(controller.state.sessionsState).toBe('loaded'));
  return { api, controller };
}

/** Starts a Relay session in a folder and waits until its engine is idle. */
async function liveNewSession(controller: AppController, cwd = 'D:\\demos\\demo-app', profileId = 'default'): Promise<string> {
  await controller.newSession(cwd, profileId);
  const key = controller.state.currentKey!;
  await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
  return key;
}

async function confirmWhenAsked(controller: AppController): Promise<void> {
  await waitFor(() => expect(controller.state.takeover).not.toBeNull());
  controller.confirmTakeover();
}

describe('one view per session (RQ-1)', () => {
  it('the listed entry of Relay’s own new session opens its live view instead of a read-only copy', async () => {
    const { api, controller } = await boot();
    const liveKey = await liveNewSession(controller);
    const live = controller.view(liveKey)!;
    const summary = { sessionId: live.sessionId!, title: 'mine', cwd: live.cwd, lastModified: Date.now() };
    vi.spyOn(api.sessions, 'list').mockResolvedValue([summary]);
    await controller.loadSessions();
    controller.showHome();
    controller.openSummary({ ...summary, sessionId: summary.sessionId.toUpperCase() });
    expect(controller.state.currentKey).toBe(liveKey);
    expect(Object.keys(controller.state.views)).toEqual([liveKey]);
    const send = vi.spyOn(api.engine, 'send');
    expect(await controller.send(liveKey, 'still mine')).toBe(true);
    expect(controller.state.takeover).toBeNull();
    expect(send).toHaveBeenCalledWith(live.handleId, 'still mine', undefined);
  });

  it('a writer returned for another view is shown there, never re-pointed, and the draft moves with it', async () => {
    const { api, controller } = await boot();
    const liveKey = await liveNewSession(controller);
    const live = controller.view(liveKey)!;
    const copyKey = 'copy';
    controller.store.set((state) => ({
      ...state,
      views: { ...state.views, [copyKey]: createView({ key: copyKey, profileId: 'default', sessionId: live.sessionId, cwd: live.cwd, title: 'copy', confirmed: true }) },
    }));
    controller.navigate(copyKey);
    controller.setDraft(copyKey, 'half-typed');
    const open = vi.spyOn(api.engine, 'open');
    expect(await controller.takeOver(copyKey)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(controller.state.currentKey).toBe(liveKey);
    expect(controller.state.handleToKey[live.handleId!]).toBe(liveKey);
    expect(controller.view(copyKey)).toMatchObject({ engineState: 'none', opening: false });
    expect(controller.view(copyKey)?.handleId).toBeUndefined();
    expect(controller.view(liveKey)?.handleId).toBe(live.handleId);
    expect(controller.state.drafts[liveKey]).toBe('half-typed');
  });
});

describe('history refresh (RQ-2)', () => {
  it('reopening a handed-back session reloads its history without duplicating Relay’s own turn', async () => {
    const { api, controller } = await boot();
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    controller.openSummary(summary);
    const key = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(key)?.history).toBe('loaded'));
    const took = controller.takeOver(key);
    await confirmWhenAsked(controller);
    expect(await took).toBe(true);
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    await controller.send(key, 'relay turn');
    await waitFor(() => expect(controller.view(key)?.items.some((i) => i.kind === 'result')).toBe(true));
    const handBack = controller.handBack(key);
    await waitFor(() => expect(controller.state.confirm).not.toBeNull());
    controller.resolveConfirm(true);
    await handBack;
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('closed'));

    // The transcript on disk now holds Relay's turn under history ids and a turn added in the desktop.
    const disk: TranscriptItem[] = [
      ...MOCK_HISTORY[MAIN_SESSION_ID]!,
      { kind: 'user', id: 'disk-u1', text: 'relay turn' },
      { kind: 'assistant', id: 'disk-a1:0', text: 'Mock reply to: relay turn' },
      { kind: 'user', id: 'disk-u2', text: 'typed in the desktop' },
    ];
    const history = vi.spyOn(api.sessions, 'history').mockResolvedValue({ items: disk });
    controller.showHome();
    controller.openSummary(summary);
    expect(controller.state.currentKey).toBe(key);
    await waitFor(() => expect(controller.view(key)?.history).toBe('loaded'));
    expect(history).toHaveBeenCalledTimes(1);
    expect(controller.view(key)!.items.map((i) => i.id)).toEqual(disk.map((i) => i.id));
  });

  it('only the newest history request of a view applies', async () => {
    const { api, controller } = await boot();
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    const older = deferred<HistoryPage>();
    const newer = deferred<HistoryPage>();
    const failing = deferred<HistoryPage>();
    const newest = deferred<HistoryPage>();
    vi.spyOn(api.sessions, 'history')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
      .mockReturnValueOnce(failing.promise)
      .mockReturnValueOnce(newest.promise);
    controller.openSummary(summary);
    const key = controller.state.currentKey!;
    const second = controller.loadHistory(key);
    newer.resolve({ items: [{ kind: 'user', id: 'new', text: 'new' }] });
    await second;
    older.resolve({ items: [{ kind: 'user', id: 'old', text: 'old' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.view(key)!.items.map((i) => i.id)).toEqual(['new']);

    const third = controller.loadHistory(key);
    const fourth = controller.loadHistory(key);
    newest.resolve({ items: [{ kind: 'user', id: 'newest', text: 'newest' }] });
    await fourth;
    failing.reject(new Error('late failure'));
    await third;
    expect(controller.view(key)!.items.map((i) => i.id)).toEqual(['newest']);
    expect(controller.view(key)!.errors).toEqual([]);
    expect(controller.view(key)!.history).toBe('loaded');
  });

  it('take-over reloads the history before resuming, and a failed reload does not block it', async () => {
    const { api, controller } = await boot();
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    controller.openSummary(summary);
    const key = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(key)?.history).toBe('loaded'));
    const history = vi.spyOn(api.sessions, 'history').mockRejectedValueOnce(new Error('worker exited'));
    const open = vi.spyOn(api.engine, 'open');
    const took = controller.takeOver(key);
    await confirmWhenAsked(controller);
    expect(await took).toBe(true);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
    expect(controller.view(key)!.errors).toEqual([expect.objectContaining({ message: 'worker exited', retry: { kind: 'history' } })]);
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
  });

  it('a send that resumes a session reloads first, then sends', async () => {
    const { api, controller } = await boot();
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    controller.openSummary(summary);
    const key = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(key)?.history).toBe('loaded'));
    const history = vi.spyOn(api.sessions, 'history');
    const open = vi.spyOn(api.engine, 'open');
    const sent = controller.send(key, 'go on');
    await confirmWhenAsked(controller);
    expect(await sent).toBe(true);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
  });
});

describe('permission mode (EC-1)', () => {
  it('a mode the CLI reported is shown but never sent back on the next open', async () => {
    const { api, controller } = await boot();
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    controller.openSummary(summary);
    const key = controller.state.currentKey!;
    const open = vi.spyOn(api.engine, 'open');
    const took = controller.takeOver(key);
    await confirmWhenAsked(controller);
    await took;
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    expect(controller.view(key)?.permissionMode).toBeUndefined();
    const handleId = controller.view(key)!.handleId!;
    api.mock.emitEngine({ type: 'init', handleId, sessionId: MAIN_SESSION_ID, model: 'opus', permissionMode: 'plan', slashCommands: [], tools: [], cwd: summary.cwd });
    expect(controller.view(key)?.permissionMode).toBe('plan');
    await controller.closeSession(key);
    await controller.openEngine(key, true);
    expect(open).toHaveBeenCalledTimes(2);
    for (const [request] of open.mock.calls) expect(request).not.toHaveProperty('permissionMode');
  });

  it('only the user’s choice is sent: the picker, or the settings default for a new session', async () => {
    const { api, controller } = await boot({ settings: { defaultPermissionMode: 'acceptEdits' } });
    const open = vi.spyOn(api.engine, 'open');
    const key = await liveNewSession(controller);
    expect(open.mock.calls[0]![0]).toMatchObject({ permissionMode: 'acceptEdits' });

    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    controller.openSummary(summary);
    const listed = controller.state.currentKey!;
    expect(listed).not.toBe(key);
    await controller.setPermissionMode(listed, 'plan');
    const took = controller.takeOver(listed);
    await confirmWhenAsked(controller);
    await took;
    expect(open.mock.calls[1]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID, permissionMode: 'plan' });
  });
});

describe('mergeHistory', () => {
  it('replaces items shown when the request started, keeps later ones and trims stale echoes', () => {
    const view = {
      ...createView({ key: 'k', profileId: 'default', cwd: 'D:\\x', title: 't' }),
      items: [
        { kind: 'assistant', id: 'msg_01:0', text: 'A' },
        { kind: 'user', id: 'local-user-1', text: 'echo' },
        { kind: 'result', id: 'r1' },
        { kind: 'assistant', id: 'later', text: 'arrived while loading' },
      ] satisfies TranscriptItem[],
      localEchoes: ['local-user-1'],
    };
    const merged = mergeHistory(view, [{ kind: 'assistant', id: 'e1:0', text: 'A' }], new Set(['msg_01:0', 'local-user-1', 'r1']));
    expect(merged.items.map((i) => i.id)).toEqual(['e1:0', 'later']);
    expect(merged.localEchoes).toEqual([]);
  });
});

describe('hand-offs close writers of every view (RQ-3)', () => {
  it('continue latest from a read-only view confirms, naming the live sessions of the account in that folder', async () => {
    const { api, controller } = await boot();
    const sameFolder = await liveNewSession(controller, 'd:\\DEMOS\\demo-app\\');
    const otherFolder = await liveNewSession(controller, 'D:\\demos\\other');
    const otherAccount = await liveNewSession(controller, 'D:\\demos\\demo-app', 'profile-work');
    const summary = controller.state.sessions.find((s) => s.title === 'Fix flaky test')!;
    controller.openSummary(summary);
    const readOnly = controller.state.currentKey!;
    const sameHandle = controller.view(sameFolder)!.handleId!;
    api.mock.emitEngine({ type: 'state', handleId: sameHandle, state: 'running' });
    const terminal = vi.spyOn(api.handoff, 'openInTerminal');
    const action = controller.runAction('handoff.continueLatestInTerminal', readOnly);
    await waitFor(() => expect(controller.state.confirm).not.toBeNull());
    expect(terminal).not.toHaveBeenCalled();
    const body = controller.state.confirm!.body;
    expect(body).toContain('Relay Desk sessions that will end:\n• New session');
    expect(body.match(/• /g)).toHaveLength(2);
    expect(body).toContain('Still running; these turns will be interrupted:\n• New session');
    controller.resolveConfirm(true);
    await action;
    expect(terminal).toHaveBeenCalledWith({ profileId: 'default', cwd: summary.cwd, continueLatest: true });
    expect(controller.view(sameFolder)?.handedOff?.ok).toBe(true);
    await waitFor(() => expect(controller.view(sameFolder)?.engineState).toBe('closed'));
    expect(controller.view(otherFolder)).toMatchObject({ engineState: 'idle' });
    expect(controller.view(otherFolder)?.handedOff).toBeUndefined();
    expect(controller.view(otherAccount)).toMatchObject({ engineState: 'idle' });
    expect(controller.view(otherAccount)?.handedOff).toBeUndefined();
    expect(controller.view(readOnly)?.handedOff).toBeUndefined();
  });

  it('hand back from a second view of a live session confirms and marks the live view handed off', async () => {
    const { api, controller } = await boot();
    const liveKey = await liveNewSession(controller);
    const live = controller.view(liveKey)!;
    controller.store.set((state) => ({
      ...state,
      views: { ...state.views, copy: createView({ key: 'copy', profileId: 'default', sessionId: live.sessionId, cwd: live.cwd, title: 'copy' }) },
    }));
    const toDesktop = vi.spyOn(api.handoff, 'toDesktop');
    const action = controller.runAction('handoff.toDesktop', 'copy');
    await waitFor(() => expect(controller.state.confirm).not.toBeNull());
    expect(controller.state.confirm!.body).toContain('• New session');
    expect(toDesktop).not.toHaveBeenCalled();
    controller.resolveConfirm(true);
    await action;
    expect(toDesktop).toHaveBeenCalledWith({ profileId: 'default', sessionId: live.sessionId, cwd: live.cwd });
    expect(controller.view(liveKey)?.handedOff?.ok).toBe(true);
    await waitFor(() => expect(controller.view(liveKey)?.handleId).toBeUndefined());
  });
});
