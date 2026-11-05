import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpStore } from '../../src/main/system/mcp';

let dir: string;
let userData: string;
let desktopPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relay-mcp-'));
  userData = join(dir, 'userData');
  desktopPath = join(dir, 'Claude', 'claude_desktop_config.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const SECRET = 'sk-super-secret-value';
const HEADER_SECRET = 'Bearer header-secret-value';

const writeDesktop = async (value: unknown): Promise<void> => {
  await mkdir(join(dir, 'Claude'), { recursive: true });
  await writeFile(desktopPath, typeof value === 'string' ? value : JSON.stringify(value));
};

const desktopConfig = {
  theme: 'dark',
  somethingElse: { token: 'must-not-be-read' },
  mcpServers: {
    blender: { command: 'uvx', args: ['blender-mcp'], env: { API_KEY: SECRET, PLAIN: 'x' } },
    remote: { type: 'http', url: 'https://example.com/mcp?token=abc', headers: { Authorization: HEADER_SECRET } },
    events: { type: 'sse', url: 'http://localhost:8080/sse' },
    plain: { command: 'node' },
  },
};

const newStore = () => createMcpStore(userData, { desktopConfigPath: desktopPath });
const readStoreFile = async (): Promise<{ version: number; servers: Array<Record<string, unknown>> }> =>
  JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as never;

describe('mcp store: desktop preview', () => {
  it('lists valid servers with env and header names only, masks url query strings, and marks existing names', async () => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    const preview = await store.previewDesktopImport();
    expect(preview.sourcePath).toBe(desktopPath);
    expect(preview.warnings).toEqual([]);
    expect(preview.servers).toEqual([
      { name: 'blender', transport: 'stdio', command: 'uvx', args: ['blender-mcp'], envKeys: ['API_KEY', 'PLAIN'], exists: false },
      { name: 'remote', transport: 'http', url: 'https://example.com/mcp', envKeys: ['Authorization'], exists: false },
      { name: 'events', transport: 'sse', url: 'http://localhost:8080/sse', envKeys: [], exists: false },
      { name: 'plain', transport: 'stdio', command: 'node', envKeys: [], exists: false },
    ]);
    const text = JSON.stringify(preview);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HEADER_SECRET);
    expect(text).not.toContain('token=abc');
    expect(text).not.toContain('must-not-be-read');

    await store.importFromDesktop(['plain']);
    const again = await store.previewDesktopImport();
    expect(again.servers.map((s) => [s.name, s.exists])).toEqual([
      ['blender', false],
      ['remote', false],
      ['events', false],
      ['plain', true],
    ]);
  });

  it('skips invalid entries with a warning that names the server and never shows values', async () => {
    await writeDesktop({
      mcpServers: {
        ok: { command: 'node' },
        noCommand: { args: ['x'] },
        badArgs: { command: 'node', args: [1, 2] },
        badEnv: { command: 'node', env: { A: 5 } },
        ftp: { type: 'http', url: 'ftp://example.com/x' },
        creds: { type: 'sse', url: `https://user:${SECRET}@example.com/` },
        urlOnly: { url: 'https://example.com/' },
        notObject: 'node',
        weird: { type: 'websocket', url: 'https://example.com/' },
        ['x'.repeat(101)]: { command: 'node' },
        '': { command: 'node' },
      },
    });
    const preview = await newStore().previewDesktopImport();
    expect(preview.servers.map((s) => s.name)).toEqual(['ok']);
    for (const name of ['noCommand', 'badArgs', 'badEnv', 'ftp', 'creds', 'urlOnly', 'notObject', 'weird']) {
      expect(preview.warnings.some((w) => w.includes(`"${name}"`))).toBe(true);
    }
    expect(preview.warnings).toHaveLength(10);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
  });

  it('returns an empty preview with a warning for a missing, corrupt or section-less file', async () => {
    const store = newStore();
    expect(await store.previewDesktopImport()).toEqual({
      sourcePath: desktopPath,
      servers: [],
      warnings: [expect.stringContaining('not found')],
    });

    await writeDesktop('{oops');
    expect((await store.previewDesktopImport()).warnings).toEqual([expect.stringContaining('not valid JSON')]);

    await writeDesktop({ mcpServers: ['a'] });
    expect((await store.previewDesktopImport()).warnings).toEqual([expect.stringContaining('no mcpServers')]);
  });

  it('does not log or touch anything else', async () => {
    await writeDesktop(desktopConfig);
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const store = newStore();
    await store.previewDesktopImport();
    await store.importFromDesktop(['blender']);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('mcp store: import and edit', () => {
  it('imports the named servers with env values, enabled, and never returns the values', async () => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    const list = await store.importFromDesktop(['blender', 'remote']);
    expect(list).toEqual([
      expect.objectContaining({ name: 'blender', transport: 'stdio', command: 'uvx', args: ['blender-mcp'], envKeys: ['API_KEY', 'PLAIN'], enabled: true, source: 'desktop' }),
      expect.objectContaining({ name: 'remote', transport: 'http', url: 'https://example.com/mcp', envKeys: ['Authorization'], enabled: true, source: 'desktop' }),
    ]);
    expect(typeof list[0]!.importedAt).toBe('number');
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(await store.list())).not.toContain(HEADER_SECRET);

    const stored = await readStoreFile();
    expect(stored.version).toBe(1);
    expect(stored.servers[0]).toMatchObject({ name: 'blender', env: { API_KEY: SECRET, PLAIN: 'x' } });
    expect(stored.servers[1]).toMatchObject({ name: 'remote', url: 'https://example.com/mcp?token=abc', headers: { Authorization: HEADER_SECRET } });
    expect((await readdir(userData)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await newStore().list()).toEqual(list);
  });

  it('re-reads the desktop file at import time and replaces same-named servers, enabled again', async () => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    await store.importFromDesktop(['blender', 'plain']);
    await store.setEnabled('blender', false);
    await writeDesktop({ mcpServers: { blender: { command: 'python', args: ['new.py'], env: { NEW: '1' } } } });
    const list = await store.importFromDesktop(['blender']);
    expect(list.map((s) => s.name)).toEqual(['blender', 'plain']);
    expect(list[0]).toMatchObject({ command: 'python', args: ['new.py'], envKeys: ['NEW'], enabled: true });
    expect(await store.enabledConfigs()).toMatchObject({ blender: { command: 'python', env: { NEW: '1' } } });
  });

  it.each([
    ['not an array', 'blender'],
    ['not strings', [1]],
    ['too many', Array.from({ length: 51 }, (_, i) => `s${i}`)],
    ['empty name', ['']],
    ['long name', ['x'.repeat(101)]],
  ])('rejects the argument (%s) and writes nothing', async (_name, names) => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    await expect(store.importFromDesktop(names as never)).rejects.toThrow();
    await expect(readFile(join(userData, 'mcp.json'), 'utf8')).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('rejects more than 50 names even when they all exist in the desktop file', async () => {
    const names = Array.from({ length: 51 }, (_, i) => `s${i}`);
    await writeDesktop({ mcpServers: Object.fromEntries(names.map((name) => [name, { command: 'node' }])) });
    const store = newStore();
    await expect(store.importFromDesktop(names)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
    expect(await store.importFromDesktop(names.slice(0, 50))).toHaveLength(50);
  });

  it('rejects names that are not valid servers in the desktop file without importing the others', async () => {
    await writeDesktop({ mcpServers: { ok: { command: 'node' }, bad: { args: [] } } });
    const store = newStore();
    await expect(store.importFromDesktop(['ok', 'bad'])).rejects.toThrow(/bad/);
    await expect(store.importFromDesktop(['ghost'])).rejects.toThrow(/ghost/);
    expect(await store.list()).toEqual([]);
  });

  it('a missing desktop file fails the import without writing', async () => {
    const store = newStore();
    await expect(store.importFromDesktop(['blender'])).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('setEnabled and remove validate the name and persist', async () => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    await store.importFromDesktop(['blender', 'plain']);
    const off = await store.setEnabled('plain', false);
    expect(off.find((s) => s.name === 'plain')?.enabled).toBe(false);
    expect((await newStore().list()).find((s) => s.name === 'plain')?.enabled).toBe(false);
    await expect(store.setEnabled('ghost', true)).rejects.toThrow(/ghost/);
    await expect(store.setEnabled('plain', 'yes' as never)).rejects.toThrow();
    await expect(store.remove('ghost')).rejects.toThrow(/ghost/);
    const left = await store.remove('plain');
    expect(left.map((s) => s.name)).toEqual(['blender']);
    expect((await newStore().list()).map((s) => s.name)).toEqual(['blender']);
  });

  it('serialises concurrent edits', async () => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    await Promise.all([
      store.importFromDesktop(['blender']),
      store.importFromDesktop(['plain']),
      store.importFromDesktop(['events']),
    ]);
    expect((await newStore().list()).map((s) => s.name)).toEqual(['blender', 'plain', 'events']);
  });
});

describe('mcp store: SDK configs and the stored file', () => {
  it('builds SDK configs for enabled servers only', async () => {
    await writeDesktop(desktopConfig);
    const store = newStore();
    await store.importFromDesktop(['blender', 'remote', 'events', 'plain']);
    await store.setEnabled('events', false);
    expect(await store.enabledConfigs()).toEqual({
      blender: { type: 'stdio', command: 'uvx', args: ['blender-mcp'], env: { API_KEY: SECRET, PLAIN: 'x' } },
      remote: { type: 'http', url: 'https://example.com/mcp?token=abc', headers: { Authorization: HEADER_SECRET } },
      plain: { type: 'stdio', command: 'node' },
    });
  });

  it('quarantines a corrupt mcp.json and starts empty', async () => {
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, 'mcp.json'), '{oops');
    expect(await newStore().list()).toEqual([]);
    expect((await readdir(userData)).some((f) => f.startsWith('mcp.json.invalid-'))).toBe(true);

    await writeFile(join(userData, 'mcp.json'), JSON.stringify({ servers: 'nope' }));
    expect(await newStore().list()).toEqual([]);
    expect((await readdir(userData)).filter((f) => f.startsWith('mcp.json.invalid-'))).toHaveLength(2);
  });

  it('a hand-edited file keeps its valid servers; invalid and duplicate ones are dropped', async () => {
    await mkdir(userData, { recursive: true });
    await writeFile(
      join(userData, 'mcp.json'),
      JSON.stringify({
        version: 1,
        servers: [
          { name: 'a', transport: 'stdio', command: 'node', enabled: true, source: 'desktop', importedAt: 5 },
          { name: 'a', transport: 'stdio', command: 'dup', enabled: true },
          { name: 'b', transport: 'stdio', enabled: true },
          { name: 'c', transport: 'http', url: 'file:///etc/passwd', enabled: true },
          { name: 'd', transport: 'http', url: 'https://example.com/x', headers: { H: 'v' } },
        ],
      }),
    );
    const list = await newStore().list();
    expect(list).toEqual([
      { name: 'a', transport: 'stdio', command: 'node', envKeys: [], enabled: true, source: 'desktop', importedAt: 5 },
      { name: 'd', transport: 'http', url: 'https://example.com/x', envKeys: ['H'], enabled: false, source: 'desktop', importedAt: 0 },
    ]);
  });
});
