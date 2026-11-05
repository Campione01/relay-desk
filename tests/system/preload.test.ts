import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC, isEventMethod, type RelayApi } from '@shared/ipc';

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const exposed: Record<string, unknown> = {};
  const invoked: unknown[][] = [];
  return {
    listeners,
    exposed,
    invoked,
    electron: {
      contextBridge: { exposeInMainWorld: (key: string, value: unknown) => (exposed[key] = value) },
      webUtils: { getPathForFile: (file: { name: string }) => `C:\\dropped\\${file.name}` },
      ipcRenderer: {
        invoke: async (...args: unknown[]) => {
          invoked.push(args);
          return 'result';
        },
        on: (channel: string, fn: (event: unknown, payload: unknown) => void) => {
          if (!listeners.has(channel)) listeners.set(channel, new Set());
          listeners.get(channel)!.add(fn);
        },
        removeListener: (channel: string, fn: (event: unknown, payload: unknown) => void) => {
          listeners.get(channel)?.delete(fn);
        },
      },
    },
  };
});
vi.mock('electron', () => h.electron);

let relay: RelayApi;
beforeAll(async () => {
  await import('../../src/preload/index');
  relay = h.exposed.relay as RelayApi;
});

describe('preload', () => {
  it('exposes exactly one window.relay member per channel', () => {
    expect(Object.keys(h.exposed)).toEqual(['relay', 'relayFiles']);
    for (const [ns, methods] of Object.entries(IPC)) {
      expect(Object.keys((relay as unknown as Record<string, object>)[ns]!).sort()).toEqual(Object.keys(methods).sort());
    }
  });

  it('relayFiles only resolves the local path of a dropped file through webUtils', () => {
    const files = h.exposed.relayFiles as { pathFor(file: unknown): string };
    expect(Object.keys(files)).toEqual(['pathFor']);
    expect(files.pathFor({ name: 'notes.md' })).toBe('C:\\dropped\\notes.md');
  });

  it('invoke methods forward their arguments on their channel', async () => {
    await expect(relay.handoff.toCloud({ profileId: 'default', cwd: 'D:\\x', task: 't' })).resolves.toBe('result');
    await relay.accounts.login('work', 'sso', 'me@example.com');
    expect(h.invoked).toEqual([
      ['relay:handoff:toCloud', { profileId: 'default', cwd: 'D:\\x', task: 't' }],
      ['relay:accounts:login', 'work', 'sso', 'me@example.com'],
    ]);
  });

  it('on* methods deliver the payload only and unsubscribe their own listener', () => {
    const got: unknown[] = [];
    const off = relay.accounts.onStatus((s) => got.push(s));
    const otherOff = relay.app.onLaunchRequest(() => {});
    for (const fn of h.listeners.get('relay:accounts:onStatus') ?? []) fn({ sender: 'x' }, { profileId: 'work' });
    expect(got).toEqual([{ profileId: 'work' }]);
    off();
    expect(h.listeners.get('relay:accounts:onStatus')?.size).toBe(0);
    expect(h.listeners.get('relay:app:onLaunchRequest')?.size).toBe(1);
    otherOff();
    for (const [ns, methods] of Object.entries(IPC)) {
      for (const method of Object.keys(methods)) {
        if (isEventMethod(method)) expect(typeof (relay as unknown as Record<string, Record<string, unknown>>)[ns]![method]).toBe('function');
      }
    }
  });
});
