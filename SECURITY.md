# Security policy

## Reporting a vulnerability in Relay Desk

Report vulnerabilities privately, through the private vulnerability reporting of the platform that hosts this
repository (for example "Report a vulnerability" on its Security tab). Do not open a public issue, discussion or pull
request about a vulnerability before it is fixed.

Please include:

- what an attacker can do, and under which conditions;
- the steps or a minimal proof of concept to reproduce it;
- the Relay Desk version and the output of `npm run cli:status`.

Leave out real credentials, tokens, personal paths and session contents; synthetic values are enough.
`npm run cli:status` and most logs print folders under your user profile: replace your user name in them (for example
with `C:\Users\me`) before you paste the output.

Reports are fixed in the maintainers' workspace and published with the next export (see CONTRIBUTING.md).

## Vulnerabilities in Claude Code

Relay Desk runs Claude Code unmodified. Vulnerabilities in Claude Code itself, in the Claude Agent SDK or in Anthropic's
services are not Relay Desk's to fix: report them to Anthropic through its own published vulnerability disclosure
channel.

## Scope notes

These are design boundaries; a way around any of them is a vulnerability:

- Relay Desk's own code must never capture, store, log or display Claude's own sign-in addresses, authorization codes,
  tokens, API keys or other credentials, and must never read, copy or forward Claude Code's credential file. An MCP
  server's own authorization address is not Claude's sign-in: it can appear in the mirrored `/mcp` dialog, because that
  is how an MCP server is authorized. Text that Claude Code's tools print is shown as it is; "What the guard cannot
  catch" below lists what that means for sign-in addresses.
- The Anthropic and Claude Code authentication variables of the launch environment (which can include subscription
  tokens such as `CLAUDE_CODE_OAUTH_TOKEN`) are kept in memory only and are never stored, logged, sent to the window or
  put on a command line. They may be handed on, in the environment of a process, only to the Claude Code processes
  started for an account that uses that source, through Relay Desk's own helper processes; "Launch-environment values"
  below says where they end up. The cloud provider variables in the same list (`AWS_*`, `GOOGLE_*` and the others named
  there) are the exception: Relay Desk never removes them from its own environment, so every process it starts inherits
  them.
- Relay Desk must never show Claude Code's own sign-in screen in its window, and must write no key or text to a screen
  it has recognized as that sign-in. A session whose screen shows that sign-in is closed, and sign-in happens only in
  the separate console window that Log in opens. "The sign-in guard" below says what is checked and what is not,
  including the cases where a key reaches Claude Code before its sign-in has been drawn.
- The named pipe between Relay Desk and its plugin must not be usable by other Windows users or without the session's
  nonce.
- Private storage under `C:\RelayDeskNativePrototype` must not be readable by other Windows users.
- `relaydesk://` links must never start a model turn or run a command by themselves.

## The sign-in guard

Before a session is ready (the startup screen) and in every Claude Code dialog Relay Desk mirrors, each screen update is
checked. If it shows Claude Code's own sign-in, Relay Desk publishes none of it, writes no key or text to it, closes the
session at once and shows: "This account is not signed in to Claude Code. Use Log in under Accounts, then open the
session again."

Relay Desk does not check an account's status before it opens a session, and it runs no `claude auth status` in a
session's folder. A session of a signed-out account starts. Its earlier first-run steps (the text style, the approval
of an API key) are shown and answered as before, and the session is closed as soon as the CLI shows its sign-in. That
sign-in can be the first-run login step, the Cloud gateway address, a login method forced by settings, or a first-run
sign-in that failed to start. A project that signs in through its own settings (`env` in `.claude/settings.json`, an
`apiKeyHelper`) opens normally, because only the CLI's own screen decides. The one check left that depends on a status
is for effort notes: Relay Desk reads Claude Code's global configuration only while a status checked within the last
minute says claude.ai sign-in from the CLI's configuration; an older status is refreshed in the background and decides
nothing.

Startup keys: Relay Desk sends one startup key at a time. After a key or a key button on the startup screen, the keys
stay disabled and further presses are ignored (not queued, no error) until Claude Code has answered. A key counts as
answered once the screen differs from the one shown when the key had been written and then gets no output from Claude
Code for 150 ms; after about one second if the key changed nothing on the screen; or after at most three seconds if the
screen keeps changing. Output that arrived before the key had been written never counts as its answer, and a screen
that arrives in pieces less than 150 ms apart is checked whole by the guard before the keys come back. So a second key
pressed for an earlier first-run screen (the text style, an API key approval) is not written once Claude Code has moved
on to its sign-in. For a signed-out account, the one key that answers the last first-run step (for example Enter on the
text style) is written, and the sign-in that follows closes the session. If a key could not be written, the startup
screen says why and the keys come back.

What it recognizes: the rows of the sign-in screens of Claude Code 2.1.311 and 2.1.322, matched whole and spelled as
those builds draw them, also behind the spinner or bullet that Claude Code puts in front of them. They are the
login-method choice, the Console method question, a login method forced by settings (worded "Subscription Plan" in 2.1.311 and "Claude subscription" in 2.1.322 for
claude.ai), "Opening browser to sign in...", "Creating API key for Claude Code..." (2.1.311 only), the paste-code prompt, the "Use the URL below to sign in" heading, the success
row, the new-login notes of `/upgrade` and `/usage-credits`, the Remote Control device enrollment note, the Teleport
"Log in to Claude" gate, the first-run sign-in that failed to start ("Press Enter to retry. (Esc to continue without
logging in)") and the GitHub app token step. The Cloud gateway sign-in is recognized from its first screen: the
address screen ("Press Enter to connect · Esc for other login methods", or, when a policy enforces the gateway, the
"Cloud gateway" heading with "Press Enter to connect", the gateway address caption or the note that the policy names
no address), "Connecting to gateway...", the question "Trust gateway <host>?" with its "Yes, trust this gateway" row
and certificate fingerprint, the device-code step ("Cloud gateway · sign in", "Waiting for sign-in to complete in your
browser...") and the success rows. Relay Desk writes no key to a gateway screen it has recognized, so no gateway can be
trusted from Relay Desk (see the limits below for a screen it has not seen yet). In 2.1.322 the device-code step can
also show a notice that the gateway sends ("Notice from <host>:" and its text); the notice is not matched itself, but
it is drawn only between the device-code step's own rows. A row that reads only "Cloud gateway"
counts only together with one of the gateway rows below it, so a conversation or heading named "Cloud gateway" does
not close a session. Under that heading the captions count only whole: "Your organization's gateway URL (set by
managed settings):" and "Gateway login is required by your organization's policy, but no gateway URL is configured.
Contact your IT administrator." (each fits on one row at a session's 140 columns), and "Gateway URL from your settings
file (<path of the account's settings.json>), not from your organization's managed settings." The last one names the
account's settings file, so for a longer path it wraps onto the next rows (an account folder that Relay Desk manages
makes it two rows); it counts with its rows joined: up to four rows, with no blank row between them, and the path
must start with a drive letter or `\\`. A row under the heading that only starts like one of these captions (prose in
a reply) does not close a session. The guard also recognizes Claude's own
authorization page address (on claude.com, platform.claude.com and the FedStart and staging endpoints Claude Code
accepts), on one row or wrapped over rows at the edge of the terminal. Assistant text that only starts with the same
words is not treated as sign-in.

Commands that can start the sign-in are refused before they reach Claude Code, by the window, the main process and the
plugin, with or without arguments and in any letter case, whether they are run as a command or submitted as a prompt
(the plugin refuses a prompt that Claude Code would run as one of them): `/login`, `/logout`, `/design-login`,
`/upgrade`, `/remote-control` (`/rc`), `/teleport` (`/tp`), `/usage-credits`, `/extra-usage`, `/rate-limit-options`,
`/pro-trial-expired`, `/install-github-app` and `/setup-bedrock` (its wizard takes a Bedrock API key and AWS access keys
in masked fields). A message that only mentions one of them (such as "why does /login fail?") is sent as an ordinary
prompt. The window, the main process and the plugin match a command of the user's own letter for letter, as Claude
Code does: your own `rc` or `tp` runs for `/rc` or `/tp`, but `/TP` with your own `tp` is refused, and so is `/tp` with
your own `TP`, because Claude Code would run `/teleport`. A command of your own named like one of the others (for
example `UPGRADE`) is refused in any letter case.

What the guard cannot catch:

- Other Claude Code versions may draw their sign-in differently; only the two admitted builds were checked, and a build
  that rewords a row is silently no longer matched.
- A sign-in that draws nothing. The `DesignSync` tool is one: in both builds it can start Claude Design's own browser
  authorization when the model calls it (whether that feature is enabled was not verified).
- A sign-in that the model or the user starts outside the guard's view. The guard watches only the startup screen and
  the mirrored dialogs. If the model runs `claude auth login` with its Bash tool, the CLI prints Claude's authorization
  address ("If the browser didn't open, visit: ...") in the tool output, which Relay Desk shows unredacted. A prompt
  that starts with `!` may do the same: Relay Desk refuses `!` only in messages with attachments, and the refusals of
  `/` commands do not cover `!` prompts or tool calls. This was read in the CLI's code, not run, so what a `!` prompt
  runs, and whether the address is printed, is not verified.
- The gateway's own error screen ("Error: ..." with "Press Esc to go back") and the plain "Press Enter to retry." row of
  the in-session login dialog are not matched. The first follows a screen that is matched, so the session is already
  closed; the second is reachable only through commands Relay Desk already refuses.
- A browser that Claude Code opens itself when its sign-in starts. Claude Code can do this before it draws anything
  the guard can match, for example when settings force a login method (`forceLoginMethod`), so the guard is too late
  to prevent it. Relay Desk closes the session as soon as the first sign-in row appears. If a browser was already
  running, the page opens in it and its tab stays open; completing it can no longer sign in the closed session. If no
  browser was running, the browser starts inside the session's process tree, which ends with the session, so it closes
  with it (read in the code of the session host, not run with a real browser).
- Timing. A key is written only after Claude Code has answered the previous one, but the answer is judged by what
  Relay Desk sees and when:
  - If Claude Code takes longer than about one second to start drawing its answer to a startup key, stops for more
    than 150 ms in the middle of drawing it, or keeps changing the screen for more than three seconds, a key pressed
    after that goes to whatever Claude Code shows by then, which can be a sign-in it has not finished drawing.
  - The first rows of a screen that arrives in pieces can be shown before the rest. For the first-run login step these
    are its introduction ("Claude Code can be used with your Claude subscription or billed based on API usage..."),
    which the guard does not match on its own; the keys stay disabled while the pieces keep coming less than 150 ms
    apart, and the method list that follows closes the session.
  - A screen that changes by itself holds a key until it stops changing for 150 ms, or for at most three seconds. Both
    builds can show one among the first-run steps, before the text style: "Checking connectivity..." with a spinner
    that changes about eight times a second. It appears when that check takes longer than a second, and Claude Code
    moves on to the text style by itself when the check succeeds. Where its spinner turns back it keeps the same symbol
    for two steps, a pause of about a quarter of a second, so a key pressed on it usually comes back within a second.
    The text style and the API key approval do not animate.
  - Claude Code draws a frame 16 ms after the last one (4 ms right after input). While its optional stdout queue holds
    more than 16 KiB (only with CLAUDE_CODE_NONBLOCKING_STDOUT, a write hook or a server flag) it holds a frame in
    250 ms steps, so a screen can pause longer than 150 ms in the middle of drawing; the three-second cap still applies.
  - These timings were read in the code of 2.1.311 and 2.1.322 and tested with synthetic screens; they were not
    measured with a real Claude Code.
  - Mirrored dialogs: keys go to Claude Code in order, and the screen Relay Desk has is checked before each one, but a
    key does not wait for Claude Code's answer to the previous one. In the two admitted builds no dialog that Relay
    Desk mirrors leads to Claude Code's sign-in; only the commands Relay Desk refuses do (read in the code of both
    builds, not run).
- A sign-in drawn anywhere other than the startup screen or a mirrored dialog.
- It can also be wrong the other way: a resumed conversation whose startup screen shows an assistant line that is
  exactly one of those rows (or the whole settings-file caption), or Claude's authorization address, closes the
  session at startup.

If the dialog about a custom API key ("Detected a custom API key in your environment") is not answered before the
startup timeout, the error says that native startup is waiting for an answer to that dialog. The key fragment Claude
Code shows there is masked in the startup screen Relay Desk shows and in its error texts. Mirrored dialogs are not
redacted.

## The login and the browser

When a login ends (it succeeds or fails, **Cancel pending login** is used, its console window is closed, or Relay Desk
quits normally), the login host (`RelayAuthHost`) ends Claude Code and the login's console processes: those on the
login console, or on a hidden console of its own, which is how Claude Code starts most helpers. That includes helpers
whose parent has already exited. Processes without a console keep running. That includes the browser Claude Code
opens for the sign-in page (on Windows it runs `rundll32 url,OpenURL` with the address). Relay Desk never sees that
address and never closes the tab. The host also spares any console program that such a process started, directly or
through other console programs: for example, a password manager's native messaging host that the browser starts
through `cmd.exe` keeps running.

How the host decides: on each pass it holds every process of its tracking job by a handle, so none of their process
ids can name another process meanwhile, and reads the parent links from a process snapshot taken while those handles
are open. It follows a parent link only while that parent is a running tracked process that started no later than its
child, so a parent id that a newer process took over after the real parent exited is not followed. That comparison
accepts equal creation times and rests on the system clock, so a clock change could in principle defeat it.

Limits:

- If a console process between the browser and such a helper exits first, the helper loses its link to the browser and
  is ended.
- A helper that Claude Code started without any console was never ended, and the console programs it starts are now
  spared too.
- If Relay Desk or the login host is killed abruptly (a crash, Task Manager), Windows still ends Claude Code itself, but
  helpers it had already started are no longer owned and are not ended. The browser is never ended either way. An
  Electron crash counts as this abrupt case.
- Ctrl+C and Ctrl+Break in the login console never end the login host. Windows delivers them to every process attached
  to that console: Claude Code and any helper that shares the login console. Helpers with a hidden console of their
  own, and the browser, do not receive them. Closing the console window ends the login like **Cancel pending login**.
- All of this was verified with synthetic programs, not with a real browser or password manager.

## Launch-environment values

At startup Relay Desk removes from its own environment, and from every process it starts, the `ANTHROPIC_*` variables of
the list `AUTHENTICATION_VARIABLES` and every `CLAUDE_CODE_*` variable except seven network settings
(`CLAUDE_CODE_PROXY_RESOLVES_HOSTS`, `CLAUDE_CODE_CERT_STORE`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`,
`CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`, `CLAUDE_CODE_GZIP_REQUEST_BODIES` and
`CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION`). (Rule R3 in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the
full list.)

For an account set to the launch environment, Relay Desk passes the values it removed in the environment of the Claude
Code processes it starts for that account: sessions, sign-in status and sign-out, the login, usage checks, the
background-agents list and terminal handoffs. The values pass through Relay Desk's own helper processes: the session
host (`RelayNativeHost`, over its private pipe), the login host (`RelayAuthHost`: its own environment and its start
request) and the terminal launchers (a `cmd.exe` or Windows Terminal console). The process that lists saved sessions
never gets them.

The cloud provider variables of the same list are not removed, so none of the above applies to them. They are
`AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`,
`AWS_DEFAULT_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`,
`AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, the `AWS_CONTAINER_*` variables,
`CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`,
`GOOGLE_CLOUD_QUOTA_PROJECT`, `CLOUDSDK_CONFIG` and the `AZURE_*` variables. Every process Relay Desk starts inherits
them, the process that lists saved sessions included, whatever the account's source. So "only that account's Claude
Code processes" and "the process that lists saved sessions does not get them" are true for the Anthropic and Claude
Code variables only.

Claude Code passes its environment on to everything it starts: tools such as Bash, hooks and MCP servers. A command such
as `printenv` or `set` run as a tool shows the values in the transcript, and Relay Desk does not redact tool output. Do
not use a token for this source that you would not want a tool or an MCP server of that account to see.
