import { describe, expect, it } from 'vitest';
import { ALL_CHANNELS, IPC, createRelayApi, isEventMethod, registerHandlers, sendEvent } from '@shared/ipc';
import { scrubEnv } from '../../src/main/system/env';

describe('env scrub (R3)', () => {
  it('removes host auth and Claude variables, case-insensitively, and keeps the rest', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      ANTHROPIC_API_KEY: 'x',
      ANTHROPIC_AUTH_TOKEN: 'x',
      ANTHROPIC_BASE_URL: 'x',
      ANTHROPIC_MODEL: 'kept',
      CLAUDECODE: '1',
      CLAUDE_PID: '1',
      CLAUDE_CONFIG_DIR: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'x',
      claude_code_oauth_token: 'x',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'x',
      CLAUDE_EFFORT: 'kept',
    };
    const result = scrubEnv(env);
    expect(result).toBe(env);
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_MODEL', 'CLAUDE_EFFORT', 'PATH', 'USERPROFILE']);
  });
});

describe('ipc channel table', () => {
  it('names every channel relay:<namespace>:<method> and never reuses one', () => {
    for (const [ns, methods] of Object.entries(IPC)) {
      for (const [method, channel] of Object.entries(methods)) {
        expect(channel).toBe(`relay:${ns}:${method}`);
      }
    }
    expect(new Set(ALL_CHANNELS).size).toBe(ALL_CHANNELS.length);
    expect(ALL_CHANNELS.filter((c) => isEventMethod(c.split(':')[2] ?? '')).sort()).toEqual([
      'relay:accounts:onStatus',
      'relay:app:onLaunchRequest',
      'relay:engine:onEvent',
    ]);
  });

  it('createRelayApi invokes and subscribes on the matching channels', async () => {
    const invoked: Array<[string, unknown[]]> = [];
    const subscribed: string[] = [];
    let push: ((payload: unknown) => void) | undefined;
    const api = createRelayApi({
      invoke: async (channel, ...args) => {
        invoked.push([channel, args]);
        return 'ok';
      },
      on: (channel, listener) => {
        subscribed.push(channel);
        push = listener;
        return () => {
          push = undefined;
        };
      },
    });

    await expect(api.engine.send('h1', 'hello', { queue: true })).resolves.toBe('ok');
    expect(invoked).toEqual([['relay:engine:send', ['h1', 'hello', { queue: true }]]]);

    const received: unknown[] = [];
    const off = api.engine.onEvent((e) => received.push(e));
    expect(subscribed).toEqual(['relay:engine:onEvent']);
    push?.({ type: 'state', handleId: 'h1', state: 'idle' });
    off();
    expect(push).toBeUndefined();
    expect(received).toEqual([{ type: 'state', handleId: 'h1', state: 'idle' }]);
  });

  it('registerHandlers and sendEvent use the same table on the main side', () => {
    const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerHandlers({ handle: (channel, listener) => handled.set(channel, listener) }, 'shortcuts', {
      get: () => [],
      set: (list) => list,
      reset: () => [],
    });
    expect([...handled.keys()]).toEqual(['relay:shortcuts:get', 'relay:shortcuts:set', 'relay:shortcuts:reset']);
    expect(handled.get('relay:shortcuts:set')?.({}, [])).toEqual([]);

    const sent: unknown[][] = [];
    sendEvent({ send: (...args) => sent.push(args) }, 'accounts', 'onStatus', {
      profileId: 'default',
      loggedIn: false,
      authMethod: 'none',
      checkedAt: 1,
    });
    expect(sent).toEqual([
      ['relay:accounts:onStatus', { profileId: 'default', loggedIn: false, authMethod: 'none', checkedAt: 1 }],
    ]);
  });
});
