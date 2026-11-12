import { NATIVE_POINTER, NativeControlGate, type NativeUiController, type NativeUiSnapshot, type NativeUiWaitOptions } from './controls.ts';

export type NativeSessionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly NativeSessionEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Picker labels and native getter IDs verified without model requests. `fable` is Fable 5.2 from CLI 2.1.321, but on an
 * older build, or where the account's model catalog still targets 5.1, the same alias draws and runs Fable 5.1. Both are
 * listed; the row the picker draws decides which one a selection means, and the getter must report that one.
 */
export const NATIVE_SESSION_MODELS = [
  { model: 'claude-opus-5-5', alias: 'opus', label: 'Opus', display: 'Opus 5.5' },
  { model: 'claude-fable-5-2', alias: 'fable', label: 'Fable', display: 'Fable 5.2' },
  { model: 'claude-fable-5-1', alias: 'fable', label: 'Fable', display: 'Fable 5.1' },
  { model: 'claude-sonnet-5-5', alias: 'sonnet', label: 'Sonnet', display: 'Sonnet 5.5' },
  { model: 'claude-haiku-5-5', alias: 'haiku', label: 'Haiku', display: 'Haiku 5.5' },
] as const;
export type NativeSessionModel = typeof NATIVE_SESSION_MODELS[number]['model'];

export interface NativeEffortView { selected: NativeSessionEffort }
export interface NativeModelView {
  selected: number;
  choices: Array<{ model: NativeSessionModel; ordinal: number }>;
  defaultChoice?: { model: NativeSessionModel; ordinal: number };
}

/**
 * The footer's effort chip ("◉ xhigh · /effort", with ultracode on "◈ max · ultracode · /effort"), under the composer or in a
 * docked dialog's top border. From CLI 2.1.312 a level picked mid-task reads "◉ high · may wait for your next message" until
 * that message is sent.
 */
export function nativeEffortChip(lines: readonly string[]): NativeSessionEffort | undefined {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  for (let index = end - 1; index >= Math.max(0, end - 16); index--) {
    const match = /(?:^|\s)(low|medium|high|xhigh|max)(?:\s+·\s+ultracode)?\s+·\s+(?:\/effort|may wait for your next message)(?:\s|$)/.exec(lines[index]);
    if (match) return match[1] as NativeSessionEffort;
  }
  return undefined;
}

function panel(text: string, heading: string, footer: RegExp): string[] | undefined {
  const lines = text.split('\n');
  const start = lines.findLastIndex((line) => line.trim() === heading);
  if (start < 0 || !footer.test(lines.slice(start).join(' '))) return undefined;
  return lines.slice(start);
}

/** Label/selection guards on the shared projector's screen, not another VT parser. */
export function nativeEffortView(snapshot: NativeUiSnapshot): NativeEffortView | undefined {
  const lines = panel(snapshot.text, 'Effort', /s\s+for\s+this\s+session\s+only.*Esc\s+to\s+cancel/i);
  // The adapter uses guarded arrows, s or Escape, never the unrelated Enter action.
  if (!lines) return undefined;
  const labels = lines.find((line) => /\blow\s+medium\s+high\s+xhigh\s+max\b/.test(line));
  const gauges = lines.filter((line) => line.includes('\u25b2'));
  if (!labels || gauges.length !== 1) return undefined;
  const pointer = gauges[0].indexOf('\u25b2');
  if (pointer !== gauges[0].lastIndexOf('\u25b2')) return undefined;
  const positions = EFFORTS.map((level) => {
    const match = new RegExp(`\\b${level}\\b`).exec(labels);
    return { level, distance: match ? Math.abs(pointer - (match.index + (level.length - 1) / 2)) : Infinity };
  }).sort((a, b) => a.distance - b.distance);
  if (positions[0].distance > 4 || positions[0].distance === positions[1].distance) return undefined;
  return { selected: positions[0].level };
}

const SELECTED_ROW = new RegExp(`^\\s*${NATIVE_POINTER}\\s*(\\d+)\\.\\s*(.+)$`);
const NUMBERED_ROW = new RegExp(`^\\s*(?:${NATIVE_POINTER}\\s*)?(\\d+)\\.\\s*(.+)$`);
const pattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(' ', '\\s+');

/**
 * The two layouts of a picker row (after its number). Built-in rows put the family label first and the model's name at
 * the start of the description ("Fable   Fable 5.2 · Most capable …"); cells right of a short label can keep stale
 * characters, so anything may sit between the two, but the name must end at " ·" or the row's end: a subscriber's 1M rows
 * read "Opus (1M context)   Opus 5.5 with 1M context · …" and "Sonnet 5.5 (1M context)   Sonnet 5.5 for long sessions"
 * (2.1.322 `tm()`/`_d()`, the same in 2.1.311). An `availableModels` row for an older model ends with the newer one
 * ("Fable 5.1   Newer version available · select Fable for Fable 5.2", `ds()`), so a name after "for" is not the row's
 * model. A served catalog's rows (2.1.322 `fm()`) are labelled with the model's name
 * itself and carry the catalog's own description ("Fable 5.2   For your toughest challenges"); the name must be followed
 * by the current-model mark or the column gap, so "Fable 5.2 (1M context)" is another model.
 */
function rowNamesModel(text: string, item: typeof NATIVE_SESSION_MODELS[number]): boolean {
  const name = pattern(item.display);
  return new RegExp(`^${item.label}\\b.*(?<!\\bfor\\s+)\\b${name}(?=\\s+\\u00b7|\\s*$)`).test(text) || new RegExp(`^${name}(?:\\s+[\\u2714\\u221a])?(?:\\s{2,}|$)`).test(text);
}

export function nativeModelView(snapshot: NativeUiSnapshot): NativeModelView | undefined {
  const lines = panel(snapshot.text, 'Select model', /Enter\s+to\s+set\s+as\s+default.*s\s+to\s+use\s+this\s+session\s+only.*Esc\s+to\s+cancel/i);
  if (!lines) return undefined;
  const selected = lines.map((line) => SELECTED_ROW.exec(line)).filter((match) => match !== null);
  const rows = lines.map((line) => NUMBERED_ROW.exec(line)).filter((match) => match !== null)
    .map((match) => ({ ordinal: Number(match[1]), text: match[2] }));
  if (selected.length !== 1 || rows.length === 0 || rows.some((row) => row.ordinal < 1 || row.ordinal > 20) || new Set(rows.map((row) => row.ordinal)).size !== rows.length) return undefined;
  const selectedRow = Number(selected[0][1]);
  if (!rows.some((row) => row.ordinal === selectedRow)) return undefined;
  const choices: NativeModelView['choices'] = [];
  for (const item of NATIVE_SESSION_MODELS) {
    const matches = rows.filter((row) => rowNamesModel(row.text, item));
    if (matches.length > 1) return undefined;
    if (matches.length === 1) choices.push({ model: item.model, ordinal: matches[0].ordinal });
  }
  // One row naming two models identifies neither.
  if (new Set(choices.map((choice) => choice.ordinal)).size !== choices.length) return undefined;
  const defaults = rows.filter((row) => /^Default\b/.test(row.text));
  if (defaults.length > 1) return undefined;
  const defaultDisplay = defaults.length === 1 ? /\bUse\s+the\s+default\s+model\s+\(currently\s+([^()]+)\)/.exec(defaults[0].text)?.[1].trim() : undefined;
  const defaultModel = NATIVE_SESSION_MODELS.find((item) => item.display === defaultDisplay);
  return choices.length ? { selected: selectedRow, choices,
    ...(defaultModel ? { defaultChoice: { model: defaultModel.model, ordinal: defaults[0].ordinal } } : {}),
  } : undefined;
}

export interface NativeSessionSettingsOptions {
  ui: Pick<NativeUiController, 'run'>;
  readModel(): Promise<string>;
  /** CLAUDE_CODE_EFFORT_LEVEL outranks the native picker; read it from this native process. */
  readEffortEnvironment(): Promise<string | undefined>;
  /** Hash only persistent preference sources, not volatile native usage/session metadata. */
  preferenceFingerprint(): Promise<string>;
  wait?: NativeUiWaitOptions;
}

function fingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new NativeControlGate('settings', 'persistent preference fingerprint is not verified.');
  return value.toLowerCase();
}

export class NativeSessionSettings {
  private readonly options: NativeSessionSettingsOptions;
  constructor(options: NativeSessionSettingsOptions) { this.options = options; }

  setEffort(level: NativeSessionEffort): Promise<{ effort: NativeSessionEffort; scope: 'session' }> {
    if (!EFFORTS.includes(level)) return Promise.reject(new NativeControlGate('effort', 'unsupported native effort level.'));
    return this.options.ui.run('settings.effort', async (tx) => {
      const before = fingerprint(await this.options.preferenceFingerprint());
      if (await this.options.readEffortEnvironment()) throw new NativeControlGate('effort', 'a native effort environment override outranks this picker.');
      let snapshot = await tx.open('effort', '', (frame) => nativeEffortView(frame) !== undefined, this.options.wait);
      for (let moves = 0; moves <= EFFORTS.length; moves++) {
        const current = nativeEffortView(snapshot)?.selected;
        if (!current) throw new NativeControlGate('effort', 'native slider selection is ambiguous.');
        if (current === level) break;
        const direction = Math.sign(EFFORTS.indexOf(level) - EFFORTS.indexOf(current));
        const next = EFFORTS[EFFORTS.indexOf(current) + direction];
        snapshot = await tx.key(direction > 0 ? '\x1b[C' : '\x1b[D',
          (frame) => nativeEffortView(frame)?.selected === current,
          (frame) => nativeEffortView(frame)?.selected === next, this.options.wait);
      }
      if (nativeEffortView(snapshot)?.selected !== level) throw new NativeControlGate('effort', 'native slider did not select the requested effort.');
      const confirmation = new RegExp(`Set\\s+effort\\s+level\\s+to\\s+${level}\\s*\\(this\\s+session\\s+only\\)`, 'i');
      await tx.key('s', (frame) => nativeEffortView(frame)?.selected === level,
        (frame) => nativeEffortView(frame) === undefined && confirmation.test(frame.text), this.options.wait);
      if (await this.options.readEffortEnvironment()) throw new NativeControlGate('effort', 'the native effort environment override changed during selection.');
      if (fingerprint(await this.options.preferenceFingerprint()) !== before) throw new NativeControlGate('effort', 'native session-only selection changed persistent defaults.');
      return { effort: level, scope: 'session' };
    }, { cancelPanel: (snapshot) => nativeEffortView(snapshot) !== undefined });
  }

  setModel(model: string): Promise<{ model: string; scope: 'session' }> {
    const requested = NATIVE_SESSION_MODELS.filter((item) => item.model === model || item.alias === model);
    if (!requested.length && model !== 'default') return Promise.reject(new NativeControlGate('model', 'the requested native model or alias is not attested by this adapter.'));
    return this.options.ui.run('settings.model', async (tx) => {
      const before = fingerprint(await this.options.preferenceFingerprint());
      let snapshot = await tx.open('model', '', (frame) => nativeModelView(frame) !== undefined, this.options.wait);
      const view = nativeModelView(snapshot);
      // An alias with two attested models (fable) means the one the picker draws.
      const drawn = view?.choices.filter((item) => requested.some((entry) => entry.model === item.model)) ?? [];
      const choice = model === 'default' ? view?.defaultChoice : drawn.length === 1 ? drawn[0] : undefined;
      if (!choice) throw new NativeControlGate('model', model === 'default' ? 'the native Default row does not identify an attested model.'
        : drawn.length > 1 ? 'the native picker draws more than one attested model for this alias.' : 'the attested model is not available in this native catalog.');
      const target = choice.ordinal;
      const attested = NATIVE_SESSION_MODELS.find((item) => item.model === choice.model)!;
      const at = (frame: NativeUiSnapshot, selected: number) => {
        const view = nativeModelView(frame);
        const currentChoice = model === 'default' ? view?.defaultChoice : view?.choices.find((item) => item.model === attested.model);
        return Boolean(view && view.selected === selected && currentChoice?.model === attested.model && currentChoice.ordinal === target);
      };
      for (let moves = 0; moves < 20; moves++) {
        const current = nativeModelView(snapshot);
        if (!current) throw new NativeControlGate('model', 'native model selection is ambiguous.');
        if (current.selected === target) break;
        const direction = Math.sign(target - current.selected);
        snapshot = await tx.key(direction > 0 ? '\x1b[B' : '\x1b[A',
          (frame) => at(frame, current.selected),
          (frame) => at(frame, current.selected + direction), this.options.wait);
      }
      if (!at(snapshot, target)) throw new NativeControlGate('model', 'the attested native model row was not selected.');
      const display = pattern(attested.display);
      const confirmation = model === 'default'
        ? /Set\s+model\s+to\s+[^\n]+\s+for\s+this\s+session\s+only/i
        : new RegExp(`Set\\s+model\\s+to\\s+${display}\\s+for\\s+this\\s+session\\s+only`, 'i');
      await tx.key('s', (frame) => at(frame, target),
        (frame) => nativeModelView(frame) === undefined && confirmation.test(frame.text), this.options.wait);
      if (await this.options.readModel() !== attested.model) throw new NativeControlGate('model', 'the native session getter did not confirm the requested model.');
      if (fingerprint(await this.options.preferenceFingerprint()) !== before) throw new NativeControlGate('model', 'native session-only selection changed persistent defaults.');
      return { model: attested.model, scope: 'session' };
    }, { cancelPanel: (snapshot) => nativeModelView(snapshot) !== undefined });
  }
}
