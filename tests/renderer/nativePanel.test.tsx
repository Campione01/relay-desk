import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { NativePanel, NativePanelInput } from '@shared/types';
import {
  contrastRatio,
  panelKeyInput,
  readableColor,
  runStyle,
  type KeyPress,
} from '../../src/renderer/components/prompt/NativePanel';
import { applyEngineEvent, createView } from '../../src/renderer/state/sessionReducer';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

const CELL = 10;
const GRID_LEFT = 100;
const GRID_TOP = 200;
const LIGHT = { text: '#0b0b0b', background: '#ffffff' };

const PANEL: NativePanel = {
  revision: 1,
  command: 'config',
  columns: 60,
  mouse: true,
  styles: [{}, { fg: '#000000', bg: '#b1b9f9', bold: true }, { fg: '#999999' }, { inverse: true }],
  rows: [
    { runs: [{ text: '   Settings  Status  ', s: 0 }, { text: ' Config ', s: 1 }, { text: '  Usage', s: 0 }] },
    { runs: [] },
    { runs: [{ text: '  ', s: 0 }, { text: '設定', s: 0 }, { text: ' Auto-compact', s: 0 }, { text: ' ', s: 3 }] },
    { runs: [{ text: '  Type to filter · Esc to clear', s: 2 }] },
  ],
};

const panelOf = (patch: Partial<NativePanel> = {}): NativePanel => ({ ...structuredClone(PANEL), ...patch });

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

const sent = (api: Rendered['api']): NativePanelInput[] =>
  api.mock.panelCalls.flatMap((call) => (call.method === 'panelInput' ? [call.input] : []));

const settle = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const hue = (color: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return ((h * 60) + 360) % 360;
};

interface Opened extends Rendered {
  handleId: string;
  key: string;
  card: HTMLElement;
  input: HTMLTextAreaElement;
  grid: HTMLElement;
}

async function openPanel(patch: Partial<NativePanel> = {}): Promise<Opened> {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  act(() => rendered.api.mock.emitEngine({ type: 'panel', handleId, panel: panelOf(patch) }));
  const card = await screen.findByTestId('native-panel');
  return {
    ...rendered,
    handleId,
    key: rendered.controller.state.currentKey!,
    card,
    input: within(card).getByRole('textbox', { name: 'Type into panel' }) as HTMLTextAreaElement,
    grid: within(card).getByTestId('native-panel-grid'),
  };
}

/** Client point inside the given cell of the mocked grid. */
const at = (grid: HTMLElement, row: number, column: number): { clientX: number; clientY: number } => {
  const height = Number.parseFloat(grid.style.getPropertyValue('--rd-npanel-row'));
  return { clientX: GRID_LEFT + column * CELL + CELL / 2, clientY: GRID_TOP + row * height + height / 2 };
};

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this instanceof HTMLElement && this.dataset.probe) return rect(0, 0, CELL * 40, 16);
    if (this instanceof HTMLElement && this.dataset.testid === 'native-panel-grid') return rect(GRID_LEFT, GRID_TOP, 600, 64);
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('panel colors', () => {
  it('keeps a readable foreground and moves a faint one just far enough toward the theme text, keeping its hue', () => {
    expect(readableColor('#000000', '#b1b9f9', LIGHT.text)).toBe('#000000');
    expect(readableColor('#ececec', '#262626', '#ececec')).toBe('#ececec');
    const gray = readableColor('#999999', '#ffffff', LIGHT.text);
    expect(gray).not.toBe('#999999');
    expect(contrastRatio(gray, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(gray, '#ffffff')).toBeLessThan(3.4);
    const border = readableColor('#b1b9f9', '#ffffff', LIGHT.text);
    expect(contrastRatio(border, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(Math.abs(hue(border) - hue('#b1b9f9'))).toBeLessThan(3);
    const dark = readableColor('#3a3a3a', '#262626', '#ececec');
    expect(contrastRatio(dark, '#262626')).toBeGreaterThanOrEqual(3);
    // On a light background of its own, a dark theme's text color goes dark instead.
    expect(contrastRatio(readableColor('#ececec', '#b1b9f9', '#ececec'), '#b1b9f9')).toBeGreaterThanOrEqual(3);
  });

  it('swaps colors for inverse, fades dim text toward its background and keeps run backgrounds', () => {
    expect(runStyle({ inverse: true }, LIGHT)).toEqual({ backgroundColor: '#0b0b0b', color: '#ffffff' });
    expect(runStyle({ dim: true }, LIGHT).color).toBe('#858585');
    const onDark = runStyle({ bg: '#262626' }, LIGHT);
    expect(onDark.backgroundColor).toBe('#262626');
    expect(contrastRatio(onDark.color as string, '#262626')).toBeGreaterThanOrEqual(3);
    expect(runStyle({ bold: true, italic: true, underline: true, strike: true }, LIGHT)).toEqual({
      fontWeight: 600, fontStyle: 'italic', textDecoration: 'underline line-through',
    });
    expect(runStyle({}, LIGHT)).toEqual({});
  });
});

describe('panel keys', () => {
  const press = (key: string, extra: Partial<KeyPress> = {}): NativePanelInput | null =>
    panelKeyInput({ key, code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra });

  it('maps named keys, Shift+Tab and the CLI Ctrl letters; other combinations stay the app\'s', () => {
    expect(press('Tab', { shiftKey: true })).toEqual({ kind: 'key', key: 'shift-tab' });
    expect(press('Enter', { shiftKey: true })).toEqual({ kind: 'key', key: 'enter' });
    expect(press('ф', { code: 'KeyA', ctrlKey: true })).toEqual({ kind: 'ctrl', letter: 'a' });
    expect(press('c', { code: 'KeyC', ctrlKey: true })).toBeNull();
    expect(press('a', { code: 'KeyA', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press('Enter', { altKey: true })).toBeNull();
    expect(press('x')).toBeNull();
    expect(press('constructor')).toBeNull();
  });
});

describe('panel state in the session reducer', () => {
  const open = createView({ key: 'k', profileId: 'default', cwd: 'D:\\x', title: 't', handleId: 'h1', engineState: 'idle' });

  it('shows the newest revision, ignores stale ones and clears the panel on null or when the handle closes', () => {
    const shown = applyEngineEvent(open, { type: 'panel', handleId: 'h1', panel: panelOf({ revision: 2 }) }, 0);
    expect(shown.panel?.revision).toBe(2);
    expect(applyEngineEvent(shown, { type: 'panel', handleId: 'h1', panel: panelOf({ revision: 2 }) }, 0)).toBe(shown);
    expect(applyEngineEvent(shown, { type: 'panel', handleId: 'h1', panel: panelOf({ revision: 1 }) }, 0)).toBe(shown);
    const next = applyEngineEvent(shown, { type: 'panel', handleId: 'h1', panel: panelOf({ revision: 3 }) }, 0);
    expect(next.panel?.revision).toBe(3);
    expect(applyEngineEvent(next, { type: 'panel', handleId: 'h1', panel: null }, 0).panel).toBeUndefined();
    const closed = applyEngineEvent(next, { type: 'state', handleId: 'h1', state: 'closed' }, 0);
    expect(closed.panel).toBeUndefined();
    expect(applyEngineEvent(closed, { type: 'panel', handleId: 'h1', panel: panelOf({ revision: 4 }) }, 0).panel).toBeUndefined();
  });

  it('applies the effort a native panel changed like a reported value', () => {
    const init: Extract<EngineEvent, { type: 'init' }> = {
      type: 'init', handleId: 'h1', sessionId: 's', model: 'opus', slashCommands: [], tools: [], cwd: 'D:\\x',
    };
    const changed = applyEngineEvent({ ...open, effort: 'high' }, { ...init, effort: 'max' }, 0);
    expect(changed.effort).toBe('max');
    expect(applyEngineEvent(changed, init, 0).effort).toBe('max');
  });
});

describe('native panel card', () => {
  it('renders the rows on the cell grid with their styles and the selected tab background', async () => {
    const { card, grid } = await openPanel();
    expect(card).toHaveAttribute('role', 'region');
    expect(screen.getByRole('region', { name: '/config panel' })).toBe(card);
    expect(within(card).getByRole('heading', { name: '/config' })).toBeInTheDocument();
    expect(grid.style.getPropertyValue('--rd-npanel-cell')).toBe(`${CELL}px`);
    const rows = grid.querySelectorAll('.rd-npanel__row');
    expect(rows).toHaveLength(4);
    expect(rows[2]).toHaveTextContent('設定 Auto-compact');
    const tab = within(grid).getByText('Config');
    expect(tab).toHaveStyle({ backgroundColor: 'rgb(177, 185, 249)', color: 'rgb(0, 0, 0)', fontWeight: '600' });
    expect(within(grid).getByText('設').style.getPropertyValue('--rd-cells')).toBe('2');
    expect(within(grid).getByText('Auto-compact').style.getPropertyValue('--rd-cells')).toBe('13');
    const hint = within(grid).getByText('Type to filter');
    expect(hint.style.color).not.toBe('rgb(153, 153, 153)');
    expect(contrastRatio(hint.style.color, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(rows[2]!.lastElementChild).toHaveStyle({ backgroundColor: 'rgb(11, 11, 11)', color: 'rgb(255, 255, 255)' });
  });

  it('measures its cells on probes that never transition, so reduced motion cannot report the previous font size', async () => {
    // jsdom has no transitions; Chromium with reduced motion read the inherited 14px and drew 13px text on 14px cells.
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>('node:fs');
    const css = readFileSync('src/renderer/styles/nativePanel.css', 'utf8');
    expect(css.match(/\.rd-npanel__probes > span\s*\{([^}]+)\}/)?.[1]).toMatch(/transition:\s*none !important;/);
  });

  it('names a panel without a command generically', async () => {
    const { card } = await openPanel({ command: undefined });
    expect(card).toHaveAccessibleName('CLI panel');
    expect(within(card).getByRole('heading', { name: 'CLI panel' })).toBeInTheDocument();
  });

  it('takes the keyboard when it appears and gives it back to the composer when it closes', async () => {
    const { api, handleId, input } = await openPanel();
    await waitFor(() => expect(input).toHaveFocus());
    act(() => api.mock.emitEngine({ type: 'panel', handleId, panel: null }));
    expect(screen.queryByTestId('native-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus());
  });

  it('takes the keyboard again when its session comes back into view', async () => {
    const { controller, key, input } = await openPanel();
    await waitFor(() => expect(input).toHaveFocus());
    act(() => controller.showHome());
    act(() => controller.navigate(key));
    const again = within(await screen.findByTestId('native-panel')).getByRole('textbox', { name: 'Type into panel' });
    await waitFor(() => expect(again).toHaveFocus());
  });

  it('the close button closes it through the engine and the composer gets the keyboard', async () => {
    const { api, handleId, user, card } = await openPanel();
    await user.click(within(card).getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByTestId('native-panel')).not.toBeInTheDocument());
    expect(api.mock.panelCalls).toEqual([{ method: 'panelClose', handleId }]);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus());
  });

  it('sends every mapped key in order and keeps handled keys away from the rest of the app', async () => {
    const { api, input } = await openPanel();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    const keys: Array<[string, Partial<KeyboardEventInit>]> = [
      ['ArrowUp', {}], ['ArrowDown', {}], ['ArrowLeft', {}], ['ArrowRight', {}], ['Enter', {}], ['Escape', {}],
      ['Tab', {}], ['Tab', { shiftKey: true }], ['Backspace', {}], ['Delete', {}], ['Home', {}], ['End', {}],
      ['PageUp', {}], ['PageDown', {}], [' ', {}], ['a', { code: 'KeyA', ctrlKey: true }], ['b', { code: 'KeyB', ctrlKey: true }],
    ];
    for (const [key, init] of keys) expect(fireEvent.keyDown(input, { key, ...init })).toBe(false);
    expect(outside).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: 'c', code: 'KeyC', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter', repeat: true })).toBe(false);
    fireEvent.keyDown(input, { key: 'ArrowDown', repeat: true });
    window.removeEventListener('keydown', outside);
    await waitFor(() => expect(sent(api)).toHaveLength(18));
    expect(sent(api)).toEqual([
      { kind: 'key', key: 'up' }, { kind: 'key', key: 'down' }, { kind: 'key', key: 'left' }, { kind: 'key', key: 'right' },
      { kind: 'key', key: 'enter' }, { kind: 'key', key: 'escape' }, { kind: 'key', key: 'tab' }, { kind: 'key', key: 'shift-tab' },
      { kind: 'key', key: 'backspace' }, { kind: 'key', key: 'delete' }, { kind: 'key', key: 'home' }, { kind: 'key', key: 'end' },
      { kind: 'key', key: 'pageup' }, { kind: 'key', key: 'pagedown' }, { kind: 'key', key: 'space' },
      { kind: 'ctrl', letter: 'a' }, { kind: 'ctrl', letter: 'b' }, { kind: 'key', key: 'down' },
    ]);
    // Ctrl+B went to the panel, not to the sidebar toggle.
    expect(sidebar()).toBeInTheDocument();
  });

  it('sends typed text and clears the input', async () => {
    const { api, input, user } = await openPanel();
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard('ab');
    await waitFor(() => expect(sent(api)).toEqual([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]));
    expect(input).toHaveValue('');
  });

  it('sends an IME composition once, when it ends', async () => {
    const { api, input } = await openPanel();
    fireEvent.compositionStart(input, { data: '' });
    fireEvent.input(input, { target: { value: 'ㄋ' }, isComposing: true });
    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true });
    fireEvent.input(input, { target: { value: '你好' }, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(input, { data: '你好' });
    // A repeated report of the same commit is not a second input.
    fireEvent.input(input, { target: { value: '你好' } });
    await waitFor(() => expect(sent(api)).toEqual([{ kind: 'text', text: '你好' }]));
    expect(input).toHaveValue('');
    fireEvent.keyDown(input, { key: 'x' });
    fireEvent.input(input, { target: { value: 'x' } });
    await waitFor(() => expect(sent(api)).toEqual([{ kind: 'text', text: '你好' }, { kind: 'text', text: 'x' }]));
  });

  it('sends a paste as one pasted text', async () => {
    const { api, input } = await openPanel();
    const long = 'x'.repeat(5000);
    fireEvent.paste(input, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? 'D:\\demos\\demo' : '') } });
    fireEvent.paste(input, { clipboardData: { getData: () => long } });
    await waitFor(() => expect(sent(api)).toHaveLength(2));
    expect(sent(api)[0]).toEqual({ kind: 'text', text: 'D:\\demos\\demo', paste: true });
    expect(sent(api)[1]).toEqual({ kind: 'text', text: 'x'.repeat(4000), paste: true });
    expect(input).toHaveValue('');
  });

  it('maps a click to its row and column, wide CJK cells included, and focuses the input', async () => {
    const { api, grid, input } = await openPanel();
    act(() => input.blur());
    fireEvent.mouseDown(within(grid).getByText('Config'), { button: 0, ...at(grid, 0, 22) });
    fireEvent.mouseDown(within(grid).getByText('設'), { button: 0, ...at(grid, 2, 3) });
    fireEvent.mouseDown(within(grid).getByText('定'), { button: 0, ...at(grid, 2, 5) });
    fireEvent.mouseDown(within(grid).getByText('Auto-compact'), { button: 0, ...at(grid, 2, 7) });
    fireEvent.mouseDown(grid, { button: 2, ...at(grid, 2, 7) });
    fireEvent.mouseDown(grid, { button: 0, ...at(grid, 9, 1) });
    expect(input).toHaveFocus();
    await waitFor(() => expect(sent(api)).toHaveLength(4));
    expect(sent(api)).toEqual([
      { kind: 'mouse', action: 'click', row: 0, column: 22 },
      { kind: 'mouse', action: 'click', row: 2, column: 3 },
      { kind: 'mouse', action: 'click', row: 2, column: 5 },
      { kind: 'mouse', action: 'click', row: 2, column: 7 },
    ]);
  });

  it('sends the wheel for the hovered cell at most once per 40 ms', async () => {
    const { api, grid } = await openPanel();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(50_000);
    const target = within(grid).getByText('Auto-compact');
    expect(fireEvent.wheel(target, { deltaY: 120, ...at(grid, 2, 8) })).toBe(false);
    expect(fireEvent.wheel(target, { deltaY: -120, ...at(grid, 2, 8) })).toBe(false);
    vi.setSystemTime(50_050);
    fireEvent.wheel(target, { deltaY: -120, ...at(grid, 3, 4) });
    await waitFor(() => expect(sent(api)).toHaveLength(2));
    expect(sent(api)).toEqual([
      { kind: 'mouse', action: 'wheel-down', row: 2, column: 8 },
      { kind: 'mouse', action: 'wheel-up', row: 3, column: 4 },
    ]);
  });

  it('a panel without mouse support gets no clicks or wheel, but a click still focuses its input', async () => {
    const { api, grid, input } = await openPanel({ mouse: false });
    act(() => input.blur());
    fireEvent.mouseDown(within(grid).getByText('設'), { button: 0, ...at(grid, 2, 2) });
    fireEvent.click(within(grid).getByText('設'), { button: 0, ...at(grid, 2, 2) });
    expect(fireEvent.wheel(grid, { deltaY: 120, ...at(grid, 2, 2) })).toBe(true);
    expect(input).toHaveFocus();
    await settle();
    expect(sent(api)).toEqual([]);
  });
});

describe('native panel input ownership', () => {
  it('sends nothing for a handle that closed', async () => {
    const { api, controller, handleId, key } = await openPanel();
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'closed' }));
    expect(screen.queryByTestId('native-panel')).not.toBeInTheDocument();
    await controller.panelInput(key, { kind: 'key', key: 'enter' });
    await controller.closePanel(key);
    expect(api.mock.panelCalls).toEqual([]);
  });

  it('drops input queued for a handle the view replaced, and never retries', async () => {
    const { api, controller, handleId, key, input } = await openPanel();
    let release: () => void = () => {};
    const panelInput = vi.spyOn(api.engine, 'panelInput')
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(panelInput).toHaveBeenCalledTimes(1));
    await act(() => controller.closeSession(key));
    await act(async () => {
      await controller.openEngine(key, true);
    });
    const next = controller.view(key)!.handleId!;
    expect(next).not.toBe(handleId);
    expect(controller.view(key)!.panel).toBeUndefined();
    act(() => api.mock.emitEngine({ type: 'panel', handleId: next, panel: panelOf({ revision: 9 }) }));
    await screen.findByTestId('native-panel');
    release();
    await settle();
    expect(panelInput.mock.calls).toEqual([[handleId, { kind: 'key', key: 'down' }]]);
  });

  it('a failing panel shows one toast for a run of failures', async () => {
    const { api, input } = await openPanel();
    const panelInput = vi.spyOn(api.engine, 'panelInput').mockRejectedValue(new Error('pipe closed'));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(panelInput).toHaveBeenCalledTimes(3));
    await settle();
    expect(screen.getAllByText("Couldn't reach the panel: pipe closed")).toHaveLength(1);
    expect(panelInput).toHaveBeenCalledTimes(3);
  });
});
