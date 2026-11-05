# Claude Code CLI tracks

Relay Desk runs the official Claude Code CLI, which is Anthropic's software. You download it yourself from npm; this
repository does not include the CLI or any of its code. Its test fixtures do contain short terminal captures of the
CLI's own screens, used to test the dialog parser (see [NOTICE.md](../NOTICE.md)). Relay's dialog automation, footer
reading and Mod API were checked against specific CLI builds, so this source admits exactly one build per track.

## Tracks

The tracks follow the official npm dist-tags of `@anthropic-ai/claude-code`:

- **stable** follows the `stable` tag.
- **latest** follows the `latest` tag. npm has no "nightly" tag; "nightly" only describes how new latest is.

| Track | Version | claude.exe sha256 | Verification |
| --- | --- | --- | --- |
| stable | 2.1.311 | `966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680` | `real-account-and-isolated` |
| latest | 2.1.318 | `b9aa5b08dc2cc46ea77d334dce792d1b8fdbb3a43bb290efdebdc905b1181082` | `isolated-only` |

The table matches `NATIVE_CLI_TRACKS` and `NATIVE_CLI_BUILDS` in `src/main/native/cliBuilds.ts`;
`tests/source/cli-tracks-doc.test.mjs` fails when they differ.

Verification levels:

- `real-account-and-isolated`: the maintainers use this build with their own real accounts, and it passes the isolated
  acceptance runs.
- `isolated-only`: the build passes the isolated acceptance runs only. Those runs use a synthetic home folder, a fake API
  key and a loopback model provider. The maintainers never run it with a real account. Use it with that in mind.

## Switching tracks

```powershell
npm run cli:stable              # stage and install the admitted stable build
npm run cli:latest              # stage and install the admitted latest build
npm run cli:latest -- --exact   # install the admitted version even though the npm tag has moved on
npm run cli:status              # the installed track and the staged tracks
npm run build                   # regenerate the Mod declarations and rebuild for the installed build
```

`npm run cli:<track>`:

1. Reads the track's npm dist-tag. If it no longer names the admitted version, it stops before downloading, for
   example: `npm latest is 2.1.319; this source admits 2.1.318. Run npm run cli:latest -- --exact.`
2. Stages the package from `registry.npmjs.org` only, with the registry integrity checks, into
   `%LOCALAPPDATA%\relay-desk-dev\cli-stage` (or `--stage-root <absolute folder>`, outside the repository). It never runs
   the CLI. The registry must start answering the download request within 120 s, and the download stops only if no data
   arrives for 60 s or if it runs past a total cap: the larger of 30 minutes and the package's unpacked size read at
   64 KiB/s. For 2.1.318 (159,306,524 bytes to download, 342,408,922 unpacked) the cap is about 87 minutes, so an
   average of about 30 KB/s (about 0.24 Mbit/s) is enough. The 120 s window covers only the download. The metadata
   checks before it have their own short limits: see "Metadata checks before the download" below.
3. Checks that the staged version and the sha256 of `claude.exe` equal the admitted entry.
4. Copies `claude.exe` into `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/`, where Relay Desk looks for it. That
   folder and `node_modules` must be physical folders (a junction or linked `node_modules` is refused). The binary it
   replaces must be the SDK's own build or an admitted one, and the SDK's `package.json` must be the locked file; it is
   never rewritten. The result is recorded in `.relay-cli.json`, written through `.relay-cli.json.relay-partial` and a
   rename, so a killed install never leaves it cut short. It can leave the `.relay-cli.json.relay-partial` in the
   project folder, which the next install removes (if that name is a folder or another non-file, the install asks you to
   remove it by hand).

`node tools/cli/official-cli.mjs install <track>` repeats step 4 offline from an existing stage. `npm ci` restores the
SDK's own `claude.exe`; run `npm run cli:<track>` again afterwards.

The default stage root is shared by every clone, worktree and moved copy of the repository on the machine. A complete
stage is reused by any of them, whatever the letter case of the path, without downloading again: it is checked against
the registry integrity, its own archive and the admitted sha256 of `claude.exe` first.

A `claude.exe.relay-new` that a killed install left in the SDK package folder is removed by the next
`npm run cli:<track>` or `install`, even when nothing needs copying ("Removed a claude.exe.relay-new that an
interrupted install left in the SDK package folder."). If that path is not a regular file, the command asks you to
remove it by hand. Packaging excludes it.

## Metadata checks before the download

Before it downloads anything, `npm run cli:<track>` makes up to five metadata checks against `registry.npmjs.org`: the
moved-tag check of step 1 (not with `--exact`), the `latest` and `stable` dist-tag checks, and the metadata of the
parent and of the Windows package. They are separate from the download and have their own short limits: each dist-tag
check (two requests) allows 5 s in total, and each of the other two requests allows 5 s. The 120 s answer window above
applies to the download request only. A failed check reads:

```text
Checking <the npm stable tag | the latest release | the stable release | Claude Code <version> | the Windows package
<version>> failed: <reason> (cause: ...). <advice>
```

The advice depends on the failure, because not every failed check is a network problem:

| Failure | Advice |
| --- | --- |
| The request got no answer, or failed on the connection, a name lookup, a certificate or a timeout | `Check the network, then rerun the same command.` |
| The registry answered with an HTTP error status | `The registry answered with an error status, which is usually temporary. Rerun the same command in a few minutes.` |
| A redirect, a page that is not JSON, an answer over the size limit, or an answer the stager rejects (a proxy or captive portal can cause these) | `The registry, or a proxy or captive portal in between, gave an answer this tool does not accept. Rerun the same command later or from another network.` |
| Wrong registry data: an invalid version, a missing dist-tag, another package identity, bad dist data | `The registry data is not what this source accepts, so nothing was staged. Rerunning changes nothing until that data does; report this message if it persists.` |
| Anything else | `Rerun the same command; if it fails the same way again, report this message.` |

The run has not created or changed any stage folder at that point, so there is nothing to delete; a rerun simply repeats
the check.

## If a download fails

After a failed or interrupted `npm run cli:<track>`, run the same command again (with the same `--stage-root` and
`--exact`). Run one `npm run cli:<track>` at a time: nothing locks a stage folder. If two runs use the same stage folder
(same stage root, version and selection) from one clone, the second finds the first one's incomplete stage, deletes it
together with the tarball the first run is writing, and the first run then fails with an error such as
`EEXIST: file already exists, mkdir '...\extracted'`, which gives no guidance. Rerun the same command after both have
ended; a complete stage is reused. Runs for two different tracks use different stage folders and do not collide there,
but both installs write the same `claude.exe` and `claude.exe.relay-new` under `node_modules`, so installs must not
overlap either. Another clone's incomplete stage is not deleted but refused (first row of the table below).

The failure message names the stage folder and the reason, for example:

```text
Downloading <tarball URL> failed after <n> bytes: no data arrived for 60 s. Stage folder: <folder>; the partial download
was removed, and rerunning the same command starts again from a clean stage.
```

The timeout reasons are "no data arrived for 60 s", "the registry did not answer within 120 s" and "it did not finish
within <seconds> s". A network failure shows the cause that Node's fetch keeps after the short reason, for example:

```text
Downloading <tarball URL> failed after 4096 bytes: terminated (cause: UND_ERR_SOCKET: other side closed). Stage folder:
<folder>; the partial download was removed, and rerunning the same command starts again from a clean stage.
```

A refused connection reads "fetch failed (cause: ...ECONNREFUSED...)", and a proxy or certificate problem shows its code
and message the same way. The text "socket hang up" appears only when the fetch implementation raises exactly that. The
timeout reasons carry no cause. Another reason is "Downloaded package SRI differs". If nothing had been written yet, the
message says "no download was kept" instead of "the partial download was removed".

An incomplete stage (one without `stage-receipt.json`) that this clone created is deleted entry by entry, never through
links, and staged again ("Replaced an incomplete stage that an earlier run left in <folder>."). Each file and folder is
checked when the stage is inspected and again immediately before it is deleted, and must still be the same file or
folder (same type, device and file id). This narrows the window for a swap but cannot close it completely, so keep the
stage root in a folder that only you can write to.

The stager writes the owner file, the channel and package metadata files and `stage-receipt.json` through a temporary
file named `<file>.relay-partial` and then renames it, so a run that is killed or runs out of disk space never leaves a
cut-short file under its real name. A kill between the two steps leaves a `.relay-partial` file, and an incomplete
stage that holds one is deleted like any other.

A stage folder that is empty, or holds only `<file>.relay-partial` files (a run killed before it wrote its owner file),
has no owner file yet, so it belongs to no clone. It is taken over silently only when the folder and its files have not
changed for at least 60 s; otherwise a run that is still creating it would look the same, and the command stops (last
rows of the table below). Only plain files at the top level are removed. A nested folder, a link or a junction, even one
named `*.relay-partial`, is refused and left untouched. Another clone's incomplete stage is still never deleted: a stage
(a folder with an owner file) is never taken over, and the brand-new folder of another run is protected by the 60 s rule.

You only have to delete a folder by hand when the command refuses:

| Message | What to do |
| --- | --- |
| `<folder> is an incomplete stage of the clone at <path>, which may still be using it.` | Finish or rerun the command in that clone, or delete the folder once nothing uses it |
| `<entry> was not written by this tool, so the incomplete stage <folder> was left as it is.` | A link, a junction or a foreign file is inside it: delete that folder, then rerun |
| `<entry> changed while the incomplete stage <folder> was being removed, so the removal stopped there.` | Something replaced or removed an entry between the check and the delete; entries already deleted stay deleted. Delete that folder by hand, then rerun |
| `<folder> is not a stage this tool created.` | Move or delete that folder, then rerun |
| `<check> Stage folder: <folder>. Delete it, then rerun the same command to stage again.` | A complete stage failed its checks: delete the folder, then rerun |
| `<file> cannot be read (<reason>). Stage folder: <folder>. Delete it, then rerun the same command to stage again.` | During `npm run cli:<track>`: the stage receipt or the owner file cannot be read. The reason is the JSON error, "it is not a JSON object", or the system's error (such as `EISDIR: illegal operation on a directory, read`, `EACCES` or `EBUSY`). Delete the folder, then rerun |
| `<file> cannot be read (<reason>). Stage folder: <folder>. Delete it, then run stage instead of resume to stage again.` | Only when you run the stager's own `resume` (`node tools/native-cli-maintenance/stage-official.mjs resume ...`, not an npm script). It is the only command that reads the saved metadata files, and any of the stage files can be the unreadable or missing one (`cannot be read (ENOENT ...)`) |
| `<file> cannot be read (<reason>). Stage folder: <folder>. Delete it, then rerun the command that staged it (npm run cli:<track> -- --stage-root <folder>).` | During `install`, `npm run cli:status` or `npm run typecheck:tracks`: the stage receipt cannot be read (status fails as a whole when one receipt cannot). The advice repeats the stage root when you gave one, with `--exact` before `--stage-root` for a stage made by exact version, and quotes a folder with spaces; with the default stage root it is just `npm run cli:<track>` (or `npm run cli:<track> -- --exact`). Delete the folder, then run that command |
| `<project>\.relay-cli.json cannot be read (<reason>). Delete it, then rerun npm run cli:stable or npm run cli:latest, whichever you use, to write it again.` | `npm run cli:status`: the install record is cut short, empty, not a JSON object or a folder. Status fails as a whole. Delete the file, then rerun `npm run cli:<track>` |
| `<folder> holds other package bytes for <version>.` | Delete that folder, then rerun |
| `<folder> was changed less than a minute ago and holds only temporary files, so another run may still be creating it. Rerun the same command when that run has finished, or in a minute if none is running.` | Wait for the other run, or a minute, then rerun; nothing needs deleting |
| `<entry> is not a file this tool wrote, so <folder> was left as it is. Delete that folder, then rerun the same command.` | A nested folder, link or junction (even one named `*.relay-partial`) is in a folder that otherwise holds only temporary files: delete that folder, then rerun |

When `resume` finds a partial stage it cannot continue, the error names the folder and says "Run stage instead of resume
to replace this incomplete stage, or delete that folder and run stage." A leftover temporary file is named ("Partial
stage contains unexpected files: stage-receipt.json.relay-partial"), as is a missing file ("Partial stage lacks files:
..."). A failed download removes its archive, so resuming it ends in an `ENOENT ... lstat ...tgz` error plus that
advice; run stage again.

Folders under `%LOCALAPPDATA%` or `%USERPROFILE%` are printed with the variable instead of your user name. The default
stage folder of one build is `%LOCALAPPDATA%\relay-desk-dev\cli-stage\claude-code-<version>-<track>`.

## Unadmitted builds

Any other `claude.exe`, including the SDK's own build that `npm ci` installs, is unadmitted:

- Relay Desk still runs it, but its automatic dialog drivers stay off and the CLI's own panels are mirrored instead.
- `npm run build` and `npm run types:generate` refuse it.
- It is unsupported: please reproduce an issue on an admitted build before reporting it.

## Mod declarations per track

The Mod API declarations are Claude Code's own text, shipped for plugin authors inside the CLI, so they are copied out
of the installed build locally and never committed:

- `npm run types:generate` writes them for the installed build; `npm run build` does this on every run.
- `npm run typecheck` checks the source against the generated declarations and warns when they are not the installed build's.
- `npm run typecheck:tracks` checks it against both tracks. It reads the builds staged under
  `%LOCALAPPDATA%\relay-desk-dev\cli-stage`, or under `-- --stage-root <absolute folder>` (the folder you gave to
  `npm run cli:<track>`), or the binaries given with `-- --stable-binary <claude.exe> --latest-binary <claude.exe>`.
  The options can be combined, each is given once, and paths must be absolute. It generates into
  `.cache/types/<version>/`. Run it when you change `native-mod/` or `src/main/native/`. A missing stage ends with
  `No staged <track> build under <folder>` and the command to run.

## How a version is admitted

1. When an npm tag moves, the maintainers stage the new version by exact version and compare it with the admitted build:
   the Mod contract, the slash command aliases and every CLI text Relay's parsers match.
2. They run the isolated acceptance (synthetic home, fake API key, loopback provider): commands, docked panels, effort,
   model and Relay's own dialog drivers. Relay is fixed where the CLI changed.
3. Only when everything passes is the build added to `NATIVE_CLI_BUILDS`, and `NATIVE_CLI_TRACKS` names it for its
   track, together with this table. A build becomes stable only after maintainer real-account use as well. The stable
   entry stays first in `NATIVE_CLI_BUILDS`; the previous stable entry is removed in the following release.

When `@anthropic-ai/claude-agent-sdk` is bumped in `package.json`, also update `SDK_VERSION`, `SDK_METADATA_SHA256` and
`SDK_BUNDLED_CLI_SHA256` in `tools/cli/admission.mjs`: `npm run test:source` fails until all three match
`package-lock.json` and the installed package, and `npm run cli:<track>` stops with "package.json is not the locked SDK
platform metadata" while they differ.

Pull requests that admit a build should include the comparison, `npm run typecheck:tracks` output and the test results.
The maintainers repeat the acceptance before merging.
