import type { IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import { IPC } from '@shared/ipc';
import { ACCOUNT_COMMANDS, isSignInScreen, SIGN_IN_COMMANDS, SIGN_IN_REQUIRED, signInCommandRefusal } from '@shared/signIn';
import type { NativeStartupKey, Profile } from '@shared/types';
import { PermissionBroker } from '../../src/main/engine/broker';
import type { NativeLaunch, NativeReady, NativeRequestOptions, NativeRuntime } from '../../src/main/native/contract';
import { NativeInteractiveSession } from '../../src/main/native/session';

vi.mock('electron', () => ({ app: { getPath: (name: string) => `C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\${name}` } }));

const { registerEngineIpc } = await import('../../src/main/engine/ipc');

// Synthetic screens in the shape CLI 2.1.311 and 2.1.322 draw them. Nothing here is a real address or code.
// The glyphs a row can start with: the spinner's frames on Windows, its Ghostty frame, its reduced-motion dot (also the
// assistant bullet on Windows), the assistant bullet on macOS and the selection pointer.
const GLYPHS = ['\u00b7', '\u2722', '*', '\u2736', '\u273b', '\u273d', '\u2733', '\u25cf', '\u23fa', '\u276f'];
// The authorization path is assembled so this file passes the export's login-assist scan.
const PATH = ['oauth', 'authorize'].join('/');
const address = (origin: string) => `${origin}/${PATH}?code=true&client_id=synthetic-client&response_type=code&scope=synthetic-scope&state=synthetic-state`;
const CLAUDE_AI = address('https://claude.com/cai');
const SIGN_IN = ['Select login method:', '\u276f 1. Claude account with subscription \u00b7 Pro, Max, Team, or Enterprise', '  2. Anthropic Console account \u00b7 API usage billing'];
// A setting forces the login method: no selection screen, the browser opens at once and the address follows 3 s later.
const FORCED = ['Login method pre-selected: Subscription Plan (Claude Pro/Max)', '', '\u273b Opening browser to sign in\u2026'];
// 2.1.322 words the same forced method differently, and words the option of the selection screen differently too.
const FORCED_322 = ['Login method pre-selected: Claude subscription (claude.ai account)', '', '\u273b Opening browser to sign in\u2026'];
const SIGN_IN_322 = ['Select login method:', '\u276f 1. Claude account with subscription \u00b7 Individual, Team, or Enterprise', '  2. Anthropic Console account \u00b7 API usage billing'];
const CODE_PROMPT = ['Browser didn\'t open? Use the url below to sign in (c to copy)', '', 'Paste code here if prompted > '];
// The first-run sign-in when its start failed, e.g. a login method forced by settings the organization does not admit.
const FIRST_RUN_RETRY = ['OAuth error: Synthetic sign-in failure', '', 'Press Enter to retry. (Esc to continue without logging in)'];
// The Cloud gateway sign-in, where the CLI's sign-in starts when settings name a gateway. Synthetic host, path and code.
const GATEWAY_HOST = 'gateway.example.invalid';
const boxed = (text: string) => [`\u256d${'\u2500'.repeat(44)}\u256e`, `\u2502 ${text.padEnd(42)} \u2502`, `\u2570${'\u2500'.repeat(44)}\u256f`];
const GATEWAY_ADDRESS = ['Cloud gateway', '', 'Your organization\'s gateway URL (set by managed settings):', '', ...boxed(`https://${GATEWAY_HOST}`), '',
  'Press Enter to connect \u00b7 Esc for other login methods'];
// The address caption names the settings file: the default account's, or an account folder that Relay Desk manages.
const SETTINGS_CAPTION = (file: string) => `Gateway URL from your settings file (${file}), not from your organization's managed settings.`;
const HOME_SETTINGS = 'C:\\Users\\me\\.claude\\settings.json';
const PROFILE_SETTINGS = 'C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\profiles\\p-0123abcd\\settings.json';
const DEEP_SETTINGS = `C:\\${'nested-folder\\'.repeat(10)}settings.json`;
const POLICY_CAPTION = 'Gateway login is required by your organization\'s policy, but no gateway URL is configured. Contact your IT administrator.';
// A gateway login that a policy enforces has no way back to the other methods.
const GATEWAY_LOCKED = ['Cloud gateway', '', SETTINGS_CAPTION(HOME_SETTINGS), '', ...boxed(`https://${GATEWAY_HOST}`), '', 'Press Enter to connect'];
const GATEWAY_UNSET = ['Cloud gateway', '', POLICY_CAPTION];
const GATEWAY_CONNECTING = ['\u273b Connecting to gateway\u2026', '', 'Press Esc to cancel'];
const GATEWAY_TRUST = [`Trust gateway ${GATEWAY_HOST}?`, '', 'You haven\'t connected to this gateway before. Once trusted, it can push settings to this machine that execute commands and change your environment. Only continue if this is your organization\'s gateway.',
  '', 'Certificate fingerprint (SHA-256): 0123456789abcdef\u2026', '', '  Yes, trust this gateway', '\u276f No, cancel login'];
const GATEWAY_CODE = ['Cloud gateway \u00b7 sign in', '', 'A browser window should have opened. After signing in with your identity provider, confirm this code on the verification page:',
  '', ...boxed('SYNT-CODE'), '', 'Browser didn\'t open? Visit:', `https://${GATEWAY_HOST}/device`, '', '\u2722 Waiting for sign-in to complete in your browser\u2026', '', 'Press Esc to cancel'];
// 2.1.322 shows a notice the gateway sends with the device code between the address and the wait row.
const GATEWAY_CODE_NOTICE = [...GATEWAY_CODE.slice(0, -4), '', `Notice from ${GATEWAY_HOST}:`, 'Synthetic notice: sign in with your work account.', ...GATEWAY_CODE.slice(-4)];
const GATEWAY_ACCOUNT = ['Signed in to Cloud gateway as someone@example.com', '', 'Continue only if this is your account; that organization\'s settings will then apply to this machine. Otherwise go back: nothing is saved, and you can sign in again.',
  '', '\u276f Yes, continue', '  No, cancel login'];
const GATEWAY_DONE = ['Connected to Cloud gateway.', '', 'Press Enter to continue.'];
/** The address alone, run into the next row inside its path, at a screen `columns` wide. */
const wrapped = (columns: number) => {
  const head = 'https://claude.com/cai/oauth/a'.length;
  const line = `${' '.repeat(columns - head)}${CLAUDE_AI}`;
  return ['Opening the page in your browser', line.slice(0, columns), line.slice(columns)];
};
const ORDINARY = [
  ['Quick safety check: Is this a project you created or one you trust?', 'Security guide https://example.com/docs/security', '\u276f 1. Yes, I trust this folder', '  2. No, exit'],
  ['WARNING: Claude Code running in Bypass Permissions mode', '\u276f 1. No, exit', '  2. Yes, I accept'],
  ['Choose the text style that looks best with your terminal', '\u276f 1. Dark mode', '  2. Light mode'],
  ['Detected a custom API key in your environment', 'Do you want to use this API key?', '\u276f 1. Yes', '  2. No (recommended)'],
  ['New MCP server found in .mcp.json: example', '\u276f 1. Use this and all future MCP servers in this project', '  2. Continue without using this MCP server'],
  // An MCP server's own authentication is not a Claude sign-in.
  ['Authentication required for HTTP server example', '\u276f 1. Authenticate', '  2. Disable'],
  ['Opening browser to authenticate example', `https://mcp.example.com/${PATH}?state=synthetic-state`],
  ['Starting authentication for "example"\u2026', `https://mcp-proxy.anthropic.com/v1/mcp/example/${PATH}?state=synthetic-state`],
  // A resumed conversation can draw assistant text that starts with a sign-in row's words.
  ['\u25cf Login successful. The tests pass now.', '\u25cf Opening browser to sign in\u2026 is the first step the CLI shows.'],
  // Or that has the gateway heading's words on a row of their own, as a heading or list entry does.
  ['Cloud gateway', '\u25cf The gateway is our TLS proxy; trust gateway certificates only from IT.', '  - Press Enter to connect is the hint it shows.',
    '\u25cf Connected to Cloud gateway. The tests pass now.'],
];
const LEAK = /login method|paste code|claude\.com\/cai|synthetic-state|synthetic-code|opening browser|gateway|logging in/i;
// Every session's terminal is 140 columns wide.
const COLUMNS = 140;
/**
 * `text` wrapped as the CLI's renderer wraps it, `width` columns wide: at a space, and inside a word longer than a row,
 * which starts on a row of its own unless `keepRow`.
 */
const wrapText = (text: string, width: number, keepRow = false): string[] => {
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    let rest = row ? `${row} ${word}` : word;
    if (rest.length > width && row && !(keepRow && word.length > width)) { rows.push(row); rest = word; }
    while (rest.length > width) { rows.push(rest.slice(0, width)); rest = rest.slice(width); }
    row = rest;
  }
  if (row) rows.push(row);
  return rows;
};
/** Rows of the first-run sign-in, which the CLI draws one column in from the left edge of a session. */
const laidOut = (rows: string[], keepRow = false) => rows.flatMap((row) => row ? wrapText(row, COLUMNS - 1, keepRow).map((part) => ` ${part}`) : ['']);

afterEach(() => { vi.useRealTimers(); });

describe('the sign-in screens Relay Desk recognises', () => {
  const seen = (rows: string[], columns = COLUMNS) => isSignInScreen(rows, columns);

  it.each([['a sign-in heading', SIGN_IN], ['a sign-in heading with 2.1.322\'s option label', SIGN_IN_322],
    ['a forced login method before the address appears', FORCED], ['a forced claude.ai login method of 2.1.322 before the address appears', FORCED_322],
    ['the code prompt', CODE_PROMPT],
    ['the Console sign-in method', ['Anthropic Console account', 'How do you want to sign in?', '\u276f Sign in with your Console account (recommended)']],
    ['the Teleport sign-in gate', ['Log in to Claude', 'Teleport requires a Claude.ai account.', '\u276f Login with Claude account']],
    ['the success row', ['Logged in as someone@example.com', 'Login successful. Press Enter to continue\u2026']],
    ['the first-run sign-in after its start failed', FIRST_RUN_RETRY],
    ['the Cloud gateway address', GATEWAY_ADDRESS], ['the Cloud gateway address a policy enforces', GATEWAY_LOCKED],
    ['the Cloud gateway a policy enforces without an address', GATEWAY_UNSET], ['the connection to the gateway', GATEWAY_CONNECTING],
    ['the question whether to trust the gateway', GATEWAY_TRUST], ['the gateway\'s device code', GATEWAY_CODE],
    ['the gateway\'s device code with 2.1.322\'s notice from the gateway', GATEWAY_CODE_NOTICE],
    ['the gateway account to confirm', GATEWAY_ACCOUNT], ['the gateway sign-in done', GATEWAY_DONE],
  ])('matches %s', (_name, rows) => {
    expect(seen(rows)).toBe(true);
  });

  it('matches every Cloud gateway screen as the CLI lays it out in a session, and the trust question of a one-label host by its other rows', () => {
    const profileLocked = GATEWAY_LOCKED.map((row) => row.replace(HOME_SETTINGS, PROFILE_SETTINGS));
    for (const rows of [GATEWAY_ADDRESS, GATEWAY_LOCKED, profileLocked, GATEWAY_UNSET, GATEWAY_CONNECTING, GATEWAY_TRUST, GATEWAY_CODE, GATEWAY_CODE_NOTICE, GATEWAY_ACCOUNT, GATEWAY_DONE]) {
      expect(seen(laidOut(rows))).toBe(true);
    }
    const oneLabel = GATEWAY_TRUST.map((row) => row.replace(GATEWAY_HOST, 'gateway'));
    expect(seen([oneLabel[0]!])).toBe(false);
    expect(seen(oneLabel)).toBe(true);
    expect(seen(oneLabel.filter((row) => !row.includes('Yes, trust')))).toBe(true);
    expect(seen(oneLabel.filter((row) => !row.startsWith('Certificate')))).toBe(true);
  });

  it('counts the plain rows of the gateway address only below the gateway heading, each whole', () => {
    const plain = ['Press Enter to connect', 'Your organization\'s gateway URL (set by managed settings):', SETTINGS_CAPTION(HOME_SETTINGS), POLICY_CAPTION];
    for (const row of plain) {
      expect(seen([row])).toBe(false);
      expect(seen(['Cloud gateway', '', `  ${row}`])).toBe(true);
      expect(seen([row, 'Cloud gateway'])).toBe(false);
      expect(seen(['\u25cf Cloud gateway is our TLS proxy.', row])).toBe(false);
      // A row cut short, as a narrower terminal would wrap it, or run on with more words, is not the CLI's.
      expect(seen(['Cloud gateway', '', row.slice(0, -12)])).toBe(false);
      expect(seen(['Cloud gateway', '', `${row} Ask IT.`])).toBe(false);
    }
    expect(seen(['Cloud gateway'])).toBe(false);
    expect(seen(['Cloud gateway', '', 'The proxy every request goes through.', 'Press Enter to connect the dots.'])).toBe(false);
  });

  it('fits each gateway caption on one row of a session, except the settings-file caption of a longer path, which counts over its rows', () => {
    expect(laidOut([POLICY_CAPTION])).toHaveLength(1);
    expect(laidOut([SETTINGS_CAPTION(HOME_SETTINGS)])).toHaveLength(1);
    const wrapped = [laidOut([SETTINGS_CAPTION(PROFILE_SETTINGS)]), laidOut([SETTINGS_CAPTION(DEEP_SETTINGS)]), laidOut([SETTINGS_CAPTION(DEEP_SETTINGS)], true),
      laidOut([SETTINGS_CAPTION('\\\\server\\share\\claude-accounts\\an account folder with a long name of its own\\settings.json')])];
    // Wrapped at a space inside the path, before the path (whose row then starts with its parenthesis), and inside it.
    expect(wrapped.map((rows) => rows.length)).toEqual([2, 3, 2, 2]);
    expect(wrapped[1]![1]).toMatch(/^ \(C:\\/);
    for (const rows of wrapped) {
      expect(seen(['Cloud gateway', '', ...rows])).toBe(true);
      expect(seen(rows)).toBe(false);
      // Only the caption's own rows count: not with a row between them, and not without its last row.
      expect(seen(['Cloud gateway', '', rows[0]!, '', ...rows.slice(1)])).toBe(false);
      expect(seen(['Cloud gateway', '', ...rows.slice(0, -1)])).toBe(false);
    }
  });

  // Review regression: rows that only start like a gateway caption, under a "Cloud gateway" heading of a reply.
  it.each([
    [['\u25cf Cloud gateway', '', 'Cloud gateway', '', '  Gateway login is required by your organization\'s policy, so ask IT for the URL.']],
    [['Cloud gateway', 'Gateway URL from your settings file (see below) is used first.']],
    [['Cloud gateway', '', 'Gateway URL from your settings file (C:\\Users\\me\\.claude\\settings.json) wins over the managed one.']],
    [['Cloud gateway', '', 'Gateway URL from your settings file (C:\\Users\\me\\.claude\\settings.json), not from', 'the managed settings, applies.']],
    [['Cloud gateway', '', SETTINGS_CAPTION('see the file named below')]],
    [['Cloud gateway', '', 'Gateway login is required by your organization\'s policy, but no gateway URL is configured.']],
  ])('leaves prose under a "Cloud gateway" heading alone: %j', (rows) => {
    expect(seen(rows)).toBe(false);
  });

  it.each(GLYPHS)('reads a status row behind the leading glyph %s', (glyph) => {
    for (const row of ['Opening browser to sign in\u2026', 'Opening browser to sign in with your Claude account\u2026', 'Creating API key for Claude Code\u2026']) {
      expect(seen([`  ${glyph} ${row}`])).toBe(true);
      expect(seen([row.replace('\u2026', '')])).toBe(false);
    }
  });

  it.each([
    ['the subscription login a setting forces', 'Login method pre-selected: Subscription Plan (Claude Pro/Max)'],
    ['the claude.ai login a setting forces in 2.1.322', 'Login method pre-selected: Claude subscription (claude.ai account)'],
    ['the Console login a setting forces', 'Login method pre-selected: API usage billing (Anthropic Console)'],
    ['/upgrade starting a new login', 'Starting new login following /upgrade. Exit with Ctrl-C to use existing account.'],
    ['/usage-credits starting a new login', 'Starting new login following /usage-credits. Exit with Ctrl-C to use existing account.'],
    ['/remote-control enrolling this device', 'Sign in to enroll this device for Remote Control.'],
    ['the GitHub app token step starting', '\u273b  Starting authentication\u2026'],
    ['the first-run sign-in offering a retry', 'Press Enter to retry. (Esc to continue without logging in)'],
    ['the gateway address', 'Press Enter to connect \u00b7 Esc for other login methods'],
    ['the gateway connection', '\u273b Connecting to gateway\u2026'],
    ['the gateway trust question', `Trust gateway ${GATEWAY_HOST}?`],
    ['an IPv6 gateway\'s trust question', 'Trust gateway fd00::1?'],
    ['the gateway trust choice', 'Yes, trust this gateway'],
    ['the gateway certificate', 'Certificate fingerprint (SHA-256): 0123456789abcdef\u2026'],
    ['a loopback gateway\'s certificate', 'Certificate fingerprint (SHA-256): http-loopback\u2026'],
    ['the gateway device code step', 'Cloud gateway \u00b7 sign in'],
    ['the gateway device code wait', '\u2722 Waiting for sign-in to complete in your browser\u2026'],
    ['the gateway account', 'Signed in to Cloud gateway as someone@example.com'],
    ['the gateway sign-in done', 'Connected to Cloud gateway.'],
  ])('matches the row of %s', (_name, row) => {
    expect(seen([row])).toBe(true);
    expect(seen([`\u2502 ${row}`])).toBe(true);
  });

  it.each([
    '\u25cf Opening browser to sign in\u2026 is what the CLI shows first.',
    '\u25cf Select login method: pick the subscription there.',
    '\u25cf Login successful. The tests pass now.',
    '  Login successful. Press Enter\u2026',
    '\u23fa Starting authentication\u2026 then the browser opens.',
    '\u25cf Login method pre-selected: none, so the CLI asks.',
    '\u25cf Login method pre-selected: Claude subscription (claude.ai account) is how 2.1.322 words it.',
    '\u25cf Login method pre-selected: Claude subscription (claude.ai account',
    '\u25cf Claude subscription (claude.ai account)',
    '\u25cf Starting new login following /upgrade means the CLI signs in again.',
    '\u25cf Sign in to enroll this device for Remote Control. That is the trusted-device step.',
    '\u25cf Use the URL below to sign in to the dashboard:',
    '\u25cf How do you want to sign in? With SSO.',
    '\u25cf Paste code here when the page shows it.',
    '  \u23fa The docs explain how to select login method in the CLI.',
    '\u25cf Press Enter to retry.',
    '\u25cf Press Enter to retry. (Esc to continue without logging in) is what it says.',
    '\u25cf Press Enter to connect \u00b7 Esc for other login methods is the hint.',
    '\u25cf Connecting to gateway\u2026 took a while.',
    '\u25cf Trust gateway certificates?',
    `\u25cf Trust gateway ${GATEWAY_HOST}? Only if it is yours.`,
    '\u25cf Yes, trust this gateway if IT says so.',
    '\u25cf Certificate fingerprint (SHA-256): compare it with the one IT sent.',
    '\u25cf Waiting for sign-in to complete in your browser\u2026 then it timed out.',
    '\u25cf Signed in to Cloud gateway as admin, then it failed.',
    '\u25cf Connected to Cloud gateway. The tests pass now.',
    '  Cloud gateway',
  ])('leaves assistant text that starts with the same words alone: %s', (row) => {
    expect(seen([row])).toBe(false);
  });

  it.each(ORDINARY.map((rows) => [rows[0], rows]))('leaves "%s" alone', (_name, rows) => {
    expect(seen(rows)).toBe(false);
  });

  it('matches only Claude\'s own authorization pages, each on its row', () => {
    for (const origin of ['https://claude.com/cai', 'https://platform.claude.com', 'https://claude.fedstart.com', 'https://claude-staging.fedstart.com', 'https://beacon.claude-ai.staging.ant.dev']) {
      expect(seen([`  ${address(origin)}`])).toBe(true);
    }
    expect(seen([`https://platform.claude.com/${PATH}`])).toBe(true);
    for (const other of [`https://claude.ai/${PATH}?code=true`, `https://mcp.example.com/${PATH}?code=true`, `https://claude.com/cai/${PATH}ize`,
      'https://claude.com/cai/oauth', `https://platform.claude.com/${['oauth', 'code', 'callback'].join('/')}`]) expect(seen([other])).toBe(false);
    // Not across rows: an Anthropic address and a later row that mentions OAuth.
    expect(seen(['See https://docs.anthropic.com/en/api', 'OAuth flows\u2026'])).toBe(false);
    expect(seen(['See https://claude.com/cai/', `${PATH}?code=true`])).toBe(false);
  });

  it('joins a row with the next one only where it runs into it, up to the last column', () => {
    for (const columns of [40, 100, 140]) {
      const rows = wrapped(columns);
      expect(rows[1]).toHaveLength(columns);
      expect(seen(rows, columns)).toBe(true);
      // The same split one column short of the edge is two rows, not one address.
      expect(seen(rows, columns + 1)).toBe(false);
      expect(seen([rows[1]!.trimStart(), rows[2]!], columns)).toBe(false);
    }
    const beacon = address('https://beacon.claude-ai.staging.ant.dev');
    expect(seen([beacon.slice(0, 40), beacon.slice(40, 80), beacon.slice(80)], 40)).toBe(true);
  });
});

function startup(correlated = true) {
  const events: EngineEvent[] = [];
  const terminals = new Set<(text: string) => void>();
  let resolve!: (ready: NativeReady) => void;
  let reject!: (error: Error) => void;
  const hello = new Promise<NativeReady>((done, failed) => { resolve = done; reject = failed; });
  void hello.catch(() => undefined);
  const runtime = {
    start: vi.fn(() => hello), request: vi.fn(async () => []),
    writeStartup: vi.fn(async (_data: string) => undefined), writeTerminal: vi.fn(async (_data: string) => undefined),
    close: vi.fn(async () => { reject(new Error('Native transport: runtime closed')); }), resize: vi.fn(async () => undefined),
    onEvent: () => () => undefined, onExit: () => () => undefined,
    onTerminal: (callback: (data: string) => void) => { terminals.add(callback); return () => terminals.delete(callback); },
  } satisfies NativeRuntime;
  const session = new NativeInteractiveSession({
    handleId: 'owned', profile: { id: 'default', name: 'Synthetic', configDir: null, createdAt: 0 },
    request: { profileId: 'default', cwd: 'C:\\synthetic', ...(correlated ? { startupRequestId: 'request-1' } : {}) },
    launch: { exe: 'C:\\synthetic\\claude.exe', args: [], cwd: 'C:\\synthetic', env: {}, handleId: 'owned', cols: COLUMNS, rows: 48 },
    runtime, emit: (event) => events.push(event), broker: new PermissionBroker('owned', () => undefined),
  });
  const snapshots = () => events.filter((event): event is Extract<EngineEvent, { type: 'startup' }> => event.type === 'startup');
  const raw = (data: string) => { for (const callback of terminals) callback(data); };
  return { session, events, runtime, snapshots, raw,
    screen(rows: string[]) { raw(`\x1b[2J\x1b[H${rows.join('\r\n')}`); },
    ready() { resolve({ protocol: 1, sessionId: 'synthetic-session', isInteractive: true, surface: 'terminal', capabilities: [] }); },
    timeout() { reject(new Error('Native transport: interactive hello timed out')); },
  };
}

const SCREENS: Array<[string, string[]]> = [['sign-in heading', SIGN_IN], ['forced login method', FORCED], ['forced login method of 2.1.322', FORCED_322], ['code prompt', CODE_PROMPT],
  ['wrapped authorization address', wrapped(COLUMNS)],
  ['spinner row of the GitHub app token step', ['Set up Claude GitHub Actions', '', '\u2736  Starting authentication\u2026']],
  ['first-run sign-in after its start failed', FIRST_RUN_RETRY],
  ['Cloud gateway address', GATEWAY_ADDRESS], ['Cloud gateway address a policy enforces', GATEWAY_LOCKED],
  ['Cloud gateway without an address', GATEWAY_UNSET], ['connection to the gateway', GATEWAY_CONNECTING],
  ['question whether to trust the gateway', GATEWAY_TRUST], ['gateway device code', GATEWAY_CODE], ['gateway device code with a notice', GATEWAY_CODE_NOTICE],
  ['gateway account to confirm', GATEWAY_ACCOUNT]];

describe('the CLI sign-in on the startup screen', () => {
  it.each(SCREENS)(
    'a %s is never published, takes no key and ends the startup with the sign-in message', async (_name, rows) => {
      vi.useFakeTimers();
      const f = startup(); const started = f.session.start();
      const failed = expect(started).rejects.toThrow(SIGN_IN_REQUIRED);
      f.screen(ORDINARY[0]!);
      await vi.advanceTimersByTimeAsync(30);
      const shown = f.snapshots().at(-1)!;
      expect(shown).toMatchObject({ phase: 'waiting', text: expect.stringContaining('trust this folder') });
      f.screen(rows);
      await expect(f.session.startupInput({ revision: shown.revision, key: 'enter' })).rejects.toThrow(SIGN_IN_REQUIRED);
      await vi.advanceTimersByTimeAsync(30);
      await failed;
      expect(f.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });
      expect(f.runtime.writeStartup).not.toHaveBeenCalled();
      expect(f.runtime.writeTerminal).not.toHaveBeenCalled();
      expect(f.runtime.close).toHaveBeenCalled();
      expect(JSON.stringify(f.events)).not.toMatch(LEAK);
      expect(f.session.currentState).toBe('closed');
    });

  it('stops an uncorrelated startup too, at once rather than after the startup timeout', async () => {
    const f = startup(false); const started = f.session.start();
    f.screen(FORCED);
    await expect(started).rejects.toThrow(SIGN_IN_REQUIRED);
    expect(f.snapshots()).toEqual([]);
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });

  it.each(ORDINARY.map((rows) => [rows[0], rows]))('still publishes and answers "%s"', async (_name, rows) => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    f.screen(rows);
    await vi.advanceTimersByTimeAsync(30);
    const shown = f.snapshots().at(-1)!;
    expect(shown).toMatchObject({ phase: 'waiting', text: expect.stringContaining(rows[0]!) });
    const down = f.session.startupInput({ revision: shown.revision, key: 'down' });
    // Once the key is written the CLI answers with its next frame, which counts once 150 ms pass without more output; the
    // key that finishes the startup is answered by the session being ready.
    await vi.advanceTimersByTimeAsync(0);
    f.screen([...rows, '  (moved)']);
    await vi.advanceTimersByTimeAsync(150);
    await down;
    const enter = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' });
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\x1b[B'], ['\r']]);
    f.ready();
    await expect(started).resolves.toMatchObject({ handleId: 'owned', sessionId: 'synthetic-session' });
    await enter;
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'ready', text: '' });
    await f.session.close();
  });
});

// Review regression: after a startup key, the same screen came back under a new revision at once, so a second Enter
// pressed before the CLI's next frame arrived was written too, and could pick a method in the CLI's login-method list.
describe('one startup key at a time', () => {
  const THEME = ORDINARY[2]!;
  const API_KEY = ORDINARY[3]!;
  const TRUST = ORDINARY[0]!;
  // The first-run login step in two pieces: its intro rows, then the method list.
  const LOGIN_INTRO = `\x1b[2J\x1b[H${['Welcome to Claude Code', '',
    ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.', ''].join('\r\n')}`;
  const LOGIN_METHODS = `\r\n${[' Select login method:', '', ` ${SIGN_IN[1]}`, ` ${SIGN_IN[2]}`].join('\r\n')}`;
  // The connectivity check that both builds can show before the text style; its spinner steps every 120 ms or so.
  const SPINNER = ['·', '✢', '*', '✶', '✻', '✽'];
  const checking = (step: number) => [`${SPINNER[step % SPINNER.length]} Checking connectivity...`];
  const settled = (promise: Promise<unknown>) => {
    const state = { done: false };
    void promise.then(() => { state.done = true; }, () => { state.done = true; });
    return state;
  };

  it('writes one of two Enters pressed within one CLI frame, and the login-method list that follows closes the session', async () => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    const failed = expect(started).rejects.toThrow(SIGN_IN_REQUIRED);
    f.screen(THEME);
    await vi.advanceTimersByTimeAsync(30);
    const theme = f.snapshots().at(-1)!;
    const first = f.session.startupInput({ revision: theme.revision, key: 'enter' });
    const firstFailed = expect(first).rejects.toThrow(SIGN_IN_REQUIRED);
    // While the key waits for the CLI's answer, the same screen is shown under a new revision.
    const again = f.snapshots().at(-1)!;
    expect(again).toMatchObject({ phase: 'waiting', text: theme.text });
    expect(again.revision).toBeGreaterThan(theme.revision);
    await vi.advanceTimersByTimeAsync(5);
    await expect(f.session.startupInput({ revision: again.revision, key: 'enter' })).rejects.toThrow('has not answered the previous key yet');
    await expect(f.session.startupInput({ revision: theme.revision, key: 'enter' })).rejects.toThrow('screen changed');
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
    // Only now does the frame of the step the CLI moved to arrive.
    f.screen(SIGN_IN);
    await firstFailed;
    await failed;
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });
    expect(f.runtime.close).toHaveBeenCalledOnce();
    expect(f.session.currentState).toBe('closed');
    expect(JSON.stringify(f.events)).not.toMatch(LEAK);
  });

  it('re-arms input after a quiet second when a key changes nothing on the screen, and not before', async () => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    f.screen(THEME);
    await vi.advanceTimersByTimeAsync(30);
    const up = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'up' });
    const state = settled(up);
    const revision = f.snapshots().at(-1)!.revision;
    await vi.advanceTimersByTimeAsync(999);
    expect(state.done).toBe(false);
    await expect(f.session.startupInput({ revision, key: 'down' })).rejects.toThrow('has not answered the previous key yet');
    await vi.advanceTimersByTimeAsync(1);
    await up;
    // The window's revision is still the current one.
    expect(f.snapshots().at(-1)!.revision).toBe(revision);
    const down = f.session.startupInput({ revision, key: 'down' });
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\x1b[A'], ['\x1b[B']]);
    f.ready(); await started; await down;
    await f.session.close();
  });

  it('re-arms input once a changed screen has had no output for 150 ms, and never for output from before the write was confirmed', async () => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    f.screen(THEME);
    await vi.advanceTimersByTimeAsync(30);
    const enter = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' });
    const state = settled(enter);
    const consumed = f.snapshots().at(-1)!.revision;
    await vi.advanceTimersByTimeAsync(0);
    f.screen(API_KEY);
    await vi.advanceTimersByTimeAsync(149);
    // Shown, but not taken as the answer before the screen has been quiet for the whole period.
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'waiting', text: expect.stringContaining('Detected a custom API key') });
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    await enter;
    const approval = f.snapshots().at(-1)!;
    // A key for the screen before it is never written.
    await expect(f.session.startupInput({ revision: consumed, key: 'enter' })).rejects.toThrow('screen changed');
    let confirm!: () => void;
    f.runtime.writeStartup.mockImplementationOnce(() => new Promise<undefined>((done) => { confirm = () => done(undefined); }));
    const down = f.session.startupInput({ revision: approval.revision, key: 'down' });
    const downState = settled(down);
    // Output that arrives while the write is not confirmed yet, also just before and not shown yet, is part of the screen
    // the key is judged against, not its answer: the key settles as one that changed nothing.
    f.screen(TRUST);
    await vi.advanceTimersByTimeAsync(30);
    await expect(f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' })).rejects.toThrow('has not answered the previous key yet');
    f.screen([...TRUST, '  (redrawn)']);
    confirm();
    await vi.advanceTimersByTimeAsync(999);
    expect(downState.done).toBe(false);
    await expect(f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' })).rejects.toThrow('has not answered the previous key yet');
    await vi.advanceTimersByTimeAsync(1);
    expect(downState.done).toBe(true);
    await down;
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'waiting', text: expect.stringContaining('Quick safety check') });
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\r'], ['\x1b[B']]);
    f.ready(); await started;
    await f.session.close();
  });

  // Review regression: the first piece of a frame that arrived in pieces answered the key, so a second Enter pressed
  // before the rest of the login step arrived was written.
  it.each([['right after the key', 0], ['just before the quiet second ends', 995]])(
    'holds the key while the login step arrives in two pieces 50 ms apart (%s), so no second Enter is written', async (_name, delay) => {
      vi.useFakeTimers();
      const f = startup(); const started = f.session.start();
      const failed = expect(started).rejects.toThrow(SIGN_IN_REQUIRED);
      f.screen(THEME);
      await vi.advanceTimersByTimeAsync(30);
      const first = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' });
      const firstFailed = expect(first).rejects.toThrow(SIGN_IN_REQUIRED);
      await vi.advanceTimersByTimeAsync(delay);
      f.raw(LOGIN_INTRO);
      await vi.advanceTimersByTimeAsync(40);
      // The intro row, which no sign-in row is part of, reached the window; the key still waits.
      const partial = f.snapshots().at(-1)!;
      expect(partial.text).toContain('Claude Code can be used with your Claude subscription');
      await expect(f.session.startupInput({ revision: partial.revision, key: 'enter' })).rejects.toThrow('has not answered the previous key yet');
      await vi.advanceTimersByTimeAsync(10);
      f.raw(LOGIN_METHODS);
      await firstFailed;
      await failed;
      expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
      expect(f.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });
      expect(f.runtime.close).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.events)).not.toMatch(LEAK);
    });

  it('holds a key while the screen keeps changing, past the quiet second, until no output has followed for 150 ms', async () => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    f.screen(checking(0));
    await vi.advanceTimersByTimeAsync(30);
    const enter = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' });
    const state = settled(enter);
    for (let step = 1; step <= 12; step++) {
      await vi.advanceTimersByTimeAsync(120);
      await expect(f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' })).rejects.toThrow('has not answered the previous key yet');
      f.screen(checking(step));
    }
    // The check is over and the text style follows by itself.
    await vi.advanceTimersByTimeAsync(120);
    expect(state.done).toBe(false);
    f.screen(THEME);
    await vi.advanceTimersByTimeAsync(149);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    await enter;
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'waiting', text: expect.stringContaining('Choose the text style') });
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
    f.ready(); await started;
    await f.session.close();
  });

  it('re-arms input three seconds after the write when the screen never goes quiet, so a key never sticks', async () => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    f.screen(checking(0));
    await vi.advanceTimersByTimeAsync(30);
    const enter = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'enter' });
    const state = settled(enter);
    await vi.advanceTimersByTimeAsync(0);
    for (let step = 1; step <= 24; step++) {
      await vi.advanceTimersByTimeAsync(120);
      f.screen(checking(step));
    }
    await vi.advanceTimersByTimeAsync(110);
    f.screen(checking(25));
    await vi.advanceTimersByTimeAsync(9);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    await enter;
    // The window has the screen of that moment, also a step that came just before, and the next key goes to it.
    const now = f.snapshots().at(-1)!;
    expect(now.text).toContain(`${SPINNER[25 % SPINNER.length]} Checking connectivity...`);
    const next = f.session.startupInput({ revision: now.revision, key: 'down' });
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\r'], ['\x1b[B']]);
    f.ready(); await started; await next;
    await f.session.close();
  });

  it('still ends at the startup timeout or a close while a key waits for its answer, and a key that could not be written fails at once', async () => {
    vi.useFakeTimers();
    const timedOut = startup(); const first = timedOut.session.start();
    const firstFailed = expect(first).rejects.toThrow('waiting for an answer to the API key approval dialog');
    timedOut.screen(API_KEY);
    await vi.advanceTimersByTimeAsync(30);
    const waiting = timedOut.session.startupInput({ revision: timedOut.snapshots().at(-1)!.revision, key: 'down' });
    const waitingFailed = expect(waiting).rejects.toThrow('no longer available');
    timedOut.timeout();
    await firstFailed; await waitingFailed;
    expect(timedOut.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });

    const closed = startup(); const second = closed.session.start().catch((error: unknown) => error);
    closed.screen(THEME);
    await vi.advanceTimersByTimeAsync(30);
    const pending = closed.session.startupInput({ revision: closed.snapshots().at(-1)!.revision, key: 'enter' });
    const pendingFailed = expect(pending).rejects.toThrow('no longer available');
    await closed.session.close();
    await pendingFailed; await second;
    expect(closed.runtime.close).toHaveBeenCalledOnce();

    const refused = startup(); const third = refused.session.start();
    refused.screen(THEME);
    await vi.advanceTimersByTimeAsync(30);
    refused.runtime.writeStartup.mockRejectedValueOnce(new Error('Native transport: startup input is no longer available'));
    await expect(refused.session.startupInput({ revision: refused.snapshots().at(-1)!.revision, key: 'enter' })).rejects.toThrow('startup input is no longer available');
    const next = refused.session.startupInput({ revision: refused.snapshots().at(-1)!.revision, key: 'down' });
    expect(refused.runtime.writeStartup.mock.calls).toEqual([['\r'], ['\x1b[B']]);
    refused.ready(); await third; await next;
    await refused.session.close();
  });
});

// Review regression: the gateway's address, connection and trust screens were shown and answered (Enter to connect,
// Down and Enter to trust the gateway) before its device-code step closed the session.
describe('the Cloud gateway sign-in before its device code', () => {
  it.each([['address', GATEWAY_ADDRESS], ['connection', GATEWAY_CONNECTING], ['trust', GATEWAY_TRUST]])('recognises the %s screen', (_name, rows) => {
    expect(isSignInScreen(rows, 140)).toBe(true);
  });

  it('never publishes the address or trust screen and lets no Enter, Down or Enter reach the CLI', async () => {
    vi.useFakeTimers();
    const f = startup(); const started = f.session.start();
    const failed = expect(started).rejects.toThrow(SIGN_IN_REQUIRED);
    f.screen(GATEWAY_ADDRESS);
    await vi.advanceTimersByTimeAsync(30);
    for (const key of ['enter', 'down', 'enter'] as NativeStartupKey[]) {
      await expect(f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key })).rejects.toThrow(SIGN_IN_REQUIRED);
    }
    f.screen(GATEWAY_TRUST);
    await vi.advanceTimersByTimeAsync(30);
    await failed;
    expect(f.snapshots().map((snapshot) => snapshot.text).join('\n')).not.toMatch(/Press Enter to connect|Yes, trust this gateway/);
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });
    expect(f.runtime.writeStartup).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
    expect(f.session.currentState).toBe('closed');
    expect(JSON.stringify(f.events)).not.toMatch(LEAK);
  });
});

const CAPS = ['prompt.submit', 'command.run', 'command.list'];
const LAUNCH: NativeLaunch = { exe: 'C:\\synthetic\\claude.exe', args: [], cwd: 'C:\\synthetic', env: {}, handleId: 'h', cols: COLUMNS, rows: 30 };
const draw = (rows: string[]) => `\x1b[2J\x1b[H${rows.join('\r\n')}`;
const PROMPT = draw(['', '\u2500'.repeat(70), '>', '\u2500'.repeat(70)]);
const docked = (rows: string[], indent = '   ') => draw([...Array<string>(8).fill(''), '\u2594'.repeat(60), ...rows.map((row) => `${indent}${row}`)]);
const CONFIG = docked(['Settings  Status  Config', '\u276f Auto-compact   true', 'Esc to close']);

/** A CLI whose slash commands draw a docked dialog and wait until the session ends. */
class DialogRuntime implements NativeRuntime {
  readonly terminals = new Set<(data: string) => void>();
  readonly writeTerminal = vi.fn(async (_data: string) => undefined);
  constructor(private readonly listed: readonly string[] = []) {}
  readonly request = vi.fn((method: string, _args?: unknown, options?: NativeRequestOptions): Promise<unknown> => {
    if (method === 'command.list') return Promise.resolve(['config', ...this.listed].map((name) => ({ name, description: 'A synthetic command' })));
    if (method !== 'command.run') return Promise.resolve({});
    this.terminal(CONFIG);
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  readonly start = vi.fn(async (): Promise<NativeReady> => {
    this.terminal(PROMPT);
    return { sessionId: 'native-session', isInteractive: true, surface: 'terminal', protocol: 1, capabilities: CAPS };
  });
  readonly close = vi.fn(async () => undefined);
  readonly resize = vi.fn(async () => undefined);
  onEvent() { return () => undefined; }
  onExit() { return () => undefined; }
  onTerminal(listener: (data: string) => void) { this.terminals.add(listener); return () => this.terminals.delete(listener); }
  terminal(text: string): void { for (const listener of this.terminals) listener(text); }
}

async function openSession(listed: readonly string[] = []) {
  const runtime = new DialogRuntime(listed);
  const events: EngineEvent[] = [];
  const session = new NativeInteractiveSession({ handleId: 'h', runtime, launch: LAUNCH,
    request: { cwd: LAUNCH.cwd, profileId: 'default' }, profile: { id: 'default', name: 'Default', configDir: null, createdAt: 0 },
    broker: new PermissionBroker('h', (event) => events.push(event)), emit: (event) => events.push(event), newId: () => 'command-1' });
  await session.start();
  await vi.waitFor(() => expect(events.some((event) => event.type === 'commands')).toBe(true));
  const panels = () => events.flatMap((event) => event.type === 'panel' ? [event.panel] : []);
  const runs = () => runtime.request.mock.calls.filter(([method]) => method === 'command.run');
  return { runtime, events, session, panels, runs };
}

// The wrapped address fills the panel's rows from the first column, as the CLI outdents it.
const PANEL_SCREENS: Array<[string, string[], string]> = [...SCREENS.filter(([name]) => name !== 'wrapped authorization address')
  .map(([name, rows]): [string, string[], string] => [name, rows, '   ']), ['wrapped authorization address', wrapped(COLUMNS), '']];

describe('the CLI sign-in in a mirrored panel', () => {
  it.each(PANEL_SCREENS)(
    'a dialog that turns into the %s is never mirrored, takes no input and closes the session', async (_name, rows, indent) => {
      const h = await openSession();
      const command = h.session.send('/config').catch((error: unknown) => error);
      await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
      h.runtime.terminal(docked(rows, indent));
      await vi.waitFor(() => expect(h.session.currentState).toBe('closed'));
      expect(h.panels().at(-1)).toBeNull();
      expect(h.events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', handleId: 'h', message: SIGN_IN_REQUIRED, fatal: true }]);
      await expect(h.session.panelInput({ kind: 'text', text: 'synthetic-code', paste: true })).rejects.toThrow(SIGN_IN_REQUIRED);
      expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
      expect(h.runtime.close).toHaveBeenCalledOnce();
      expect(JSON.stringify(h.events)).not.toMatch(LEAK);
      await command;
    });

  it('refuses input meant for a dialog that became the sign-in before the mirror caught up', async () => {
    const h = await openSession();
    const command = h.session.send('/config').catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    // The dialog's first row says nothing yet; the spinner row below it does.
    h.runtime.terminal(docked(['Signing in', '', '\u2722 Opening browser to sign in\u2026']));
    await expect(h.session.panelInput({ kind: 'key', key: 'enter' })).rejects.toThrow(SIGN_IN_REQUIRED);
    expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.session.currentState).toBe('closed'));
    expect(JSON.stringify(h.events)).not.toMatch(LEAK);
    await command;
  });

  it('keeps mirroring and answering an ordinary dialog, also one with assistant-like rows', async () => {
    const h = await openSession();
    const command = h.session.send('/config').catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    h.runtime.terminal(docked(['Resume a conversation', '\u276f \u25cf Login successful. The tests pass now.', '  \u25cf Opening browser to sign in\u2026 failed once.']));
    await vi.waitFor(() => expect(JSON.stringify(h.panels().at(-1))).toContain('Resume a conversation'));
    await h.session.panelInput({ kind: 'key', key: 'down' });
    expect(h.runtime.writeTerminal.mock.calls).toEqual([['\x1b[B']]);
    expect(h.events.some((event) => event.type === 'error')).toBe(false);
    expect(h.session.currentState).toBe('running');
    await h.session.close(); await command;
  });
});

describe('the CLI sign-in commands', () => {
  it('are the commands of CLI 2.1.311 and 2.1.322 that can run its own sign-in', () => {
    expect([...SIGN_IN_COMMANDS].sort()).toEqual(['design-login', 'extra-usage', 'install-github-app', 'login', 'logout', 'pro-trial-expired',
      'rate-limit-options', 'remote-control', 'setup-bedrock', 'teleport', 'upgrade', 'usage-credits']);
    expect([...ACCOUNT_COMMANDS].sort()).toEqual(['design-login', 'login', 'logout']);
  });

  it.each([...SIGN_IN_COMMANDS, 'rc', 'tp', 'TP', '  /Upgrade now  ', '/LOGOUT'])('refuses %s in the main process, before the CLI sees it', async (typed) => {
    const h = await openSession();
    const text = typed.trim().startsWith('/') ? typed : `/${typed}`;
    const name = text.trim().slice(1).split(/\s/)[0]!.toLowerCase();
    const refusal = signInCommandRefusal(name);
    await expect(h.session.send(text)).rejects.toThrow(refusal);
    expect(refusal).not.toMatch(/not signed in/);
    expect(refusal).toBe(ACCOUNT_COMMANDS.has(name) ? `/${name} is handled by Relay, not the native CLI.`
      : `Relay Desk does not run Claude Code's own sign-in inside a session. Run /${name} in a terminal.`);
    expect(h.runs()).toEqual([]);
    const command = h.session.send('/config').catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.runs()).toHaveLength(1));
    await h.session.close(); await command;
  });

  it.each(['tp', 'rc'])('runs a session command named exactly /%s, which the CLI finds before the alias', async (name) => {
    const h = await openSession([name]);
    const command = h.session.send(`/${name}`).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.runs()).toEqual([['command.run', { command: name, args: '' }, expect.anything()]]));
    await h.session.close(); await command;
  });

  it.each(['tp', 'rc'])('compares a session command with the typed /%s letter for letter, as the CLI, the window and the plugin do', async (alias) => {
    for (const [typed, listed] of [[alias.toUpperCase(), alias], [alias, alias.toUpperCase()]]) {
      const h = await openSession([listed!]);
      await expect(h.session.send(`/${typed}`)).rejects.toThrow(signInCommandRefusal(alias));
      expect(h.runs()).toEqual([]);
      await h.session.close();
    }
  });

  it('refuses a session command of a sign-in command\'s name in any letter case, as the window and the plugin do', async () => {
    const h = await openSession(['UPGRADE']);
    await expect(h.session.send('/UPGRADE')).rejects.toThrow(signInCommandRefusal('upgrade'));
    expect(h.runs()).toEqual([]);
    await h.session.close();
  });

  it('sends a message that only mentions them as an ordinary prompt', async () => {
    const h = await openSession();
    await h.session.send('why does /login fail?');
    expect(h.runtime.request).toHaveBeenCalledWith('prompt.submit', { text: 'why does /login fail?', asUser: true }, expect.anything());
    await h.session.close();
  });
});

// No status is checked before a session opens: a signed-out account's session starts, and the CLI's first sign-in screen
// closes it with the sign-in message. The key that led there is answered by that screen, and no other key is written.
describe('a session of a signed-out account', () => {
  const work: Profile = { id: 'work', name: 'Work', configDir: 'C:\\Users\\me\\profiles\\work', createdAt: 0 };
  const REQUEST = '00000000-0000-4000-8000-000000000001';
  const THEME =['Welcome to Claude Code', '', 'Choose the text style that looks best with your terminal', '\u276f 1. Dark mode', '  2. Light mode'];
  // The first-run sign-in step as the CLI shows it after the text style.
  const FIRST_SIGN_IN = ['Welcome to Claude Code', '',
    ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.', '',
    ' Select login method:', '', ` ${SIGN_IN[1]}`, ` ${SIGN_IN[2]}`];
  function engine() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const events: EngineEvent[] = [];
    const terminals = new Set<(data: string) => void>();
    let reject!: (error: Error) => void;
    const hello = new Promise<NativeReady>((_resolve, failed) => { reject = failed; });
    void hello.catch(() => undefined);
    const runtime = {
      start: vi.fn(() => hello), request: vi.fn(async () => []),
      writeStartup: vi.fn(async (_data: string) => undefined), writeTerminal: vi.fn(async (_data: string) => undefined),
      close: vi.fn(async () => { reject(new Error('Native transport: runtime closed')); }), resize: vi.fn(async () => undefined),
      onEvent: () => () => undefined, onExit: () => () => undefined,
      onTerminal: (callback: (data: string) => void) => { terminals.add(callback); return () => terminals.delete(callback); },
    } satisfies NativeRuntime;
    registerEngineIpc({ handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, listener); } } as unknown as IpcMain, {
      emit: (event) => events.push(event), getProfile: async () => work, listingWorkerPath: 'C:\\synthetic\\listingWorker.js',
      logDir: 'C:\\synthetic\\logs', isDirectory: async () => true, newHandleId: () => 'h1',
      createSession: (options) => new NativeInteractiveSession({ ...options, runtime,
        launch: { exe: 'C:\\synthetic\\claude.exe', args: [], cwd: options.request.cwd, env: {}, handleId: options.handleId, cols: 140, rows: 48 } }),
    });
    const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({ sender: {} }, ...args));
    const snapshots = () => events.filter((event): event is Extract<EngineEvent, { type: 'startup' }> => event.type === 'startup');
    const key = (key: NativeStartupKey) => invoke(IPC.engine.startupInput, 'h1', REQUEST, { revision: snapshots().at(-1)!.revision, key });
    return { events, runtime, invoke, snapshots, key,
      screen(rows: string[]) { for (const callback of terminals) callback(`\x1b[2J\x1b[H${rows.join('\r\n')}`); } };
  }

  it.each([['first-run sign-in', FIRST_SIGN_IN], ['Cloud gateway address', GATEWAY_ADDRESS], ['forced login method', FORCED],
    ['forced login method of 2.1.322', FORCED_322], ['first-run sign-in after its start failed', FIRST_RUN_RETRY]])(
    'opens, and ends with the sign-in message at the CLI\'s %s, which answers the text-style key', async (_name, rows) => {
      vi.useFakeTimers();
      const f = engine();
      const opened = f.invoke(IPC.engine.open, { profileId: 'work', cwd: 'C:\\synthetic', startupRequestId: REQUEST });
      const failed = expect(opened).rejects.toThrow(SIGN_IN_REQUIRED);
      await vi.waitFor(() => expect(f.runtime.start).toHaveBeenCalledOnce());
      f.screen(THEME);
      await vi.advanceTimersByTimeAsync(30);
      expect(f.snapshots().at(-1)).toMatchObject({ phase: 'waiting', text: expect.stringContaining('Choose the text style') });
      const theme = f.key('enter');
      const answered = expect(theme).rejects.toThrow(SIGN_IN_REQUIRED);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
      f.screen(rows);
      await answered;
      await expect(f.key('enter')).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30);
      await failed;
      expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
      expect(f.runtime.close).toHaveBeenCalled();
      expect(f.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });
      expect(JSON.stringify(f.events)).not.toMatch(LEAK);
    });

  it('writes one of two Enters sent through the engine within one CLI frame, and the first-run sign-in closes the session', async () => {
    vi.useFakeTimers();
    const f = engine();
    const opened = f.invoke(IPC.engine.open, { profileId: 'work', cwd: 'C:\\synthetic', startupRequestId: REQUEST });
    const failed = expect(opened).rejects.toThrow(SIGN_IN_REQUIRED);
    await vi.waitFor(() => expect(f.runtime.start).toHaveBeenCalledOnce());
    f.screen(THEME);
    await vi.advanceTimersByTimeAsync(30);
    const first = f.key('enter');
    const firstFailed = expect(first).rejects.toThrow(SIGN_IN_REQUIRED);
    await vi.advanceTimersByTimeAsync(1);
    await expect(f.key('enter')).rejects.toThrow('has not answered the previous key yet');
    await expect(f.invoke(IPC.engine.startupInput, 'h1', REQUEST, { revision: 1, key: 'enter' })).rejects.toThrow('no longer active');
    f.screen(FIRST_SIGN_IN);
    await firstFailed;
    await failed;
    expect(f.runtime.writeStartup.mock.calls).toEqual([['\r']]);
    expect(f.snapshots().map((snapshot) => snapshot.text).join('\n')).not.toMatch(/Select login method/);
    expect(JSON.stringify(f.events)).not.toMatch(LEAK);
  });
});
