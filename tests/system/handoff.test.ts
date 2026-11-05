import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle, Profile } from '@shared/types';
import type { HandoffDeps } from '../../src/main/system/handoff';
import type { RunOptions, RunResult } from '../../src/main/system/run';
import type { TerminalHandle, TerminalLaunch, TerminalOpenOptions } from '../../src/main/system/terminal';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:\\dev' } }));

const {
  agentsListArgs,
  attachArgs,
  cloudArgs,
  createHandoffService,
  DESKTOP_TIMEOUT_MS,
  desktopOpenArgs,
  desktopResumeArgs,
  parseBackgroundAgents,
  remoteControlArgs,
  teleportArgs,
  terminalResumeArgs,
} = await import('../../src/main/system/handoff');

const SID = '7f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c01';
const OTHER_SID = '3b8e5d10-6a2f-4e7c-8d94-71c0a5f2e3b2';
const BIN = 'D:\\dev\\claude.exe';
const CWD = 'D:\\demos\\demo';
const HOME = 'C:\\Users\\me';
const PROFILES: Record<string, Profile> = {
  default: { id: 'default', name: 'Default', configDir: null, createdAt: 0 },
  work: { id: 'work', name: 'Work', configDir: 'D:\\profiles\\work', createdAt: 1 },
};
const envOf = (p: Profile): NodeJS.ProcessEnv => ({ PATH: 'p', ...(p.configDir ? { CLAUDE_CONFIG_DIR: p.configDir } : {}) });

describe('argv builders', () => {
  it('desktop', () => {
    expect(desktopResumeArgs(SID)).toEqual(['--desktop', '--resume', SID]);
    expect(desktopOpenArgs()).toEqual(['--desktop']);
    expect(() => desktopResumeArgs('--evil')).toThrow();
  });

  it('terminal resume / fork / continue / new', () => {
    expect(terminalResumeArgs({ sessionId: SID })).toEqual(['--resume', SID]);
    expect(terminalResumeArgs({ sessionId: SID, fork: true })).toEqual(['--resume', SID, '--fork-session']);
    expect(terminalResumeArgs({ continueLatest: true })).toEqual(['--continue']);
    expect(terminalResumeArgs({ continueLatest: true, sessionId: SID })).toEqual(['--continue']);
    expect(terminalResumeArgs({ continueLatest: true, fork: true })).toEqual(['--continue', '--fork-session']);
    expect(terminalResumeArgs({})).toEqual([]);
    expect(() => terminalResumeArgs({ sessionId: 'abc & calc' })).toThrow();
  });

  it('cloud keeps the task as one argument, flag-like tasks use --cloud=', () => {
    expect(cloudArgs('  fix the "login" bug & ship\r\nthen test  ')).toEqual([
      '--cloud',
      'fix the "login" bug & ship\nthen test',
    ]);
    expect(cloudArgs('--dangerously-skip-permissions')).toEqual(['--cloud=--dangerously-skip-permissions']);
    expect(cloudArgs('a\u0000b\u0007c')).toEqual(['--cloud', 'abc']);
    expect(() => cloudArgs('   ')).toThrow();
    expect(() => cloudArgs('x'.repeat(6001))).toThrow('The task is too long (at most 6000 characters).');
  });

  it('teleport, remote control, agents, attach', () => {
    expect(teleportArgs()).toEqual(['--teleport']);
    expect(teleportArgs('session_01AbC-x')).toEqual(['--teleport', 'session_01AbC-x']);
    expect(() => teleportArgs('-x')).toThrow();
    expect(() => teleportArgs('a b')).toThrow();
    expect(remoteControlArgs()).toEqual(['--remote-control']);
    expect(remoteControlArgs(SID)).toEqual(['--remote-control', '--resume', SID]);
    expect(agentsListArgs()).toEqual(['agents', '--json']);
    expect(attachArgs('a1b2c3')).toEqual(['attach', 'a1b2c3']);
    expect(() => attachArgs('--all')).toThrow();
    expect(() => attachArgs('x & y')).toThrow();
  });
});

describe('parseBackgroundAgents', () => {
  it('reads known fields defensively and skips junk', () => {
    const stdout = JSON.stringify([
      { id: 'a1', kind: 'background', sessionId: SID, name: 'Refactor', cwd: 'D:\\r', state: 'running', status: 'busy', startedAt: 1_700_000_000_000 },
      { id: 'b2', kind: 'background', title: 'Tests', startedAt: 1_700_000_000 },
      { id: 'c3', kind: 'background', session_id: OTHER_SID, label: 'x\u0007y' },
      { name: 'no id' },
      null,
      'text',
      { id: { nested: true } },
    ]);
    expect(parseBackgroundAgents(stdout)).toEqual([
      {
        id: 'a1',
        sessionId: SID,
        name: 'Refactor',
        cwd: 'D:\\r',
        state: 'running',
        status: 'busy',
        startedAt: new Date(1_700_000_000_000).toISOString(),
      },
      { id: 'b2', name: 'Tests', startedAt: new Date(1_700_000_000_000).toISOString() },
      { id: 'c3', sessionId: OTHER_SID, name: 'x y' },
    ]);
  });

  it('accepts a wrapped list and returns [] for anything unreadable', () => {
    for (const key of ['sessions', 'agents', 'items']) {
      expect(parseBackgroundAgents(JSON.stringify({ [key]: [{ id: 'z', kind: 'background' }] }))).toEqual([{ id: 'z' }]);
    }
    expect(parseBackgroundAgents('[]')).toEqual([]);
    expect(parseBackgroundAgents('not json')).toEqual([]);
    expect(parseBackgroundAgents('{"x":1}')).toEqual([]);
  });

  it('only exposes real attach ids of background rows, never interactive sessions or fallback ids', () => {
    expect(parseBackgroundAgents(JSON.stringify([
      { kind: 'background', id: 'real-id', sessionId: SID },
      { kind: 'interactive', id: 'interactive-id', sessionId: SID },
      { id: 'missing-kind' },
      { kind: 'background', shortId: 'short-id' },
      { kind: 'background', short_id: 'short-id' },
      { kind: 'background', sessionId: SID },
      { kind: 'background', session_id: SID },
      { kind: 'background', id: '--help' },
      { kind: 'background', id: 'x & calc' },
      { kind: 'background', id: 123 },
    ]))).toEqual([{ id: 'real-id', sessionId: SID }]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options: {
  runResult?: Partial<RunResult>;
  writer?: EngineHandle;
  writers?: EngineHandle[];
  closeFails?: boolean;
  closeWait?: Promise<void>;
  terminalExit?: Promise<number | null> | null;
  terminalFails?: boolean;
  profiles?: Record<string, Profile>;
  prepareCodeContext?: HandoffDeps['prepareCodeContext'];
} = {}) {
  const log: string[] = [];
  const runs: Array<{ file: string; args: readonly string[]; options: RunOptions }> = [];
  const terminals: TerminalLaunch[] = [];
  const terminalOptions: Array<TerminalOpenOptions | undefined> = [];
  const cwdLookups: Array<{ cwd: string; profileId: string }> = [];
  const service = createHandoffService({
    engine: {
      close: async (handleId) => {
        log.push(`close:${handleId}`);
        if (options.closeFails) throw new Error('busy');
        await options.closeWait;
      },
      findBySession: (sessionId, profileId) => (options.writer && options.writer.sessionId === sessionId
        && (profileId === undefined || options.writer.profileId === profileId) ? options.writer : undefined),
      findByCwd: (cwd, profileId) => {
        cwdLookups.push({ cwd, profileId });
        return (options.writers ?? (options.writer ? [options.writer] : []))
          .filter((writer) => writer.cwd === cwd && writer.profileId === profileId);
      },
    },
    getProfile: async (id) => {
      const profile = (options.profiles ?? PROFILES)[id];
      if (!profile) throw new Error('unknown');
      return profile;
    },
    runner: async (file, args, opts) => {
      log.push(`run:${args.join(' ')}`);
      runs.push({ file, args, options: opts });
      return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, ...options.runResult };
    },
    openTerminal: async (launch, opts): Promise<TerminalHandle> => {
      log.push(`terminal:${launch.args.join(' ')}`);
      terminals.push(launch);
      terminalOptions.push(opts);
      if (options.terminalFails) throw new Error('no console');
      return { exited: options.terminalExit === undefined ? Promise.resolve(0) : options.terminalExit };
    },
    resolveBinary: () => BIN,
    buildEnv: envOf,
    prepareCodeContext: options.prepareCodeContext,
    homeDir: () => HOME,
  });
  return { service, log, runs, terminals, terminalOptions, cwdLookups };
}

const writer = (handleId: string, sessionId = SID, profileId = 'default'): EngineHandle => ({ handleId, sessionId, profileId, cwd: CWD });

describe('shared context on project handoff', () => {
  it('prepares the selected profile and passes only shared permission/memory settings to project launch commands', async () => {
    const settings = Object.freeze({
      permissions: Object.freeze({ deny: ['Read(secret)'], allow: ['Read(shared/**)'] }),
      autoMemoryDirectory: 'D:\\shared memory', autoMemoryEnabled: false,
      env: { ANTHROPIC_AUTH_TOKEN: 'must-not-copy', CLAUDE_CONFIG_DIR: 'D:\\wrong-account' },
      hooks: { SessionStart: ['must-not-run'] }, mcpServers: { secret: {} }, arbitrary: 'must-not-pass',
    });
    const prepareCodeContext = vi.fn(async () => ({ settings }));
    const h = harness({ prepareCodeContext });
    await h.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: SID, fork: true });
    await h.service.toCloud({ profileId: 'work', cwd: CWD, task: '--synthetic-task' });
    await h.service.teleport({ profileId: 'work', cwd: CWD, cloudSessionId: 'synthetic_cloud' });
    await h.service.remoteControl({ profileId: 'work', cwd: CWD, sessionId: SID });
    expect(prepareCodeContext.mock.calls).toEqual(Array.from({ length: 4 }, () => [PROFILES.work, CWD]));
    expect(h.terminals.map((launch) => launch.args.slice(2))).toEqual([
      ['--resume', SID, '--fork-session'], ['--cloud=--synthetic-task'], ['--teleport', 'synthetic_cloud'],
      ['--remote-control', '--resume', SID],
    ]);
    for (const launch of h.terminals) {
      expect(launch.args[0]).toBe('--settings');
      expect(JSON.parse(launch.args[1]!)).toEqual({
        permissions: { deny: ['Read(secret)'], allow: ['Read(shared/**)'] },
        autoMemoryDirectory: 'D:\\shared memory', autoMemoryEnabled: false,
      });
      expect(launch.env).toEqual(envOf(PROFILES.work!));
      expect(launch.args.join(' ')).not.toMatch(/must-not|wrong-account|hooks|mcpServers|arbitrary/);
    }
    expect(h.runs).toHaveLength(0);
    expect(settings.env.CLAUDE_CONFIG_DIR).toBe('D:\\wrong-account');
  });

  it('does not prepare Default, sharing-disabled accounts, Desktop or projectless background operations', async () => {
    const prepareCodeContext = vi.fn(async () => ({ settings: { autoMemoryEnabled: true } }));
    const h = harness({
      prepareCodeContext, profiles: { ...PROFILES, private: { ...PROFILES.work!, id: 'private', sharedCodeContext: false } },
    });
    for (const profileId of ['default', 'private']) {
      await h.service.openInTerminal({ profileId, cwd: CWD });
      await h.service.toCloud({ profileId, cwd: CWD, task: 'synthetic task' });
      await h.service.teleport({ profileId, cwd: CWD });
      await h.service.remoteControl({ profileId, cwd: CWD });
    }
    await h.service.openFolderInDesktop({ profileId: 'default', cwd: CWD });
    await h.service.backgroundAgents('work');
    await h.service.attachBackground({ profileId: 'work', id: 'synthetic_job' });
    expect(prepareCodeContext).not.toHaveBeenCalled();
    expect(h.terminals.every((launch) => !launch.args.includes('--settings'))).toBe(true);
  });

  it('keeps original argv when preparation returns no shared settings', async () => {
    for (const result of [{}, { settings: {} }]) {
      const h = harness({ prepareCodeContext: async () => result });
      await h.service.openInTerminal({ profileId: 'work', cwd: CWD, continueLatest: true });
      expect(h.terminals[0]?.args).toEqual(['--continue']);
    }
  });

  it('validates profile, folder and command input before any shared-context preparation or writer shutdown', async () => {
    const prepareCodeContext = vi.fn(async () => ({ settings: {} }));
    const h = harness({ prepareCodeContext, writer: writer('live', SID, 'work') });
    const results = [
      await h.service.openInTerminal({ profileId: 'missing', cwd: CWD, sessionId: SID }),
      await h.service.openInTerminal({ profileId: 'work', cwd: '\\\\server\\share', sessionId: SID }),
      await h.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: 'invalid' }),
      await h.service.toCloud({ profileId: 'work', cwd: CWD, task: '' }),
      await h.service.teleport({ profileId: 'work', cwd: CWD, cloudSessionId: '--invalid' }),
      await h.service.remoteControl({ profileId: 'work', cwd: CWD, sessionId: 'invalid' }),
    ];
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(prepareCodeContext).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });

  it('awaits shared preparation before closing a writer and leaves it open when preparation fails', async () => {
    const ready = deferred<{ settings: { autoMemoryDirectory: string } }>();
    const prepareCodeContext = vi.fn(() => ready.promise);
    const h = harness({ prepareCodeContext, writer: writer('live', SID, 'work') });
    const pending = h.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: SID });
    await vi.waitFor(() => expect(prepareCodeContext).toHaveBeenCalledOnce());
    expect(h.log).toEqual([]);
    ready.resolve({ settings: { autoMemoryDirectory: 'D:\\shared memory' } });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(h.log[0]).toBe('close:live');
    expect(h.log[1]).toMatch(/^terminal:--settings /);

    const failed = harness({
      writer: writer('still-live', SID, 'work'),
      prepareCodeContext: async () => { throw new Error('Shared context could not be prepared.'); },
    });
    await expect(failed.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: SID })).resolves.toMatchObject({ ok: false });
    await expect(failed.service.remoteControl({ profileId: 'work', cwd: CWD, sessionId: SID })).resolves.toMatchObject({ ok: false });
    expect(failed.log).toEqual([]);
  });

  it('uses the stored profile rather than profile fields supplied with a handoff request', async () => {
    const prepareCodeContext = vi.fn(async () => ({ settings: {} }));
    const h = harness({ prepareCodeContext });
    await h.service.openInTerminal({
      profileId: 'work', cwd: CWD, configDir: 'D:\\unrelated-profile', sharedCodeContext: true,
    } as Parameters<typeof h.service.openInTerminal>[0]);
    expect(prepareCodeContext).toHaveBeenCalledExactlyOnceWith(PROFILES.work, CWD);
    expect(h.terminals[0]?.env).toEqual(envOf(PROFILES.work!));
  });
});

describe('handoff service', () => {
  it('toDesktop closes the Relay handles first, then opens an observable TTY with the default env', async () => {
    const h = harness({ writer: writer('h-writer') });
    const result = await h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD, handleId: 'h-mine' });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(h.log).toEqual(['close:h-mine', 'close:h-writer', `terminal:--desktop --resume ${SID}`]);
    expect(h.terminals[0]).toEqual({
      exe: BIN,
      args: ['--desktop', '--resume', SID],
      env: { PATH: 'p' },
      cwd: CWD,
      title: 'Relay Desk',
    });
    expect(h.terminalOptions).toEqual([{ waitForExit: true, keepOpenOnError: true }]);
    expect(h.runs).toEqual([]);
  });

  it('toDesktop waits for writer shutdown and for the console program exit, not just terminal launch', async () => {
    const close = deferred<void>();
    const exit = deferred<number | null>();
    const h = harness({ writer: writer('h-writer'), closeWait: close.promise, terminalExit: exit.promise });
    let settled = false;
    const pending = h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD })
      .then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(h.log).toEqual(['close:h-writer']));
    expect(h.terminals).toEqual([]);
    close.resolve();
    await vi.waitFor(() => expect(h.terminals).toHaveLength(1));
    expect(settled).toBe(false);
    exit.resolve(0);
    await expect(pending).resolves.toMatchObject({ ok: true, exitCode: 0 });
  });

  it('toDesktop refuses non-default profiles before closing anything', async () => {
    const h = harness({ writer: writer('h-writer') });
    const result = await h.service.toDesktop({ profileId: 'work', sessionId: SID, cwd: CWD, handleId: 'h-mine' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Only the default account');
    expect(h.log).toEqual([]);
  });

  it('toDesktop does not run the desktop command when closing fails, or for invalid input', async () => {
    const h = harness({ writer: writer('h-writer'), closeFails: true });
    expect((await h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD })).ok).toBe(false);
    expect(h.log).toEqual(['close:h-writer']);
    const bad = harness();
    expect((await bad.service.toDesktop({ profileId: 'default', sessionId: 'x', cwd: CWD })).ok).toBe(false);
    expect((await bad.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: '\\\\srv\\s' })).ok).toBe(false);
    expect(bad.log).toEqual([]);
  });

  it('toDesktop reports a failing desktop command with its exit code', async () => {
    const h = harness({ terminalExit: Promise.resolve(2) });
    await expect(h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD })).resolves.toMatchObject({
      ok: false,
      exitCode: 2,
      message: expect.stringMatching(/default account.*Claude subscription/),
    });
  });

  it('a failed hand-back keeps the console open and gives a neutral message that points to the console reason', async () => {
    const h = harness({ terminalExit: Promise.resolve(1) });
    const result = await h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD });
    expect(h.terminalOptions).toEqual([{ waitForExit: true, keepOpenOnError: true }]);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.message).toContain('The exact reason is shown in the terminal window that just opened');
    expect(result.message).toContain('open elsewhere');
    const terminal = harness();
    await terminal.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: SID });
    expect(terminal.terminalOptions).toEqual([undefined]);
  });

  it('toDesktop times out rather than reporting a still-running console as successful', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ terminalExit: new Promise(() => {}) });
      let settled = false;
      const pending = h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD })
        .then((result) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(DESKTOP_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(await pending).not.toHaveProperty('exitCode');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('toDesktop fails closed when the terminal cannot report the program exit', async () => {
    const h = harness({ terminalExit: null });
    await expect(h.service.toDesktop({ profileId: 'default', sessionId: SID, cwd: CWD })).resolves.toMatchObject({ ok: false });
  });

  it('clears the desktop deadline after a fast exit or a launch failure', async () => {
    vi.useFakeTimers();
    try {
      const success = harness();
      await expect(success.service.openFolderInDesktop({ profileId: 'default', cwd: CWD })).resolves.toMatchObject({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
      const failure = harness({ terminalFails: true });
      await expect(failure.service.openFolderInDesktop({ profileId: 'default', cwd: CWD })).resolves.toMatchObject({ ok: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('openFolderInDesktop: `--desktop` in cwd, default profile only', async () => {
    const h = harness();
    await expect(h.service.openFolderInDesktop({ profileId: 'default', cwd: CWD })).resolves.toMatchObject({ ok: true });
    expect(h.terminals.map((t) => [t.args, t.cwd, t.env])).toEqual([[['--desktop'], CWD, { PATH: 'p' }]]);
    expect(h.terminalOptions).toEqual([{ waitForExit: true, keepOpenOnError: true }]);
    expect(h.runs).toHaveLength(0);
    await expect(h.service.openFolderInDesktop({ profileId: 'work', cwd: CWD })).resolves.toMatchObject({ ok: false });
    expect(h.terminals).toHaveLength(1);
  });

  it('openInTerminal resumes in a visible terminal with the profile env after closing the same-session handle', async () => {
    const h = harness({ writer: writer('h-writer', SID, 'work') });
    const result = await h.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: SID, handleId: 'h-mine' });
    expect(result.ok).toBe(true);
    expect(h.log).toEqual(['close:h-mine', 'close:h-writer', `terminal:--resume ${SID}`]);
    expect(h.terminals[0]).toEqual({
      exe: BIN,
      args: ['--resume', SID],
      cwd: CWD,
      env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' },
      title: 'Relay Desk',
    });
  });

  it('openInTerminal fork keeps writers open; continueLatest closes discovered and caller handles once', async () => {
    const fork = harness({ writer: writer('h-writer') });
    await fork.service.openInTerminal({ profileId: 'default', cwd: CWD, sessionId: SID, fork: true, handleId: 'h-mine' });
    expect(fork.log).toEqual([`terminal:--resume ${SID} --fork-session`]);

    const latest = harness({ writer: writer('h-writer') });
    await latest.service.openInTerminal({ profileId: 'default', cwd: CWD, continueLatest: true, handleId: 'h-mine' });
    expect(latest.log).toEqual(['close:h-mine', 'close:h-writer', 'terminal:--continue']);

    const latestFork = harness({ writer: writer('h-writer') });
    await latestFork.service.openInTerminal({ profileId: 'default', cwd: CWD, continueLatest: true, fork: true, handleId: 'h-writer' });
    expect(latestFork.log).toEqual(['terminal:--continue --fork-session']);
    expect(latestFork.cwdLookups).toEqual([]);

    const same = harness({ writer: writer('h-writer') });
    await same.service.openInTerminal({ profileId: 'default', cwd: CWD, continueLatest: true, handleId: 'h-writer' });
    expect(same.log).toEqual(['close:h-writer', 'terminal:--continue']);

    const other = harness({ writer: writer('h-writer', OTHER_SID) });
    await other.service.openInTerminal({ profileId: 'default', cwd: CWD, sessionId: SID });
    expect(other.log).toEqual([`terminal:--resume ${SID}`]);
  });

  it('continueLatest without handleId waits for every same-profile folder writer and leaves other writers open', async () => {
    const close = deferred<void>();
    const h = harness({
      writers: [
        writer('one', SID, 'work'),
        writer('two', OTHER_SID, 'work'),
        writer('other-profile'),
        { ...writer('other-folder', SID, 'work'), cwd: 'D:\\else' },
      ],
      closeWait: close.promise,
    });
    const pending = h.service.openInTerminal({ profileId: 'work', cwd: CWD, continueLatest: true });
    await vi.waitFor(() => expect(h.log).toEqual(['close:one']));
    expect(h.terminals).toEqual([]);
    close.resolve();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(h.cwdLookups).toEqual([{ cwd: CWD, profileId: 'work' }]);
    expect(h.log).toEqual(['close:one', 'close:two', 'terminal:--continue']);
  });

  it('continueLatest does not open another writer if a discovered writer fails to close', async () => {
    const h = harness({ writers: [writer('one')], closeFails: true });
    await expect(h.service.openInTerminal({ profileId: 'default', cwd: CWD, continueLatest: true })).resolves.toMatchObject({ ok: false });
    expect(h.log).toEqual(['close:one']);
    expect(h.terminals).toEqual([]);
  });

  it('toCloud, teleport and remoteControl open visible terminals with exact argv', async () => {
    const h = harness({ writer: writer('h-writer', SID, 'work') });
    await h.service.toCloud({ profileId: 'work', cwd: CWD, task: 'ship it & "go"' });
    await h.service.teleport({ profileId: 'work', cwd: CWD });
    await h.service.teleport({ profileId: 'work', cwd: CWD, cloudSessionId: 'session_01X' });
    await h.service.remoteControl({ profileId: 'work', cwd: CWD });
    await h.service.remoteControl({ profileId: 'work', cwd: CWD, sessionId: SID, handleId: 'h-mine' });
    expect(h.terminals.map((t) => t.args)).toEqual([
      ['--cloud', 'ship it & "go"'],
      ['--teleport'],
      ['--teleport', 'session_01X'],
      ['--remote-control'],
      ['--remote-control', '--resume', SID],
    ]);
    expect(h.log.slice(-3)).toEqual(['close:h-mine', 'close:h-writer', `terminal:--remote-control --resume ${SID}`]);
    for (const t of h.terminals) expect(t.env).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' });
    expect(h.runs).toHaveLength(0);
  });

  it('session lookup never closes another profile with the same copied UUID', async () => {
    const h = harness({ writer: writer('other-profile') });
    await h.service.openInTerminal({ profileId: 'work', cwd: CWD, sessionId: SID });
    await h.service.remoteControl({ profileId: 'work', cwd: CWD, sessionId: SID });
    expect(h.log).toEqual([`terminal:--resume ${SID}`, `terminal:--remote-control --resume ${SID}`]);
  });

  it('rejects empty cloud tasks and unknown profiles without opening a terminal', async () => {
    const h = harness();
    await expect(h.service.toCloud({ profileId: 'work', cwd: CWD, task: '  ' })).resolves.toMatchObject({ ok: false });
    await expect(h.service.teleport({ profileId: 'ghost', cwd: CWD })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('ghost'),
    });
    expect(h.terminals).toHaveLength(0);
  });

  it('a terminal that cannot open gives ok:false', async () => {
    const service = createHandoffService({
      engine: { close: async () => {}, findBySession: () => undefined, findByCwd: () => [] },
      getProfile: async () => PROFILES.default!,
      openTerminal: async () => {
        throw new Error('no cmd');
      },
      resolveBinary: () => BIN,
      buildEnv: envOf,
    });
    await expect(service.teleport({ profileId: 'default', cwd: CWD })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('no cmd'),
    });
  });

  it('backgroundAgents runs `agents --json` hidden with the profile env; attach opens a terminal in home', async () => {
    const h = harness({ runResult: { stdout: JSON.stringify([{ id: 'a1', kind: 'background', name: 'Job' }]) } });
    await expect(h.service.backgroundAgents('work')).resolves.toEqual([{ id: 'a1', name: 'Job' }]);
    expect(h.runs[0]).toEqual({
      file: BIN,
      args: ['agents', '--json'],
      options: { env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' }, cwd: HOME, timeoutMs: 15_000 },
    });
    await h.service.attachBackground({ profileId: 'work', id: 'a1' });
    expect(h.terminals[0]).toMatchObject({ args: ['attach', 'a1'], cwd: HOME });
    await expect(h.service.attachBackground({ profileId: 'work', id: '--help' })).resolves.toMatchObject({ ok: false });

    const failing = harness({ runResult: { exitCode: 1 } });
    await expect(failing.service.backgroundAgents('work')).rejects.toThrow('Could not list the background sessions (exit code 1).');
    const slow = harness({ runResult: { exitCode: null, timedOut: true } });
    await expect(slow.service.backgroundAgents('work')).rejects.toThrow('Could not list the background sessions (timed out).');
  });
});
