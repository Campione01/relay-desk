import { describe, expect, it } from 'vitest';
import { SLASH_ALIASES, buildSlashEntries, canonicalSlash, filterSlash, rewritesConversation, slashInsertText, slashRoute } from '../../src/renderer/lib/slash';
import { friendlyError } from '../../src/renderer/lib/errors';

const aliasPairs = Object.entries(SLASH_ALIASES).flatMap(([name, aliases]) => aliases.map((alias) => [alias, name] as const));

describe('slash aliases of the CLI 2.1.308 commands Relay routes', () => {
  it('lists the aliases the pinned CLI registers', () => {
    expect(SLASH_ALIASES).toEqual({ clear: ['reset', 'new'], resume: ['continue'], exit: ['quit'], background: ['bg'], 'remote-control': ['rc'], teleport: ['tp'] });
  });

  it.each(aliasPairs)('/%s is routed like /%s', (alias, name) => {
    expect(canonicalSlash(alias.toUpperCase())).toBe(name);
    expect(slashRoute(alias, '')).toBe(slashRoute(name, ''));
    expect(slashRoute(alias, 'with arguments')).toBe(slashRoute(name, 'with arguments'));
    expect(slashRoute(alias, '')).not.toBeNull();
  });

  it.each([['bg', 'terminal'], ['rc', 'signIn'], ['tp', 'signIn'], ['continue', 'history'], ['quit', 'close'], ['New', 'newSession'], ['reset', 'newSession']] as const)(
    '/%s answers %s', (alias, route) => expect(slashRoute(alias, '')).toBe(route));

  it.each(['backgrounds', 'r', 'continues', 'newest', 'context', 'compact', 'fork', 'branch', 'help', 'update'])(
    '/%s is not an alias and goes to the CLI', (name) => {
      expect(canonicalSlash(name)).toBe(name);
      expect(slashRoute(name, '')).toBeNull();
    });

  it('keeps /model and /effort routing by argument, and the other routes unchanged', () => {
    expect(slashRoute('model', '')).toBe('model');
    expect(slashRoute('EFFORT', '')).toBe('effort');
    expect(slashRoute('model', 'sonnet')).toBeNull();
    expect(slashRoute('login', '')).toBe('accounts');
    expect(slashRoute('logout', '')).toBe('accounts');
    expect(slashRoute('clear', '')).toBe('newSession');
    expect(slashRoute('resume', '')).toBe('history');
    expect(slashRoute('exit', '')).toBe('close');
    for (const name of ['tui', 'focus', 'background', 'cd', 'terminal-setup', 'migrate-installer']) {
      expect(slashRoute(name, '')).toBe('terminal');
    }
    for (const name of ['upgrade', 'remote-control', 'teleport']) expect(slashRoute(name, '')).toBe('signIn');
  });
});

describe('a session command named exactly like an alias (CLI 2.1.308 finds an exact name before an alias)', () => {
  const own = (name: string) => [{ name, description: 'My own command' }];

  it.each(aliasPairs)('/%s runs the session\'s own command of that name instead of /%s', (alias, name) => {
    expect(slashRoute(alias, '', own(alias))).toBeNull();
    expect(slashRoute(alias, 'with arguments', own(alias))).toBeNull();
    // Only exactly that name: another spelling or another command leaves the alias routed.
    expect(slashRoute(alias.toUpperCase(), '', own(alias))).toBe(slashRoute(name, ''));
    expect(slashRoute(alias, '', own(`${alias}s`))).toBe(slashRoute(name, ''));
  });

  it.each(Object.keys(SLASH_ALIASES))('keeps routing the canonical /%s that the session lists', (name) => {
    expect(slashRoute(name, '', own(name))).toBe(slashRoute(name, ''));
    expect(slashRoute(name, '')).not.toBeNull();
  });
});

describe('commands after which Relay reads the conversation again', () => {
  it('are /rewind and its CLI 2.1.308 aliases, which the CLI still runs', () => {
    for (const name of ['rewind', 'checkpoint', 'undo']) {
      expect(rewritesConversation(name)).toBe(true);
      expect(slashRoute(name, '')).toBeNull();
    }
    for (const name of ['compact', 'mcp', 'export', 'status', 'rename', 'clear', 'resume', 'rewinds', 'undone']) expect(rewritesConversation(name)).toBe(false);
  });

  it('leave out a session command named exactly /undo or /checkpoint, but not /rewind itself', () => {
    expect(rewritesConversation('undo', [{ name: 'undo', description: '' }])).toBe(false);
    expect(rewritesConversation('checkpoint', [{ name: 'checkpoint', description: '' }])).toBe(false);
    expect(rewritesConversation('rewind', [{ name: 'rewind', description: '' }])).toBe(true);
  });
});

describe('slash menu with aliases', () => {
  // Rows shaped like the native runtime sends them: no aliases field.
  const entries = buildSlashEntries([
    { name: 'background', description: 'Send this session to the background' },
    { name: 'desktop', description: 'Continue the current session in Claude Desktop' },
    { name: 'resume', description: 'Resume a previous conversation' },
    { name: 'context', description: 'Show context' },
    { name: 'constructor', description: 'Not a command' },
  ], ['clear', 'remote-control'], []);

  it('finds a command by its alias and completes it with the canonical name', () => {
    expect(filterSlash(entries, 'bg').map((entry) => entry.name)).toEqual(['background']);
    expect(filterSlash(entries, 'cont').map((entry) => entry.name)).toEqual(['resume', 'context', 'desktop', 'remote-control']);
    expect(slashInsertText(filterSlash(entries, 'bg')[0]!)).toBe('/background ');
  });

  it('puts the canonical command first for /continue, not /desktop', () => {
    const [first] = filterSlash(entries, 'continue');
    expect(first?.name).toBe('resume');
    expect(slashInsertText(first!)).toBe('/resume ');
  });

  it('gives names-only rows their aliases too', () => {
    expect(filterSlash(entries, 'new').map((entry) => entry.name)).toEqual(['clear']);
    expect(filterSlash(entries, 'rc').map((entry) => entry.name)).toEqual(['remote-control']);
  });

  it('keeps aliases the engine sends and ignores inherited object keys', () => {
    const own = buildSlashEntries([{ name: 'resume', description: '', aliases: ['again'] }, { name: 'toString', description: '' }], [], []);
    expect(own[0]?.aliases).toEqual(['again']);
    expect(own[1]?.aliases).toBeUndefined();
  });
});

describe('Mod refusal of a terminal-only alias', () => {
  it.each(['bg', 'rc', 'background', 'remote-control'])('/%s reads as a terminal-only note, not as a Relay control', (name) => {
    expect(friendlyError(`/${name} is handled by Relay, not the native CLI.`)).toEqual({ key: 'slash.terminalOnly' });
  });

  it.each(['continue', 'quit', 'fork'])('/%s keeps the Relay-controls note', (name) => {
    expect(friendlyError(`/${name} is handled by Relay, not the native CLI.`)).toEqual({ key: 'slash.relayHandled', params: { name } });
  });
});
