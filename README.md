# Relay Desk

> **Unofficial; not affiliated with or endorsed by Anthropic.**

Relay Desk is a Windows desktop shell that runs Claude Code, Anthropic's official CLI, in a native console session. It
adds a desktop interface around that session:

- **Accounts**: several Claude Code accounts side by side, each with its own configuration folder; sign-in and sign-out
  use the CLI's own commands.
- **History**: the Claude Code sessions of an account, grouped by project folder, with paged transcripts, images and
  background tasks.
- **MCP**: Relay Desk's own list of MCP servers, with live status and per-session switches, and an optional import of
  the server list from the Claude desktop app.
- **Handoff**: continue a session in the Claude desktop app, a terminal, the cloud or Remote Control, using the CLI's
  documented commands; the optional [desktop mod](mod/README.md) adds a button in the desktop app that hands a session
  to Relay Desk.

Relay Desk does not modify Claude Code. It starts the official executable, loads a small plugin into it with the CLI's
documented `--plugin-dir` option, and mirrors the CLI's own dialogs.

This repository is source only. It contains no Claude Code binaries and no prebuilt Relay Desk builds.

## Requirements

- Windows 10 version 1809 or later, or Windows 11, x64.
- Node.js 24 or later, and npm.
- The C# compiler of the .NET Framework that ships with Windows (`csc.exe` under `%SystemRoot%\Microsoft.NET`); the
  helper programs are built from source with it.
- Internet access for `npm ci` and for downloading Claude Code from the npm registry.
- Your own Claude account: a Claude subscription or a Claude Console API key.

## Quick start

```powershell
npm ci
npm run cli:stable
npm run build
npm start
```

`npm run cli:stable` downloads the official Claude Code build of the stable track from the npm registry, checks it
against the build this source admits and installs it into the project. [BUILD.md](BUILD.md) describes every command.

## Signing in

Relay Desk does not offer a Claude.ai login of its own. **Log in** runs Claude Code's own `claude auth login` in a
separate console window, and sign-in completes there, through Anthropic's own flow. Relay Desk does not read that
window: it never sees the sign-in URL, code or credentials of the sign-in flow. When the window closes, Relay Desk
checks the account again with `claude auth status`. **Log out** runs `claude auth logout`.

The login ends when it succeeds or fails, when you use **Cancel pending login**, when you close its console window, or
when Relay Desk quits normally. Relay Desk then ends Claude Code and the login's console programs: those on the login
console or on a hidden console of their own, which is how Claude Code starts most helpers. It does not end programs
without a console, and that includes the browser Claude Code opens for the sign-in page: Relay Desk never sees that
address and does not close the tab. Console programs that such a program started keep running too (for example a
password manager's native messaging host that the browser starts). After **Cancel pending login** the account is
checked again, so a sign-in that finished just as you pressed it shows as signed in. See [SECURITY.md](SECURITY.md) for
the limits.

### Sessions do not show Claude Code's sign-in

Relay Desk does not offer Claude Code's own sign-in inside a session, and it does not show it. Before a session is
ready and in every Claude Code dialog Relay Desk mirrors, each screen update is checked. When it shows Claude Code's
sign-in, Relay Desk publishes none of it, writes no key or text to it, closes the session at once and says: "This
account is not signed in to Claude Code. Use Log in under Accounts, then open the session again."

- Relay Desk does not check an account's status before it opens a session. A session of a signed-out account starts;
  its earlier first-run questions (such as the text style or an API key approval) are shown and answered as usual, and
  the session closes as soon as the CLI shows its sign-in. The sign-in can be the first-run login step, the Cloud
  gateway address, a login method forced by settings, or a start that failed. A project that signs in through its own
  settings (`env` in `.claude/settings.json`, an `apiKeyHelper`) opens normally, because only the CLI's own screen
  decides.
- Startup keys are sent one at a time. After a key, the keys of the startup screen stay disabled, and further presses
  are ignored, until Claude Code has answered: once its screen has changed and then stayed still for 150 ms (so a
  screen that arrives in pieces is checked whole), after about one second if the key changed nothing, or after at most
  three seconds if the screen keeps changing by itself, as the spinner of Claude Code's connectivity check does. So a
  second key pressed for an earlier question is not written once Claude Code has moved on to its sign-in. For a
  signed-out account, the key that answers the last first-run question is written, and the sign-in that follows closes
  the session.
- Claude Code can open a browser at Claude's sign-in page by itself, for example when settings force a login method,
  before it draws anything the guard recognizes. Relay Desk closes the session as soon as it sees the sign-in, but it
  cannot stop that browser from opening. If a browser was already running, the tab stays open; completing it can no
  longer sign in the closed session. If no browser was running, the browser that starts closes with the session
  (read in the code, not tried with a real browser).
- These commands are not sent to a session, with or without arguments and in any letter case, whether typed as a
  command or submitted as a prompt. `/login`, `/logout` and `/design-login` open Accounts instead. `/upgrade`,
  `/remote-control` (`/rc`), `/teleport` (`/tp`), `/usage-credits`, `/extra-usage`, `/rate-limit-options`,
  `/pro-trial-expired`, `/install-github-app` and `/setup-bedrock` can start Claude Code's own sign-in or ask for keys,
  so Relay Desk refuses them with a note that it does not run Claude Code's own sign-in inside a session and that the
  command has to be run in a terminal. A command of your own named exactly `rc` or `tp` still runs; Claude Code looks
  commands up letter for letter, so `/TP` is refused even if you have a command `tp`. A message that only mentions a
  command (such as "why does /login fail?") is sent.
- **Log in** does not grant the design-system access that `/design-sync` needs; that still needs `/design-login` in a
  terminal.
- The guard recognizes the sign-in screens of the two admitted Claude Code builds only, and it cannot catch every way
  a sign-in could start. For example, the model's Bash tool may run `claude auth login`, and so may a prompt that
  starts with `!` (read in the CLI's code, not run). The authorization address that command prints would appear in the
  transcript, where Relay Desk does not redact it. A key can also reach Claude Code before its sign-in is drawn if
  Claude Code is slower than these waits: more than about a second before it starts to answer a startup key, or a
  stop of more than 150 ms while it draws the answer (read in Claude Code's code and tested with synthetic screens, not
  measured with a real Claude Code). [SECURITY.md](SECURITY.md) lists what the guard does not catch.

### Launch-environment authentication

An account can instead use the launch environment as its authentication source. At startup Relay Desk copies the
supported authentication variables of its own environment into memory. They include API keys (`ANTHROPIC_API_KEY`),
bearer tokens (`ANTHROPIC_AUTH_TOKEN`), Claude subscription tokens such as `CLAUDE_CODE_OAUTH_TOKEN`, and the Amazon
Bedrock, Google Vertex AI and Microsoft Foundry settings; the full list is `AUTHENTICATION_VARIABLES` in
`src/main/system/authenticationEnvironment.ts`. It then removes the `ANTHROPIC_` and `CLAUDE_CODE_` ones from its own
environment.

Relay Desk does not store or log the values, never sends them to its window (the authentication settings show only the
names of the variables it found) and never puts them on a command line. For an account set to this source it passes
the values it removed (the Anthropic and Claude Code ones) in the environment of the Claude Code processes it starts
for that account: sessions, sign-in status and sign-out checks, the login, usage checks, the background-agents list and
terminal handoffs. The process that lists saved sessions never gets them. On the way they pass through
Relay Desk's own helper processes: the session host (over its private pipe), the login host (its environment and its
start request) and the terminal launchers that handoff uses (a `cmd.exe` or Windows Terminal console).

Two limits follow:

- Claude Code passes its environment on to everything it starts: tools such as Bash, hooks and MCP servers. A command
  such as `printenv` or `set` run as a tool therefore shows the values in the transcript, and Relay Desk does not redact
  tool output.
- Cloud provider variables (`AWS_*`, `GOOGLE_*`, `GCLOUD_PROJECT`, `CLOUDSDK_CONFIG`, `CLOUD_ML_REGION`, `AZURE_*`) are
  never removed from Relay Desk's own environment, so every process Relay Desk starts inherits them (the process that
  lists saved sessions too), whatever the account's source. They stay so that tools and providers configured in Claude
  Code's settings keep working.

Accounts that keep the default source (Claude Code's saved sign-in) do not get the Anthropic and Claude Code variables
of that list: Relay Desk removes them from its own environment at startup and from every process it starts. See rule
R3 in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Claude Code tracks

Relay Desk is verified against specific Claude Code builds, one per track:

- **stable**: `npm run cli:stable`, verified with real accounts and with isolated tests;
- **latest**: `npm run cli:latest`, a newer build verified with isolated tests only.

`npm run cli:status` shows which track is installed. Details, versions and hashes are in
[docs/CLI-TRACKS.md](docs/CLI-TRACKS.md).

## Architecture in short

- The Electron main process starts Claude Code in a Windows pseudo console (ConPTY) through a small helper,
  `RelayNativeHost`. A plugin loaded into the CLI (`native-mod/`) reports the session's events and answers Relay
  Desk's requests over a named pipe that only the current Windows user can open.
- The React renderer shows the transcript, the prompt box, the right-hand panel and the mirrored CLI dialogs.
- Shared types and the IPC contract live in `src/shared/`; the preload script exposes them as `window.relay`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

## Known limits

- Windows only.
- Each track admits one pinned Claude Code build. Any other build still runs, but with Relay Desk's automation off:
  the CLI's own dialogs are shown instead of Relay Desk's controls.
- PDF attachments are optional and off by default; they need Poppler tools that you supply (see BUILD.md). Images
  and text files work without them.
- The helper programs are built locally from source and are not code-signed.
- Attachments and each session's private launch files (such as its MCP configuration) are kept in
  `C:\RelayDeskNativePrototype`, in folders that only your Windows account can open. This needs a local NTFS drive `C:`.
- Settings, accounts and that folder are shared with any other Relay Desk build run by the same Windows user, and only
  one Relay Desk runs at a time. The last Relay Desk started owns the `relaydesk://` link.
- The interface is in English, with Traditional Chinese available under Settings, Language. The desktop mod is in
  English only.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; report security problems as
described in [SECURITY.md](SECURITY.md).

## License

Relay Desk's own code is under the [MIT License](LICENSE). Claude Code and the other Anthropic packages it downloads
are not; see [NOTICE.md](NOTICE.md) and THIRD_PARTY_NOTICES.md.
