import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/main/system/run';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:\\dev\\relay-desk' } }));

const {
  claudeBinaryCandidates,
  createCliVersionReader,
  parseCliVersion,
  resolveClaudeBinary,
} = await import('../../src/main/system/claudeBinary');

const DEV = { isPackaged: false, appPath: 'D:\\dev\\relay-desk', resourcesPath: 'C:\\electron\\resources' };
const PACKAGED = {
  isPackaged: true,
  appPath: 'C:\\Program Files\\Relay Desk\\resources\\app.asar',
  resourcesPath: 'C:\\Program Files\\Relay Desk\\resources',
};

describe('resolveClaudeBinary', () => {
  it('dev: the SDK platform package under the app path', () => {
    expect(claudeBinaryCandidates(DEV)[0]).toBe(
      join('D:\\dev\\relay-desk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'),
    );
  });

  it('packaged: the app.asar.unpacked copy, never inside the asar', () => {
    const candidates = claudeBinaryCandidates(PACKAGED);
    expect(candidates[0]).toBe(
      join(
        'C:\\Program Files\\Relay Desk\\resources',
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe',
      ),
    );
    for (const path of candidates) expect(path).toContain('app.asar.unpacked');
  });

  it('returns the first existing candidate', () => {
    const [, nested] = claudeBinaryCandidates(DEV);
    expect(resolveClaudeBinary({ location: DEV, exists: (p) => p === nested })).toBe(nested);
  });

  it('throws a clear error listing where it looked when the binary is missing', () => {
    expect(() => resolveClaudeBinary({ location: DEV, exists: () => false })).toThrow(
      /Bundled Claude Code binary not found\. Looked in: .*claude-agent-sdk-win32-x64/,
    );
  });

  it('finds the real bundled binary of this checkout', () => {
    const root = join(import.meta.dirname, '..', '..');
    expect(resolveClaudeBinary({ location: { ...DEV, appPath: root } })).toMatch(/claude\.exe$/);
  });

  it('uses electron app paths by default', () => {
    expect(() => resolveClaudeBinary({ exists: () => false })).toThrow(/D:\\dev\\relay-desk/);
  });
});

describe('cliVersion', () => {
  it('parses the version line', () => {
    expect(parseCliVersion('2.1.302 (Claude Code)\n')).toBe('2.1.302');
    expect(parseCliVersion('garbage')).toBeNull();
  });

  it('runs --version on the bundled binary with a scrubbed env and caches the result', async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: RunOptions }> = [];
    const runner = async (file: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
      calls.push({ file, args, options });
      return { exitCode: 0, stdout: '2.1.302 (Claude Code)\n', stderr: '', timedOut: false };
    };
    const read = createCliVersionReader({
      runner,
      resolveBinary: () => 'X:\\claude.exe',
      baseEnv: () => ({ PATH: 'p', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_ENTRYPOINT: 'desktop' }),
    });
    await expect(read()).resolves.toBe('2.1.302');
    await expect(read()).resolves.toBe('2.1.302');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('X:\\claude.exe');
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls[0]?.options.env).toEqual({ PATH: 'p' });
  });

  it('rejects on failure and retries on the next call', async () => {
    let attempt = 0;
    const read = createCliVersionReader({
      runner: async () => {
        attempt += 1;
        return attempt === 1
          ? { exitCode: null, stdout: '', stderr: '', timedOut: true }
          : { exitCode: 0, stdout: '2.1.302 (Claude Code)', stderr: '', timedOut: false };
      },
      resolveBinary: () => 'X:\\claude.exe',
      baseEnv: () => ({}),
    });
    await expect(read()).rejects.toThrow(/timed out/);
    await expect(read()).resolves.toBe('2.1.302');
  });
});
