import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  CMD_ENV,
  CWD_ENV,
  INNER_ENV,
  MAX_COMMAND_CHARS,
  buildCommandLine,
  buildLaunchCommandLine,
  buildTerminalSpawn,
  createTerminalOpener,
  findWindowsTerminal,
  quoteWindowsArg,
  sanitizeTitle,
  type TerminalLaunch,
} from '../../src/main/system/terminal';

const HOSTILE = [
  'a b',
  '"quoted"',
  'back\\slash\\',
  'x\\"y',
  '& calc',
  '%PATH%',
  '!PATH!',
  '^caret^',
  '(paren)',
  '<>|',
  'line1\nline2',
  'tab\there',
  'trail\\',
  '中文 テスト',
  '',
  ';semi',
  '--flag',
  '%%',
  'a"b c"d',
  '\\\\server\\x',
  'end\\\\',
  'cr\r\nlf',
  'x;y \\; z',
  '" & echo injected & "',
];

const EXE = 'D:\\app\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';
const launch = (over: Partial<TerminalLaunch> = {}): TerminalLaunch => ({
  exe: EXE,
  args: ['--cloud', 'fix & "ship" %USERPROFILE% !x!'],
  cwd: 'D:\\work\\R&D %TEMP% !x! (1)',
  env: { PATH: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' },
  ...over,
});
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';

describe('quoteWindowsArg', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['a b', '"a b"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\dir\\', 'C:\\dir\\'],
    ['C:\\my dir\\', '"C:\\my dir\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['tab\there', '"tab\there"'],
  ])('%j -> %j', (input, expected) => {
    expect(quoteWindowsArg(input)).toBe(expected);
  });

  it('round-trips hostile arguments through a real child process command line', async () => {
    // node -e <script> -- <args>: process.argv = [node, ...args].
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    // The whole command line is ours (verbatim): node parses it with the same MSVC rules as claude.exe.
    const line = buildCommandLine('-e', [script, '--', ...HOSTILE]);
    const child = spawn(process.execPath, [line], {
      argv0: quoteWindowsArg(process.execPath),
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(HOSTILE);
  });
});

describe('buildTerminalSpawn', () => {
  it('cmd.exe path: fixed launcher line, program and args only in the environment, observable exit', () => {
    const plan = buildTerminalSpawn(launch(), { windowsTerminal: null, systemRoot: 'C:\\Windows' });
    expect(plan.file).toBe(CMD);
    expect(plan.args).toEqual([
      '/d',
      '/v:on',
      '/s',
      '/c',
      '"start "Relay Desk" /wait /D "!RELAY_DESK_CWD!" !RELAY_DESK_CMD! & exit !errorlevel!"',
    ]);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.observable).toBe(true);
    expect(plan.cwd).toBe('D:\\work\\R&D %TEMP% !x! (1)');
    expect(plan.env[CMD_ENV]).toBe(`"${EXE}" --cloud "fix & \\"ship\\" %USERPROFILE% !x!"`);
    expect(plan.env[CWD_ENV]).toBe('D:\\work\\R&D %TEMP% !x! (1)');
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe('D:\\profiles\\work');
    expect(plan.args.join(' ')).not.toContain('fix');
    expect(plan.args.join(' ')).not.toContain('R&D');
  });

  it('Windows Terminal path: wt -w new -d . -- cmd.exe with fixed tokens only', () => {
    const plan = buildTerminalSpawn(launch({ title: 'Login; & "x"' }), {
      windowsTerminal: WT,
      systemRoot: 'C:\\Windows',
    });
    expect(plan.file).toBe(WT);
    expect(plan.args).toEqual([
      '-w',
      'new',
      '--title',
      'Login x',
      '-d',
      '.',
      '--',
      CMD,
      '/d',
      '/v:on',
      '/c',
      '!RELAY_DESK_CMD!',
    ]);
    expect(plan.windowsVerbatimArguments).toBe(false);
    expect(plan.observable).toBe(false);
    expect(plan.cwd).toBe('D:\\work\\R&D %TEMP% !x! (1)');
    for (const arg of plan.args) expect(arg).not.toMatch(/[;"]/);
  });

  it('waitForExit uses the observable cmd launcher even when Windows Terminal exists', () => {
    const plan = buildTerminalSpawn(launch(), { windowsTerminal: WT, systemRoot: 'C:\\Windows', waitForExit: true });
    expect(plan.file).toBe(CMD);
    expect(plan.observable).toBe(true);
  });

  it('hostile arguments never reach the launcher line', () => {
    const plan = buildTerminalSpawn(launch({ args: HOSTILE }), { windowsTerminal: null, systemRoot: 'C:\\Windows' });
    expect(plan.args[4]).toBe('"start "Relay Desk" /wait /D "!RELAY_DESK_CWD!" !RELAY_DESK_CMD! & exit !errorlevel!"');
    expect(plan.env[CMD_ENV]).toBe(buildLaunchCommandLine(EXE, HOSTILE));
  });

  it('keepOpenOnError runs the program in its own console cmd that pauses only on failure; nothing hostile reaches a command line', () => {
    const plan = buildTerminalSpawn(launch({ args: HOSTILE, env: { PATH: 'C:\\Windows', relay_desk_inner: 'calc.exe', Relay_Desk_Cmd: 'calc.exe' } }), {
      windowsTerminal: WT, systemRoot: 'C:\\Windows', waitForExit: true, keepOpenOnError: true,
    });
    expect(plan.file).toBe(CMD);
    expect(plan.observable).toBe(true);
    expect(plan.args[4]).toBe('"start "Relay Desk" /wait /D "!RELAY_DESK_CWD!" !RELAY_DESK_INNER! & exit !errorlevel!"');
    expect(plan.env[INNER_ENV]).toBe(`"${CMD}" /d /v:on /s /c "!RELAY_DESK_CMD! & if !errorlevel! neq 0 (set RELAY_DESK_EXIT=!errorlevel!& pause & exit !RELAY_DESK_EXIT!)"`);
    expect(plan.env[CMD_ENV]).toBe(buildLaunchCommandLine(EXE, HOSTILE));
    expect(Object.keys(plan.env).filter((key) => /^relay_desk_(inner|cmd)$/i.test(key)).sort()).toEqual([CMD_ENV, INNER_ENV].sort());
    expect(buildTerminalSpawn(launch(), { windowsTerminal: null, systemRoot: 'C:\\Windows', waitForExit: true }).env).not.toHaveProperty(INNER_ENV);
  });

  it.skipIf(process.platform !== 'win32')('cmd.exe runs the expanded program line even when the program path has no spaces (Windows Terminal path)', () => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const plan = buildTerminalSpawn(
      { exe: join(systemRoot, 'System32', 'whoami.exe'), args: ['/?'], cwd: process.cwd(), env: process.env },
      { windowsTerminal: WT, systemRoot },
    );
    expect(plan.args.slice(-4)).toEqual(['/d', '/v:on', '/c', '!RELAY_DESK_CMD!']);
    const result = spawnSync(join(systemRoot, 'System32', 'cmd.exe'), plan.args.slice(-4), { env: plan.env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== 'win32')('the keep-open chain preserves the exit code and arguments and pauses only on failure (hidden, no new window)', () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.argv[1]))';
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const args = HOSTILE.filter((arg) => !/[\r\n]/.test(arg));
    const printed = JSON.stringify(args);
    for (const code of [0, 3]) {
      const plan = buildTerminalSpawn(
        { exe: process.execPath, args: ['-e', script, String(code), ...args], cwd: process.cwd(), env: process.env },
        { windowsTerminal: null, systemRoot, waitForExit: true, keepOpenOnError: true },
      );
      // The same inner chain the console runs, started without `start` so no window opens; stdin answers pause.
      const result = spawnSync(join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/v:on', '/s', '/c', `"!${INNER_ENV}! & exit !errorlevel!"`], {
        env: plan.env, input: 'x\r\n', encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 20_000,
      });
      expect(result.status).toBe(code);
      expect(result.stdout.startsWith(printed)).toBe(true);
      if (code === 0) expect(result.stdout).toBe(printed);
      else expect(result.stdout.length).toBeGreaterThan(printed.length);
    }
  });

  it('sanitises the title (no quotes, percent, bang, ampersand or semicolon)', () => {
    expect(sanitizeTitle('a"b%c!d&e;f^g')).toBe('abcdefg');
    expect(sanitizeTitle('登入 Work')).toBe('登入 Work');
    expect(sanitizeTitle('"%!')).toBe('Relay Desk');
    expect(sanitizeTitle(undefined)).toBe('Relay Desk');
  });

  it.each([
    ['UNC cwd', { cwd: '\\\\server\\share' }, /working folder/],
    ['relative cwd', { cwd: 'repo' }, /working folder/],
    ['dot-dot cwd', { cwd: 'D:\\a\\..\\b' }, /working folder/],
    ['relative exe', { exe: 'claude.exe' }, /program path/],
    ['NUL in an argument', { args: ['a\0b'] }, /Invalid argument/],
    ['overlong task', { args: ['x'.repeat(MAX_COMMAND_CHARS)] }, /too long/],
  ])('rejects %s', (_name, over, error) => {
    expect(() => buildTerminalSpawn(launch(over), { windowsTerminal: null, systemRoot: 'C:\\Windows' })).toThrow(error);
  });

  it('accepts a command right at the limit', () => {
    const base = buildLaunchCommandLine(EXE, ['']).length + 'D:\\w'.length;
    const args = ['x'.repeat(MAX_COMMAND_CHARS - base)];
    expect(() =>
      buildTerminalSpawn(launch({ cwd: 'D:\\w', args }), { windowsTerminal: null, systemRoot: 'C:\\Windows' }),
    ).not.toThrow();
  });
});

class FakeChild extends EventEmitter {
  unrefCalled = false;
  unref(): void {
    this.unrefCalled = true;
  }
}

function fakeSpawn() {
  const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const children: FakeChild[] = [];
  const fn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { fn, calls, children };
}

describe('createTerminalOpener', () => {
  it('waitForExit overrides Windows Terminal, keeps the launcher hidden and returns the actual exit code', async () => {
    const fake = fakeSpawn();
    const open = createTerminalOpener({ spawn: fake.fn, findWindowsTerminal: () => WT, systemRoot: () => 'C:\\Windows' });
    const pending = open(launch(), { waitForExit: true });
    fake.children[0]!.emit('spawn');
    const handle = await pending;
    expect(fake.calls[0]!.file).toBe(CMD);
    expect(fake.calls[0]!.args.join(' ')).toContain('/wait');
    expect(fake.calls[0]!.options).toMatchObject({ windowsHide: true, detached: true, stdio: 'ignore', shell: false });
    let settled = false;
    void handle.exited?.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.children[0]!.emit('exit', 7);
    await expect(handle.exited).resolves.toBe(7);
    expect(fake.children[0]!.unrefCalled).toBe(false);
  });

  it('spawns the cmd launcher detached with the plan env and reports the exit code', async () => {
    const fake = fakeSpawn();
    const open = createTerminalOpener({ spawn: fake.fn, findWindowsTerminal: () => null, systemRoot: () => 'C:\\Windows' });
    const pending = open(launch());
    fake.children[0]!.emit('spawn');
    const handle = await pending;
    expect(fake.calls[0]!.file).toBe(CMD);
    expect(fake.calls[0]!.options).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      shell: false,
      cwd: 'D:\\work\\R&D %TEMP% !x! (1)',
    });
    expect((fake.calls[0]!.options.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR).toBe('D:\\profiles\\work');
    fake.children[0]!.emit('exit', 0);
    await expect(handle.exited).resolves.toBe(0);
    expect(fake.children[0]!.unrefCalled).toBe(false);
  });

  it('Windows Terminal: not observable, unref so the app can quit', async () => {
    const fake = fakeSpawn();
    const open = createTerminalOpener({ spawn: fake.fn, findWindowsTerminal: () => WT, systemRoot: () => 'C:\\Windows' });
    const pending = open(launch());
    fake.children[0]!.emit('spawn');
    const handle = await pending;
    expect(handle.exited).toBeNull();
    expect(fake.calls[0]!.options.windowsHide).toBe(false);
    expect(fake.children[0]!.unrefCalled).toBe(true);
  });

  it('rejects when the launcher cannot start and for invalid input', async () => {
    const fake = fakeSpawn();
    const open = createTerminalOpener({ spawn: fake.fn, findWindowsTerminal: () => null, systemRoot: () => 'C:\\Windows' });
    const pending = open(launch());
    fake.children[0]!.emit('error', new Error('spawn ENOENT'));
    await expect(pending).rejects.toThrow(/Could not open a terminal/);
    await expect(open(launch({ cwd: '\\\\srv\\x' }))).rejects.toThrow(/working folder/);
    expect(fake.calls).toHaveLength(1);
  });

  it('finds wt.exe through the app execution alias only', () => {
    const seen: string[] = [];
    expect(findWindowsTerminal({ LOCALAPPDATA: 'C:\\L' }, (p) => (seen.push(String(p)), true))).toBe(
      'C:\\L\\Microsoft\\WindowsApps\\wt.exe',
    );
    expect(findWindowsTerminal({}, () => true)).toBeNull();
    expect(findWindowsTerminal({ LOCALAPPDATA: 'C:\\L' }, () => false)).toBeNull();
  });
});
