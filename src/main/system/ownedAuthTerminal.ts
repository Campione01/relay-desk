import { spawn as nodeSpawn } from 'node:child_process';
import { toLocalAbsolutePath } from './paths';
import { buildCommandLine, sanitizeTitle, TerminalLaunchError } from './terminal';
import type { TerminalHandle, TerminalLaunch, TerminalOpenOptions } from './terminal';

export interface OwnedAuthTerminalOptions extends TerminalOpenOptions {
  signal?: AbortSignal;
}

export interface OwnedAuthTerminalHandle extends TerminalHandle {
  exited: Promise<number | null>;
  /** Resolves only after the host exits and its kill-on-close job has been released. */
  close(): Promise<void>;
}

export type OwnedAuthTerminalOpener = (
  launch: TerminalLaunch,
  options?: OwnedAuthTerminalOptions,
) => Promise<OwnedAuthTerminalHandle>;

export interface OwnedAuthTerminalDeps {
  helperPath: string;
  /** Production defaults to a native login console; ordinary tests pass false, and the CLI's output then goes nowhere. */
  visible?: boolean;
  spawn?: typeof nodeSpawn;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const MAX_START_BYTES = 1024 * 1024;
const MAX_FRAME_CHARS = 128 * 1024;

function startMessage(launch: TerminalLaunch, visible: boolean): string {
  const exe = toLocalAbsolutePath(launch.exe);
  const cwd = toLocalAbsolutePath(launch.cwd);
  if (!exe) throw new TerminalLaunchError('The program path must be an absolute local path');
  if (!cwd) throw new TerminalLaunchError('The working folder must be an absolute local path');
  if (!Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TerminalLaunchError('Invalid argument');
  }
  if (buildCommandLine(exe, launch.args).length >= 32767) throw new TerminalLaunchError('The command is too long');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(launch.env)) {
    if (value === undefined) continue;
    if (!name || /[=\0]/.test(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new TerminalLaunchError('Invalid environment');
    }
    env[name] = value;
  }
  const message = JSON.stringify({ protocol: 1, exe, args: launch.args, cwd, env, visible, relayOutput: false, title: sanitizeTitle(launch.title) });
  if (Buffer.byteLength(message, 'utf8') > MAX_START_BYTES) throw new TerminalLaunchError('The login launch request is too large');
  return `${message}\n`;
}

/**
 * The private stdin pipe is the parent's lifetime capability, not the CLI's stdin.
 * EOF kills the native job even when Electron dies without running cleanup code.
 * The CLI's output never comes back: the host reports only that the CLI started and how it exited.
 */
export function createOwnedAuthTerminalOpener(deps: OwnedAuthTerminalDeps): OwnedAuthTerminalOpener {
  return async (launch, options = {}) => {
    const helperPath = toLocalAbsolutePath(deps.helperPath);
    if (!helperPath) throw new TerminalLaunchError('The login host path must be an absolute local path');
    if ('onOutput' in options) throw new TerminalLaunchError('The login host never relays the CLI output');
    const message = startMessage(launch, deps.visible ?? true);
    if (options.signal?.aborted) throw new TerminalLaunchError('Login terminal cancelled');
    return new Promise<OwnedAuthTerminalHandle>((resolve, reject) => {
      const child = (deps.spawn ?? nodeSpawn)(helperPath, [], {
        cwd: launch.cwd,
        // Launch material belongs only to the authenticated pipe, not argv or extra env variables.
        env: launch.env,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      let opened = false;
      let finished = false;
      let closing = false;
      let reportedExit: number | null = null;
      let sawExit = false;
      let failure: TerminalLaunchError | undefined;
      let buffer = '';
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((done) => { resolveExit = done; });
      const requestClose = (): void => {
        if (finished || closing) return;
        closing = true;
        child.stdin?.end();
        closeTimer = setTimeout(() => {
          // Only the process object spawned above. Native job closure owns the entire subtree.
          if (!finished) child.kill();
        }, deps.closeTimeoutMs ?? 5000);
        closeTimer.unref();
      };
      const fail = (reason: string): void => {
        failure ??= new TerminalLaunchError(reason);
        requestClose();
      };
      const abort = (): void => fail('Login terminal cancelled');
      const startupTimer = setTimeout(() => fail('The login host did not become ready'), deps.startupTimeoutMs ?? 10000);
      startupTimer.unref();
      const handle: OwnedAuthTerminalHandle = {
        exited,
        async close() { requestClose(); await exited; },
      };
      const frame = (line: string): void => {
        let value: Record<string, unknown>;
        try { value = JSON.parse(line) as Record<string, unknown>; } catch { fail('Invalid login host response'); return; }
        if (!value || typeof value !== 'object') { fail('Invalid login host response'); return; }
        if (value.type === 'ready' && value.protocol === 1 && !opened && !closing && !sawExit) {
          opened = true;
          clearTimeout(startupTimer);
          resolve(handle);
        } else if (value.type === 'exit' && !sawExit && Number.isInteger(value.code) &&
          (value.code as number) >= 0 && (value.code as number) <= 0xffffffff) {
          reportedExit = value.code as number;
          sawExit = true;
        } else if (value.type === 'error') {
          // Native diagnostics intentionally exclude command lines, output, URLs and credentials.
          fail('The owned login process could not be started or monitored');
        } else {
          fail('Invalid login host response');
        }
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          if (end > MAX_FRAME_CHARS) { fail('The login host response is too large'); buffer = ''; return; }
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          frame(line);
        }
        if (buffer.length > MAX_FRAME_CHARS) { fail('The login host response is too large'); buffer = ''; }
      });
      // Drain native runtime diagnostics without retaining or presenting potentially sensitive material.
      child.stderr?.resume();
      child.stdin?.on('error', () => fail('The login host control pipe closed'));
      child.stdout?.on('error', () => fail('The login host output pipe closed'));
      child.once('error', () => fail('Could not start the owned login host'));
      child.once('close', () => {
        finished = true;
        clearTimeout(startupTimer);
        if (closeTimer) clearTimeout(closeTimer);
        options.signal?.removeEventListener('abort', abort);
        if (!opened) reject(failure ?? new TerminalLaunchError('The login host exited before becoming ready'));
        resolveExit(sawExit ? reportedExit : null);
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once('spawn', () => {
        if (!closing) child.stdin?.write(message);
      });
    });
  };
}
