import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NativeUiController, NativeTerminalScreen, NATIVE_UI_PINNED_SHA256, type NativeUiSnapshot } from '../../src/main/native/controls';
import { NATIVE_SESSION_MODELS, NativeSessionSettings, nativeEffortChip, nativeEffortView, nativeModelView, type NativeSessionEffort } from '../../src/main/native/sessionSettings';

// Fixture-only effort chip and session-setting cases; captures from private acceptance runs are not part of this source.
const levels: NativeSessionEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const labels = '                             low     medium     high     xhigh      max';
function effortPanel(level: NativeSessionEffort): string {
  const column = labels.indexOf(level, level === 'high' ? labels.indexOf('medium') : 0) + Math.floor((level.length - 1) / 2);
  return `Effort\n\n${' '.repeat(column)}▲\n${labels}\nUltracode: dynamic workflows on every task\n\n←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`;
}
const defaultRows = ['Default (recommended) Use the default model (currently Opus 5.5)', ...NATIVE_SESSION_MODELS.map((item) => `${item.label} New ${item.display} Native description`)];
function modelPanel(selected = 2, rows = defaultRows): string {
  return `Select model\nYour pick becomes the default for new sessions.\n\n${rows.map((label, index) => `${selected === index + 1 ? '>' : ' '} ${index + 1}. ${label}`).join('\n')}\n\nEnter to set as default · s to use this session only · Esc to cancel`;
}
const snapshot = (text: string): NativeUiSnapshot => ({ text, sessionId: 'fixture', cliSha256: NATIVE_UI_PINNED_SHA256, revision: 1 });
const defaultChoices = NATIVE_SESSION_MODELS.map((item, index) => ({ model: item.model, ordinal: index + 2 }));
const defaultChoice = { model: 'claude-opus-5-5', ordinal: 1 };

function fixture(options: { preferenceChange?: boolean; getterMismatch?: boolean; malformed?: boolean; selectedModelRow?: number; forcedEffort?: string; modelRows?: string[]; effortHint?: 'missing-confirm' | 'wrapped-session-only' } = {}) {
  let effort: NativeSessionEffort = 'xhigh', model = 'claude-opus-5-5';
  let active: 'effort' | 'model' | undefined; let selectedModel = options.selectedModelRow ?? 2;
  let resolveCommand: (() => void) | undefined; let changed = false;
  const keys: string[] = [];
  let ui: NativeUiController;
  const render = (text: string) => { ui.observeTerminal(`\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`); };
  const currentEffortPanel = () => {
    let panel = effortPanel(effort);
    if (options.effortHint) panel = panel.replace('Enter to confirm · ', '');
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
        const selected = NATIVE_SESSION_MODELS.find((item) => isDefault ? row.includes(`(currently ${item.display})`) : row.startsWith(`${item.label} `));
        if (active === 'model') model = options.getterMismatch ? 'other' : selected!.model;
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
    expect(nativeModelView(snapshot(modelPanel(2, [...defaultRows, 'Opus Opus 5.5 duplicate'])))).toBeUndefined();
    expect(nativeModelView(snapshot(modelPanel(2).replace('3. Fable', '2. Fable')))).toBeUndefined();
    expect(nativeModelView(snapshot(modelPanel(2, [...defaultRows, defaultRows[0]])))).toBeUndefined();
  });
  it('reads the picker whether the CLI draws its ASCII or its Unicode pointer', () => {
    // 2.1.308 under TERM=xterm-256color; without it the same build draws '>' and '√'.
    const unicode = [
      '   Select model',
      '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
      '     1. Default (recommended)  Use the default model (currently Opus 5.5) · $4/$20 per Mtok',
      '   ❯ 2. Opus ✔                 Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok',
      '     3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok',
      '     4. Sonnet                 Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok',
      '     5. Haiku                  Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)',
      '   ◉ xHigh effort ←/→ to adjust',
      '   Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n');
    expect(nativeModelView(snapshot(unicode))).toEqual({ selected: 2, choices: defaultChoices, defaultChoice });
    expect(nativeModelView(snapshot(unicode.replace('❯ 2.', '  2.').replace('  3. Fable', '› 3. Fable'))))
      .toEqual({ selected: 3, choices: defaultChoices, defaultChoice });
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
    lines[38] = '   Effort'; lines[41] = ' '.repeat(69) + '▲';
    lines[42] = ' '.repeat(39) + 'low     medium     high     xhigh      max';
    lines[47] = '   ←/→ to adjust · s for this session only · Esc to cancel';
    const screen = new NativeTerminalScreen(140, 48); screen.write(lines.join('\r\n'));
    const projected = screen.text().split('\n');
    expect(projected[38].trim()).toBe('Effort'); expect(projected[41].indexOf('▲')).toBe(69);
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
    const complete = effortPanel('xhigh').replace('Enter to confirm · ', '');
    const malformed = [
      complete.replace(/^Effort/, 'Other panel'), complete.replace('low     medium', 'low     unknown'),
      complete.replace('▲', '▲▲'), complete.replace(/^ +▲$/m, '▲'),
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
    for (const model of ['claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']) {
      await expect(f.settings.setModel(model)).resolves.toEqual({ model, scope: 'session' });
    }
    expect(f.keys).toEqual(['\x1b[B', 's', '\x1b[B', 's', '\x1b[B', 's', '\x1b[A', '\x1b[A', '\x1b[A', 's']);
    f.ui.close();
  });
  it('maps only the four native family aliases to their verified row IDs', async () => {
    const f = fixture();
    for (const item of NATIVE_SESSION_MODELS) await expect(f.settings.setModel(item.alias)).resolves.toEqual({ model: item.model, scope: 'session' });
    expect(f.keys.filter((key) => key === 's')).toHaveLength(4);
    expect(f.keys).not.toContain('\r'); expect(f.keys).not.toContain('\n');
    f.ui.close();
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
