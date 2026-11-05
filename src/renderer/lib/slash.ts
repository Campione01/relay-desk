import type { Shortcut } from '@shared/shortcuts';
import type { SlashCommandInfo } from '@shared/types';
import { ACCOUNT_COMMANDS, SIGN_IN_COMMANDS } from '@shared/signIn';

export interface SlashEntry {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  source: 'command' | 'shortcut';
  /** Shortcut entries insert their own text (e.g. "/compact "). */
  text?: string;
  shortcutId?: string;
}

/** The native runtime sends no aliases, so the menu falls back to the known CLI table. */
function aliasesOf(name: string, given?: readonly string[]): { aliases?: string[] } {
  const aliases = given?.length ? given : Object.hasOwn(SLASH_ALIASES, name) ? SLASH_ALIASES[name] : undefined;
  return aliases?.length ? { aliases: [...aliases] } : {};
}

/** Engine commands (with descriptions) + init names without one + slash shortcuts not already listed. */
export function buildSlashEntries(
  commands: readonly SlashCommandInfo[],
  names: readonly string[],
  shortcuts: readonly Shortcut[],
): SlashEntry[] {
  const out: SlashEntry[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.name.replace(/^\//, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: command.description,
      source: 'command',
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      ...aliasesOf(name, command.aliases),
    });
  }
  for (const raw of names) {
    const name = raw.replace(/^\//, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: '', source: 'command', ...aliasesOf(name) });
  }
  for (const shortcut of shortcuts) {
    if (shortcut.kind !== 'slash' || !shortcut.text) continue;
    const name = shortcut.text.trim().replace(/^\//, '').split(/\s+/)[0] ?? '';
    if (!name) continue;
    const key = `${name}::${shortcut.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const plainCommand = seen.has(name) && shortcut.text.trim() === `/${name}`;
    if (plainCommand) continue;
    out.push({
      name,
      description: shortcut.hint ?? shortcut.label,
      source: 'shortcut',
      text: shortcut.text,
      shortcutId: shortcut.id,
    });
  }
  return out;
}

/** Prefix matches first (in list order), then other substring matches; aliases count as names. */
export function filterSlash(entries: readonly SlashEntry[], query: string): SlashEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  const prefix: SlashEntry[] = [];
  const contains: SlashEntry[] = [];
  for (const entry of entries) {
    const names = [entry.name, ...(entry.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) prefix.push(entry);
    else if (names.some((n) => n.includes(q)) || entry.description.toLowerCase().includes(q)) contains.push(entry);
  }
  return [...prefix, ...contains];
}

/** The filter text while the box holds a single "/token" being typed; null otherwise. */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

/** Text to put in the box when an entry is chosen. */
export function slashInsertText(entry: SlashEntry): string {
  if (entry.text) return entry.text;
  return `/${entry.name} `;
}

/** CLI 2.1.308 (and 2.1.311) aliases of the commands Relay routes, toasts or refuses; native-mod/hooks/bridge.ts keeps its own copy. */
export const SLASH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  clear: ['reset', 'new'],
  resume: ['continue'],
  exit: ['quit'],
  background: ['bg'],
  'remote-control': ['rc'],
  teleport: ['tp'],
};

/** CLI 2.1.308 (and 2.1.311) aliases of /rewind, after which Relay reads the conversation again; the bridge guards none, so its copy lacks them. */
const REWIND_ALIASES: Readonly<Record<string, readonly string[]>> = { rewind: ['checkpoint', 'undo'] };

const CANONICAL_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries({ ...SLASH_ALIASES, ...REWIND_ALIASES }).flatMap(([name, aliases]) => aliases.map((alias) => [alias, name] as const)),
);

/** The name the CLI registers a typed name under; other names come back lower-cased. */
export function canonicalSlash(name: string): string {
  const typed = name.toLowerCase();
  return CANONICAL_NAMES.get(typed) ?? typed;
}

/** A typed alias that the session also lists as a command of exactly that name: the CLI runs that command, not the alias. */
function listedAsTyped(name: string, commands: readonly SlashCommandInfo[]): boolean {
  return CANONICAL_NAMES.has(name.toLowerCase()) && commands.some((command) => command.name === name);
}

/** /rewind and its aliases rewrite the saved conversation, which Relay then reads again. */
export function rewritesConversation(name: string, commands: readonly SlashCommandInfo[] = []): boolean {
  return !listedAsTyped(name, commands) && canonicalSlash(name) === 'rewind';
}

/** CLI commands that need the CLI's own terminal, with their aliases; Relay never sends them. */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'tui', 'focus', 'background', 'cd', 'terminal-setup', 'upgrade', 'migrate-installer', 'remote-control',
].flatMap((name) => [name, ...(SLASH_ALIASES[name] ?? [])]));

/** What Relay does itself for a slash command instead of sending it to the native CLI. */
export type SlashRoute = 'newSession' | 'history' | 'accounts' | 'close' | 'model' | 'effort' | 'terminal' | 'signIn';

/** Name and arguments of a message that is one slash command; null for anything else. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: (match[2] ?? '').trim() } : null;
}

/** Relay's own answer to a slash command; null = the native CLI runs it. `commands`: the session's own command list. */
export function slashRoute(name: string, args: string, commands: readonly SlashCommandInfo[] = []): SlashRoute | null {
  if (listedAsTyped(name, commands)) return null;
  const command = canonicalSlash(name);
  // Log in and Log out under Accounts stand in for the CLI's own sign-in commands; the others need a terminal.
  if (SIGN_IN_COMMANDS.has(command)) return ACCOUNT_COMMANDS.has(command) ? 'accounts' : 'signIn';
  if (TERMINAL_ONLY_COMMANDS.has(command)) return 'terminal';
  switch (command) {
    case 'clear':
      return 'newSession';
    case 'resume':
      return 'history';
    case 'login':
    case 'logout':
      return 'accounts';
    case 'exit':
      return 'close';
    // With arguments the CLI sets them directly, as in the terminal.
    case 'model':
    case 'effort':
      return args ? null : command;
    default:
      return null;
  }
}
