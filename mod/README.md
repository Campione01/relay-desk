# Relay Desk handoff mod (relay-desk-handoff)

This mod hands the current conversation in the Claude desktop app's Code tab over to Relay Desk.

A mod is a Claude Code plugin: Claude Code runs its JavaScript or TypeScript code in its own process, and the code can
draw buttons in the interface and register commands. This one lives in `mod/relay-desk-handoff/` and is listed by the
local marketplace `mod/.claude-plugin/marketplace.json` (named `relay-desk-local`).

## What it does

- **Button**: shows **Continue in Relay Desk** in the row above the prompt box (AbovePrompt). The button is hidden
  while Claude is responding, so that two programs never write to the same conversation at once.
- **`/relay` command**: does the same as the button and does not start a Claude turn.
- When pressed, the mod:
  1. reads the conversation id with `$.session.id()`. The official declarations describe it as the transcript's file
     name, which is the UUID that `claude --resume` accepts;
  2. reads the conversation's project folder with `$.session.root()`: the folder the conversation started in, where
     its transcript is stored. A `cd` in the shell does not change it (it changes `$.session.cwd()`);
  3. checks that the id is a UUID and that the folder is an absolute path on a local drive (for example `C:\...`).
     Network (UNC) paths, paths containing `..` and paths with invalid characters are refused;
  4. builds `relaydesk://resume?session=<uuid>&cwd=<encoded folder>`; the link contains only letters, digits, `-_.~`
     and `%` escapes;
  5. runs `%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler <link>` with an argument array
     (`$.process.run`, no command interpreter), so Windows opens Relay Desk through its registered `relaydesk://`
     handler.
- The result appears as a notification (button) or as command output (`/relay`).

The mod does not use the network, reads no files, and does not read or forward any credentials. The only environment
variable it reads is `SystemRoot`.

The button label and the mod's messages are in English. After a handoff, the message reminds you not to type in the
conversation here while Relay Desk has it, and to press **Hand back to desktop** in Relay Desk before you continue here.

## Before you install

- Windows x64, and Relay Desk started at least once: Relay Desk registers the `relaydesk://` link each time it starts.
  When several Relay Desk builds exist, the one started last owns the link. A development run (`npm start`) registers
  Electron together with this repository's folder, so start Relay Desk again after moving the repository.
- The Code tab must use a local session, and the desktop app's built-in Claude Code must be version 2.1.286 or later
  to support mods (type `/status` in the Code tab and look at the **Claude Code** row). WSL and cloud sessions do not
  support plugins.

## Install

In the Code tab of the Claude desktop app, open a local session and enter, with the path of your copy of this
repository:

```text
/plugin marketplace add C:\Users\me\relay-desk\mod
/plugin install relay-desk-handoff@relay-desk-local
```

The second command opens the plugin details; choose the user scope so that every project can use it.

If the desktop app says these commands are not available there, use one of these instead:

- **Desktop interface**: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, and enter the
  `mod` folder; then **+**, **Plugins**, **Add plugin** and install `relay-desk-handoff`.
- **PowerShell**, with the Claude Code executable that `npm run cli:stable` installed into this repository:

  ```powershell
  $claude = 'C:\Users\me\relay-desk\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
  & $claude plugin marketplace add 'C:\Users\me\relay-desk\mod'
  & $claude plugin install relay-desk-handoff@relay-desk-local
  ```

  The terminal, the desktop app's local sessions and VS Code read the same user settings, so a plugin installed here is
  also loaded by the desktop app.

After installing, open a new session, or enter `/reload-plugins` in an existing one; the button appears above the
prompt box.

The marketplace points at the `mod` folder itself. After changing the mod, `/reload-plugins` picks up the change without
reinstalling; after moving or deleting the folder, the mod no longer loads.

## Remove

In the Code tab:

```text
/plugin uninstall relay-desk-handoff@relay-desk-local
/plugin marketplace remove relay-desk-local
```

Removing the marketplace also uninstalls the plugins installed from it. In the desktop interface the same actions are
under **+**, **Plugins**, **Manage plugins**, where you can also just disable the mod. In PowerShell use
`claude.exe plugin uninstall relay-desk-handoff@relay-desk-local` and
`claude.exe plugin marketplace remove relay-desk-local`.

## Using it

- After the handoff, only one side may write to the conversation: **do not type in that conversation in the desktop
  app while Relay Desk has it.** Relay Desk asks you to confirm when it takes a conversation over.
- To give it back, use **Hand back to desktop** in Relay Desk. Relay Desk first ends its own process for the
  conversation, then runs the official `claude --desktop --resume <id>`.
- If nothing happens after pressing the button, Windows found no handler for `relaydesk://`: start Relay Desk once.
  The mod cannot detect this case, because Windows always reports success. The registry key
  `HKCU\Software\Classes\relaydesk` stays behind when Relay Desk is removed.

## Security

**A mod runs with your user rights and is not sandboxed.** According to the official documentation, any mod can read
and write the files your account can reach, start programs, use the network, read environment variables and settings
files, and see and change your prompts and tool calls. Install mods only from sources you trust.

Before installing, you can list the events and calls the mod uses, without running it:

```powershell
$claude = 'C:\Users\me\relay-desk\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
& $claude plugin validate 'C:\Users\me\relay-desk\mod\relay-desk-handoff'
```

For this mod the result must contain only the following; any other call means its code was changed:

- hooks: `session.start`, `command.run{command=relay}`, `ui.render{component=AbovePrompt}`
- calls: `$.command.register`, `$.env.get`, `$.process.run`, `$.session.id`, `$.session.root`, `$.ui.log`,
  `$.ui.resolve`, `$.ui.toast`
- environment reads: `SystemRoot`; environment writes: none

`$.process.run` only runs `%SystemRoot%\System32\rundll32.exe` with fixed arguments and a link that contains only
escaped characters. Relay Desk checks the UUID and the path again when it receives the link.

## Checks for developers

Run these in the repository folder. To keep your own sign-in out of the checks, remove the `ANTHROPIC_*` and
`CLAUDE_CODE_*` variables from the environment first, and point `CLAUDE_CONFIG_DIR` at a temporary folder so that the
real `~/.claude` is not touched.

| Check | Command |
| --- | --- |
| Plugin manifest and code | `claude.exe plugin validate mod/relay-desk-handoff` |
| Marketplace manifest | `claude.exe plugin validate mod` |
| Mod behaviour (the engine's built-in test runner) | `claude.exe plugin test mod/relay-desk-handoff` |
| Unit tests of the link and path checks | `npx vitest run --config mod/vitest.config.ts` |

`claude.exe` is `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, installed by `npm run cli:stable`.
The tests use made-up conversation ids and folders and intercept `$.process.run`, so they never open Relay Desk or
touch a real conversation.
