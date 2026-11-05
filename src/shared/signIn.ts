// The sign-in guard. The main process checks every startup screen and every mirrored dialog with isSignInScreen: a screen
// that shows the Claude Code CLI's own sign-in is never sent to the window and takes no key or text, and the session
// closes with SIGN_IN_REQUIRED. A startup key is written only after the CLI has answered the one before it: a changed
// screen that then stays quiet (so one that arrives in pieces is checked whole), a second without a change, or at most
// three seconds of a screen that keeps changing. The CLI can still open a browser at Claude's sign-in page by itself (a
// login method forced by settings) before it draws anything matched here. Log in runs the official sign-in in its own
// console instead (src/main/system/officialLogin.ts).
import { cellWidth } from './terminalWidth';

export const SIGN_IN_REQUIRED = 'This account is not signed in to Claude Code. Use Log in under Accounts, then open the session again.';

/** Sign-in commands that Log in and Log out under Accounts stand in for. */
export const ACCOUNT_COMMANDS: ReadonlySet<string> = new Set(['login', 'logout', 'design-login']);

/**
 * Commands of CLI 2.1.311 and 2.1.318 that can run Claude Code's own sign-in (its login screen, its browser
 * authorization or a key typed into the CLI), by the name the CLI registers them under; /remote-control and /teleport
 * also answer to rc and tp. The plugin ships without src/, so native-mod/hooks/bridge.ts keeps a copy.
 */
export const SIGN_IN_COMMANDS: ReadonlySet<string> = new Set([...ACCOUNT_COMMANDS, 'upgrade', 'remote-control', 'teleport',
  'usage-credits', 'extra-usage', 'rate-limit-options', 'pro-trial-expired', 'install-github-app', 'setup-bedrock']);

/** Why a sign-in command is refused; `name` is the command as typed, lower-cased. */
export function signInCommandRefusal(name: string): string {
  return ACCOUNT_COMMANDS.has(name) ? `/${name} is handled by Relay, not the native CLI.`
    : `Relay Desk does not run Claude Code's own sign-in inside a session. Run /${name} in a terminal.`;
}

// Rows of the CLI's sign-in screens (CLI 2.1.311 and 2.1.318), whole and spelled as the CLI draws them, once the
// leading run of spinner frames, bullets, pointers and box edges is dropped. Assistant text that only starts with the
// same words does not match, nor does an MCP server's own authentication.
const SIGN_IN_ROWS: readonly RegExp[] = [
  /^Select login method:$/,
  /^How do you want to sign in\?$/,
  // A login method forced to claude.ai reads "Subscription Plan" in 2.1.311 and "Claude subscription" in 2.1.318.
  /^Login method pre-selected: (?:Subscription Plan \(Claude Pro\/Max\)|Claude subscription \(claude\.ai account\)|API usage billing \(Anthropic Console\))$/,
  /^Starting new login following \/[a-z-]+\. Exit with Ctrl-C to use existing account\.$/,
  /^Sign in to enroll this device for Remote Control\.$/,
  /^Log in to Claude$/,
  /^Starting authentication\u2026$/,
  /^Opening browser to sign in(?: with your Claude account)?\u2026$/,
  /^(?:Browser didn't open\? Use the url|Use the URL) below to sign in(?: \([^()]{1,60}\))?$/,
  /^Paste code here(?: if prompted)? >/,
  // 2.1.311 only: 2.1.318 no longer has this screen.
  /^Creating API key for Claude Code\u2026$/,
  /^Login successful\. Press Enter to continue\u2026$/,
  // The first-run sign-in when its start failed (a forced login method the organization's settings do not admit).
  /^Press Enter to retry\. \(Esc to continue without logging in\)$/,
  // The Cloud gateway sign-in, which starts here when settings name a gateway: its address, the connection, trusting
  // the gateway's certificate, the device code and the account. A host is shown only with a dot or colon; a one-label
  // host's trust screen is still matched by its other rows.
  /^Press Enter to connect \u00b7 Esc for other login methods$/,
  /^Connecting to gateway\u2026$/,
  /^Trust gateway (?=[^\s?]*[.:])[^\s?]+\?$/,
  /^Yes, trust this gateway$/,
  /^Certificate fingerprint \(SHA-256\): (?:[0-9a-f]{16}|http-loopback)\u2026$/,
  /^Cloud gateway \u00b7 sign in$/,
  /^Waiting for sign-in to complete in your browser\u2026$/,
  /^Signed in to Cloud gateway as \S+$/,
  /^Connected to Cloud gateway\.$/,
];
// The gateway sign-in's heading is too plain to count alone; these rows count only below it, each whole (at the 140
// columns of a session they fit on one row).
const GATEWAY_HEADING = /^Cloud gateway$/;
const GATEWAY_ROWS: readonly RegExp[] = [
  /^Press Enter to connect$/,
  /^Your organization's gateway URL \(set by managed settings\):$/,
  /^Gateway login is required by your organization's policy, but no gateway URL is configured\. Contact your IT administrator\.$/,
];
// Except this caption: it names the settings file, whose path (an account's own folder) can wrap it onto the next rows
// at a space or, for a long word, mid-word. It counts whole, its rows joined.
const GATEWAY_FILE_CAPTION = /^Gateway URL from your settings file \((?:[A-Za-z]:|\\\\).+\), not from your organization's managed settings\.$/;
const CAPTION_ROWS = 4;
const LEADING_GLYPHS = /^[^\p{L}\p{N}]+/u;
// Claude's own authorization pages: the claude.ai and Console sign-ins and the endpoints CLAUDE_CODE_CUSTOM_OAUTH_URL
// may name. An MCP server authorizes on its own host, so its address stays usable in the /mcp panel. The export refuses
// files that spell the path out, hence the join.
const AUTHORIZATION_URL = new RegExp(`https://(?:claude\\.com/cai|platform\\.claude\\.com|claude\\.fedstart\\.com|claude-staging\\.fedstart\\.com|beacon\\.claude-ai\\.staging\\.ant\\.dev)/${['oauth', 'authorize'].join('/')}(?=[?#\\s]|$)`, 'i');

/** Rows that run into the next one (text up to the last column) joined with it, the way the CLI wrote them. */
function unwrapped(rows: readonly string[], columns: number): string[] {
  const lines: string[] = [];
  let carried = '';
  for (const row of rows) {
    const text = row.trimEnd();
    if (cellWidth(text) >= columns) { carried += text; continue; }
    lines.push(carried + text);
    carried = '';
  }
  if (carried) lines.push(carried);
  return lines;
}

/** Whether terminal rows `columns` cells wide show the CLI's sign-in or one of Claude's authorization addresses. */
export function isSignInScreen(rows: readonly string[], columns: number): boolean {
  if (unwrapped(rows, columns).some((line) => AUTHORIZATION_URL.test(line))) return true;
  const plain = rows.map((row) => row.replace(/\s+/g, ' ').trim());
  const texts = plain.map((text) => text.replace(LEADING_GLYPHS, ''));
  if (texts.some((text) => SIGN_IN_ROWS.some((pattern) => pattern.test(text)))) return true;
  const heading = texts.findIndex((text) => GATEWAY_HEADING.test(text));
  if (heading < 0) return false;
  for (let row = heading + 1; row < texts.length; row++) {
    if (GATEWAY_ROWS.some((pattern) => pattern.test(texts[row]!))) return true;
    // A continued row keeps its first character, which can be the caption's opening parenthesis.
    let caption = texts[row]!;
    for (let next = row; next < Math.min(texts.length, row + CAPTION_ROWS) && plain[next]; next++) {
      if (next > row) caption += ` ${plain[next]}`;
      if (GATEWAY_FILE_CAPTION.test(caption)) return true;
    }
  }
  return false;
}
