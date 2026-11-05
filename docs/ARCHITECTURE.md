# Architecture

Relay Desk is an Electron app for Windows x64. Its main process runs the official Claude Code executable, unmodified,
in a Windows pseudo console (ConPTY); a plugin loaded into Claude Code connects the session back to Relay Desk; a React
renderer shows it.

```text
 renderer (React)  <-- IPC (window.relay) -->  main process (Node)
                                                 |  starts, owns and stops
                                                 v
                                     RelayNativeHost.exe (ConPTY host, job object, named pipe)
                                                 |  console input/output
                                                 v
                                     claude.exe (official, unmodified)
                                       --plugin-dir native-mod  -> plugin  <-- named pipe -->  RelayNativeHost
```

## Entry points

- `out/main/nativeProduction.js` is the app's `main`. `npm run build` copies it from `tools/release/bootstrap.mjs`. It
  refuses the fixture environment variables, sets `DISABLE_AUTOUPDATER` so that a pinned Claude Code build never
  updates itself, and loads `src/main/index.ts`.
- `src/main/nativePrototype.ts` is an isolated test entry for local acceptance runs: every storage location, the home
  folder and the profiles live under a sandbox root, and sessions may only talk to a loopback test provider with a fake
  key. electron-vite builds it into `out/main/nativePrototype.js` next to the app, so it is also packaged, but the
  app's `main` never loads it; it runs only when Electron is started with it explicitly.

## Main process (`src/main`)

### Application shell

`index.ts` takes the single-instance lock, registers the `relaydesk://` protocol, creates the frameless window
(context isolation, sandbox, no Node integration, content security policy, navigation and new windows denied) and
wires the IPC handlers. `tray.ts` keeps the app running in the notification area when the window closes;
`contextMenu.ts` builds the right-click menu. Both follow the UI language.

### System services (`src/main/system`)

| Module | Role |
| --- | --- |
| `env.ts`, `scrubOnLoad.ts` | Remove inherited Claude and Anthropic variables at startup and from every child process (rule R3); set `CLAUDE_CONFIG_DIR` for independent accounts |
| `profiles.ts`, `stores.ts`, `jsonFile.ts` | Accounts, settings and shortcuts as JSON files in the app's data folder, written atomically and validated |
| `auth.ts`, `ownedAuthTerminal.ts`, `cliProfile.ts` | `claude auth status`, `login` and `logout`. Login runs in its own visible console owned by `RelayAuthHost`; Relay Desk does not read that console |
| `authenticationEnvironment.ts` | The optional launch-environment source: the authentication variables of Relay Desk's own environment (API keys, cloud provider settings and subscription tokens such as `CLAUDE_CODE_OAUTH_TOKEN`), captured at startup and passed in memory to the Claude Code processes of the accounts that use this source (the cloud provider ones are never removed from the environment, so all processes inherit them; rule R3); the renderer sees only their names |
| `claudeBinary.ts` | Finds the project's `claude.exe` (`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/`, or its unpacked copy in a packaged build); never the `PATH` |
| `handoff.ts`, `terminal.ts`, `launchArgs.ts` | Handoff commands (`claude --desktop --resume`, `--resume` in a terminal, `--cloud`, `--teleport`, `--remote-control`, background agents) and parsing of `relaydesk://` links and command-line launches |
| `mcp.ts` | Relay Desk's own MCP server list and the import from the Claude desktop app's configuration |
| `sharedCodeContext.ts` | Optional sharing of the default account's instructions, rules, skills and memory with independent accounts, without copying credentials or settings secrets |
| `ipc.ts`, `messages.ts` | The `app`, `accounts`, `handoff`, `shortcuts`, `usage` and `mcp` IPC namespaces |

### Engine services (`src/main/engine`)

`ipc.ts` serves the `engine` and `sessions` namespaces and enforces a single writer per session (rule R4). The
session list, transcript pages, renames and subagent transcripts are read in a utility process (`listingWorker.ts`,
`transcriptReader.ts`) with the Agent SDK's read-only transcript functions. `mapTranscript.ts` maps saved messages to
transcript items; `tasks.ts` and `historyTasks.ts` derive background tasks; `images.ts` keeps image bytes in the main
process until the renderer asks for one; `autoContinue.ts` continues a turn after a usage-limit reset when the user
enabled it; `usageMemory.ts` remembers the last plan usage per account.

`session.ts` and `usage.ts` hold an earlier engine built on the Agent SDK's `query()`. The source still contains it,
but the app's wiring replaces both with the native engine below.

### Native engine (`src/main/native`)

- **Launch and transport.** `launch.ts` turns a session request into documented CLI options (`--plugin-dir`,
  `--setting-sources`, `--settings`, `--mcp-config`, `--resume`, the model and effort). `transport.ts` starts
  `RelayNativeHost`, which creates the console, puts Claude Code in a job object so its process tree ends with the
  session, and carries the plugin's pipe; the transport frames, bounds and orders the messages.
- **Session.** `session.ts` (`NativeInteractiveSession`) is the per-view engine: prompts, interrupts, permission and
  question requests, model, effort, permission mode, fast mode, workflows, MCP switches, context and usage, background
  tasks and attachments. `mapping.ts` and `commandResults.ts` turn the plugin's events and the session transcript into
  the shared `EngineEvent`s.
- **Admitted builds and controls.** `cliBuilds.ts` lists the Claude Code builds this source admits, by SHA-256, one per
  track. `controlsState.ts` hashes the executable that actually runs. Only for an admitted build do `controls.ts`,
  `nativeSettings.ts`, `nativeQuotaControls.ts`, `persistentMcp.ts` and their helpers drive the CLI's own dialogs on the
  user's behalf; for any other build those drivers stay off.
- **Dialog mirroring.** `terminalScreen.ts` keeps a model of the console screen; `panel.ts` and `panelHost.ts` detect
  a dialog the CLI draws and mirror it into the renderer, and send the user's keys and clicks back. Claude Code's own
  sign-in screen is never mirrored. Relay Desk does not check an account's status before a session; when a session shows
  that screen, Relay Desk sends neither the screen nor input, closes the session and asks the user to use Log in.
- **Sign-in guard.** `src/shared/signIn.ts` holds the guard. Each screen update of the startup screen and of every
  mirrored dialog is checked against the rows of the sign-in screens of CLI 2.1.311 and 2.1.318 (matched whole, after
  the spinner or bullet the CLI draws in front is dropped) and against Claude's own authorization page address, per row
  and across rows that run to the last column of the terminal. An MCP server's own authorization address is not matched,
  so MCP authentication keeps working in the mirrored `/mcp` dialog. One list, `SIGN_IN_COMMANDS`, names the slash
  commands that can start the CLI's own sign-in or take keys (`/login`, `/logout`, `/design-login`, `/upgrade`,
  `/remote-control`, `/teleport`, `/usage-credits`, `/extra-usage`, `/rate-limit-options`, `/pro-trial-expired`,
  `/install-github-app`, `/setup-bedrock`); the renderer, the main process and the plugin (which keeps a copy, checked
  by a test for drift) refuse them before they reach the CLI, as a command and as a prompt, matching a user's own
  command letter for letter as the CLI does. The screen is the only judge: a signed-out account's session starts, the
  CLI draws its sign-in, and the guard closes the session; no key or text is written to a screen it has recognized as
  the sign-in (no `claude auth status` runs in a session's folder). Startup keys go one at a time: `session.ts` writes
  the next one only after the CLI has answered the previous one. The answer is a screen that differs from the one shown
  when the write was confirmed and then gets no terminal data for 150 ms (the guard checks every piece as it arrives),
  a second with no change, or three seconds of a screen that keeps changing. `session.ts` refuses a second key
  meanwhile, and the window's own input gate ignores a press in that time. For a signed-out account the key that
  answers the last first-run step is still written, and the sign-in that follows closes the session. The Cloud gateway
  sign-in is recognized from its first screen, and its captions are matched whole. The guard recognizes only what the
  two admitted builds draw, and it watches only the startup screen and mirrored dialogs, so it does not see a sign-in
  that the model starts with its Bash tool, and it is too late for a browser the CLI opens by itself before it draws a
  matchable row (for example for a login method forced by settings); [SECURITY.md](../SECURITY.md) lists what it cannot
  catch, timing included.
- **MCP.** `mcpControls.ts` and `mcpFacade/` put a small stdio facade in front of each of Relay Desk's MCP servers,
  inside an `OwnedMcpJob` job object, so a server can be switched off for one session without touching others.
- **Private files.** `privateStorage.ts` and `durableAssets.ts` use `RelayPrivateStorage` to write attachments and each
  session's launch files (such as its MCP configuration) under `C:\RelayDeskNativePrototype`, in folders only the
  current user can open. `attachments.ts` checks every attachment; `pdfSelection.ts` and `pdfResources.ts` enable PDF
  attachments only when the optional PDF tools are present.
- **Settings and usage.** `sessionSettings.ts`, `modelCatalog.ts`, `effortGuide.ts`, `fastMode.ts` and
  `persistentPreferences.ts` read and change session settings through the CLI; `usage.ts` collects plan usage from the
  session.
- **Boundaries.** `scope.ts`, `isolation.ts` and `guardedRuntime.ts` (its local-fixture network mode) serve the
  isolated entry and its tests. `prototypeServices.ts` wires all of the above into the engine services.

## The plugin bridge (`native-mod`)

`native-mod` is a Claude Code plugin that `launch.ts` passes with `--plugin-dir`. `hooks/register.ts` starts the bridge
only for an interactive terminal session. `hooks/bridge.ts` announces its capabilities, forwards the session's events
(messages, tool use, permission and question requests, usage, tasks) and runs Relay Desk's requests through the plugin
API. `hooks/transport.ts` runs `RelayNativeHost` as a pipe client: one long-running `recv` process delivers Relay
Desk's requests, and short-lived `send` processes deliver batched events. The pipe name, a nonce and the helper path
come from the environment that Relay Desk set (`hooks/protocol.ts`). `hooks/attachmentGuard.ts` checks that a
submitted prompt carries exactly the attachments Relay Desk armed for it.

The plugin is written against the plugin API declarations that Claude Code ships for plugin authors (in the Windows
build they are stored inside `claude.exe`). `npm run types:generate` copies them out of the installed build into
`native-mod/types/` and `src/main/native/generated/` for local type checking. They are never committed, and no Claude
Code code is copied into the repository.

## Preload (`src/preload`)

`index.ts` exposes `window.relay` with `contextBridge`, built from the channel table in `src/shared/channels.ts`, and
`window.relayFiles.pathFor` for dropped files. The renderer has no other access to Node or Electron.

## Renderer (`src/renderer`)

- **State.** `state/controller.ts` (`AppController`) owns the app state and every call to `window.relay`; components
  read the store (`state/store.ts`) and call controller methods. `state/sessionReducer.ts` applies engine events to a
  session view. Per-session choices, sidebar marks and account-label checks are kept in local storage.
- **Components.** `components/shell` (window layout, title bar, sidebar, new-session page), `transcript`, `prompt`
  (prompt box, footer, slash popup, usage popover, mirrored CLI dialogs), `panel` (right-hand cards: environment,
  context, handoff, accounts, outputs, connectors, background tasks), `flows` (dialogs and cards), `tasks`, `shortcuts`
  and `ui` primitives.
- **Internationalization.** `i18n/en.ts` and `i18n/zh-TW.ts` hold every UI string; English is the default and Settings
  switches the language. `theme/` applies the light, dark or system theme from the CSS tokens in `styles/`.
- **Mock.** `mock/` is an in-memory `window.relay` with synthetic sessions. It backs `npm run dev:web` and the renderer
  tests.

## Shared contract (`src/shared`)

`types.ts` (domain types and default settings), `events.ts` (the `EngineEvent` union), `channels.ts` and `ipc.ts` (one
channel per API method, named `relay:<namespace>:<method>`, and the typed `RelayApi`), `shortcuts.ts` (shortcut schema
and seed list), `workflowMeta.ts` (reads a workflow script's `meta` without running it) and `terminalWidth.ts`. These
files use no Node or DOM APIs.

## Helpers (`tools/`)

All helpers are C# programs compiled locally with the .NET Framework compiler that ships with Windows.

| Helper | Role |
| --- | --- |
| `tools/native/RelayNativeHost.cs` | ConPTY host for Claude Code, job object, named pipe restricted to the current user, and the pipe client the plugin runs |
| `tools/private-storage/RelayPrivateStorage.cs` | One bounded request per run: creates owner-only folders under `C:\RelayDeskNativePrototype` and writes or verifies files there |
| `tools/auth/RelayAuthHost.cs` | Starts `claude auth login` in a visible console; when the login ends, ends Claude Code and the login's console processes (see below) |
| `tools/native-mcp-facade/OwnedMcpJob.cs` | Starts an MCP server suspended inside a job object owned by its facade |
| `tools/native/NativeConsoleFixture.cs`, `tools/auth-host-tests/FakeAuthProcess.cs` | Synthetic programs for the tests |

**The login host and the browser.** `RelayAuthHost` puts the CLI alone in a Windows job object with kill-on-close and
`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`. Everything the CLI starts goes to a second, "tracking" job without limits (the
first job is nested in it). When the login ends (success, failure, **Cancel pending login**, closing the console
window, or a normal quit of Relay Desk), the host ends the CLI and terminates the tracked processes that have a console,
waiting about 3 s at most. Claude Code starts most helpers with a hidden console of their own, so they are ended too,
including helpers whose parent has already exited. Tracked processes without a console keep running; this includes the
browser the CLI opens for the sign-in page (on Windows the CLI runs `rundll32 url,OpenURL <url>`), whose address Relay
Desk never sees. So does every console program that such a process started, directly or through other console
programs (a password manager's native messaging host that the browser starts through `cmd.exe`, for example). On each
pass the host holds every tracked process by a handle and reads parent links from a process snapshot taken while those
handles are open; it follows a parent only while that parent is a running tracked process that started no later than
its child, so a parent id that a newer process took over is not followed (the comparison accepts equal creation times
and rests on the system clock). If a console process between the browser and such a helper exits
first, the helper loses its link and is ended; a helper that the CLI started without any console was never ended.
Ctrl+C and Ctrl+Break in the visible login console never end the host; Windows delivers them to every process attached
to that console (the CLI and any helper that shares it), but not to helpers with a hidden console of their own or to
the browser. Closing the console ends the login like a cancel. If Relay Desk or the host is killed abruptly, Windows
still ends the CLI through kill-on-close, but helpers it had already started are no longer owned and are not ended;
Node puts the host in its own kill-on-close job, so an Electron crash is such a case. This was verified with synthetic
programs, not with a real browser or password manager. The session host's job object
(`RelayNativeHost`) is different: it ends the whole process tree of a session when the session ends, which can include a
browser the CLI started during the session, for example for an MCP server's authorization, or for a login method
forced by settings when no browser was already running. A browser that was already running keeps its tab.

`tools/native-cli-maintenance/` stages official Claude Code builds and copies out their plugin API declarations;
`tools/cli/` (the `cli:*`, `types:generate` and `typecheck:tracks` scripts), `tools/release/` (`build`) and `tools/pdf/`
(the optional PDF receipt) are the build tooling.

## Desktop handoff mod (`mod/`)

A separate Claude Code plugin for the Claude desktop app's Code tab. It adds a button and a `/relay` command that open
the current session in Relay Desk through a `relaydesk://resume` link. Its button and messages are in English. See
[mod/README.md](../mod/README.md).

## Data locations

| Location | Contents |
| --- | --- |
| `%APPDATA%\Relay Desk` | Settings, accounts, shortcuts, the MCP list, the usage cache; independent accounts' configuration folders default to `profiles\<id>` here |
| `~/.claude` | The default account's Claude Code data, shared with Claude Code and the Claude desktop app |
| `C:\RelayDeskNativePrototype\app-assets\<hash>` | Owner-only attachments and launch files; the hash is derived from the data folder |
| `HKCU\Software\Classes\relaydesk` | The `relaydesk://` link, registered at startup by the last Relay Desk started |

## Design rules

Source comments cite these rules by number.

- **R1 Official interfaces only.** Relay Desk uses the official Claude Code executable unmodified, through its
  documented options, commands and plugin API, and separates accounts with the documented `CLAUDE_CONFIG_DIR`. It never
  reads or changes the Claude desktop app's own files, with one exception: "Import from desktop" reads only the
  `mcpServers` object of `%APPDATA%\Claude\claude_desktop_config.json`, and only when the user asks for it.
- **R2 No sign-in of its own.** Relay Desk does not offer a Claude.ai login of its own. Apart from the
  launch-environment source below, it never reads, copies, stores, logs or displays credential files, OAuth tokens,
  authorization URLs or codes, or API keys. Sign-in runs `claude auth login` in its own console window, which Relay Desk
  does not read, so it never sees the sign-in URL, code or credentials of the sign-in flow; sign-out runs
  `claude auth logout`. A session does not show Claude Code's own sign-in screen: the guard described under "Dialog
  mirroring" closes a session that does, and the commands that can start that sign-in (`/login`, `/logout` and the
  others in `SIGN_IN_COMMANDS`) are not sent to a session. Relay Desk's own code never displays Claude's own sign-in
  address; an MCP server's authorization address is a different thing and can appear in the mirrored `/mcp` dialog. The
  guard cannot see a sign-in that the model starts with its Bash tool, or a prompt that starts with `!`: the address
  `claude auth login` prints then appears in the tool output, which Relay Desk does not redact. Claude Code's global
  configuration is read only while a status checked within the last minute says claude.ai sign-in, because a Console
  sign-in keeps the API key there. The launch-environment source is the one place where credentials pass
  through Relay Desk: for an account that uses it, Relay Desk passes the authentication variables of its own
  environment, including subscription tokens such as `CLAUDE_CODE_OAUTH_TOKEN`, in the environment of the Claude Code
  processes it starts. It keeps them in memory, never stores, logs or sends them to the window, and never puts them on a
  command line. They go through Relay Desk's own helper processes (the session host over its private pipe, the login
  host, and the terminal launchers of a handoff), and Claude Code hands them on to the tools, hooks and MCP servers it
  starts; a tool that prints its environment shows them in the transcript, which Relay Desk does not redact.
- **R3 Environment scrub.** At startup, right after the launch-environment source has captured its variables, and for
  every child process, inherited host variables are removed (names compared case-insensitively):
  - every `ANTHROPIC_*` variable of the authentication list in `authenticationEnvironment.ts`: the API key, auth token,
    base URL and custom headers, the profile, configuration folder and workload-identity variables, and the Bedrock,
    Vertex and Foundry endpoints and keys;
  - `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`;
  - every `CLAUDE_CODE_*` and `CLAUDE_AGENT_SDK_*` variable (including `CLAUDE_CODE_OAUTH_TOKEN` and the
    `CLAUDE_CODE_USE_*` provider switches), except seven network settings: `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`,
    `CLAUDE_CODE_CERT_STORE`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`,
    `CLAUDE_CODE_GZIP_REQUEST_BODIES` and `CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION`.

  Proxy and certificate variables, and cloud provider variables such as `AWS_*`, `GOOGLE_*`, `GCLOUD_PROJECT`,
  `CLOUDSDK_CONFIG`, `CLOUD_ML_REGION` and `AZURE_*`, are never removed from Relay Desk's own environment, so every
  process Relay Desk starts inherits them, whatever the account's source; tools and providers configured in Claude
  Code's settings need them. Only an account set to the launch-environment source gets the captured `ANTHROPIC_*` and
  `CLAUDE_CODE_*` authentication variables back. When the desktop app starts Relay Desk, this stops Relay Desk
  from riding on the desktop's sign-in or switching billing to an inherited API key. The lists are `SCRUB_EXACT`,
  `SCRUB_PREFIXES` and `PRESERVED_TRANSPORT` in `src/main/system/env.ts`.
- **R4 Single writer.** A session is open in at most one Relay Desk engine. Taking over a session asks the user not to
  type in it elsewhere; handing it back first ends Relay Desk's process for it.
- **R5 No automatic account switching.** Nothing switches accounts on usage limits or errors.
- **R6 No unrequested sends.** Shortcuts send only when clicked, and a `relaydesk://` link never starts a turn by
  itself.
- **R7 Tests never touch real data.** Tests use synthetic sessions and temporary folders, never the real `~/.claude`,
  and never sign in.

Other tags in comments (`EC-n`, `AS-n`, `Un`, section marks such as `§4.11`, and screenshot names such as
`desktop-light-07`) refer to the maintainers' internal design notes and reference screenshots, which are not
published. The code and its tests are the authoritative description.

## Tests

| Folder | Runner | Contents |
| --- | --- | --- |
| `tests/engine` | Vitest, Node | The native engine, the plugin bridge (it imports `native-mod/hooks`), transcripts, usage, MCP and attachments, with synthetic fixtures and short terminal captures of Claude Code's own screens (see NOTICE.md) |
| `tests/system` | Vitest, Node | Main-process services: environment, accounts, sign-in hosting, handoff, stores, protocol, tray, private storage |
| `tests/renderer` | Vitest, jsdom | Components and the controller against the mock API |
| `mod/tests` | Vitest, Node | The desktop mod's link and path checks |
| `native-mod/tests` | Claude Code's plugin test runner | Bridge behaviour inside the CLI (`claude plugin test`) |
| `tests/source`, `tools/native-cli-maintenance/*.test.mjs` | `node --test` | Build tooling: CLI staging, declarations, public package contract |

Windows-only tests that need a helper skip themselves when it has not been built; `npm test` builds the helpers first.
