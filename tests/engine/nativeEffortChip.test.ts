import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NativeUiController, NativeTerminalScreen, NATIVE_UI_PINNED_SHA256, type NativeUiSnapshot } from '../../src/main/native/controls';
import { NATIVE_SESSION_MODELS, NativeSessionSettings, nativeEffortChip, nativeEffortView, nativeModelView, type NativeSessionEffort } from '../../src/main/native/sessionSettings';

// Fixture-only effort chip and session-setting cases; captures from private acceptance runs are not part of this source.
const levels: NativeSessionEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const labels = '                             low     medium     high     xhigh      max';
function effortPanel(level: NativeSessionEffort): string {
  const column = labels.indexOf(level, level === 'high' ? labels.indexOf('medium') : 0) + Math.floor((level.length - 1) / 2);
  return `Effort\n\n${' '.repeat(column)}\u25b2\n${labels}\nUltracode: dynamic workflows on every task\n\n\u2190/\u2192 to adjust \u00b7 Enter to confirm \u00b7 s for this session only \u00b7 Esc to cancel`;
}
// The picker draws one Fable row, the model its `fable` alias runs: Fable 5.2 on 2.1.322, Fable 5.1 on 2.1.311.
const drawnModels = (fable: 'claude-fable-5-2' | 'claude-fable-5-1' = 'claude-fable-5-2') => NATIVE_SESSION_MODELS.filter((item) => item.alias !== 'fable' || item.model === fable);
// "New" stands for stale cells right of the label; the model's name opens the description, as the CLI writes it.
const rowsFor = (models: ReturnType<typeof drawnModels>) => ['Default (recommended) Use the default model (currently Opus 5.5)', ...models.map((item) => `${item.label} New ${item.display} · Native description`)];
const defaultRows = rowsFor(drawnModels());
function modelPanel(selected = 2, rows = defaultRows): string {
  return `Select model\nYour pick becomes the default for new sessions.\n\n${rows.map((label, index) => `${selected === index + 1 ? '>' : ' '} ${index + 1}. ${label}`).join('\n')}\n\nEnter to set as default \u00b7 s to use this session only \u00b7 Esc to cancel`;
}
const snapshot = (text: string): NativeUiSnapshot => ({ text, sessionId: 'fixture', cliSha256: NATIVE_UI_PINNED_SHA256, revision: 1 });
const choicesFor = (models: ReturnType<typeof drawnModels>) => models.map((item, index) => ({ model: item.model, ordinal: index + 2 }));
const defaultChoices = choicesFor(drawnModels());
const defaultChoice = { model: 'claude-opus-5-5', ordinal: 1 };

function fixture(options: { preferenceChange?: boolean; getterMismatch?: boolean; reportModel?: string; malformed?: boolean; selectedModelRow?: number; forcedEffort?: string; modelRows?: string[]; effortHint?: 'missing-confirm' | 'wrapped-session-only' } = {}) {
  let effort: NativeSessionEffort = 'xhigh', model = 'claude-opus-5-5';
  let active: 'effort' | 'model' | undefined; let selectedModel = options.selectedModelRow ?? 2;
  let resolveCommand: (() => void) | undefined; let changed = false;
  const keys: string[] = [];
  let ui: NativeUiController;
  const render = (text: string) => { ui.observeTerminal(`\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`); };
  const currentEffortPanel = () => {
    let panel = effortPanel(effort);
    if (options.effortHint) panel = panel.replace('Enter to confirm \u00b7 ', '');
    return options.effortHint === 'wrapped-session-only' ? panel.replace('s for this session only', 's for this session\nonly') : panel;
  };
  ui = new NativeUiController({ sessionId: 'fixture', cliSha256: NATIVE_UI_PINNED_SHA256, isIdle: () => true,
    port: { request: async (_method, args) => {
      active = (args as { command: 'effort' | 'model' }).command;
      render(options.malformed ? 'Unrecognized native dialog' : active === 'effort' ? currentEffortPanel() : modelPanel(selectedModel, options.modelRows));
      return new Promise<void>((resolve) => { resolveCommand = resolve; });
    } },
    writeTerminal: (key) => {
      keys.push(key);
      if (key === '\x1b') {
        render('Canceled native picker'); active = undefined; resolveCommand?.(); return;
      }
      if (key === 's') {
        changed = Boolean(options.preferenceChange);
        const row = (options.modelRows ?? defaultRows)[selectedModel - 1];
        const isDefault = row.startsWith('Default ');
        const selected = NATIVE_SESSION_MODELS.find((item) => isDefault ? row.includes(`(currently ${item.display})`) : row.startsWith(`${item.label} `) && row.includes(item.display));
        if (active === 'model') model = options.getterMismatch ? 'other' : options.reportModel ?? selected!.model;
        render(active === 'effort' ? `Set effort level to ${effort} (this session only)` : `Set model to ${isDefault ? `Default (${selected!.display})` : selected!.display} for this session only`);
        active = undefined; resolveCommand?.(); return;
      }
      if (active === 'effort') { effort = levels[levels.indexOf(effort) + (key === '\x1b[C' ? 1 : -1)]; render(currentEffortPanel()); }
      else { selectedModel += key === '\x1b[B' ? 1 : -1; render(modelPanel(selectedModel, options.modelRows)); }
    },
  });
  const settings = new NativeSessionSettings({ ui, readModel: async () => model,
    readEffortEnvironment: async () => options.forcedEffort,
    preferenceFingerprint: async () => (changed ? 'b' : 'a').repeat(64), wait: { timeoutMs: 100, stableMs: 1 } });
  return { ui, settings, keys };
}

describe('native effort chip', () => {
  const footer = (chip: string) => [`${' '.repeat(80)}${chip}`, '─'.repeat(40), '>', '─'.repeat(40), '  ⏸ manual mode on · ? for shortcuts', ''];
  it('reads the 2.1.308 idle footer capture', async () => {
    const idle = await readFile(new URL('./fixtures/native-panel/idle.txt', import.meta.url), 'utf8');
    expect(nativeEffortChip(idle.split('\n'))).toBe('xhigh');
  });
  it('reads the chip in both builds’ shapes, including 2.1.312’s note for a level picked mid-task', () => {
    expect(nativeEffortChip(footer('◉ high · /effort'))).toBe('high');
    expect(nativeEffortChip(footer('effort: max · /effort'))).toBe('max');
    expect(nativeEffortChip(footer('◉ high · may wait for your next message'))).toBe('high');
    expect(nativeEffortChip(footer('effort: low · may wait for your next message'))).toBe('low');
  });
  it('reads the chip with ultracode on, in 2.1.308’s committed and 2.1.312’s pending form', () => {
    expect(nativeEffortChip(footer('◈ max · ultracode · /effort'))).toBe('max');
    expect(nativeEffortChip(footer('◉ high · ultracode · may wait for your next message'))).toBe('high');
    expect(nativeEffortChip(footer('◉ high · ultracode'))).toBeUndefined();
  });
  it('reads nothing from a footer without a chip or with another suffix', () => {
    expect(nativeEffortChip(footer(''))).toBeUndefined();
    expect(nativeEffortChip(footer('◉ high · may wait'))).toBeUndefined();
    expect(nativeEffortChip(footer('◉ high · /effortless'))).toBeUndefined();
  });
});

describe('native session-only settings', () => {
  it('recognizes only a complete native slider and numbered model selection', () => {
    expect(nativeEffortView(snapshot(effortPanel('xhigh')))).toEqual({ selected: 'xhigh' });
    expect(nativeEffortView(snapshot(effortPanel('max')))).toEqual({ selected: 'max' });
    expect(nativeEffortView(snapshot('Effort xhigh s'))).toBeUndefined();
    expect(nativeModelView(snapshot(modelPanel(2)))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    expect(nativeModelView(snapshot(modelPanel(2).replace('s to use this session only', 'Enter to save')))).toBeUndefined();
    expect(nativeModelView(snapshot(modelPanel(2, [...defaultRows, 'Opus Opus 5.5 · duplicate'])))).toBeUndefined();
    expect(nativeModelView(snapshot(modelPanel(2).replace('3. Fable', '2. Fable')))).toBeUndefined();
    expect(nativeModelView(snapshot(modelPanel(2, [...defaultRows, defaultRows[0]])))).toBeUndefined();
  });
  // The rows as CLI 2.1.322 writes them: its Fable row names Fable 5.2 at $8/$40.
  const picker322 = [
    '   Select model',
    '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
    '',
    '     1. Default (recommended)  Use the default model (currently Opus 5.5) · $4/$20 per Mtok',
    '   ❯ 2. Opus ✔                 Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok',
    '     3. Fable                  Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok',
    '     4. Sonnet                 Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok',
    '     5. Haiku                  Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)',
    '',
    '   ◉ xHigh effort ←/→ to adjust',
    '',
    '   Enter to set as default · s to use this session only · Esc to cancel',
  ];
  it('reads the picker whether the CLI draws its ASCII or its Unicode pointer', () => {
    // Under TERM=xterm-256color the CLI draws '❯' and '✔'; without it '>' and '√'.
    const unicode = picker322.join('\n');
    expect(nativeModelView(snapshot(unicode))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    expect(nativeModelView(snapshot(unicode.replace('❯ 2.', '  2.').replace('  3. Fable', '› 3. Fable'))))
      .toEqual({ selected: 3, choices: defaultChoices, defaultChoice });
  });
  it('reads the 2.1.322 survey’s /model capture', async () => {
    const capture = await readFile(new URL('./fixtures/native-panel/model.open.txt', import.meta.url), 'utf8');
    expect(nativeModelView(snapshot(capture))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
  });
  // A claude.ai subscriber's built-in picker (2.1.322 `dm()`, its `Ct()` branch, the same templates in 2.1.311): the
  // Default row names the model without "(currently …)", rows carry no prices, and with the 1M entitlement `tm()` and
  // `_d()` add "Opus (1M context)" and "Sonnet 5.5 (1M context)". The Fable row is `ZS()`, added for first-party sign-ins.
  const subscriber = (fable: string, extended: boolean) => [
    '   Select model',
    '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
    '',
    '     1. Default (recommended)    Opus 5.5 · Best for everyday, complex tasks',
    '   ❯ 2. Opus ✔                   Opus 5.5 · Best for everyday, complex tasks',
    ...extended ? ['     3. Opus (1M context)        Opus 5.5 with 1M context · Draws from usage credits'] : [],
    `     ${extended ? 4 : 3}. Sonnet                   Sonnet 5.5 · Efficient for routine tasks`,
    ...extended ? ['     5. Sonnet 5.5 (1M context)  Sonnet 5.5 for long sessions'] : [],
    `     ${extended ? 6 : 4}. Haiku                    Haiku 5.5 · Fastest for quick answers`,
    `     ${extended ? 7 : 5}. Fable                    ${fable} · Most capable for your hardest and longest-running tasks`,
    '',
    '   ◉ xHigh effort ←/→ to adjust',
    '',
    '   Enter to set as default · s to use this session only · Esc to cancel',
  ].join('\n');
  it('reads a subscriber’s picker with and without the 1M rows on both builds, never taking a 1M row for the plain model', () => {
    for (const [fable, model] of [['Fable 5.2', 'claude-fable-5-2'], ['Fable 5.1', 'claude-fable-5-1']] as const) {
      const ordinals = (extended: boolean) => extended ? { opus: 2, sonnet: 4, haiku: 6, fable: 7 } : { opus: 2, sonnet: 3, haiku: 4, fable: 5 };
      for (const extended of [false, true]) {
        const at = ordinals(extended);
        expect(nativeModelView(snapshot(subscriber(fable, extended))), `${fable} ${extended}`).toEqual({ selected: 2, choices: [
          { model: 'claude-opus-5-5', ordinal: at.opus }, { model, ordinal: at.fable }, { model: 'claude-sonnet-5-5', ordinal: at.sonnet },
          { model: 'claude-haiku-5-5', ordinal: at.haiku }] });
      }
    }
  });
  it('selects the plain Opus and Sonnet rows on a subscriber’s picker that also draws their 1M rows', async () => {
    const rows = subscriber('Fable 5.2', true).split('\n').filter((line) => /^\s*(?:❯\s*)?\d+\./.test(line)).map((line) => line.replace(/^\s*(?:❯\s*)?\d+\.\s*/, ''));
    const f = fixture({ modelRows: rows });
    await expect(f.settings.setModel('sonnet')).resolves.toEqual({ model: 'claude-sonnet-5-5', scope: 'session' });
    await expect(f.settings.setModel('opus')).resolves.toEqual({ model: 'claude-opus-5-5', scope: 'session' });
    await expect(f.settings.setModel('fable')).resolves.toEqual({ model: 'claude-fable-5-2', scope: 'session' });
    expect(f.keys.filter((key) => key === 's')).toHaveLength(3);
    f.ui.close();
  });
  it('reads an availableModels row for the older Fable as Fable 5.1 only, whichever description the CLI gives it', () => {
    // 2.1.322 `ds()` (the same in 2.1.311): the row of a listed older model ends with the newer one, or names its own ID.
    const withOlder = (description: string) => [...picker322.slice(0, 8), `     6. Fable 5.1              ${description}`, ...picker322.slice(8)].join('\n');
    const both = [{ model: 'claude-opus-5-5', ordinal: 2 }, { model: 'claude-fable-5-2', ordinal: 3 }, { model: 'claude-fable-5-1', ordinal: 6 },
      { model: 'claude-sonnet-5-5', ordinal: 4 }, { model: 'claude-haiku-5-5', ordinal: 5 }];
    for (const description of ['Newer version available · select Fable for Fable 5.2', 'Most capable for your hardest and longest-running tasks (claude-fable-5-1)']) {
      expect(nativeModelView(snapshot(withOlder(description))), description).toEqual({ selected: 2, choices: both, defaultChoice });
    }
  });
  it('reads 2.1.311’s Fable 5.1 row as Fable 5.1, never as Fable 5.2', () => {
    const picker311 = picker322.join('\n').replace('Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok',
      'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok');
    expect(nativeModelView(snapshot(picker311))).toEqual({ selected: 2, choices: choicesFor(drawnModels('claude-fable-5-1')), defaultChoice });
  });
  // A served catalog's picker (2.1.322 `hE()`/`fm()`, the same in 2.1.311's `X_`): the Default row, then each catalog row
  // labelled with its name and followed by the catalog's own description; older rows sit behind the unnumbered More
  // models row (▸ collapsed, ▾ opened) and are numbered after the others when opened. Names and descriptions are the
  // baked catalog's (2.1.322 seed, version 4371).
  const served = (fable: string, after: string[] = []) => [
    '   Select model',
    '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
    '',
    '     1. Default (recommended)  Use the default model (currently Opus 5.5)',
    '   ❯ 2. Opus 5.5 ✔             For complex work and everyday tasks',
    `     3. ${fable.padEnd(23)}For your toughest challenges`,
    '     4. Sonnet 5.5             Most efficient for simpler tasks',
    '     5. Haiku 5.5              Fastest for quick answers',
    ...after,
    '',
    '   ◉ xHigh effort ←/→ to adjust',
    '',
    '   Enter to set as default · s to use this session only · Esc to cancel',
  ].join('\n');
  it('reads a served catalog’s rows, which carry the model’s name as their label, without loosening model identity', () => {
    expect(nativeModelView(snapshot(served('Fable 5.2')))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    expect(nativeModelView(snapshot(served('Fable 5.1')))).toEqual({ selected: 2, choices: choicesFor(drawnModels('claude-fable-5-1')), defaultChoice });
    // Without TERM the current-model mark is '√'.
    expect(nativeModelView(snapshot(served('Fable 5.2').replace('❯ 2. Opus 5.5 ✔', '> 2. Opus 5.5 √'))))
      .toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    // Another model whose name starts the same, or a row whose label cell kept stale characters, is not attested.
    const others = served('Fable 5.2', ['     6. Opus 5.5 (1M context)  For complex work and everyday tasks', '     7. Fable 5.25             Synthetic']);
    expect(nativeModelView(snapshot(others))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    expect(nativeModelView(snapshot(served('Fable 5.2x')))?.choices).toEqual(defaultChoices.filter((choice) => choice.model !== 'claude-fable-5-2'));
    // A row naming both Fable models identifies neither, so the picker is refused.
    expect(nativeModelView(snapshot(served('Fable 5.2').replace('For your toughest challenges', 'Replaces Fable 5.1')))).toBeUndefined();
  });
  it('reads the unnumbered More models row collapsed or opened, and refuses the picker while that row has focus', () => {
    const collapsed = served('Fable 5.2', ['     ▸ More models']);
    expect(nativeModelView(snapshot(collapsed))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    const older = ['     6. Fable 5.1              For your toughest challenges', '     7. Opus 4.8               For complex work and everyday tasks'];
    const opened = served('Fable 5.2', ['     ▾ More models', ...older]);
    expect(nativeModelView(snapshot(opened))).toEqual({ selected: 2, choices: [{ model: 'claude-opus-5-5', ordinal: 2 }, { model: 'claude-fable-5-2', ordinal: 3 },
      { model: 'claude-fable-5-1', ordinal: 6 }, { model: 'claude-sonnet-5-5', ordinal: 4 }, { model: 'claude-haiku-5-5', ordinal: 5 }], defaultChoice });
    // With the More models row focused, the picker's hint is Enter to expand (or collapse) instead of the model actions.
    const modelHint = 'Enter to set as default · s to use this session only · Esc to cancel';
    const focused = (text: string, marker: string, action: string) => text.replace('❯ 2.', '  2.').replace(`     ${marker} More models`, `   ❯ ${marker} More models`)
      .replace(modelHint, `Enter to ${action} · Esc to cancel`);
    expect(nativeModelView(snapshot(focused(collapsed, '▸', 'expand')))).toBeUndefined();
    expect(nativeModelView(snapshot(focused(opened, '▾', 'collapse')))).toBeUndefined();
    // Either difference alone refuses: the hint without the session-only action, and a pointer on no numbered row.
    expect(nativeModelView(snapshot(collapsed.replace(modelHint, 'Enter to expand · Esc to cancel')))).toBeUndefined();
    expect(nativeModelView(snapshot(collapsed.replace('❯ 2.', '  2.').replace('     ▸ More models', '   ❯ ▸ More models')))).toBeUndefined();
  });
  it('changes effort through guarded arrows and s, never the default-saving Enter', async () => {
    const f = fixture();
    await expect(f.settings.setEffort('max')).resolves.toEqual({ effort: 'max', scope: 'session' });
    await expect(f.settings.setEffort('xhigh')).resolves.toEqual({ effort: 'xhigh', scope: 'session' });
    expect(f.keys).toEqual(['\x1b[C', 's', '\x1b[D', 's']);
    expect(f.ui.active()).toBe(false); f.ui.close();
  });
  it('recognizes session-only effort from the live 140x48 structural facts without an Enter hint', () => {
    const lines = Array.from({ length: 48 }, (_, index) => index < 38 ? `Synthetic history ${index}` : '');
    lines[38] = '   Effort'; lines[41] = ' '.repeat(69) + '\u25b2';
    lines[42] = ' '.repeat(39) + 'low     medium     high     xhigh      max';
    lines[47] = '   \u2190/\u2192 to adjust \u00b7 s for this session only \u00b7 Esc to cancel';
    const screen = new NativeTerminalScreen(140, 48); screen.write(lines.join('\r\n'));
    const projected = screen.text().split('\n');
    expect(projected[38].trim()).toBe('Effort'); expect(projected[41].indexOf('\u25b2')).toBe(69);
    expect(projected[42].indexOf('low')).toBe(39);
    expect(nativeEffortView({ ...snapshot(screen.text()), revision: screen.revision })).toEqual({ selected: 'xhigh' });
  });
  it.each(['missing-confirm', 'wrapped-session-only'] as const)('commits session-only effort with %s using only the verified arrow and s', async (effortHint) => {
    const f = fixture({ effortHint });
    try {
      await expect(f.settings.setEffort('max')).resolves.toEqual({ effort: 'max', scope: 'session' });
      expect(f.keys).toEqual(['\x1b[C', 's']); expect(f.ui.active()).toBe(false);
    } finally { f.ui.close(); }
  });
  it('still rejects a session-only effort panel without its exact title, labels, unique aligned pointer, s action or Escape footer', () => {
    const complete = effortPanel('xhigh').replace('Enter to confirm \u00b7 ', '');
    const malformed = [
      complete.replace(/^Effort/, 'Other panel'), complete.replace('low     medium', 'low     unknown'),
      complete.replace('\u25b2', '\u25b2\u25b2'), complete.replace(/^ +\u25b2$/m, '\u25b2'),
      complete.replace('s for this session only', 'Enter to save globally'), complete.replace('Esc to cancel', 'Unknown action'),
    ];
    for (const panel of malformed) expect(nativeEffortView(snapshot(panel))).toBeUndefined();
  });
  it('selects only the attested native model row and verifies the actual getter', async () => {
    const f = fixture({ selectedModelRow: 1 });
    await expect(f.settings.setModel('claude-opus-5-5')).resolves.toEqual({ model: 'claude-opus-5-5', scope: 'session' });
    expect(f.keys).toEqual(['\x1b[B', 's']);
    await expect(f.settings.setModel('unattested-model')).rejects.toThrow('attested');
    expect(f.keys).toEqual(['\x1b[B', 's']); f.ui.close();
  });
  it('selects all attested model families with native session-only commits', async () => {
    const f = fixture();
    for (const model of ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']) {
      await expect(f.settings.setModel(model)).resolves.toEqual({ model, scope: 'session' });
    }
    expect(f.keys).toEqual(['\x1b[B', 's', '\x1b[B', 's', '\x1b[B', 's', '\x1b[A', '\x1b[A', '\x1b[A', 's']);
    f.ui.close();
  });
  it('maps only the four native family aliases to their verified row IDs', async () => {
    const f = fixture();
    for (const item of drawnModels()) await expect(f.settings.setModel(item.alias)).resolves.toEqual({ model: item.model, scope: 'session' });
    expect(f.keys.filter((key) => key === 's')).toHaveLength(4);
    expect(f.keys).not.toContain('\r'); expect(f.keys).not.toContain('\n');
    f.ui.close();
  });
  it('takes fable as the Fable model the picker draws, 5.1 on a 2.1.311-shaped picker and 5.2 on a 2.1.322 one, and checks the getter against it', async () => {
    const older = fixture({ modelRows: rowsFor(drawnModels('claude-fable-5-1')) });
    await expect(older.settings.setModel('fable')).resolves.toEqual({ model: 'claude-fable-5-1', scope: 'session' });
    await expect(older.settings.setModel('claude-fable-5-1')).resolves.toEqual({ model: 'claude-fable-5-1', scope: 'session' });
    await expect(older.settings.setModel('claude-fable-5-2')).rejects.toThrow('not available');
    older.ui.close();
    const newer = fixture();
    await expect(newer.settings.setModel('fable')).resolves.toEqual({ model: 'claude-fable-5-2', scope: 'session' });
    await expect(newer.settings.setModel('claude-fable-5-1')).rejects.toThrow('not available');
    newer.ui.close();
    // The getter must report the model of the row the picker drew, not the other Fable.
    const mismatch = fixture({ reportModel: 'claude-fable-5-1' });
    await expect(mismatch.settings.setModel('fable')).rejects.toThrow('native session getter');
    mismatch.ui.close();
  });
  it('selects served catalog rows and refuses fable while the picker draws both Fable models', async () => {
    const servedRows = ['Default (recommended)  Use the default model (currently Opus 5.5)', 'Opus 5.5 ✔             For complex work and everyday tasks',
      'Fable 5.2              For your toughest challenges', 'Sonnet 5.5             Most efficient for simpler tasks', 'Haiku 5.5              Fastest for quick answers'];
    const f = fixture({ modelRows: servedRows });
    await expect(f.settings.setModel('fable')).resolves.toEqual({ model: 'claude-fable-5-2', scope: 'session' });
    await expect(f.settings.setModel('haiku')).resolves.toEqual({ model: 'claude-haiku-5-5', scope: 'session' });
    f.ui.close();
    const both = fixture({ modelRows: [...servedRows, 'Fable 5.1              For your toughest challenges'] });
    await expect(both.settings.setModel('fable')).rejects.toThrow('more than one attested model');
    expect(both.keys).toEqual(['\x1b']);
    await expect(both.settings.setModel('claude-fable-5-1')).resolves.toEqual({ model: 'claude-fable-5-1', scope: 'session' });
    both.ui.close();
  });
  it('rejects mixed, extended-context and unknown aliases before opening a native dialog', async () => {
    const f = fixture();
    for (const alias of ['best', 'opusplan', 'opus[1m]', 'sonnet[1m]', 'fable[1m]', 'claude-opus-5-5[1m]', 'OPUS', 'unknown']) {
      await expect(f.settings.setModel(alias)).rejects.toThrow('not attested');
    }
    expect(f.keys).toEqual([]); expect(f.ui.active()).toBe(false); f.ui.close();
  });
  it('selects the observed native Default row, not the current or assumed Opus model', async () => {
    const modelRows = defaultRows.map((row, index) => index === 0 ? row.replace('Opus 5.5', 'Sonnet 5.5') : row);
    const f = fixture({ selectedModelRow: 2, modelRows });
    await expect(f.settings.setModel('default')).resolves.toEqual({ model: 'claude-sonnet-5-5', scope: 'session' });
    expect(f.keys).toEqual(['\x1b[A', 's']); f.ui.close();
  });
  it('does not guess an absent, unknown-version or ambiguous native Default row', async () => {
    for (const row of ['Default (recommended) Use the default model', 'Default (recommended) Use the default model (currently Sonnet 9.9)', 'No default row']) {
      const f = fixture({ modelRows: defaultRows.map((value, index) => index === 0 ? row : value) });
      await expect(f.settings.setModel('default')).rejects.toThrow('Default row does not identify');
      expect(f.keys).toEqual(['\x1b']); expect(f.ui.active()).toBe(false); f.ui.close();
    }
  });
  it('requires the actual getter and unchanged defaults after selecting Default', async () => {
    const wrong = fixture({ getterMismatch: true });
    await expect(wrong.settings.setModel('default')).rejects.toThrow('native session getter');
    expect(wrong.keys).toEqual(['\x1b[A', 's']); expect(wrong.ui.active()).toBe(false); wrong.ui.close();
    const changed = fixture({ preferenceChange: true });
    await expect(changed.settings.setModel('default')).rejects.toThrow('persistent defaults');
    expect(changed.keys).toEqual(['\x1b[A', 's']); expect(changed.ui.active()).toBe(false); changed.ui.close();
  });
  it('uses observed row positions rather than hardcoded model ordinals', async () => {
    const f = fixture({ selectedModelRow: 3, modelRows: [defaultRows[0], defaultRows[4], defaultRows[1], defaultRows[2], defaultRows[3]] });
    await expect(f.settings.setModel('claude-haiku-5-5')).resolves.toEqual({ model: 'claude-haiku-5-5', scope: 'session' });
    expect(f.keys).toEqual(['\x1b[A', 's']); f.ui.close();
  });
  it('cancels the owned picker without selecting an absent or unverified family', async () => {
    const f = fixture({ modelRows: defaultRows.map((row) => row.replace('Haiku 5.5', 'Haiku 9.9')) });
    await expect(f.settings.setModel('claude-haiku-5-5')).rejects.toThrow('not available');
    expect(f.keys).toEqual(['\x1b']); expect(f.ui.active()).toBe(false); f.ui.close();
  });
  it('reports a defaults write without rollback or a false success after native command completion', async () => {
    const f = fixture({ preferenceChange: true });
    await expect(f.settings.setEffort('max')).rejects.toThrow('persistent defaults');
    expect(f.keys).toEqual(['\x1b[C', 's']); expect(f.ui.active()).toBe(false);
    expect(f.ui.recoveryError()).toBeUndefined();
    await expect(f.ui.run('manual-read', async () => 'input released, setting failed')).resolves.toBe('input released, setting failed');
    expect(f.keys).toEqual(['\x1b[C', 's']); f.ui.close();
  });
  it('quarantines an ambiguous pending dialog but still reports a mismatched getter after command completion', async () => {
    const bad = fixture({ malformed: true });
    await expect(bad.settings.setEffort('max')).rejects.toThrow('expected state');
    expect(bad.keys).toEqual([]); expect(bad.ui.active()).toBe(true); bad.ui.close();
    const wrong = fixture({ getterMismatch: true });
    await expect(wrong.settings.setModel('claude-opus-5-5')).rejects.toThrow('native session getter');
    expect(wrong.ui.active()).toBe(false); expect(wrong.ui.recoveryError()).toBeUndefined(); wrong.ui.close();
  });
  it('does not claim a picker value when the native environment overrides it', async () => {
    const f = fixture({ forcedEffort: 'max' });
    await expect(f.settings.setEffort('xhigh')).rejects.toThrow('environment override');
    expect(f.keys).toEqual([]); f.ui.close();
  });
});
