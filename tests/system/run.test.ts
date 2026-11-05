import { describe, expect, it } from 'vitest';
import { runHidden } from '../../src/main/system/run';

// Uses the node binary running vitest as a harmless child process.
const node = process.execPath;

describe('runHidden', () => {
  it('passes args verbatim without a shell and returns stdout and the exit code', async () => {
    const hostile = 'a & echo pwned "q" %PATH% | x';
    const result = await runHidden(
      node,
      ['-e', 'process.stdout.write(JSON.stringify([process.argv[1], process.env.RELAY_T])); process.exit(3)', hostile],
      { env: { ...process.env, RELAY_T: 'v' }, timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual([hostile, 'v']);
  });

  it('kills the process on timeout', async () => {
    const result = await runHidden(node, ['-e', 'setTimeout(() => {}, 60000)'], { env: process.env, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('reports a spawn failure instead of rejecting', async () => {
    const result = await runHidden('Z:\\does-not-exist\\nothing.exe', [], { env: process.env, timeoutMs: 1000 });
    expect(result.exitCode).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('caps captured output', async () => {
    const result = await runHidden(node, ['-e', 'process.stdout.write("x".repeat(5000))'], {
      env: process.env,
      timeoutMs: 10_000,
      maxBytes: 100,
    });
    expect(result.stdout).toBe('x'.repeat(100));
  });
});
