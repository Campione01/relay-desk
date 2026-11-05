export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt'] as const;

function keyName(event: KeyLike): string {
  // Digits and letters by physical key, so Alt+1 works on every layout and with Shift held.
  if (event.code && /^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (event.code && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

/** "Ctrl+Shift+Alt+K" for a keyboard event (modifiers in a fixed order). */
export function hotkeyOf(event: KeyLike): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(keyName(event));
  return parts.join('+');
}

/** Canonical form of a user-typed hotkey ("alt + 1" -> "Alt+1"); null when it is not valid. */
export function normalizeHotkey(input: string): string | null {
  const parts = input
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1]!;
  const modifiers = new Set<string>();
  for (const raw of parts.slice(0, -1)) {
    const lower = raw.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modifiers.add('Ctrl');
    else if (lower === 'shift') modifiers.add('Shift');
    else if (lower === 'alt') modifiers.add('Alt');
    else return null;
  }
  if (!modifiers.has('Ctrl') && !modifiers.has('Alt')) return null;
  if (!/^[A-Za-z0-9]$/.test(key)) return null;
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key.toUpperCase()].join('+');
}

/** Alt+1 ... Alt+9 position slot for a key event, or null. */
export function altDigit(event: KeyLike): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const name = keyName(event);
  if (!/^[1-9]$/.test(name)) return null;
  return Number(name);
}
