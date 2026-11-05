import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toLocalAbsolutePath } from './paths';

/** A program to run in a new visible console window. */
export interface TerminalLaunch {
  exe: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Window title; reduced to letters, digits, spaces and ._- (default "Relay Desk"). */
  title?: string;
}

/**
 * What to spawn (detached) to open that window. The program and its arguments never appear in the launcher's
 * own command line: they travel in RELAY_DESK_CMD / RELAY_DESK_CWD and are read by cmd.exe through delayed
 * expansion (!VAR!), whose result cmd does not parse again for & | < > ^ % or quotes.
 */
export interface TerminalSpawn {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** cmd.exe parses its own command line, so its args are passed exactly as built. */
  windowsVerbatimArguments: boolean;
  windowsHide: boolean;
  /** The spawned launcher lives exactly as long as the console program (cmd start /wait). */
  observable: boolean;
}

export interface TerminalSpawnOptions {
  /** Path of wt.exe, or null when Windows Terminal is not installed. */
  windowsTerminal: string | null;
  /** %SystemRoot%, for an absolute cmd.exe path. */
  systemRoot: string;
  /** Use the observable cmd.exe launcher even when Windows Terminal is present. */
  waitForExit?: boolean;
  /** Observable launcher only: on a non-zero exit the console waits for a key so the program's reason stays readable. */
  keepOpenOnError?: boolean;
}

/** cmd.exe rejects command lines over 8191 characters after expansion; keep a margin for the fixed part. */
export const MAX_COMMAND_CHARS = 7680;
export const DEFAULT_TERMINAL_TITLE = 'Relay Desk';
export const CMD_ENV = 'RELAY_DESK_CMD';
export const CWD_ENV = 'RELAY_DESK_CWD';
export const INNER_ENV = 'RELAY_DESK_INNER';
const EXIT_ENV = 'RELAY_DESK_EXIT';

export class TerminalLaunchError extends Error {
  override name = 'TerminalLaunchError';
}

/** Pure: one argument quoted for CreateProcess / the MSVC runtime (CommandLineToArgvW rules). */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** Pure: full CreateProcess command line for `exe` + `args`. */
export function buildCommandLine(exe: string, args: readonly string[]): string {
  return [exe, ...args].map((a) => quoteWindowsArg(a)).join(' ');
}

/**
 * Pure: command line for a console launcher. cmd.exe runs an expanded !VAR! as one file name unless the program
 * is quoted, so the program is always quoted (a local absolute path never contains a quote).
 */
export function buildLaunchCommandLine(exe: string, args: readonly string[]): string {
  return [`"${exe}"`, ...args.map((a) => quoteWindowsArg(a))].join(' ');
}

export function sanitizeTitle(title: string | undefined): string {
  const clean = (title ?? '')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || DEFAULT_TERMINAL_TITLE;
}

/** Pure: wt.exe -w new -d . -- cmd.exe ... when Windows Terminal is present, else cmd.exe /c start "<title>" /wait /D <cwd> ... */
export function buildTerminalSpawn(launch: TerminalLaunch, options: TerminalSpawnOptions): TerminalSpawn {
  const exe = toLocalAbsolutePath(launch.exe);
  if (!exe) throw new TerminalLaunchError('The program path must be an absolute local path');
  const cwd = toLocalAbsolutePath(launch.cwd);
  if (!cwd) throw new TerminalLaunchError('The working folder must be an absolute local path (no network paths)');
  for (const arg of launch.args) {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new TerminalLaunchError('Invalid argument');
  }
  const commandLine = buildLaunchCommandLine(exe, launch.args);
  if (commandLine.length + cwd.length > MAX_COMMAND_CHARS) {
    throw new TerminalLaunchError(`The command is too long for a console window (max ${MAX_COMMAND_CHARS} characters)`);
  }
  const title = sanitizeTitle(launch.title);
  const env: NodeJS.ProcessEnv = { ...launch.env };
  // Windows env names are case-insensitive: an inherited variant must not shadow the launcher's own values.
  for (const key of Object.keys(env)) {
    if ([CMD_ENV, CWD_ENV, INNER_ENV, EXIT_ENV].includes(key.toUpperCase())) delete env[key];
  }
  env[CMD_ENV] = commandLine;
  env[CWD_ENV] = cwd;
  const cmdExe = join(options.systemRoot, 'System32', 'cmd.exe');

  if (options.windowsTerminal && !options.waitForExit) {
    return {
      file: options.windowsTerminal,
      // Every token is fixed text without spaces, quotes or ';', so wt's own splitting and re-quoting cannot change it.
      args: ['-w', 'new', '--title', title, '-d', '.', '--', cmdExe, '/d', '/v:on', '/c', `!${CMD_ENV}!`],
      env,
      cwd,
      windowsVerbatimArguments: false,
      windowsHide: false,
      observable: false,
    };
  }
  // The console runs its own cmd.exe, which expands the program itself (delayed expansion is not recursive) and
  // pauses only on failure, then exits with the program's own code so the launcher still reports it.
  const program = options.keepOpenOnError ? INNER_ENV : CMD_ENV;
  if (options.keepOpenOnError) {
    env[INNER_ENV] = `"${cmdExe}" /d /v:on /s /c "!${CMD_ENV}! & if !errorlevel! neq 0 (set ${EXIT_ENV}=!errorlevel!& pause & exit !${EXIT_ENV}!)"`;
  }
  return {
    file: cmdExe,
    args: ['/d', '/v:on', '/s', '/c', `"start "${title}" /wait /D "!${CWD_ENV}!" !${program}! & exit !errorlevel!"`],
    env,
    cwd,
    windowsVerbatimArguments: true,
    windowsHide: true,
    observable: true,
  };
}

export interface TerminalHandle {
  /** Exit code of the console program when the launcher can observe it (cmd path); null for Windows Terminal. */
  exited: Promise<number | null> | null;
}

export interface TerminalOpenOptions {
  /** Require the observable console launcher (login and desktop handoff need the actual program exit). */
  waitForExit?: boolean;
  /** With waitForExit: keep the console open after a failing exit until the user presses a key. */
  keepOpenOnError?: boolean;
}

export type TerminalOpener = (launch: TerminalLaunch, options?: TerminalOpenOptions) => Promise<TerminalHandle>;

export interface TerminalDeps {
  spawn?: typeof nodeSpawn;
  /** wt.exe path or null; default: the Windows Terminal app execution alias under %LOCALAPPDATA%. */
  findWindowsTerminal?: () => string | null;
  systemRoot?: () => string;
}

export function findWindowsTerminal(env: NodeJS.ProcessEnv = process.env, exists = existsSync): string | null {
  if (!env.LOCALAPPDATA) return null;
  const path = join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
  return exists(path) ? path : null;
}

/** Opens console windows; rejects on invalid input or when the launcher cannot be started. */
export function createTerminalOpener(deps: TerminalDeps = {}): TerminalOpener {
  return (launch, options = {}) =>
    new Promise<TerminalHandle>((resolve, reject) => {
      const plan = buildTerminalSpawn(launch, {
        windowsTerminal: (deps.findWindowsTerminal ?? (() => findWindowsTerminal()))(),
        systemRoot: (deps.systemRoot ?? (() => process.env.SystemRoot ?? 'C:\\Windows'))(),
        waitForExit: options.waitForExit,
        keepOpenOnError: options.keepOpenOnError,
      });
      const child = (deps.spawn ?? nodeSpawn)(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: plan.windowsHide,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        shell: false,
      });
      const exited = plan.observable
        ? new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)))
        : null;
      child.once('error', (error) => reject(new TerminalLaunchError(`Could not open a terminal: ${error.message}`)));
      child.once('spawn', () => {
        if (!plan.observable) child.unref();
        resolve({ exited });
      });
    });
}

export const openTerminal: TerminalOpener = (launch, options) => createTerminalOpener()(launch, options);
