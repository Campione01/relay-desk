import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativePanel } from '@shared/types';
import { NativePanelHost, type NativePanelHostOptions } from '../../src/main/native/panelHost';
import { NativeTerminalScreen } from '../../src/main/native/terminalScreen';

const BORDER = '▔'.repeat(60);
const dialog = (...rows: string[]) => `\x1b[2J\x1b[H${[BORDER, ...rows].join('\r\n')}`;
const composer = '\x1b[2J\x1b[H◉ high · /effort\r\n>\r\n? for shortcuts';

function host(overrides: Partial<NativePanelHostOptions> = {}) {
  const screen = new NativeTerminalScreen(80, 20);
  const published: Array<NativePanel | null> = [];
  const state = { pending: 'config' as string | undefined, recovering: false, driving: false };
  const writeTerminal = vi.fn(async (_data: string) => undefined);
  const onVisible = vi.fn();
  const panels = new NativePanelHost({ screen, publish: (panel) => published.push(panel), writeTerminal,
    pendingCommand: () => state.pending, recovering: () => state.recovering, driving: () => state.driving,
    onVisible, throttleMs: 0, ...overrides });
  return { screen, published, state, writeTerminal, onVisible, panels };
}
const text = (panel: NativePanel | null | undefined) => panel?.rows.map((row) => row.runs.map((run) => run.text).join('')) ?? [];

afterEach(() => { vi.useRealTimers(); });

describe('native panel host', () => {
  it('mirrors only a dialog the user owns, never one Relay is driving, and closes the mirror with the dialog', () => {
    const h = host();
    h.screen.write(dialog('   Settings  Status  Config', '   Esc to close'));
    h.state.driving = true; h.panels.refresh();
    expect(h.published).toEqual([]);
    h.state.driving = false; h.panels.refresh();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ revision: 1, command: 'config', columns: 80, mouse: false });
    expect(text(h.published[0])).toEqual(['   Settings  Status  Config', '   Esc to close']);
    expect(h.onVisible).toHaveBeenLastCalledWith(true);
    // An identical redraw is not published again; a changed row is.
    h.screen.write(dialog('   Settings  Status  Config', '   Esc to close')); h.panels.refresh();
    expect(h.published).toHaveLength(1);
    h.screen.write(dialog('   Settings  Status  Config', '   Type to filter')); h.panels.refresh();
    expect(h.published).toHaveLength(2); expect(h.published[1]?.revision).toBe(2);
    h.screen.write(composer); h.panels.refresh();
    expect(h.published.at(-1)).toBeNull(); expect(h.onVisible).toHaveBeenLastCalledWith(false);
    expect(h.panels.visible).toBe(false);
  });

  it('shows a dialog a failed control left behind even without a pending command', () => {
    const h = host(); h.state.pending = undefined;
    h.screen.write(dialog('   Effort', '   Esc to cancel')); h.panels.refresh();
    expect(h.published).toEqual([]);
    h.state.recovering = true; h.panels.refresh();
    expect(text(h.published[0])).toEqual(['   Effort', '   Esc to cancel']);
    expect(h.published[0]).not.toHaveProperty('command');
  });

  it('throttles terminal updates into one evaluation', () => {
    vi.useFakeTimers();
    const h = host({ throttleMs: 40 });
    h.screen.write(dialog('   one')); h.panels.observe();
    h.screen.write(dialog('   two')); h.panels.observe();
    expect(h.published).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(h.published.map(text)).toEqual([['   two']]);
  });

  it('encodes input against the panel shown and refuses input with no panel', async () => {
    const h = host();
    await expect(h.panels.input({ kind: 'key', key: 'enter' })).rejects.toThrow('No CLI panel is open.');
    h.screen.write('\x1b[?1000;1006;2004h' + dialog('   Settings  Status', '   Esc to close')); h.panels.refresh();
    await h.panels.input({ kind: 'key', key: 'down' });
    await h.panels.input({ kind: 'text', text: 'a\nb', paste: true });
    await h.panels.input({ kind: 'mouse', action: 'click', row: 0, column: 3 });
    expect(h.writeTerminal.mock.calls.map(([data]) => data)).toEqual(['\x1b[B', '\x1b[200~a\rb\x1b[201~', '\x1b[<0;4;2M\x1b[<0;4;2m']);
    await expect(h.panels.input({ kind: 'mouse', action: 'click', row: 5, column: 0 })).rejects.toThrow('outside');
    // A rejected input does not block the ones after it.
    await h.panels.input({ kind: 'key', key: 'escape' });
    expect(h.writeTerminal).toHaveBeenLastCalledWith('\x1b');
  });

  it('sends Esc until a nested dialog is gone and says so when it stays', async () => {
    const h = host();
    h.screen.write(dialog('   Search settings', '   Esc to clear')); h.panels.refresh();
    let escapes = 0;
    h.writeTerminal.mockImplementation(async () => {
      escapes++;
      h.screen.write(escapes < 3 ? dialog(`   level ${escapes}`) : composer);
    });
    await h.panels.close();
    expect(escapes).toBe(3); expect(h.published.at(-1)).toBeNull();

    const stuck = host();
    stuck.screen.write(dialog('   Unclosable')); stuck.panels.refresh();
    stuck.writeTerminal.mockImplementation(async () => { stuck.screen.write(dialog(`   Unclosable ${stuck.writeTerminal.mock.calls.length}`)); });
    await expect(stuck.panels.close()).rejects.toThrow('The CLI panel did not close.');
    expect(stuck.writeTerminal).toHaveBeenCalledTimes(6);
  });

  it('stops after dispose and clears a shown panel', async () => {
    const h = host();
    h.screen.write(dialog('   Settings')); h.panels.refresh();
    h.panels.dispose();
    expect(h.published.at(-1)).toBeNull();
    h.screen.write(dialog('   Settings again')); h.panels.observe(); h.panels.refresh();
    expect(h.published.filter(Boolean)).toHaveLength(1);
    await h.panels.close(); expect(h.writeTerminal).not.toHaveBeenCalled();
  });
});
