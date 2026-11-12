import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@shared/events';
import type { EffortGuide, ModelOption } from '@shared/types';
import { PermissionBroker } from '../../src/main/engine/broker';
import type { NativeEvent, NativeLaunch, NativeReady, NativeRuntime } from '../../src/main/native/contract';
import { EFFORT_GUIDE_TIMEOUT_MS, MAX_CATALOG_BYTES, parseCliAccount, parseServedEffortGuides, readServedEffortGuides,
  servedCatalogFileName, withEffortGuides } from '../../src/main/native/effortGuide';
import { NativeInteractiveSession, type NativeInteractiveSessionOptions } from '../../src/main/native/session';

// Synthetic accounts only; the letters make the lowercasing observable.
const ORG = '0000000a-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-00000000000a';
// sha256('00000000-0000-4000-8000-00000000000a') starts 1ad35d608dd7b52a; of the upper-case form 0a653c23d2fc.
const CATALOG_FILE = `${ORG}-1ad35d608dd7-cc.json`;

const DESCRIPTION = 'Higher effort means more thorough responses, but takes longer and uses your limits faster.';
const OPUS_MAX = 'Claude thinks longer with Max effort and can consume 3.5× or more usage than Medium.';
const MAX_TOOLTIP = 'May use excessive tokens resulting in long response times and may hit token limits. Use sparingly for the hardest tasks.';
const RECOMMENDED = { message: 'Recommended', variant: 'neutral' };

type Option = Record<string, unknown>;
const option = (id: string, extra: Option = {}): Option => ({ id, name: id[0]!.toUpperCase() + id.slice(1), ...extra });
const levels = (notes: Record<string, Option>): Option[] =>
  ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => option(id, notes[id] ?? {}));
const effortModel = (id: string, name: string, effortOptions: unknown, thinking: Option = {}): Option => ({
  id, name, short_name: name.split(' ')[0], description: `${name} for everyday work`,
  thinking: { type: 'effort', description: DESCRIPTION, effort_options: effortOptions, ...thinking },
  fast_mode: null, quick_select: true, runtime: { effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'high' },
  min_claude_code_version: '2.1.300',
});

const MODELS: Option[] = [
  effortModel('claude-opus-5-5', 'Opus 5.5', levels({ medium: { badge: RECOMMENDED },
    max: { badge: { message: '3.5× or more usage', variant: 'warning' }, tooltip: { content: OPUS_MAX } } })),
  effortModel('claude-fable-5-1', 'Fable 5.1', levels({ high: { badge: RECOMMENDED }, max: { tooltip: { content: MAX_TOOLTIP } } })),
  effortModel('claude-sonnet-5-5', 'Sonnet 5.5', levels({ medium: { badge: RECOMMENDED }, max: { tooltip: { content: MAX_TOOLTIP } } })),
  effortModel('claude-haiku-5-5', 'Haiku 5.5', levels({ medium: { badge: RECOMMENDED }, max: { tooltip: { content: MAX_TOOLTIP } } })),
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', short_name: 'Haiku', description: 'Fastest model',
    thinking: { type: 'mode', description: 'Extended thinking', modes: ['off', 'on'] }, runtime: {}, min_claude_code_version: '2.1.0' },
];

const document = (models: unknown = MODELS, overrides: Option = {}, catalog: Option = {}) => JSON.stringify({
  version: 2, fetchedAt: 1_000, staleAt: 3_601_000,
  catalog: { surface: 'cc', config: { id: 'cc', models, settings_vocabulary: {}, provider_alias_targets: {} },
    state: { id: 'cc', model: 'claude-opus-5-5', selection_source: 'default', thinking: {}, thinking_by_model: {} }, ...catalog },
  ...overrides,
});

const neutral = (message: string) => ({ message, tone: 'neutral' as const });
const GENERIC: EffortGuide = { description: DESCRIPTION, levels: { medium: { badge: neutral('Recommended') }, max: { tooltip: MAX_TOOLTIP } } };
const EXPECTED: Record<string, EffortGuide> = {
  'claude-opus-5-5': { description: DESCRIPTION, levels: { medium: { badge: neutral('Recommended') },
    max: { badge: { message: '3.5× or more usage', tone: 'warning' }, tooltip: OPUS_MAX } } },
  'claude-fable-5-1': { description: DESCRIPTION, levels: { high: { badge: neutral('Recommended') }, max: { tooltip: MAX_TOOLTIP } } },
  'claude-sonnet-5-5': GENERIC,
  'claude-haiku-5-5': GENERIC,
};

const globalConfig = (oauthAccount?: Option) => JSON.stringify({ numStartups: 4, projects: { 'D:/work': { history: [] } },
  ...(oauthAccount ? { oauthAccount } : {}) });
const ACCOUNT_CONFIG = { accountUuid: ACCOUNT, emailAddress: 'me@example.invalid', organizationUuid: ORG,
  organizationType: 'claude_max', organizationName: 'Synthetic org' };

describe('the CLI catalog cache file of an OAuth account', () => {
  it('names it <org>-<first 12 hex of sha256(account)>-<surface>.json in lower case', () => {
    expect(servedCatalogFileName({ organizationUuid: ORG, accountUuid: ACCOUNT })).toBe(CATALOG_FILE);
    expect(servedCatalogFileName({ organizationUuid: ORG.toUpperCase(), accountUuid: ACCOUNT.toUpperCase() })).toBe(CATALOG_FILE);
    expect(servedCatalogFileName({ organizationUuid: ORG, accountUuid: ACCOUNT }, 'ccd')).toBe(`${ORG}-1ad35d608dd7-ccd.json`);
  });

  it('names nothing for ids that are not UUIDs', () => {
    for (const bad of ['org-1', '', `{${ORG}}`, `${ORG} `, `${ORG}0`, '../../secrets', ORG.replaceAll('-', '')]) {
      expect(servedCatalogFileName({ organizationUuid: bad, accountUuid: ACCOUNT })).toBeUndefined();
      expect(servedCatalogFileName({ organizationUuid: ORG, accountUuid: bad })).toBeUndefined();
    }
  });

  it('takes only the two ids of the OAuth account from the global config', () => {
    expect(parseCliAccount(globalConfig(ACCOUNT_CONFIG))).toEqual({ organizationUuid: ORG, accountUuid: ACCOUNT });
    expect(parseCliAccount(`\uFEFF${globalConfig(ACCOUNT_CONFIG)}`)).toEqual({ organizationUuid: ORG, accountUuid: ACCOUNT });
    expect(parseCliAccount(globalConfig())).toBeUndefined();
    expect(parseCliAccount(JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: null }))).toBeUndefined();
    expect(parseCliAccount(globalConfig({ ...ACCOUNT_CONFIG, accountUuid: undefined }))).toBeUndefined();
    expect(parseCliAccount(globalConfig({ ...ACCOUNT_CONFIG, organizationUuid: 42 }))).toBeUndefined();
    expect(parseCliAccount(globalConfig({ ...ACCOUNT_CONFIG, organizationUuid: 'org-1' }))).toBeUndefined();
    expect(parseCliAccount('{"oauthAccount": [1]}')).toBeUndefined();
    expect(parseCliAccount('not json')).toBeUndefined();
  });
});

describe('effort notes of the cached catalog', () => {
  it('keeps each effort model\'s description, badges and hover texts, and leaves out a model without effort levels', () => {
    expect(parseServedEffortGuides(document())).toEqual(EXPECTED);
    expect(parseServedEffortGuides(`\uFEFF${document()}`)).toEqual(EXPECTED);
  });

  it('reads nothing from another version or surface, or from a document that is not a catalog', () => {
    expect(parseServedEffortGuides(document(MODELS, { version: 1 }))).toEqual({});
    expect(parseServedEffortGuides(document(MODELS, { version: '2' }))).toEqual({});
    expect(parseServedEffortGuides(document(MODELS, {}, { surface: 'ccd' }))).toEqual({});
    expect(parseServedEffortGuides(document(MODELS, {}, { surface: undefined }))).toEqual({});
    expect(parseServedEffortGuides(document({ 0: MODELS[0] }))).toEqual({});
    expect(parseServedEffortGuides(document(MODELS, { catalog: null }))).toEqual({});
    expect(parseServedEffortGuides('not json')).toEqual({});
    expect(parseServedEffortGuides('[]')).toEqual({});
    expect(parseServedEffortGuides('')).toEqual({});
  });

  it('skips a malformed effort option but keeps the others of its model', () => {
    const opus = effortModel('claude-opus-5-5', 'Opus 5.5', [
      'max', null, option('turbo', { badge: RECOMMENDED }), option('ultra', { tooltip: { content: 'x' } }),
      option('low', { badge: { message: '', variant: 'neutral' } }),
      option('medium', { badge: RECOMMENDED, tooltip: 'not an object' }),
      option('high', { badge: { message: 'Recommended', variant: 'info' } }),
      option('xhigh', { badge: { message: '  Recommended  ' }, tooltip: null }),
      option('max', { badge: { message: '3.5× or more usage', variant: 'warning' }, tooltip: { content: OPUS_MAX } }),
      option('max', { badge: { message: 'A second max', variant: 'neutral' } }),
    ]);
    expect(parseServedEffortGuides(document([opus]))).toEqual({ 'claude-opus-5-5': { description: DESCRIPTION, levels: {
      high: { badge: neutral('Recommended') }, xhigh: { badge: neutral('Recommended') },
      max: { badge: { message: '3.5× or more usage', tone: 'warning' }, tooltip: OPUS_MAX } } } });
  });

  it('refuses texts with control characters, line breaks or bidirectional marks and texts over the length limits', () => {
    const notes = (badge: unknown, tooltip?: unknown) => parseServedEffortGuides(document([effortModel('claude-opus-5-5', 'Opus 5.5',
      [option('max', { badge: { message: badge, variant: 'warning' }, ...(tooltip === undefined ? {} : { tooltip: { content: tooltip } }) })])]))['claude-opus-5-5']?.levels.max;
    expect(notes('A'.repeat(60))).toEqual({ badge: { message: 'A'.repeat(60), tone: 'warning' } });
    expect(notes('A'.repeat(61))).toBeUndefined();
    expect(notes('Max', 'T'.repeat(300))).toEqual({ badge: { message: 'Max', tone: 'warning' }, tooltip: 'T'.repeat(300) });
    expect(notes('Max', 'T'.repeat(301))).toBeUndefined();
    expect(notes('Max', '   ')).toBeUndefined();
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
      .map((code) => `usage${String.fromCharCode(code)} 3.5x`);
    for (const unsafe of ['two\nlines', 'tab\there', 'bell\u0007', 'nul\u0000', 'csi\u009b31m', 'del\u007f', 'separator\u2028line',
      `paragraph${String.fromCharCode(0x2029)}break`, ...bidi]) {
      expect(notes(unsafe)).toBeUndefined();
      expect(notes('Max', unsafe)).toBeUndefined();
    }
    expect(notes(42)).toBeUndefined();
    const described = (description: unknown) => parseServedEffortGuides(document([effortModel('claude-opus-5-5', 'Opus 5.5', [], { description })]));
    expect(described('D'.repeat(300))).toEqual({ 'claude-opus-5-5': { description: 'D'.repeat(300), levels: {} } });
    expect(described('D'.repeat(301))).toEqual({});
    expect(described('first\nsecond')).toEqual({});
    expect(described(`Higher effort${String.fromCharCode(0x202e)} means more`)).toEqual({});
  });

  it('skips a malformed model, and a model with no usable description and no usable level notes', () => {
    const notes = levels({ medium: { badge: RECOMMENDED } });
    const result = parseServedEffortGuides(document([
      null, 'claude-opus-5-5', effortModel('gpt-5', 'Other', notes), effortModel('claude-', 'Empty id', notes),
      effortModel('claude-Opus-5-5', 'Upper case', notes), effortModel(`claude-${'a'.repeat(65)}`, 'Long id', notes),
      effortModel('claude-opus-5-5', 'Opus 5.5', 'not a list'),
      effortModel('claude-opus-5-5', 'Opus 5.5', notes, { type: 'mode' }),
      effortModel('claude-fable-5-1', 'Fable 5.1', levels({}), { description: 42 }),
      effortModel('claude-sonnet-5-5', 'Sonnet 5.5', notes, { description: 'x'.repeat(301) }),
      effortModel('claude-haiku-5-5', 'Haiku 5.5', [], { description: DESCRIPTION }),
      effortModel('claude-opus-5-5', 'Opus 5.5', notes),
      effortModel('claude-opus-5-5', 'A second Opus 5.5', levels({ max: { badge: RECOMMENDED } })),
      { id: 'claude-opus-4-1', name: 'Opus 4.1' },
    ]));
    expect(result).toEqual({
      'claude-sonnet-5-5': { levels: { medium: { badge: neutral('Recommended') } } },
      'claude-haiku-5-5': { description: DESCRIPTION, levels: {} },
      'claude-opus-5-5': { description: DESCRIPTION, levels: { medium: { badge: neutral('Recommended') } } },
    });
  });
});

describe('reading the cached catalog of a profile', () => {
  let root = '';
  let home = '';
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'relay-effort-')));
    home = join(root, 'home');
    await mkdir(home, { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const writeCatalog = async (configRoot: string, name: string, text: string) => {
    await mkdir(join(configRoot, 'cache', 'model-catalog'), { recursive: true });
    await writeFile(join(configRoot, 'cache', 'model-catalog', name), text);
  };

  it('reads the default profile\'s catalog through the account in the home folder\'s global config', async () => {
    const configRoot = join(home, '.claude');
    await writeFile(join(home, '.claude.json'), globalConfig(ACCOUNT_CONFIG));
    await writeCatalog(configRoot, CATALOG_FILE, document());
    expect(await readServedEffortGuides({ configDir: null, configRoot, home })).toEqual(EXPECTED);
  });

  it('reads a separate profile\'s own config folder, not the home folder\'s account', async () => {
    const configDir = join(root, 'profiles', 'work');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(home, '.claude.json'), globalConfig({ ...ACCOUNT_CONFIG, accountUuid: '00000000-0000-4000-8000-000000000099' }));
    await writeFile(join(configDir, '.claude.json'), globalConfig(ACCOUNT_CONFIG));
    await writeCatalog(configDir, CATALOG_FILE, document());
    expect(await readServedEffortGuides({ configDir, configRoot: configDir, home })).toEqual(EXPECTED);
    expect(await readServedEffortGuides({ configDir: null, configRoot: configDir, home })).toEqual({});
  });

  it('reads only the CLI surface file of the signed-in account', async () => {
    const configRoot = join(home, '.claude');
    await writeFile(join(home, '.claude.json'), globalConfig(ACCOUNT_CONFIG));
    const decoy = document();
    for (const name of [`${ORG}-1ad35d608dd7-ccd.json`, `${ORG}-1ad35d608dd7-cc.headless-failed.json`, `tok-1ad35d608dd7-cc.json`,
      `key-1ad35d608dd7-cc.json`, `${ORG}-0a653c23d2fc-cc.json`]) await writeCatalog(configRoot, name, decoy);
    expect(await readServedEffortGuides({ configDir: null, configRoot, home })).toEqual({});
    await writeCatalog(configRoot, CATALOG_FILE, document([MODELS[1]]));
    expect(await readServedEffortGuides({ configDir: null, configRoot, home })).toEqual({ 'claude-fable-5-1': EXPECTED['claude-fable-5-1'] });
  });

  it('reads nothing for a file over the size limit', async () => {
    const configRoot = join(home, '.claude');
    await writeFile(join(home, '.claude.json'), globalConfig(ACCOUNT_CONFIG));
    const text = document();
    await writeCatalog(configRoot, CATALOG_FILE, text);
    const size = Buffer.byteLength(text);
    expect(MAX_CATALOG_BYTES).toBe(2 * 1024 * 1024 + 4096);
    expect(await readServedEffortGuides({ configDir: null, configRoot, home, maxBytes: size - 1 })).toEqual({});
    expect(await readServedEffortGuides({ configDir: null, configRoot, home, maxBytes: size })).toEqual(EXPECTED);
    await writeCatalog(configRoot, CATALOG_FILE, document(MODELS, { padding: ' '.repeat(MAX_CATALOG_BYTES) }));
    expect(await readServedEffortGuides({ configDir: null, configRoot, home })).toEqual({});
  });

  it('reads nothing when the global config is over its size limit', async () => {
    const configRoot = join(home, '.claude');
    const config = globalConfig(ACCOUNT_CONFIG);
    await writeFile(join(home, '.claude.json'), config);
    await writeCatalog(configRoot, CATALOG_FILE, document());
    const size = Buffer.byteLength(config);
    expect(await readServedEffortGuides({ configDir: null, configRoot, home, maxConfigBytes: size - 1 })).toEqual({});
    expect(await readServedEffortGuides({ configDir: null, configRoot, home, maxConfigBytes: size })).toEqual(EXPECTED);
  });

  it('reads nothing through a catalog file that is a link', async () => {
    const configRoot = join(home, '.claude');
    await writeFile(join(home, '.claude.json'), globalConfig(ACCOUNT_CONFIG));
    const real = join(root, 'linked-catalog.json');
    await writeFile(real, document());
    await mkdir(join(configRoot, 'cache', 'model-catalog'), { recursive: true });
    const linked = join(configRoot, 'cache', 'model-catalog', CATALOG_FILE);
    try { await symlink(real, linked, 'file'); } catch { return; }
    expect(await readServedEffortGuides({ configDir: null, configRoot, home })).toEqual({});
    await rm(linked);
    await writeCatalog(configRoot, CATALOG_FILE, document());
    expect(await readServedEffortGuides({ configDir: null, configRoot, home })).toEqual(EXPECTED);
  });

  it('reads nothing without an OAuth account, and resolves when files are missing or not files', async () => {
    const configRoot = join(home, '.claude');
    await writeCatalog(configRoot, CATALOG_FILE, document());
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await writeFile(join(home, '.claude.json'), globalConfig());
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: null }));
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await writeFile(join(home, '.claude.json'), '{broken');
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await rm(join(home, '.claude.json'));
    await mkdir(join(home, '.claude.json'));
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await rm(join(home, '.claude.json'), { recursive: true });
    await writeFile(join(home, '.claude.json'), globalConfig(ACCOUNT_CONFIG));
    await rm(join(configRoot, 'cache', 'model-catalog', CATALOG_FILE));
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await mkdir(join(configRoot, 'cache', 'model-catalog', CATALOG_FILE));
    await expect(readServedEffortGuides({ configDir: null, configRoot, home })).resolves.toEqual({});
    await expect(readServedEffortGuides({ configDir: join(root, 'missing'), configRoot: join(root, 'missing'), home })).resolves.toEqual({});
  });
});

describe('effort notes on the model rows', () => {
  const opus = EXPECTED['claude-opus-5-5']!, sonnet = EXPECTED['claude-sonnet-5-5']!;

  it('matches a row by its value or an equivalent, a 1M variant by its base model, and leaves Default and unknown rows alone', () => {
    const rows: ModelOption[] = [
      { value: 'default', label: 'default', catalogSource: 'native-config' },
      { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'] },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { value: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M context)' },
      { value: 'sonnet[1m]', label: 'Sonnet 5.5 (1M context)', equivalentValues: ['sonnet[1m]', 'claude-sonnet-5-5[1m]'] },
      { value: 'provider/custom-model', label: 'Custom' },
      { value: 'haiku', label: 'Haiku 4.5', equivalentValues: ['haiku', 'claude-haiku-4-5'] },
    ];
    const before = structuredClone(rows);
    const result = withEffortGuides(rows, { ...EXPECTED, default: GENERIC });
    expect(result.map((row) => row.effortGuide)).toEqual([undefined, opus, sonnet, opus, sonnet, undefined, undefined]);
    expect(rows).toEqual(before);
    for (const index of [0, 5, 6]) expect(result[index]).toBe(rows[index]);
    expect(result[1]).not.toBe(rows[1]);
    expect(result[1]).toEqual({ ...rows[1], effortGuide: opus });
  });

  it('takes the first candidate that has notes and ignores equivalents that are not strings', () => {
    const fable = EXPECTED['claude-fable-5-1']!;
    const result = withEffortGuides([
      { value: 'claude-fable-5-1', label: 'Fable', equivalentValues: ['claude-opus-5-5'] },
      { value: 'opus', label: 'Opus', equivalentValues: [7, null, 'claude-opus-5-5'] as unknown as string[] },
      { value: 'sonnet', label: 'Sonnet', equivalentValues: 'claude-sonnet-5-5' as unknown as string[] },
    ], EXPECTED);
    expect(result.map((row) => row.effortGuide)).toEqual([fable, opus, undefined]);
    expect(withEffortGuides([], EXPECTED)).toEqual([]);
    expect(withEffortGuides([{ value: 'opus', label: 'Opus', equivalentValues: ['opus', 'claude-opus-5-5'] }], {})[0]).not.toHaveProperty('effortGuide');
  });
});

const LAUNCH: NativeLaunch = { exe: 'D:\\synthetic\\claude.exe', args: [], cwd: 'D:\\synthetic', env: {}, handleId: 'h' };

function nativeSession(effortGuides: NativeInteractiveSessionOptions['effortGuides'], capabilities: string[] = ['config.list'],
  modelList: unknown = []) {
  const ready: NativeReady = { sessionId: 'native-session', isInteractive: true, surface: 'terminal', protocol: 1, capabilities, cwd: LAUNCH.cwd };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'config.list') return [{ key: 'model', value: 'opus', kind: 'choice', isLocked: false, options: ['default', 'opus', 'sonnet', 'opus[1m]'] }];
    if (method === 'model.list') return modelList;
    return {};
  });
  const runtime: NativeRuntime = { start: async () => ready, request,
    onEvent: (_listener: (event: NativeEvent) => void) => () => undefined, onExit: () => () => undefined, onTerminal: () => () => undefined,
    writeTerminal: async () => undefined, resize: async () => undefined, close: async () => undefined };
  const events: EngineEvent[] = [];
  const broker = new PermissionBroker('h', (event) => events.push(event));
  const session = new NativeInteractiveSession({ handleId: 'h', runtime, launch: LAUNCH, effortGuides,
    request: { cwd: LAUNCH.cwd, profileId: 'default' }, profile: { id: 'default', name: 'Default', configDir: null, createdAt: 0 },
    broker, emit: (event) => events.push(event) });
  return { session, events, request };
}

const PLAIN_ROWS: ModelOption[] = [{ value: 'default', label: 'default', catalogSource: 'native-config' },
  { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'] },
  { value: 'sonnet', label: 'Sonnet 5.5', catalogSource: 'native-config', equivalentValues: ['sonnet', 'claude-sonnet-5-5'] }];

describe('the native session model list', () => {
  it('attaches the catalog notes each time the list is read, on the config path and the model.list path', async () => {
    const reader = vi.fn(async () => EXPECTED);
    const config = nativeSession(reader);
    await config.session.start();
    const rows = await config.session.models();
    expect(rows).toEqual([
      { value: 'default', label: 'default', catalogSource: 'native-config' },
      { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'], effortGuide: EXPECTED['claude-opus-5-5'] },
      { value: 'sonnet', label: 'Sonnet 5.5', catalogSource: 'native-config', equivalentValues: ['sonnet', 'claude-sonnet-5-5'], effortGuide: EXPECTED['claude-sonnet-5-5'] },
    ]);
    await config.session.models();
    expect(reader).toHaveBeenCalledTimes(2);
    await config.session.close();

    const bridgeGuide = { description: 'From the bridge', levels: { max: { badge: { message: 'Unchecked', tone: 'warning' } } } };
    const fable = ['fable', 'claude-fable-5-2', 'claude-fable-5-1'];
    const listed = nativeSession(reader, ['model.list'], [
      { value: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M context)', effortGuide: bridgeGuide },
      { value: 'provider/custom', label: 'Custom', effortGuide: bridgeGuide },
      // Per-model notes from the bridge are dropped the same way.
      { value: 'fable', label: 'Fable', equivalentValues: fable, effortGuideByModel: { 'claude-fable-5-2': bridgeGuide, 'claude-fable-5-1': bridgeGuide } },
      { value: 'provider/other', label: 'Other', effortGuideByModel: { 'claude-other-1': bridgeGuide } }, { value: 7 }]);
    await listed.session.start();
    expect(await listed.session.models()).toEqual([
      { value: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M context)', effortGuide: EXPECTED['claude-fable-5-1'] },
      { value: 'provider/custom', label: 'Custom' },
      { value: 'fable', label: 'Fable', equivalentValues: fable, effortGuideByModel: { 'claude-fable-5-1': EXPECTED['claude-fable-5-1'] } },
      { value: 'provider/other', label: 'Other' },
    ]);
    await listed.session.close();
  });

  it('still lists the models when the notes cannot be read', async () => {
    for (const reader of [() => { throw new Error('Synthetic reader fault'); }, async () => { throw new Error('Synthetic reader rejection'); },
      undefined]) {
      const h = nativeSession(reader as NativeInteractiveSessionOptions['effortGuides']);
      await h.session.start();
      expect(await h.session.models()).toEqual(PLAIN_ROWS);
      expect(h.events.some((event) => event.type === 'error')).toBe(false);
      await h.session.close();
    }
  });

  it('lists the models without notes once a read takes too long, and starts no second read while it still runs', async () => {
    const reader = vi.fn(() => new Promise<Record<string, EffortGuide>>(() => undefined));
    const h = nativeSession(reader);
    await h.session.start();
    vi.useFakeTimers();
    try {
      let first: ModelOption[] | undefined;
      void h.session.models().then((rows) => { first = rows; });
      await vi.advanceTimersByTimeAsync(EFFORT_GUIDE_TIMEOUT_MS - 1);
      expect(first).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(first).toEqual(PLAIN_ROWS);
      let second: ModelOption[] | undefined;
      void h.session.models().then((rows) => { second = rows; });
      await vi.advanceTimersByTimeAsync(EFFORT_GUIDE_TIMEOUT_MS);
      expect(second).toEqual(PLAIN_ROWS);
      expect(reader).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await h.session.close();
  });

  it('shares one running read between model lists asked for together and clears its timer', async () => {
    let release: (guides: Record<string, EffortGuide>) => void = () => undefined;
    const reader = vi.fn(() => new Promise<Record<string, EffortGuide>>((resolve) => { release = resolve; }));
    const h = nativeSession(reader);
    await h.session.start();
    vi.useFakeTimers();
    try {
      const both = Promise.all([h.session.models(), h.session.models()]);
      expect(reader).toHaveBeenCalledTimes(1);
      release(EXPECTED);
      const [first, second] = await both;
      expect(first.map((row) => row.effortGuide)).toEqual([undefined, EXPECTED['claude-opus-5-5'], EXPECTED['claude-sonnet-5-5']]);
      expect(second).toEqual(first);
      expect(reader).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      const later = h.session.models();
      expect(reader).toHaveBeenCalledTimes(2);
      release({});
      await expect(later).resolves.toEqual(PLAIN_ROWS);
    } finally {
      vi.useRealTimers();
    }
    await h.session.close();
  });
});
