import type { Shortcut } from '@shared/shortcuts';
import { normalizeHotkey } from '../../lib/hotkeys';

const POSITIONAL_SLOTS = 9;

/**
 * hotkey -> shortcut id. Explicit hotkeys (any group) win; the first nine chips of the visible
 * group without one get Alt+1 ... Alt+9 by position, unless that combination is taken.
 */
export function assignHotkeys(all: readonly Shortcut[], visible: readonly Shortcut[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const shortcut of all) {
    const hotkey = shortcut.hotkey ? normalizeHotkey(shortcut.hotkey) : null;
    if (hotkey && !map.has(hotkey)) map.set(hotkey, shortcut.id);
  }
  visible.slice(0, POSITIONAL_SLOTS).forEach((shortcut, index) => {
    if (shortcut.hotkey && normalizeHotkey(shortcut.hotkey)) return;
    const hotkey = `Alt+${index + 1}`;
    if (!map.has(hotkey)) map.set(hotkey, shortcut.id);
  });
  return map;
}

export function hotkeysById(map: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [hotkey, id] of map) if (!out.has(id)) out.set(id, hotkey);
  return out;
}
