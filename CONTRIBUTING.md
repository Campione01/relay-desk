# Contributing to Relay Desk

Issues and pull requests are welcome: bug reports, fixes, translations, tests and documentation.

## How this repository is maintained

This repository is regenerated from the maintainers' workspace for each release. A pull request is therefore not
merged here directly: once it is accepted, its change is applied upstream and appears in the next export. Keep pull
requests small and focused so they apply cleanly.

## License of contributions

Relay Desk is under the MIT License. By opening a pull request you agree that your contribution is licensed under the
same terms.

## Before you open a pull request

Set up the project as described in [BUILD.md](BUILD.md), then run:

```powershell
npm run typecheck
npm test
npm run test:source
```

When you touch `native-mod/` or `src/main/native/`, also run `npm run typecheck:tracks`, which checks the code
against the plugin API of every admitted Claude Code track.

Add or update tests for every behaviour you change. Tests must not sign in, call a model, use the real `~/.claude`
folder or depend on files outside the repository. A test that starts a synthetic program must end it even when the test
fails: the login-host tests write a stop file into each case folder in `afterAll`, so a failed test leaves no
synthetic programs or temporary folders behind.

Sources are stored with LF line endings (`.gitattributes` sets `* text=auto eol=lf`); the terminal captures `*.ansi` and
the panel captures under `tests/engine/fixtures/native-panel/` are kept byte for byte. `.gitignore` ignores build outputs
(`out/`, `dist/`, `release/`, `coverage/`, `.cache/`), the three helper `bin` folders and `*.log` files. Any other `bin`
folder is not ignored, so keep compiled files out of the repository.

When you bump `@anthropic-ai/claude-agent-sdk`, update the three SDK constants in `tools/cli/admission.mjs` too (see
[docs/CLI-TRACKS.md](docs/CLI-TRACKS.md)); `npm run test:source` fails until they match `package-lock.json`.

## What is not accepted

- **Anything that lets Relay Desk handle sign-in secrets.** Pull requests that make Relay Desk read, capture, copy,
  store, forward or display authorization URLs, authorization codes, callback URLs, tokens, API keys or other
  credentials are declined. Sign-in stays inside Claude Code's own console window and Anthropic's own flow.
- **Changes to Claude Code itself**, or code that patches or redistributes it or copies any of its code into this
  repository. The only thing Relay Desk reads out of Claude Code is the plugin API declarations, locally, for type
  checking (`npm run types:generate`, see BUILD.md).
- **Binaries and generated files**: no `.exe`, `.dll` or other compiled files, and no generated Mod API declarations
  (`native-mod/types/`, `src/main/native/generated/`). Helpers are built from source.
- **Personal data in code, tests or fixtures**: no real names, email addresses, user folders, machine names, session
  ids or account details. Use `example.com` addresses, paths such as `C:\Users\me`, and made-up UUIDs.

## Reporting bugs

Include the Relay Desk version, the output of `npm run cli:status`, your Windows version and the steps to reproduce.
Remove personal paths, email addresses and session ids from pasted output, logs and screenshots before you post them:
`npm run cli:status` and many error messages print folders under your user profile, so replace your user name in them
(for example with `C:\Users\me`).

Security problems are reported privately; see [SECURITY.md](SECURITY.md).
