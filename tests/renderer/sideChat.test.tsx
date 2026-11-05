import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { actionAvailability, viewsClosedBy } from '../../src/renderer/state/availability';
import { createView, findSessionViewKey } from '../../src/renderer/state/sessionReducer';
import { renderApp, sidebar, type Rendered } from './helpers';

const SESSION = {
  sessionId: '51111111-2222-4333-8444-555555555555',
  title: 'Side chat fixture',
  cwd: 'D:\\demos\\fixture',
  lastModified: Date.UTC(2026, 9, 16),
};

const ANSWER = 'The release script signs the installer before it uploads anything to the update server.';
const ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'How does the release work?' },
  { kind: 'assistant', id: 'a1', text: ANSWER },
  { kind: 'result', id: 'r1', durationMs: 1000 },
];

async function openFixture(): Promise<Rendered> {
  const rendered = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: ITEMS } });
  await rendered.user.click(within(sidebar()).getByRole('button', { name: SESSION.title }));
  await screen.findByTestId('assistant-message');
  return rendered;
}

/** Selects the first `length` characters of the assistant answer and clicks "Start a side chat". */
async function startFromSelection({ user }: Rendered, length: number): Promise<void> {
  const text = screen.getByTestId('assistant-message').querySelector('p')!.firstChild as Text;
  act(() => {
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await user.click(within(await screen.findByTestId('selection-menu')).getByRole('button', { name: 'Start a side chat' }));
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe('side chat', () => {
  it('opens an unsaved side view with the context, the quote as draft and a strip; it is not listed', async () => {
    const rendered = await openFixture();
    const { controller } = rendered;
    const originKey = controller.state.currentKey!;
    await startFromSelection(rendered, ANSWER.length);

    const key = controller.state.currentKey!;
    expect(key).toMatch(/^side-/);
    const view = controller.view(key)!;
    expect(view).toMatchObject({
      sideChatOf: originKey,
      profileId: 'default',
      cwd: SESSION.cwd,
      sessionId: SESSION.sessionId,
      confirmed: true,
      title: `Side chat: ${ANSWER.slice(0, 40)}…`,
      engineState: 'none',
    });
    expect(view.items.map((item) => item.id)).toEqual(['u1', 'a1', 'r1']);
    expect(controller.state.drafts[key]).toBe(`> ${ANSWER}\n\n`);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(`> ${ANSWER}\n\n`);

    const strip = screen.getByTestId('sidechat-strip');
    expect(strip).toHaveTextContent('Side chat: not saved and never written to the original conversation');
    expect(within(strip).getByRole('button', { name: 'Back to conversation' })).toBeEnabled();
    expect(within(strip).getByRole('button', { name: 'Close side chat' })).toBeEnabled();
    expect(screen.queryByTestId('readonly-note')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('assistant-message')[0]).toHaveTextContent(ANSWER);
    expect(within(sidebar()).queryByRole('button', { name: /^Side chat:/ })).not.toBeInTheDocument();
    expect(within(sidebar()).getAllByRole('button', { name: /^Side chat fixture/ })).toHaveLength(1);

    // Short selections give the whole text as title; the origin stays untouched.
    await rendered.user.click(within(strip).getByRole('button', { name: 'Back to conversation' }));
    expect(controller.state.currentKey).toBe(originKey);
    expect(controller.state.drafts[originKey] ?? '').toBe('');
    await startFromSelection(rendered, 11);
    expect(controller.currentView()?.title).toBe('Side chat: The release');
  });

  it('opens a fork with persistence off on the first send, without a take-over, and never writes the origin', async () => {
    const rendered = await openFixture();
    const { api, controller, user } = rendered;
    const open = vi.spyOn(api.engine, 'open');
    const send = vi.spyOn(api.engine, 'send');
    const originKey = controller.state.currentKey!;
    await startFromSelection(rendered, 11);
    const key = controller.state.currentKey!;

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Why sign first?{Enter}');
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    expect(screen.queryByTestId('takeover-dialog')).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({
      profileId: 'default',
      cwd: SESSION.cwd,
      resumeSessionId: SESSION.sessionId,
      forkSession: true,
      ephemeral: true,
    });
    expect(send).toHaveBeenCalledWith(controller.view(key)!.handleId, '> The release\n\nWhy sign first?', undefined);
    expect(controller.view(key)!.sessionId).not.toBe(SESSION.sessionId);
    expect(controller.view(originKey)).toMatchObject({ engineState: 'none', confirmed: false });
    expect(controller.view(originKey)!.handleId).toBeUndefined();
    expect(screen.getByTestId('sidechat-strip')).toBeInTheDocument();
  });

  it('reopens by forking the original session again, never the unsaved fork id', async () => {
    const rendered = await openFixture();
    const { api, controller, user } = rendered;
    const open = vi.spyOn(api.engine, 'open');
    await startFromSelection(rendered, 11);
    const key = controller.state.currentKey!;
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First{Enter}');
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    const handleId = controller.view(key)!.handleId!;
    expect(controller.view(key)!.sessionId).not.toBe(SESSION.sessionId);

    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'closed' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Again{Enter}');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open.mock.calls[1]![0]).toMatchObject({ resumeSessionId: SESSION.sessionId, forkSession: true, ephemeral: true });
  });

  it('× closes its engine, removes the view and returns to the conversation', async () => {
    const rendered = await openFixture();
    const { api, controller, user } = rendered;
    const originKey = controller.state.currentKey!;
    await startFromSelection(rendered, 11);
    const key = controller.state.currentKey!;
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go{Enter}');
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    const handleId = controller.view(key)!.handleId!;
    const close = vi.spyOn(api.engine, 'close');

    await user.click(within(screen.getByTestId('sidechat-strip')).getByRole('button', { name: 'Close side chat' }));
    await waitFor(() => expect(controller.view(key)).toBeNull());
    expect(close).toHaveBeenCalledWith(handleId);
    expect(controller.state.currentKey).toBe(originKey);
    expect(controller.state.drafts[key]).toBeUndefined();
    expect(controller.state.navBack).not.toContain(key);
    expect(screen.queryByTestId('sidechat-strip')).not.toBeInTheDocument();
    act(() => controller.back());
    expect(controller.state.currentKey).not.toBe(key);
  });

  it('is never a writer for hand-off confirmations and offers no hand-off itself', async () => {
    const rendered = await openFixture();
    const { api, controller, user } = rendered;
    await user.click(within(screen.getByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    const originKey = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(originKey)?.engineState).toBe('idle'));

    await startFromSelection(rendered, 11);
    const key = controller.state.currentKey!;
    // Before its first send the side chat still carries the origin's session id.
    const before = controller.view(key)!;
    expect(viewsClosedBy('handoff.toDesktop', controller.view(originKey), [controller.view(originKey)!, { ...before, handleId: 'h-side', engineState: 'idle' }]).map((v) => v.key)).toEqual([originKey]);
    expect(actionAvailability('handoff.toDesktop', before, 'default')).toEqual({ ok: false, reason: 'reason.sideChat' });
    expect(actionAvailability('handoff.openInTerminal', before, 'default')).toEqual({ ok: false, reason: 'reason.sideChat' });

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go{Enter}');
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));

    // The sidebar row of the session leads to the conversation, not to its side chat.
    await user.click(within(sidebar()).getByRole('button', { name: /^Side chat fixture/ }));
    expect(controller.state.currentKey).toBe(originKey);

    const toDesktop = vi.spyOn(api.handoff, 'toDesktop');
    void controller.handBack(originKey);
    const confirm = await screen.findByRole('alertdialog', { name: 'Hand back to the desktop?' });
    expect(confirm).not.toHaveTextContent('Relay Desk sessions that will end');
    expect(confirm).not.toHaveTextContent('Side chat:');
    await user.click(within(confirm).getByRole('button', { name: 'Hand back to desktop' }));
    await waitFor(() => expect(toDesktop).toHaveBeenCalled());
    await waitFor(() => expect(controller.view(originKey)?.handedOff?.ok).toBe(true));
    expect(controller.view(key)).toMatchObject({ engineState: 'idle', handedOff: undefined });
  });

  it('never stands for its session when a listed session or a link looks for a view', () => {
    const origin = createView({ key: 's:x', profileId: 'default', cwd: 'D:\\x', title: 'x', sessionId: SESSION.sessionId });
    const side = createView({
      key: 'side-1',
      profileId: 'default',
      cwd: 'D:\\x',
      title: 'Side chat: x',
      sessionId: SESSION.sessionId,
      sideChatOf: 's:x',
      engineState: 'starting',
      opening: true,
    });
    expect(findSessionViewKey({ [origin.key]: origin, [side.key]: side }, SESSION.sessionId, 'default')).toBe('s:x');
    expect(findSessionViewKey({ [side.key]: side }, SESSION.sessionId, 'default')).toBeUndefined();
  });

  it('cannot start from a side chat or before the session exists on disk', async () => {
    const rendered = await openFixture();
    const { controller } = rendered;
    await startFromSelection(rendered, 11);
    const key = controller.state.currentKey!;
    expect(controller.sideChatBlocked(key)).toBe('selection.sideChatInside');
    expect(await controller.startSideChat(key, 'again')).toBeNull();

    await act(async () => controller.newSession('D:\\demos\\demo-app'));
    const fresh = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(fresh)?.engineState).toBe('idle'));
    expect(controller.view(fresh)?.sessionId).toBeTruthy();
    expect(controller.sideChatBlocked(fresh)).toBe('selection.sideChatNeedsSession');
    expect(await controller.startSideChat(fresh, 'text')).toBeNull();
    await act(async () => {
      await controller.send(fresh, 'hello');
    });
    await waitFor(() => expect(controller.view(fresh)?.items.some((item) => item.kind === 'result')).toBe(true));
    // A turn result is no proof of a saved transcript; the saved session list is.
    expect(controller.sideChatBlocked(fresh)).toBe('selection.sideChatNeedsSession');
    const saved = { sessionId: controller.view(fresh)!.sessionId!, title: 'hello', cwd: 'D:\\demos\\demo-app', lastModified: Date.now() };
    vi.spyOn(rendered.api.sessions, 'list').mockResolvedValue([SESSION, saved]);
    await act(async () => controller.loadSessions());
    expect(controller.sideChatBlocked(fresh)).toBeNull();
    const views = Object.keys(controller.state.views).length;
    expect(await act(async () => controller.startSideChat(fresh, 'Mock reply'))).toMatch(/^side-/);
    expect(Object.keys(controller.state.views)).toHaveLength(views + 1);
  });
});
