import { spawn } from 'node:child_process';

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  /** Per stream; output beyond it is dropped. Default 1 MiB. */
  maxBytes?: number;
}

export interface RunResult {
  /** null when the process did not exit normally (spawn failure, timeout kill). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn failure (e.g. ENOENT); never contains the output. */
  error?: string;
}

/** Runs a program without a window and without a shell; never rejects. Injectable for tests. */
export type CommandRunner = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

export const runHidden: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        env: options.env,
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: describeSpawnError(error) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk.subarray(0, maxBytes - outBytes));
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < maxBytes) err.push(chunk.subarray(0, maxBytes - errBytes));
      errBytes += chunk.length;
    });
    child.on('error', (error) => finish({ exitCode: null, error: describeSpawnError(error) }));
    child.on('close', (code) => finish({ exitCode: timedOut ? null : code }));
  });

function describeSpawnError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}
