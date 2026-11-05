# Notice

Relay Desk is an unofficial project. It is not affiliated with or endorsed by Anthropic.

## What the MIT license covers

The [MIT License](LICENSE) of this repository covers only Relay Desk's own code and documentation. It does not cover
any software that Relay Desk downloads, runs or works with.

## Claude Code and the Claude Agent SDK

Claude Code and `@anthropic-ai/claude-agent-sdk` (with its platform packages) are Anthropic's software, under
Anthropic's own license terms. They are not included in this repository: the person building Relay Desk downloads them
from the npm registry. `npm ci` installs the Agent SDK, and `npm run cli:<track>` downloads Claude Code
(`@anthropic-ai/claude-code-win32-x64`).

`npm run types:generate` (also run by `npm run build`) copies the plugin API declarations that Claude Code ships for
plugin authors out of the downloaded package, so that the plugin code can be type-checked locally. The copies stay on
the builder's machine, in folders that git ignores; no Claude Code code is copied into this repository.

The test fixtures include short terminal captures of Claude Code's own screens (its dialogs and panels as they appear in
the console). They are used only to test how Relay Desk recognizes and mirrors those dialogs.

If you use Relay Desk, you use Claude Code, and you must follow Anthropic's terms for it, including
https://code.claude.com/docs/en/legal-and-compliance.

## Sign-in and credentials

Relay Desk does not offer Claude.ai login of its own. Sign-in runs Claude Code's own `claude auth login`, which
completes through Anthropic's own flow in a console window that Relay Desk opens but does not read: Relay Desk never
sees the sign-in URL, code or credentials of the sign-in flow. When the login ends, Relay Desk ends Claude Code and the
login's console programs; a browser that Claude Code opened for the sign-in page keeps running, with the console
programs it started, and Relay Desk does not close it. If an account is not signed in, Relay Desk does not show Claude
Code's sign-in screen in a session; it closes the session and asks the user to use Log in. The check recognizes the
sign-in screens of the admitted Claude Code builds only, and it does not cover a sign-in that the model starts with its
own tools; see SECURITY.md for what it cannot catch.

An account can be set to use the launch environment as its authentication source. Relay Desk then passes the values of
its own environment's authentication variables, including API keys and subscription tokens such as
`CLAUDE_CODE_OAUTH_TOKEN`, to the Claude Code processes it starts for that account, as a terminal does. It keeps them in
memory only, does not store or log them, never sends them to its window (which shows only the variable names) and never
puts them on a command line. They do pass through Relay Desk's own helper processes, and Claude Code hands its
environment on to the tools, hooks and MCP servers it starts, so a tool that prints its environment shows them in the
transcript, which Relay Desk does not redact. Cloud provider variables such as `AWS_*`, `GOOGLE_*` and `AZURE_*` are not
removed from Relay Desk's own environment, so every process Relay Desk starts inherits them. SECURITY.md lists where
the values go. The variables are listed in
`src/main/system/authenticationEnvironment.ts`.

## Builds

Only the output of `npm run dist` (the packaged app in `release/`) contains Claude Code; `npm run build` compiles Relay
Desk's own code into `out/`. Do not redistribute packaged builds that contain Claude Code: shipping Claude Code in a
product requires Anthropic's Commercial Terms. Package Relay Desk for your own use.

## Trademarks

Claude, Claude Code and Anthropic are trademarks of Anthropic. Relay Desk uses the names only to say what it works with.
Relay Desk's own interface and icon use no Anthropic logo, and their warm orange accent is a different shade from
Anthropic's brand orange; the terminal captures in the test fixtures show Claude Code's screens, with the logo cells
blanked.

## Other third-party software

The npm packages Relay Desk depends on are listed, with their licenses, in THIRD_PARTY_NOTICES.md. The optional PDF
tools (Poppler) are not included in this repository; builders who add them supply them and follow their license
themselves.
