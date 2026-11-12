# Building Relay Desk

Everything below runs in PowerShell or Command Prompt from the repository folder, on Windows x64 with Node.js 24 or
later. All commands are npm scripts from `package.json`.

## 1. Install the dependencies

```powershell
npm ci
```

`npm ci` installs the locked packages, including `@anthropic-ai/claude-agent-sdk`. Its Windows package carries a
Claude Code build that this source does not admit; the next step replaces it. Keep `node_modules` a real folder: the
CLI installer refuses a junction or a link there.

## 2. Install the official Claude Code CLI

```powershell
npm run cli:stable      # or: npm run cli:latest
npm run cli:status
```

`npm run cli:<track>` asks the npm registry which version the track's dist-tag names, downloads that build of the
official `@anthropic-ai/claude-code-win32-x64` package from registry.npmjs.org with integrity checks, and compares the
executable's SHA-256 with the build this source admits for the track. Only then does it copy `claude.exe` into
`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/` and record the track in `.relay-cli.json`, which it writes
through `.relay-cli.json.relay-partial` and a rename, so a killed install never leaves it cut short. The CLI is never
run during this step.

- Downloads are staged outside the repository, in `%LOCALAPPDATA%\relay-desk-dev\cli-stage`. Pass
  `-- --stage-root <absolute folder>` to use another folder; the other commands that read stages
  (`typecheck:tracks`, `cli:status`) take the same option. Every clone of the repository on the machine shares the
  default folder and reuses a complete stage without downloading again.
- A slow download still succeeds: it stops only when no data arrives for 60 s, or after a total cap that is generous
  for the package size (about 88 minutes for 2.1.322). If it fails or is interrupted, run the same command again; see
  "A CLI download failed" under Troubleshooting.
- Run one `npm run cli:<track>` at a time. Nothing locks a stage folder: a second run for the same stage folder (same
  stage root, version and selection) from the same clone finds the first run's incomplete stage, deletes it, and the
  first run then fails with an error such as `EEXIST: file already exists, mkdir '...\extracted'`. Rerun the same
  command once the other run has ended; a complete stage is reused. Runs for different tracks use different stage
  folders, but both installs write the same `claude.exe` and `claude.exe.relay-new` under `node_modules`, so installs
  must not overlap either.
- When npm's tag has already moved past the admitted build, the command stops and says so. Install the admitted
  build by its exact version instead: `npm run cli:stable -- --exact` (or `cli:latest -- --exact`).
- To switch back to a track that is already staged without downloading again:
  `node tools/cli/official-cli.mjs install stable`.
- `npm run cli:status` shows the installed build, its track (`stable`, `latest` or `unadmitted`) and which tracks are
  staged.

After switching tracks, run `npm run build` again: it regenerates the declarations for the installed build. The
tracks and their verification are described in [docs/CLI-TRACKS.md](docs/CLI-TRACKS.md).

## 3. Generate the Mod API declarations

```powershell
npm run types:generate
```

Claude Code ships TypeScript declarations of its plugin API for plugin authors; in the Windows build they are stored
inside `claude.exe`. This command copies those declarations out of the installed, admitted build, offline and without
running it, into `native-mod/types/` and `src/main/native/generated/`, so that the plugin and the main process can be
type-checked locally. No Claude Code code is copied into the repository: the declarations are Anthropic's text, both
folders are ignored by git, and pull requests must not add them. `npm run build` runs this step for you;
`npm run typecheck` checks that the generated files match an admitted build.

## 4. Build the helpers

```powershell
npm run build:helpers
```

Relay Desk needs three small Windows helpers, compiled from the C# sources in `tools/` with the .NET Framework 4.x
compiler that ships with Windows (`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`):

| Helper | Source | Role |
| --- | --- | --- |
| RelayNativeHost | `tools/native/RelayNativeHost.cs` | Runs Claude Code in a pseudo console and carries the plugin's pipe |
| RelayPrivateStorage | `tools/private-storage/RelayPrivateStorage.cs` | Writes attachments and launch files into folders only your account can open |
| RelayAuthHost | `tools/auth/RelayAuthHost.cs` | Owns the visible sign-in console and its process tree |

The tests also use test-only helpers (`NativeConsoleFixture`, `OwnedMcpJob`, `FakeAuthProcess`); `npm test` builds
what it needs first. None of the helpers is code-signed.

## 5. Build and run

```powershell
npm run build
npm start
```

`npm run build` stops unless the installed CLI is an admitted build ("Run npm run cli:stable"). It then regenerates
the declarations, builds the helpers, compiles the plugin in `native-mod/`, bundles the app with electron-vite into
`out/`, and checks the optional PDF tools; one of its lines says whether PDF attachments are enabled for
`npm start`. `npm start` runs the built app with Electron; `npm run dev` does both.

`npm run dev:web` serves only the renderer in a browser, backed by an in-memory mock of the main process with synthetic
sessions. It needs no CLI and no account. URL options: `?demo=0` turns the scripted reply off, `?theme=dark` or
`?theme=light` sets the theme, `?launch=resume` opens the take-over flow.

## 6. Check

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | The declaration check, then TypeScript for the main process, the renderer and `native-mod` |
| `npm run typecheck:tracks` | The same TypeScript programs against the declarations of every admitted track |
| `npm test` | Builds the test helpers, then the Vitest suites (`tests/`, `mod/tests/`) |
| `npm run test:source` | Node's test runner for the build tooling (`tests/source/`, the CLI staging tools) |

`npm run typecheck:tracks` takes each track's binary from the stage folder, so stage both first with
`npm run cli:latest` and `npm run cli:stable` (the last one stays installed). If you staged them with
`-- --stage-root <absolute folder>`, pass `-- --stage-root <that folder>` here too; or pass
`-- --stable-binary <claude.exe> --latest-binary <claude.exe>`. The options can be combined; each is given once, with
absolute paths. Its generated files go to `.cache/types/`.

The tests use synthetic data only: they do not sign in, call a model or touch your `~/.claude` folder. A few
Windows-only tests are skipped when their helper is missing. The tests that open a visible console window run only when
you opt in with `RELAY_RUN_VISIBLE_AUTH_TEST=1` (for example `$env:RELAY_RUN_VISIBLE_AUTH_TEST = '1'; npm test` in
PowerShell); they start a synthetic program, never Claude Code.

## 7. Package for your own use

```powershell
npm run dist
```

`npm run dist` runs `npm run build` and then electron-builder for Windows x64 into `release/`. Packaged builds include
no PDF tools and ignore `RELAY_DESK_PDF_TOOLS_DIR`, so they refuse PDF attachments. The build prints a note saying so
only when PDF attachments are enabled for `npm start` (a verified PDF tools folder); otherwise its PDF line only says
that they are disabled.

> **Personal use only.** A packaged build contains Claude Code, which is Anthropic's proprietary software. Do not
> redistribute builds that contain it; shipping Claude Code in a product requires Anthropic's Commercial Terms. See
> [NOTICE.md](NOTICE.md).

## Optional: PDF attachments

PDF attachments are off by default. Images and text files do not need anything extra. PDF tools work only in
development runs (`npm start`, `npm run dev`): `electron-builder.yml` packages no `pdf-tools`, and a packaged build
reads only `resources/pdf-tools` inside its install and ignores `RELAY_DESK_PDF_TOOLS_DIR`. To enable PDFs for a
development run, supply a Poppler build for Windows x64 yourself:

1. Lay it out like this, in `resources/pdf-tools/` or any local folder named by the `RELAY_DESK_PDF_TOOLS_DIR`
   environment variable (an absolute path):

   ```text
   Library/bin/pdfinfo.exe
   Library/bin/pdftoppm.exe
   Library/bin/*.dll          every DLL the two programs load, including the Visual C++ runtime DLLs
   Library/etc/fonts/
   Library/share/fonts/
   share/poppler/
   manifest.json              written by you: where the files came from
   ```

2. Run `node tools/pdf/receipt.mjs` (or `node tools/pdf/receipt.mjs --dir <absolute folder>`). It selects the files
   the two programs need, records them with their hashes in `receipt.json` and verifies the folder against it. Relay
   Desk uses a PDF tools folder only when it holds that receipt. Nothing is downloaded or run.

How the folder is checked:

- `npm run build` only verifies the folder (`RELAY_DESK_PDF_TOOLS_DIR`, or `resources/pdf-tools`) against its
  `receipt.json` and stops when they differ, naming the file or the reason (for a changed file,
  `PDF resource hash mismatch: <file>`). It never writes the receipt: only `node tools/pdf/receipt.mjs` does. Without a
  receipt it reports PDF attachments as disabled. With a verified folder it prints
  `PDF attachments are enabled for npm start: <N> files in the <folder> folder verified`, followed by the note about
  packaged builds.
- A development run (`npm start`, `npm run dev`) checks the whole folder against `receipt.json` when it opens its
  first session, with the same verification of the listed files as `npm run build`, and again before every later
  session. A DLL, font or manifest that changed (or was removed) after the receipt was written therefore turns PDFs off
  with a warning. The receipt must also be valid. In a session, a `receipt.json` that cannot be read or parsed gives
  "The PDF tools receipt <file> cannot be read (...)", and one of the wrong shape gives "... is not a valid receipt
  (...)" or a plain reason such as "A portable PDF resource receipt is required.". `npm run build` reports the same
  receipts with the raw error instead (for example a SyntaxError for a cut-short file). Files added to the folder but
  not listed in the receipt are not checked, as in a packaged build. After you change the folder on purpose, run `node tools/pdf/receipt.mjs` to write the receipt again,
  then start Relay Desk again; the new receipt is what the run checks.

`npm run dist` never packages the PDF tools. Poppler is licensed under the GPL: if you share a build that contains it,
you are responsible for its license obligations, including the source offer.

## Troubleshooting

- **"Run npm run cli:stable"** from `npm run build`: the installed `claude.exe` is not an admitted build (after
  `npm ci` it is the SDK's own). Install a track first.
- **"npm stable is X; this source admits Y"**: npm's tag moved. Use `npm run cli:stable -- --exact`.
- **A CLI download failed** (`Downloading <URL> failed after <n> bytes: ...`): run the same `npm run cli:<track>`
  command again (once no other `npm run cli:<track>` is running), with the same `--stage-root` and `--exact`. The
  failed attempt removed its partial download, and an incomplete stage that this clone created is deleted and staged
  again ("Replaced an incomplete stage that an earlier run left in <folder>."). Only when the command refuses, naming a
  folder to delete, delete that folder (by default under
  `%LOCALAPPDATA%\relay-desk-dev\cli-stage\claude-code-<version>-<track>`) and rerun. If it says the folder "was changed
  less than a minute ago and holds only temporary files", another run may still be creating it: rerun when that run has
  finished, or in a minute if none is running. The messages are listed in [docs/CLI-TRACKS.md](docs/CLI-TRACKS.md).
- **"... cannot be read (...)" naming a stage file or `.relay-cli.json`**: the file is cut short, empty, not a JSON
  object or a folder, or the system refuses to read it. Delete it (for a stage file, the stage folder named in the
  message), then rerun the `npm run cli:<track>` command you use (the message gives the exact command when it knows
  it); `npm run cli:status` fails as a whole until you do. A killed install can also leave a
  `.relay-cli.json.relay-partial` in the project folder, which the next install removes; if that name is a folder or
  another non-file, the install asks you to remove it by hand.
- **"Refusing to replace an unrecognized claude.exe (sha256 ...)"**: the file under
  `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/` is neither the build `npm ci` installs nor one this source
  admits. Either another `claude.exe` was copied there, or a source update dropped the build that was admitted
  before. Run `npm ci` to restore the SDK's own binary, then `npm run cli:<track>`.
- **A `claude.exe.relay-new` file (about 290 MB) in that SDK folder**: a killed install left it. The next
  `npm run cli:<track>` or `install` removes it, even when nothing needs copying; if it is not a regular file, the
  command tells you to remove it by hand.
- **"package.json is not the locked SDK platform metadata"**: run `npm ci` first. If you changed the SDK version
  yourself, see "How a version is admitted" in [docs/CLI-TRACKS.md](docs/CLI-TRACKS.md).
- **"claude.exe is in use"**: close Relay Desk and any Claude Code started from this folder, then retry.
- **A junction or link is refused**: `node_modules`, the SDK package folder and `claude.exe` must be real files and
  folders. Delete the link and run `npm ci`.
- **`csc.exe` is not found**: the .NET Framework 4.x is part of Windows 10 and 11; check that
  `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` exists and has not been removed by policy.
- **Relay Desk shows the CLI's own dialogs instead of its controls**: the running build is not admitted
  (`npm run cli:status`). Install a track and rebuild.
- **A second Relay Desk does not open**: only one Relay Desk runs per Windows user, whichever build it is. Exit the
  other one from its notification-area icon.
- **PDF attachments are refused**: the PDF tools are not set up (the folder has no `receipt.json`), or
  `RELAY_DESK_PDF_TOOLS_DIR` is not a local absolute path, or you are running a packaged build (`npm run dist`),
  which includes no PDF tools and ignores that variable. Run `node tools/pdf/receipt.mjs` after setting up or changing
  the folder, then start `npm start` again.
- **"PDF attachments are off: the PDF tools folder failed its check (...)"** in a new session: `receipt.json` opts the
  folder in, but the folder fails its check, for example because a DLL was removed or changed after the receipt was
  written. The reason in the brackets names the file or the cause: a changed file reads
  `PDF resource hash mismatch: <file>`, a removed file reads the system's own error (`ENOENT: no such file or
  directory, lstat <path>`), and an unusable receipt reads "The PDF tools receipt <file> cannot be read (...)" or "...
  is not a valid receipt (...)". The check runs when Relay Desk opens its first session and again before every later
  one, so a change made while Relay Desk runs is caught too. Sessions still start, other attachments work, and a PDF is
  refused with "Native PDF attachment requires the verified portable PDF tools in this CLI child". The warning is shown
  once for each new session and logged as `[relay:pdf] ...`. It ends: "Put the folder back as its receipt.json lists
  it, then quit and restart Relay Desk. If you changed the folder on purpose, a source checkout can write its receipt
  again first with node tools/pdf/receipt.mjs. Sessions that are already open keep using the folder until you close
  them." A packaged build has no `tools/pdf/receipt.mjs`: restore the files there.
  - PDFs stay off for sessions started afterwards until the next start, so a fix takes effect only after a restart: restore the removed or changed files or, if the change was intended, run
    `node tools/pdf/receipt.mjs` (with `--dir <folder>`, or with `RELAY_DESK_PDF_TOOLS_DIR` set) to rewrite
    `receipt.json`. Then make sure the running Relay Desk (electron) process has fully exited and run `npm start`
    again.
  - Sessions that were already open when the check failed keep the PDF tools folder on their `PATH` until you close
    them: the `PATH` is fixed when a session starts, and Claude Code looks up `pdfinfo` and `pdftoppm` there and runs
    them for every PDF its own Read tool opens, not only for attachments sent through Relay Desk. Close those sessions
    if the folder is not trustworthy. Such a session still checks the folder against the receipt before each PDF
    attachment sent through Relay Desk, so a changed folder gets that attachment refused there too.
  - `npm run build` (and so `npm run dev` and `npm run dist`) stops on such a folder. For a changed or removed file it
    gives the same reason; a receipt that cannot be read or parsed is reported with the raw error (see above). To build
    or run without PDFs, unset `RELAY_DESK_PDF_TOOLS_DIR` or remove that folder's `receipt.json`.
