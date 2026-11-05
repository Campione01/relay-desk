import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { scrubEnv } from './env';
import { runHidden, type CommandRunner } from './run';

const PACKAGE_PATH = ['@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'];

export interface BinaryLocation {
  isPackaged: boolean;
  /** app.getAppPath(): the project root in dev, resources/app.asar when packaged. */
  appPath: string;
  /** process.resourcesPath. */
  resourcesPath: string;
}

/** Pure: where the bundled claude.exe may live, in lookup order. Never a PATH lookup. */
export function claudeBinaryCandidates(location: BinaryLocation): string[] {
  const root = location.isPackaged ? join(location.resourcesPath, 'app.asar.unpacked') : location.appPath;
  return [
    join(root, 'node_modules', ...PACKAGE_PATH),
    join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', ...PACKAGE_PATH),
  ];
}

export interface ResolveBinaryDeps {
  location?: BinaryLocation;
  exists?: (path: string) => boolean;
}

let resolved: string | undefined;

/**
 * Path of the bundled CLI: dev -> node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe,
 * packaged -> the same path under app.asar.unpacked. Never a `claude` from PATH. Throws when missing.
 */
export function resolveClaudeBinary(deps: ResolveBinaryDeps = {}): string {
  const injected = deps.location !== undefined || deps.exists !== undefined;
  if (!injected && resolved) return resolved;
  const location = deps.location ?? electronLocation();
  const exists = deps.exists ?? existsSync;
  const candidates = claudeBinaryCandidates(location);
  const found = candidates.find((path) => exists(path));
  if (!found) {
    throw new Error(
      `Bundled Claude Code binary not found. Looked in: ${candidates.join('; ')}. ` +
        'Reinstall dependencies (the SDK installs claude.exe through @anthropic-ai/claude-agent-sdk-win32-x64).',
    );
  }
  if (!injected) resolved = found;
  return found;
}

function electronLocation(): BinaryLocation {
  return { isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath };
}

/** Pure: "2.1.302 (Claude Code)" -> "2.1.302"; null when no version is found. */
export function parseCliVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(stdout)?.[1] ?? null;
}

export interface CliVersionDeps {
  runner?: CommandRunner;
  resolveBinary?: () => string;
  baseEnv?: () => NodeJS.ProcessEnv;
}

/** Returns a cached `claude.exe --version` reader; a failed read is retried on the next call. */
export function createCliVersionReader(deps: CliVersionDeps = {}): () => Promise<string> {
  let cached: Promise<string> | undefined;
  const read = async (): Promise<string> => {
    const runner = deps.runner ?? runHidden;
    const binary = (deps.resolveBinary ?? resolveClaudeBinary)();
    const env = scrubEnv({ ...(deps.baseEnv ?? (() => process.env))() });
    const result = await runner(binary, ['--version'], { env, timeoutMs: 15_000 });
    const version = result.exitCode === 0 ? parseCliVersion(result.stdout) : null;
    if (!version) {
      const reason = result.timedOut ? 'timed out' : (result.error ?? `exit code ${String(result.exitCode)}`);
      throw new Error(`claude --version failed: ${reason}`);
    }
    return version;
  };
  return () => {
    cached ??= read().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

/** `claude.exe --version` of the bundled binary (cached). */
export const cliVersion: () => Promise<string> = createCliVersionReader();
