import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NATIVE_CLI_BUILDS, nativeCliBuild, type NativeCliBuild } from '../../src/main/native/cliBuilds';
import { NativeUiController, type NativeUiSnapshot, type NativeUiTransaction } from '../../src/main/native/controls';
import { NativeQuotaControls, nativeQuotaView } from '../../src/main/native/nativeQuotaControls';

const LISTED = NATIVE_CLI_BUILDS[0].sha256;
const STAGED: NativeCliBuild = Object.freeze({ version: '9.9.9', sha256: 'a'.repeat(64) });
const UNKNOWN = 'f'.repeat(64);
const WAIT = 'Usage limit reached · limit resets 3pm\nContinuing automatically at 3pm · esc to cancel\n❯';
const controller = (cliSha256: string, admittedBuilds?: readonly NativeCliBuild[]) => new NativeUiController({ sessionId: 's', cliSha256,
  ...(admittedBuilds ? { admittedBuilds } : {}), port: { request: vi.fn(async () => ({})) }, writeTerminal: vi.fn(), isIdle: () => true });
const snapshot = (cliSha256: string, text = WAIT): NativeUiSnapshot => ({ sessionId: 's', cliSha256, revision: 1, text });
function quota(cliSha256: string, admittedBuilds?: readonly NativeCliBuild[]) {
  const current = snapshot(cliSha256);
  const ui: Pick<NativeUiController, 'snapshot' | 'run'> = { snapshot: () => current,
    run: <T>(_operation: string, action: (tx: NativeUiTransaction) => Promise<T>) => action({} as NativeUiTransaction) };
  return new NativeQuotaControls({ ui, turnEpoch: () => 0, ...(admittedBuilds ? { admittedBuilds } : {}) });
}

// session.ts may only declare the option on its fixture-supplied controls and forward it unchanged.
const FORWARD = /admittedBuilds\??:\s*(?:readonly NativeCliBuild\[\]|this\.options\.controls[!?]?\.admittedBuilds\b)/;
/** Ways production code could pass a second argument to the admission lookups or reach the fixture seam; whole-file matches see calls split across lines, a trailing comma is not a second argument. */
function seamBypasses(name: string, text: string): string[] {
  const at = (offset: number) => `${name}:${text.slice(0, offset).split('\n').length}`;
  const patterns = [/\b(?:nativeCliBuild|nativeQuotaView)\s*\((?:[^()]|\([^()]*\))*,(?=\s*[^\s)])/g, /\b(?:nativeCliBuild|nativeQuotaView)\s+as\b/g,
    /['"`][^'"`\n]*native-cli-maintenance\/candidate[^'"`\n]*['"`]/g];
  const found = patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => `${at(match.index)}: ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`));
  text.split('\n').forEach((line, index) => {
    if (line.includes('admittedBuilds') && !(name === 'main/native/session.ts' && FORWARD.test(line))) found.push(`${name}:${index + 1}: ${line.trim()}`);
  });
  return found;
}

describe('fixture admission seam for a staged CLI build', () => {
  it('lists the stable build first and then the latest build', () => {
    expect(NATIVE_CLI_BUILDS.map((build) => build.version)).toEqual(['2.1.311', '2.1.322']);
    expect(NATIVE_CLI_BUILDS.map((build) => build.sha256)).toEqual(['966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680',
      '345996b4bdbae21d817f750fae2f34cbf8d81224a5444c78136091d121beb298']);
    expect(Object.isFrozen(NATIVE_CLI_BUILDS) && NATIVE_CLI_BUILDS.every((build) => Object.isFrozen(build))).toBe(true);
    for (const build of NATIVE_CLI_BUILDS) {
      expect(nativeCliBuild(build.sha256.toUpperCase())).toBe(build);
      expect(controller(build.sha256).supported).toBe(true);
      expect(nativeQuotaView(snapshot(build.sha256))).not.toBeNull();
    }
  });

  it('keeps the default admission: the listed build only', async () => {
    expect(nativeCliBuild(LISTED)).toBe(NATIVE_CLI_BUILDS[0]);
    expect(nativeCliBuild(STAGED.sha256)).toBeUndefined();
    expect(controller(LISTED).supported).toBe(true);
    expect(controller(UNKNOWN).supported).toBe(false);
    expect(controller(STAGED.sha256).supported).toBe(false);
    await expect(controller(UNKNOWN).run('settings.effort', async () => 'driven')).rejects.toThrow('not verified');
    await expect(controller(LISTED).run('settings.effort', async () => 'driven')).resolves.toBe('driven');
    expect(nativeQuotaView(snapshot(LISTED))).not.toBeNull();
    expect(nativeQuotaView(snapshot(UNKNOWN))).toBeNull();
    expect(quota(LISTED).observe()).toMatchObject({ phase: 'native-waiting' });
    expect(quota(STAGED.sha256).observe()).toEqual({ phase: 'idle' });
  });

  it('admits exactly the injected sha256 and nothing else, not even the listed build', async () => {
    const seam = [STAGED];
    expect(nativeCliBuild(STAGED.sha256, seam)).toBe(STAGED);
    expect(nativeCliBuild(LISTED, seam)).toBeUndefined();
    expect(nativeCliBuild(UNKNOWN, seam)).toBeUndefined();
    expect(controller(STAGED.sha256, seam).supported).toBe(true);
    await expect(controller(STAGED.sha256, seam).run('settings.effort', async () => 'driven')).resolves.toBe('driven');
    expect(controller(LISTED, seam).supported).toBe(false);
    expect(controller(UNKNOWN, seam).supported).toBe(false);
    await expect(controller(UNKNOWN, seam).run('settings.effort', async () => 'driven')).rejects.toThrow('not verified');
    expect(controller(STAGED.sha256, []).supported).toBe(false);
    expect(nativeQuotaView(snapshot(STAGED.sha256), seam)).toMatchObject({ phase: 'waiting' });
    expect(nativeQuotaView(snapshot(LISTED), seam)).toBeNull();
    expect(quota(STAGED.sha256, seam).observe()).toMatchObject({ phase: 'native-waiting' });
    expect(quota(LISTED, seam).observe()).toEqual({ phase: 'idle' });
    expect(quota(UNKNOWN, seam).observe()).toEqual({ phase: 'idle' });
  });

  it('is never passed by production code under src/', () => {
    const root = join(process.cwd(), 'src');
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(directory, entry.name)) : /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : []);
    const definitions = new Set(['main/native/cliBuilds.ts', 'main/native/controls.ts', 'main/native/nativeQuotaControls.ts']);
    const offending = files(root).flatMap((file) => {
      const name = relative(root, file).replaceAll('\\', '/');
      return definitions.has(name) ? [] : seamBypasses(name, readFileSync(file, 'utf8'));
    });
    expect(files(root).length).toBeGreaterThan(50);
    expect(offending).toEqual([]);
  });

  it('recognizes a bypass across line breaks, through an alias or through the maintenance candidate module, and allows the forwarding forms', () => {
    expect(seamBypasses('x.ts', 'const a = nativeCliBuild(sha256, seam);')).toHaveLength(1);
    expect(seamBypasses('x.ts', 'const a = nativeCliBuild(\n  sha256,\n  seam,\n);')).toHaveLength(1);
    expect(seamBypasses('x.ts', 'const a = nativeQuotaView(\n  snapshot(x, y)\n  , seam);')).toHaveLength(1);
    expect(seamBypasses('x.ts', "import { nativeCliBuild as listed } from './cliBuilds';")).toHaveLength(1);
    expect(seamBypasses('x.ts', "import { candidateControls } from '../../tools/native-cli-maintenance/candidate';")).toHaveLength(1);
    expect(seamBypasses('x.ts', "const m = await import(`../tools/native-cli-maintenance/candidate.ts`);")).toHaveLength(1);
    expect(seamBypasses('x.ts', 'const a = { admittedBuilds: [] };')).toHaveLength(1);
    expect(seamBypasses('x.ts', 'const a = nativeCliBuild(sha256);\nconst b = nativeQuotaView(snapshot(a, b));\nconst c = nativeCliBuild(\n  f(x),\n);')).toEqual([]);
    expect(seamBypasses('main/native/session.ts', 'controls?: { admittedBuilds?: readonly NativeCliBuild[] };\n  admittedBuilds: this.options.controls.admittedBuilds,')).toEqual([]);
    expect(seamBypasses('other.ts', 'controls?: { admittedBuilds?: readonly NativeCliBuild[] };')).toHaveLength(1);
  });
});
