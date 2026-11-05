import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REMEMBERED_SESSIONS,
  SESSION_PREFS_KEY,
  mergePrefs,
  readSessionPrefs,
  sanitizePrefs,
  writeSessionPrefs,
} from '../../src/renderer/state/sessionPrefs';
import { MAIN_SESSION_ID, renderApp, takeOverMain, type Rendered } from './helpers';

function connectors(): HTMLElement {
  return screen.getByTestId('card-connectors');
}

async function openConnectors({ user }: Rendered): Promise<void> {
  const head = connectors().querySelector<HTMLButtonElement>('.rd-card__head')!;
  if (head.getAttribute('aria-expanded') !== 'true') await user.click(head);
  await within(connectors()).findAllByTestId('connector-row');
}

function blenderSwitch(): HTMLElement {
  return within(connectors()).getByRole('switch', { name: 'Use Blender in this session' });
}

describe('session prefs store', () => {
  it('keeps only well-formed choices per account and session, newest first up to the cap', () => {
    expect(
      sanitizePrefs({ model: 'sonnet', effort: 'turbo', permissionMode: 'plan', ultracode: 'yes', mcp: { Blender: false, Bad: 'off', '': true } }),
    ).toEqual({ model: 'sonnet', permissionMode: 'plan', mcp: { Blender: false } });
    expect(sanitizePrefs({ effort: 'x', mcp: [] })).toBeUndefined();
    expect(sanitizePrefs('plan')).toBeUndefined();

    writeSessionPrefs('default', 'ABC', { effort: 'max' }, 1);
    expect(readSessionPrefs('default', 'abc')).toEqual({ effort: 'max' });
    expect(readSessionPrefs('work', 'abc')).toBeUndefined();
    writeSessionPrefs('default', 'abc', {}, 2);
    expect(readSessionPrefs('default', 'abc')).toBeUndefined();

    for (let i = 0; i <= MAX_REMEMBERED_SESSIONS; i++) writeSessionPrefs('default', `s${i}`, { effort: 'low' }, 10 + i);
    expect(readSessionPrefs('default', 's0')).toBeUndefined();
    expect(readSessionPrefs('default', 's1')).toEqual({ effort: 'low' });
    expect(Object.keys(JSON.parse(window.localStorage.getItem(SESSION_PREFS_KEY)!))).toHaveLength(MAX_REMEMBERED_SESSIONS);

    window.localStorage.setItem(SESSION_PREFS_KEY, 'not json');
    expect(readSessionPrefs('default', 's1')).toBeUndefined();
    expect(mergePrefs({ model: 'a', mcp: { A: true } }, { mcp: { B: false } })).toEqual({ model: 'a', mcp: { A: true, B: false } });
    expect(mergePrefs({ mcp: { A: true } }, { effort: 'high' })).toEqual({ effort: 'high', mcp: { A: true } });
  });
});

describe('per-conversation choices', () => {
  it('remembers the model, effort, permission mode, ultracode and MCP switches of a conversation across a restart', async () => {
    const first = await renderApp({ settings: { defaultPermissionMode: 'bypassPermissions' } });
    await takeOverMain(first);
    const key = first.controller.currentView()!.key;
    await act(async () => {
      await first.controller.setModel(key, 'sonnet');
      await first.controller.setEffort(key, 'low');
      await first.controller.setPermissionMode(key, 'plan');
      await first.controller.setUltracode(key, true);
    });
    await openConnectors(first);
    await first.user.click(blenderSwitch());
    await waitFor(() => expect(blenderSwitch()).toHaveAttribute('aria-checked', 'false'));
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toEqual({
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'plan',
      ultracode: true,
      mcp: { Blender: false },
    });
    cleanup();

    // A restart: a new controller and a fresh engine, same local storage.
    const second = await renderApp({ settings: { defaultPermissionMode: 'bypassPermissions' } });
    const open = vi.spyOn(second.api.engine, 'open');
    const handleId = await takeOverMain(second);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({
      resumeSessionId: MAIN_SESSION_ID,
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'plan',
      ultracode: true,
      mcpOverrides: { Blender: false },
    });
    expect(within(screen.getByTestId('prompt-footer')).getByRole('button', { name: 'Plan' })).toBeInTheDocument();
    await openConnectors(second);
    expect(blenderSwitch()).toHaveAttribute('aria-checked', 'false');

    // Switching it back is remembered too, per server.
    const toggle = vi.spyOn(second.api.engine, 'mcpToggle');
    await second.user.click(blenderSwitch());
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(handleId, 'Blender', true));
    await waitFor(() => expect(readSessionPrefs('default', MAIN_SESSION_ID)?.mcp).toEqual({ Blender: true }));
  });

  it('a failed switch is not remembered, and an untouched conversation follows the Settings defaults', async () => {
    const rendered = await renderApp({ settings: { defaultPermissionMode: 'bypassPermissions' } });
    await takeOverMain(rendered);
    const key = rendered.controller.currentView()!.key;
    vi.spyOn(rendered.api.engine, 'setModel').mockRejectedValueOnce(new Error('model refused'));
    vi.spyOn(rendered.api.engine, 'mcpToggle').mockRejectedValueOnce(new Error('toggle refused'));
    await act(async () => {
      await rendered.controller.setModel(key, 'haiku');
    });
    await expect(rendered.controller.toggleMcp(key, 'Blender', false)).rejects.toThrow('toggle refused');
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toBeUndefined();
    expect(window.localStorage.getItem(SESSION_PREFS_KEY)).toBeNull();

    const open = vi.spyOn(rendered.api.engine, 'open');
    await act(async () => {
      await rendered.controller.newSession('D:\\codes\\fresh');
    });
    expect(open.mock.calls[0]![0]).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(open.mock.calls[0]![0]).not.toHaveProperty('mcpOverrides');
    expect(window.localStorage.getItem(SESSION_PREFS_KEY)).toBeNull();
  });

  it('a side chat starts with the original’s MCP choices and stores none of its own; a link-opened session stores its picks once it has an id', async () => {
    writeSessionPrefs('default', MAIN_SESSION_ID, { mcp: { Blender: false } }, 1);
    const rendered = await renderApp();
    const { controller } = rendered;
    await takeOverMain(rendered);
    const key = controller.currentView()!.key;
    const open = vi.spyOn(rendered.api.engine, 'open');
    const sideKey = (await act(async () => controller.startSideChat(key, 'Mock reply')))!;
    expect(sideKey).toMatch(/^side-/);
    await act(async () => {
      await controller.openEngine(sideKey, true);
    });
    expect(open.mock.calls[0]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID, forkSession: true, ephemeral: true, mcpOverrides: { Blender: false } });
    await act(async () => {
      await controller.toggleMcp(sideKey, 'Blender', true);
    });
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toEqual({ mcp: { Blender: false } });
    expect(Object.keys(JSON.parse(window.localStorage.getItem(SESSION_PREFS_KEY)!))).toHaveLength(1);

    await act(async () => {
      await controller.newSession('D:\\codes\\linked', 'default', { launch: { cwd: 'D:\\codes\\linked' } });
    });
    const linked = controller.state.currentKey!;
    await act(async () => {
      await controller.setEffort(linked, 'max');
    });
    expect(Object.keys(JSON.parse(window.localStorage.getItem(SESSION_PREFS_KEY)!))).toHaveLength(1);
    await act(async () => {
      await controller.openEngine(linked, false);
    });
    const sessionId = controller.view(linked)!.sessionId!;
    expect(readSessionPrefs('default', sessionId)).toEqual({ effort: 'max' });
  });
});
