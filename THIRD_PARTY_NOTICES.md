# Third-party notices

Generated from `package-lock.json` (relay-desk 0.2.5-public.2).

This repository contains source code only and includes none of the packages below. `npm ci` downloads them from the
npm registry, each with its own license file; this list copies no license texts.

Scope is npm's classification in the lock: `runtime` packages are installed by `npm ci --omit=dev`, `dev` packages
only for development. A build made with `npm run build` or `npm run dist` also bundles some `dev` packages (for
example Electron, React and the fonts below). `optional` packages are installed only on matching platforms.

## Packages that need attention

### Anthropic proprietary software

These packages are Anthropic proprietary software. They are not redistributed by this repository: the builder
downloads them from npm, and they are governed by Anthropic's terms, not by the MIT license of Relay Desk. They
include Claude Code, which a build places in its output; do not redistribute such builds (see NOTICE.md).

- `@anthropic-ai/claude-agent-sdk` 0.3.302 (SEE LICENSE IN README.md; runtime)
- `@anthropic-ai/claude-agent-sdk-darwin-arm64` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-darwin-x64` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-linux-arm64` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-linux-arm64-musl` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-linux-x64` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-linux-x64-musl` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-win32-arm64` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)
- `@anthropic-ai/claude-agent-sdk-win32-x64` 0.3.302 (SEE LICENSE IN LICENSE.md; runtime, optional)

Not in the lock: `npm run cli:stable` and `npm run cli:latest` download the Claude Code CLI from npm, in the version
this source admits for the track (docs/CLI-TRACKS.md), and copy its `claude.exe` into the SDK package above.

- `@anthropic-ai/claude-code-win32-x64` (Anthropic proprietary; downloaded by `npm run cli:*`, not in the lock): its `claude.exe` is the CLI a build runs and contains
- `@anthropic-ai/claude-code` (Anthropic proprietary; downloaded by `npm run cli:*`, not in the lock): registry metadata only: its dist-tags and the platform package of each version

### Fonts under the SIL Open Font License

Renderer fonts under the SIL Open Font License 1.1; a build bundles them, and their license must travel with them.

- `@fontsource-variable/dm-sans` 5.3.0 (OFL-1.1; dev)
- `@fontsource-variable/jetbrains-mono` 5.3.0 (OFL-1.1; dev)

### Mozilla Public License 2.0

File-level copyleft: changes to these packages' own files must stay under the MPL 2.0.

- `lightningcss` 1.33.0 (MPL-2.0; dev)
- `lightningcss-android-arm64` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-darwin-arm64` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-darwin-x64` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-freebsd-x64` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-linux-arm-gnueabihf` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-linux-arm64-gnu` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-linux-arm64-musl` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-linux-x64-gnu` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-linux-x64-musl` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-win32-arm64-msvc` 1.33.0 (MPL-2.0; dev, optional)
- `lightningcss-win32-x64-msvc` 1.33.0 (MPL-2.0; dev, optional)

## All packages (630)

| Package | Version | License | Scope |
| --- | --- | --- | --- |
| @adobe/css-tools | 4.5.0 | MIT | dev |
| @anthropic-ai/claude-agent-sdk (direct) | 0.3.302 | SEE LICENSE IN README.md | runtime |
| @anthropic-ai/claude-agent-sdk-darwin-arm64 | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-darwin-x64 | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-linux-arm64 | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-linux-arm64-musl | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-linux-x64 | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-linux-x64-musl | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-win32-arm64 | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/claude-agent-sdk-win32-x64 | 0.3.302 | SEE LICENSE IN LICENSE.md | runtime, optional |
| @anthropic-ai/sdk (direct) | 0.135.0 | MIT | runtime |
| @asamuzakjp/css-color | 7.1.6 | MIT | dev |
| @asamuzakjp/dom-selector | 10.0.3 | MIT | dev |
| @babel/code-frame | 7.29.7 | MIT | dev |
| @babel/compat-data | 7.29.7 | MIT | dev |
| @babel/core | 7.29.7 | MIT | dev |
| @babel/generator | 7.29.8 | MIT | dev |
| @babel/helper-compilation-targets | 7.29.7 | MIT | dev |
| @babel/helper-globals | 7.29.7 | MIT | dev |
| @babel/helper-module-imports | 7.29.7 | MIT | dev |
| @babel/helper-module-transforms | 7.29.7 | MIT | dev |
| @babel/helper-plugin-utils | 7.29.7 | MIT | dev |
| @babel/helper-string-parser | 7.29.7 | MIT | dev |
| @babel/helper-validator-identifier | 7.29.7 | MIT | dev |
| @babel/helper-validator-option | 7.29.7 | MIT | dev |
| @babel/helpers | 7.29.10 | MIT | dev |
| @babel/parser | 7.29.9 | MIT | dev |
| @babel/plugin-transform-arrow-functions | 7.29.7 | MIT | dev |
| @babel/runtime | 7.29.10 | MIT | runtime |
| @babel/template | 7.29.7 | MIT | dev |
| @babel/traverse | 7.29.10 | MIT | dev |
| @babel/types | 7.29.8 | MIT | dev |
| @bramus/specificity | 2.4.3 | MIT | dev |
| @csstools/color-helpers | 6.1.2 | MIT-0 | dev |
| @csstools/css-calc | 3.4.3 | MIT | dev |
| @csstools/css-color-parser | 4.2.6 | MIT | dev |
| @csstools/css-parser-algorithms | 4.0.2 | MIT | dev |
| @csstools/css-syntax-patches-for-csstree | 1.1.15 | MIT-0 | dev |
| @csstools/css-tokenizer | 4.0.2 | MIT | dev |
| @electron-internal/extract-zip | 1.0.5 | BSD-2-Clause | dev |
| @electron/asar | 3.4.1 | MIT | dev |
| @electron/fuses | 1.8.0 | MIT | dev |
| @electron/get | 3.1.0 | MIT | dev |
| @electron/get | 5.1.0 | MIT | dev |
| @electron/notarize | 2.5.0 | MIT | dev |
| @electron/osx-sign | 1.3.3 | BSD-2-Clause | dev |
| @electron/rebuild | 4.2.1 | MIT | dev |
| @electron/universal | 2.0.3 | MIT | dev |
| @electron/windows-sign | 1.2.2 | BSD-2-Clause | dev, optional |
| @exodus/bytes | 1.16.0 | MIT | dev |
| @fontsource-variable/dm-sans (direct) | 5.3.0 | OFL-1.1 | dev |
| @fontsource-variable/jetbrains-mono (direct) | 5.3.0 | OFL-1.1 | dev |
| @hono/node-server | 2.1.5 | MIT | runtime |
| @isaacs/fs-minipass | 4.0.1 | ISC | dev |
| @jridgewell/gen-mapping | 0.3.13 | MIT | dev |
| @jridgewell/remapping | 2.3.5 | MIT | dev |
| @jridgewell/resolve-uri | 3.1.2 | MIT | dev |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | dev |
| @jridgewell/trace-mapping | 0.3.31 | MIT | dev |
| @malept/cross-spawn-promise | 2.0.0 | Apache-2.0 | dev |
| @malept/flatpak-bundler | 0.4.0 | MIT | dev |
| @modelcontextprotocol/sdk (direct) | 1.32.1 | MIT | runtime |
| @noble/hashes | 1.8.0 | MIT | dev |
| @noble/hashes | 2.4.0 | MIT | dev |
| @opentelemetry/api | 1.9.1 | Apache-2.0 | runtime |
| @oxc-project/types | 0.154.0 | MIT | dev |
| @peculiar/asn1-schema | 2.11.0 | MIT | dev |
| @peculiar/json-schema | 1.1.12 | MIT | dev |
| @peculiar/utils | 2.0.3 | MIT | dev |
| @peculiar/webcrypto | 1.7.1 | MIT | dev |
| @rolldown/binding-android-arm-eabi | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-android-arm64 | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-darwin-arm64 | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-darwin-x64 | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-freebsd-x64 | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-arm-gnueabihf | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-arm64-gnu | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-arm64-musl | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-ppc64-gnu | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-s390x-gnu | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-x64-gnu | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-linux-x64-musl | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-openharmony-arm64 | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-win32-arm64-msvc | 1.2.14 | MIT | dev, optional |
| @rolldown/binding-win32-x64-msvc | 1.2.14 | MIT | dev, optional |
| @rolldown/pluginutils | 1.0.1 | MIT | dev |
| @sindresorhus/is | 4.6.0 | MIT | dev |
| @stablelib/base64 | 1.0.1 | MIT | runtime |
| @szmarczak/http-timer | 4.0.6 | MIT | dev |
| @testing-library/dom (direct) | 10.4.2 | MIT | dev |
| @testing-library/jest-dom (direct) | 7.0.1 | MIT | dev |
| @testing-library/react (direct) | 16.3.3 | MIT | dev |
| @testing-library/user-event (direct) | 14.6.8 | MIT | dev |
| @types/aria-query | 5.0.4 | MIT | dev |
| @types/cacheable-request | 6.0.3 | MIT | dev |
| @types/chai | 5.2.3 | MIT | dev |
| @types/debug | 4.1.13 | MIT | dev |
| @types/deep-eql | 4.0.2 | MIT | dev |
| @types/estree | 1.0.9 | MIT | dev |
| @types/estree-jsx | 1.0.5 | MIT | dev |
| @types/fs-extra | 9.0.13 | MIT | dev |
| @types/hast | 3.0.5 | MIT | dev |
| @types/http-cache-semantics | 4.2.0 | MIT | dev |
| @types/keyv | 3.1.4 | MIT | dev |
| @types/mdast | 4.0.4 | MIT | dev |
| @types/ms | 2.1.0 | MIT | dev |
| @types/node (direct) | 24.19.2 | MIT | dev |
| @types/pngjs (direct) | 6.0.5 | MIT | dev |
| @types/prop-types | 15.7.15 | MIT | dev |
| @types/react (direct) | 18.3.31 | MIT | dev |
| @types/react-dom (direct) | 18.3.7 | MIT | dev |
| @types/responselike | 1.0.3 | MIT | dev |
| @types/unist | 2.0.11 | MIT | dev |
| @types/unist | 3.0.3 | MIT | dev |
| @typescript/typescript-aix-ppc64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-darwin-arm64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-darwin-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-freebsd-arm64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-freebsd-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-arm | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-arm64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-loong64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-mips64el | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-ppc64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-riscv64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-s390x | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-linux-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-netbsd-arm64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-netbsd-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-openbsd-arm64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-openbsd-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-sunos-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-win32-arm64 | 7.0.2 | Apache-2.0 | dev, optional |
| @typescript/typescript-win32-x64 | 7.0.2 | Apache-2.0 | dev, optional |
| @ungap/structured-clone | 1.4.0 | ISC | dev |
| @vitejs/plugin-react (direct) | 6.1.2 | MIT | dev |
| @vitest/mocker | 5.0.5 | MIT | dev |
| @vitest/spy | 5.0.5 | MIT | dev |
| @xmldom/xmldom | 0.8.15 | MIT | dev |
| abbrev | 4.0.0 | ISC | dev |
| accepts | 2.0.0 | MIT | runtime |
| agent-base | 7.1.4 | MIT | dev |
| ajv | 8.20.0 | MIT | runtime |
| ajv-formats | 3.0.1 | MIT | runtime |
| ansi-regex | 5.0.1 | MIT | dev |
| ansi-styles | 4.3.0 | MIT | dev |
| ansi-styles | 5.2.0 | MIT | dev |
| app-builder-lib | 26.15.3 | MIT | dev |
| argparse | 2.0.1 | Python-2.0 | dev |
| aria-query | 5.3.0 | Apache-2.0 | dev |
| asn1js | 3.1.0 | BSD-3-Clause | dev |
| assertion-error | 2.0.1 | MIT | dev |
| async | 3.2.6 | MIT | dev |
| async-exit-hook | 2.0.1 | MIT | dev |
| asynckit | 0.4.0 | MIT | dev |
| at-least-node | 1.0.0 | ISC | dev |
| aws4 | 1.13.2 | MIT | dev |
| bail | 2.0.2 | MIT | dev |
| balanced-match | 1.0.2 | MIT | dev |
| balanced-match | 4.0.4 | MIT | dev |
| base64-js | 1.5.1 | MIT | dev |
| baseline-browser-mapping | 2.11.29 | Apache-2.0 | dev |
| bidi-js | 1.1.0 | MIT | dev |
| bluebird | 3.7.2 | MIT | dev |
| body-parser | 2.3.0 | MIT | runtime |
| boolean | 3.2.0 | MIT | dev, optional |
| brace-expansion | 1.1.21 | MIT | dev |
| brace-expansion | 2.1.7 | MIT | dev |
| brace-expansion | 5.0.12 | MIT | dev |
| browserslist | 4.29.3 | MIT | dev |
| buffer-from | 1.1.2 | MIT | dev |
| builder-util | 26.15.3 | MIT | dev |
| builder-util-runtime | 9.7.0 | MIT | dev |
| bytes | 3.1.2 | MIT | runtime |
| bytestreamjs | 2.0.1 | BSD-3-Clause | dev |
| cac | 7.1.0 | MIT | dev |
| cacheable-lookup | 5.0.4 | MIT | dev |
| cacheable-request | 7.0.4 | MIT | dev |
| call-bind-apply-helpers | 1.0.2 | MIT | runtime |
| call-bound | 1.0.4 | MIT | runtime |
| caniuse-lite | 1.0.30001816 | CC-BY-4.0 | dev |
| ccount | 2.0.1 | MIT | dev |
| chai | 6.3.0 | MIT | dev |
| chalk | 4.1.2 | MIT | dev |
| character-entities | 2.0.2 | MIT | dev |
| character-entities-html4 | 2.1.0 | MIT | dev |
| character-entities-legacy | 3.0.0 | MIT | dev |
| character-reference-invalid | 2.0.1 | MIT | dev |
| chownr | 3.0.0 | BlueOak-1.0.0 | dev |
| chromium-pickle-js | 0.2.0 | MIT | dev |
| ci-info | 4.3.1 | MIT | dev |
| ci-info | 4.4.0 | MIT | dev |
| cliui | 8.0.1 | ISC | dev |
| clone-response | 1.0.3 | MIT | dev |
| color-convert | 2.0.1 | MIT | dev |
| color-name | 1.1.4 | MIT | dev |
| combined-stream | 1.0.8 | MIT | dev |
| comma-separated-tokens | 2.0.3 | MIT | dev |
| commander | 5.1.0 | MIT | dev |
| commander | 9.5.0 | MIT | dev, optional |
| compare-version | 0.1.2 | MIT | dev |
| concat-map | 0.0.1 | MIT | dev |
| content-disposition | 2.0.1 | MIT | runtime |
| content-type | 1.0.5 | MIT | runtime |
| content-type | 2.1.0 | MIT | runtime |
| convert-source-map | 2.0.0 | MIT | dev |
| cookie | 0.7.2 | MIT | runtime |
| cookie-signature | 1.2.2 | MIT | runtime |
| core-util-is | 1.0.3 | MIT | dev |
| cors | 2.8.6 | MIT | runtime |
| cross-dirname | 0.1.0 | MIT | dev, optional |
| cross-spawn | 7.0.6 | MIT | runtime |
| css-tree | 3.2.1 | MIT | dev |
| css.escape | 1.5.1 | MIT | dev |
| csstype | 3.2.3 | MIT | dev |
| data-urls | 8.0.0 | MIT | dev |
| debug | 4.4.3 | MIT | runtime |
| decimal.js | 10.6.0 | MIT | dev |
| decode-named-character-reference | 1.3.0 | MIT | dev |
| decompress-response | 6.0.0 | MIT | dev |
| defer-to-connect | 2.0.1 | MIT | dev |
| define-data-property | 1.1.4 | MIT | dev, optional |
| define-properties | 1.2.1 | MIT | dev, optional |
| delayed-stream | 1.0.0 | MIT | dev |
| depd | 2.0.0 | MIT | runtime |
| dequal | 2.0.3 | MIT | dev |
| detect-libc | 2.1.2 | Apache-2.0 | dev |
| detect-node | 2.1.0 | MIT | dev, optional |
| devlop | 1.1.0 | MIT | dev |
| dir-compare | 4.2.0 | MIT | dev |
| dmg-builder | 26.15.3 | MIT | dev |
| dom-accessibility-api | 0.5.16 | MIT | dev |
| dom-accessibility-api | 0.6.3 | MIT | dev |
| dotenv | 16.6.1 | BSD-2-Clause | dev |
| dotenv-expand | 11.0.7 | BSD-2-Clause | dev |
| dunder-proto | 1.0.1 | MIT | runtime |
| duplexer2 | 0.1.4 | BSD-3-Clause | dev |
| ee-first | 1.1.1 | MIT | runtime |
| ejs | 3.1.10 | Apache-2.0 | dev |
| electron (direct) | 44.9.0 | MIT | dev |
| electron-builder (direct) | 26.15.3 | MIT | dev |
| electron-builder-squirrel-windows | 26.15.3 | MIT | dev |
| electron-publish | 26.15.3 | MIT | dev |
| electron-to-chromium | 1.5.458 | ISC | dev |
| electron-vite (direct) | 6.0.0 | MIT | dev |
| electron-winstaller | 5.4.0 | MIT | dev |
| emoji-regex | 8.0.0 | MIT | dev |
| encodeurl | 2.0.0 | MIT | runtime |
| end-of-stream | 1.4.5 | MIT | dev |
| entities | 8.1.0 | BSD-2-Clause | dev |
| env-paths | 2.2.1 | MIT | dev |
| env-paths | 3.0.0 | MIT | dev |
| err-code | 2.0.3 | MIT | dev |
| es-define-property | 1.0.1 | MIT | runtime |
| es-errors | 1.3.0 | MIT | runtime |
| es-module-lexer | 2.3.2 | MIT | dev |
| es-object-atoms | 1.1.2 | MIT | runtime |
| es-set-tostringtag | 2.1.0 | MIT | dev |
| es6-error | 4.1.1 | MIT | dev, optional |
| escalade | 3.2.0 | MIT | dev |
| escape-html | 1.0.3 | MIT | runtime |
| escape-string-regexp | 4.0.0 | MIT | dev, optional |
| escape-string-regexp | 5.0.0 | MIT | dev |
| estree-util-is-identifier-name | 3.0.0 | MIT | dev |
| estree-walker | 3.0.3 | MIT | dev |
| etag | 1.8.1 | MIT | runtime |
| eventsource | 3.0.7 | MIT | runtime |
| eventsource-parser | 3.1.1 | MIT | runtime |
| expect-type | 1.4.0 | Apache-2.0 | dev |
| exponential-backoff | 3.1.3 | Apache-2.0 | dev |
| express | 5.3.0 | MIT | runtime |
| express-rate-limit | 8.7.1 | MIT | runtime |
| extend | 3.0.2 | MIT | dev |
| fast-deep-equal | 3.1.3 | MIT | runtime |
| fast-sha256 | 1.3.0 | Unlicense | runtime |
| fast-uri | 3.1.8 | BSD-3-Clause | runtime |
| fdir | 6.5.0 | MIT | dev |
| filelist | 1.0.6 | Apache-2.0 | dev |
| finalhandler | 2.1.1 | MIT | runtime |
| form-data | 4.0.6 | MIT | dev |
| forwarded | 0.2.0 | MIT | runtime |
| fresh | 2.0.0 | MIT | runtime |
| fs-extra | 10.1.0 | MIT | dev |
| fs-extra | 11.3.1 | MIT | dev |
| fs-extra | 11.4.1 | MIT | dev |
| fs-extra | 7.0.1 | MIT | dev |
| fs-extra | 8.1.0 | MIT | dev |
| fs-extra | 9.1.0 | MIT | dev |
| fs.realpath | 1.0.0 | ISC | dev |
| fsevents | 2.3.3 | MIT | dev, optional |
| function-bind | 1.1.2 | MIT | runtime |
| gensync | 1.0.0-beta.2 | MIT | dev |
| get-caller-file | 2.0.5 | ISC | dev |
| get-intrinsic | 1.3.0 | MIT | runtime |
| get-proto | 1.0.1 | MIT | runtime |
| get-stream | 5.2.0 | MIT | dev |
| glob | 7.2.3 | ISC | dev |
| global-agent | 3.0.0 | BSD-3-Clause | dev, optional |
| globalthis | 1.0.4 | MIT | dev, optional |
| gopd | 1.2.0 | MIT | runtime |
| got | 11.8.6 | MIT | dev |
| graceful-fs | 4.2.11 | ISC | dev |
| has-flag | 4.0.0 | MIT | dev |
| has-property-descriptors | 1.0.2 | MIT | dev, optional |
| has-symbols | 1.1.0 | MIT | runtime |
| has-tostringtag | 1.0.2 | MIT | dev |
| hasown | 2.0.4 | MIT | runtime |
| hast-util-is-element | 3.0.0 | MIT | dev |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | dev |
| hast-util-to-text | 4.0.2 | MIT | dev |
| hast-util-whitespace | 3.0.0 | MIT | dev |
| highlight.js | 11.11.2 | BSD-3-Clause | dev |
| highlight.js (direct) | 11.12.0 | BSD-3-Clause | dev |
| hono | 4.13.13 | MIT | runtime |
| hosted-git-info | 4.1.0 | ISC | dev |
| html-encoding-sniffer | 7.0.0 | MIT | dev |
| html-url-attributes | 3.0.1 | MIT | dev |
| http-cache-semantics | 4.3.0 | BSD-2-Clause | dev |
| http-errors | 2.0.1 | MIT | runtime |
| http-proxy-agent | 7.0.2 | MIT | dev |
| http2-wrapper | 1.0.3 | MIT | dev |
| https-proxy-agent | 7.0.6 | MIT | dev |
| iconv-lite | 0.7.3 | MIT | runtime |
| indent-string | 4.0.0 | MIT | dev |
| inflight | 1.0.6 | ISC | dev |
| inherits | 2.0.4 | ISC | runtime |
| inline-style-parser | 0.2.7 | MIT | dev |
| ip-address | 10.7.4 | MIT | runtime |
| ipaddr.js | 1.9.1 | MIT | runtime |
| is-alphabetical | 2.0.1 | MIT | dev |
| is-alphanumerical | 2.0.1 | MIT | dev |
| is-decimal | 2.0.1 | MIT | dev |
| is-fullwidth-code-point | 3.0.0 | MIT | dev |
| is-hexadecimal | 2.0.1 | MIT | dev |
| is-plain-obj | 4.1.0 | MIT | dev |
| is-potential-custom-element-name | 1.0.1 | MIT | dev |
| is-promise | 4.0.0 | MIT | runtime |
| isarray | 1.0.0 | MIT | dev |
| isbinaryfile | 4.0.10 | MIT | dev |
| isbinaryfile | 5.0.7 | MIT | dev |
| isexe | 2.0.0 | ISC | runtime |
| isexe | 3.1.5 | BlueOak-1.0.0 | dev |
| isexe | 4.0.0 | BlueOak-1.0.0 | dev |
| jake | 10.9.4 | Apache-2.0 | dev |
| jiti | 2.7.0 | MIT | dev |
| jose | 6.2.12 | MIT | runtime |
| js-tokens | 4.0.0 | MIT | dev |
| js-yaml | 4.3.2 | MIT | dev |
| jsdom (direct) | 30.1.3 | MIT | dev |
| jsesc | 3.1.0 | MIT | dev |
| json-buffer | 3.0.1 | MIT | dev |
| json-schema-to-ts | 3.1.1 | MIT | runtime |
| json-schema-traverse | 1.0.0 | MIT | runtime |
| json-schema-typed | 8.0.2 | BSD-2-Clause | runtime |
| json-stringify-safe | 5.0.1 | ISC | dev, optional |
| json5 | 2.2.3 | MIT | dev |
| jsonfile | 4.0.0 | MIT | dev |
| jsonfile | 6.2.1 | MIT | dev |
| keyv | 4.5.4 | MIT | dev |
| lazy-val | 1.0.5 | MIT | dev |
| lightningcss | 1.33.0 | MPL-2.0 | dev |
| lightningcss-android-arm64 | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-darwin-arm64 | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-darwin-x64 | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-freebsd-x64 | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-linux-arm-gnueabihf | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-linux-arm64-gnu | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-linux-arm64-musl | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-linux-x64-gnu | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-linux-x64-musl | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-win32-arm64-msvc | 1.33.0 | MPL-2.0 | dev, optional |
| lightningcss-win32-x64-msvc | 1.33.0 | MPL-2.0 | dev, optional |
| lodash | 4.18.1 | MIT | dev |
| longest-streak | 3.1.0 | MIT | dev |
| loose-envify | 1.4.0 | MIT | dev |
| lowercase-keys | 2.0.0 | MIT | dev |
| lowlight | 3.3.0 | MIT | dev |
| lru-cache | 11.5.3 | BlueOak-1.0.0 | dev |
| lru-cache | 5.1.1 | ISC | dev |
| lru-cache | 6.0.0 | ISC | dev |
| lucide-react (direct) | 1.58.0 | ISC | dev |
| lz-string | 1.5.0 | MIT | dev |
| magic-string | 1.4.3 | MIT | dev |
| markdown-table | 3.0.4 | MIT | dev |
| matcher | 3.0.0 | MIT | dev, optional |
| math-intrinsics | 1.1.0 | MIT | runtime |
| mdast-util-find-and-replace | 3.0.3 | MIT | dev |
| mdast-util-from-markdown | 2.1.0 | MIT | dev |
| mdast-util-gfm | 3.1.0 | MIT | dev |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | dev |
| mdast-util-gfm-footnote | 2.1.0 | MIT | dev |
| mdast-util-gfm-strikethrough | 2.0.1 | MIT | dev |
| mdast-util-gfm-table | 2.0.0 | MIT | dev |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | dev |
| mdast-util-mdx-expression | 2.0.1 | MIT | dev |
| mdast-util-mdx-jsx | 3.2.0 | MIT | dev |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | dev |
| mdast-util-phrasing | 4.1.0 | MIT | dev |
| mdast-util-to-hast | 13.2.1 | MIT | dev |
| mdast-util-to-markdown | 2.2.0 | MIT | dev |
| mdast-util-to-string | 4.0.0 | MIT | dev |
| mdn-data | 2.27.1 | CC0-1.0 | dev |
| media-typer | 1.1.1 | MIT | runtime |
| merge-descriptors | 2.0.0 | MIT | runtime |
| micromark | 4.0.3 | MIT | dev |
| micromark-core-commonmark | 2.0.4 | MIT | dev |
| micromark-extension-gfm | 3.0.0 | MIT | dev |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | dev |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | dev |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | dev |
| micromark-extension-gfm-table | 2.1.2 | MIT | dev |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | dev |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | dev |
| micromark-factory-destination | 2.0.1 | MIT | dev |
| micromark-factory-label | 2.0.1 | MIT | dev |
| micromark-factory-space | 2.1.0 | MIT | dev |
| micromark-factory-title | 2.0.1 | MIT | dev |
| micromark-factory-whitespace | 2.0.1 | MIT | dev |
| micromark-util-character | 2.1.1 | MIT | dev |
| micromark-util-chunked | 2.0.1 | MIT | dev |
| micromark-util-classify-character | 2.0.1 | MIT | dev |
| micromark-util-combine-extensions | 2.0.1 | MIT | dev |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | dev |
| micromark-util-decode-string | 2.0.1 | MIT | dev |
| micromark-util-edit-map | 1.0.0 | MIT | dev |
| micromark-util-encode | 2.0.1 | MIT | dev |
| micromark-util-html-tag-name | 2.0.1 | MIT | dev |
| micromark-util-normalize-identifier | 2.0.1 | MIT | dev |
| micromark-util-resolve-all | 2.0.1 | MIT | dev |
| micromark-util-sanitize-uri | 2.0.1 | MIT | dev |
| micromark-util-subtokenize | 2.1.0 | MIT | dev |
| micromark-util-symbol | 2.0.1 | MIT | dev |
| micromark-util-types | 2.0.3 | MIT | dev |
| mime | 2.6.0 | MIT | dev |
| mime-db | 1.52.0 | MIT | dev |
| mime-db | 1.54.0 | MIT | runtime |
| mime-types | 2.1.35 | MIT | dev |
| mime-types | 3.0.2 | MIT | runtime |
| mimic-response | 1.0.1 | MIT | dev |
| mimic-response | 3.1.0 | MIT | dev |
| min-indent | 1.0.1 | MIT | dev |
| minimatch | 10.2.6 | BlueOak-1.0.0 | dev |
| minimatch | 3.1.5 | ISC | dev |
| minimatch | 5.1.9 | ISC | dev |
| minimatch | 9.0.9 | ISC | dev |
| minimist | 1.2.8 | MIT | dev |
| minipass | 7.1.3 | BlueOak-1.0.0 | dev |
| minizlib | 3.1.0 | MIT | dev |
| mkdirp | 0.5.6 | MIT | dev |
| ms | 2.1.3 | MIT | runtime |
| nanoid | 3.3.20 | MIT | dev |
| negotiator | 1.1.0 | MIT | runtime |
| node-abi | 4.38.0 | MIT | dev |
| node-api-version | 0.2.1 | MIT | dev |
| node-gyp | 12.4.0 | MIT | dev |
| node-int64 | 0.4.0 | MIT | dev |
| node-releases | 2.0.59 | MIT | dev |
| nopt | 9.0.0 | ISC | dev |
| normalize-url | 6.1.0 | MIT | dev |
| object-assign | 4.1.1 | MIT | runtime |
| object-inspect | 1.13.4 | MIT | runtime |
| object-keys | 1.1.1 | MIT | dev, optional |
| obug | 3.0.0 | MIT | dev |
| on-finished | 2.4.1 | MIT | runtime |
| once | 1.4.0 | ISC | runtime |
| p-cancelable | 2.1.1 | MIT | dev |
| p-limit | 3.1.0 | MIT | dev |
| parse-entities | 4.0.2 | MIT | dev |
| parse5 | 8.0.1 | MIT | dev |
| parseurl | 1.3.3 | MIT | runtime |
| path-is-absolute | 1.0.1 | MIT | dev |
| path-key | 3.1.1 | MIT | runtime |
| path-to-regexp | 8.4.2 | MIT | runtime |
| pe-library | 0.4.1 | MIT | dev |
| picocolors | 1.1.1 | ISC | dev |
| picomatch | 4.0.7 | MIT | dev |
| pkce-challenge | 5.0.1 | MIT | runtime |
| pkijs | 3.4.1 | BSD-3-Clause | dev |
| plist | 3.1.0 | MIT | dev |
| pngjs (direct) | 7.0.0 | MIT | dev |
| postcss | 8.5.30 | MIT | dev |
| postject | 1.0.0-alpha.6 | MIT | dev, optional |
| pretty-format | 27.5.1 | MIT | dev |
| proc-log | 6.1.0 | ISC | dev |
| process-nextick-args | 2.0.1 | MIT | dev |
| progress | 2.0.3 | MIT | dev |
| promise-retry | 2.0.1 | MIT | dev |
| proper-lockfile | 4.1.2 | MIT | dev |
| property-information | 7.2.0 | MIT | dev |
| proxy-addr | 2.0.8 | MIT | runtime |
| pump | 3.0.4 | MIT | dev |
| punycode | 2.3.1 | MIT | dev |
| pvtsutils | 1.3.6 | MIT | dev |
| pvutils | 1.2.0 | MIT | dev |
| qs | 6.16.1 | BSD-3-Clause | runtime |
| quick-lru | 5.1.1 | MIT | dev |
| range-parser | 1.3.0 | MIT | runtime |
| raw-body | 3.0.2 | MIT | runtime |
| react (direct) | 18.3.1 | MIT | dev |
| react-dom (direct) | 18.3.1 | MIT | dev |
| react-is | 17.0.2 | MIT | dev |
| react-markdown (direct) | 10.1.0 | MIT | dev |
| read-binary-file-arch | 1.0.6 | MIT | dev |
| readable-stream | 2.3.8 | MIT | dev |
| redent | 3.0.0 | MIT | dev |
| rehype-highlight (direct) | 7.0.2 | MIT | dev |
| remark-gfm (direct) | 4.0.1 | MIT | dev |
| remark-parse | 11.0.0 | MIT | dev |
| remark-rehype | 11.1.2 | MIT | dev |
| remark-stringify | 11.0.0 | MIT | dev |
| require-directory | 2.1.1 | MIT | dev |
| require-from-string | 2.0.2 | MIT | runtime |
| resedit | 1.7.2 | MIT | dev |
| resolve-alpn | 1.2.1 | MIT | dev |
| responselike | 2.0.1 | MIT | dev |
| retry | 0.12.0 | MIT | dev |
| rimraf | 2.6.3 | ISC | dev |
| roarr | 2.15.4 | BSD-3-Clause | dev, optional |
| rolldown | 1.2.14 | MIT | dev |
| router | 2.2.0 | MIT | runtime |
| safe-buffer | 5.1.2 | MIT | dev |
| safer-buffer | 2.1.2 | MIT | runtime |
| sanitize-filename | 1.6.4 | WTFPL OR ISC | dev |
| sax | 1.6.1 | BlueOak-1.0.0 | dev |
| saxes | 6.0.0 | ISC | dev |
| scheduler | 0.23.2 | MIT | dev |
| semver | 5.7.2 | ISC | dev |
| semver | 6.3.1 | ISC | dev |
| semver | 7.7.4 | ISC | dev |
| semver | 7.8.5 | ISC | dev |
| semver-compare | 1.0.0 | MIT | dev, optional |
| send | 1.2.1 | MIT | runtime |
| serialize-error | 7.0.1 | MIT | dev, optional |
| serve-static | 2.2.1 | MIT | runtime |
| setprototypeof | 1.2.0 | ISC | runtime |
| shebang-command | 2.0.0 | MIT | runtime |
| shebang-regex | 3.0.0 | MIT | runtime |
| side-channel | 1.1.1 | MIT | runtime |
| side-channel-list | 1.0.1 | MIT | runtime |
| side-channel-map | 1.0.1 | MIT | runtime |
| side-channel-weakmap | 1.0.2 | MIT | runtime |
| signal-exit | 3.0.7 | ISC | dev |
| simple-update-notifier | 2.0.0 | MIT | dev |
| source-map | 0.6.1 | BSD-3-Clause | dev |
| source-map-js | 1.2.2 | BSD-3-Clause | dev |
| source-map-support | 0.5.21 | MIT | dev |
| space-separated-tokens | 2.0.2 | MIT | dev |
| sprintf-js | 1.1.3 | BSD-3-Clause | dev, optional |
| standardwebhooks | 1.1.1 | MIT | runtime |
| stat-mode | 1.0.0 | MIT | dev |
| statuses | 2.0.2 | MIT | runtime |
| std-env | 4.3.0 | MIT | dev |
| string-width | 4.2.3 | MIT | dev |
| string_decoder | 1.1.1 | MIT | dev |
| stringify-entities | 4.0.4 | MIT | dev |
| strip-ansi | 6.0.1 | MIT | dev |
| strip-indent | 3.0.0 | MIT | dev |
| style-to-js | 1.1.21 | MIT | dev |
| style-to-object | 1.0.14 | MIT | dev |
| sumchecker | 3.0.1 | Apache-2.0 | dev |
| supports-color | 7.2.0 | MIT | dev |
| tar | 7.5.22 | BlueOak-1.0.0 | dev |
| temp | 0.9.4 | MIT | dev |
| temp-file | 3.4.0 | MIT | dev |
| tiny-async-pool | 1.3.0 | MIT | dev |
| tinybench | 6.2.2 | MIT | dev |
| tinyexec | 1.3.1 | MIT | dev |
| tinyglobby | 0.2.17 | MIT | dev |
| tldts | 7.4.18 | MIT | dev |
| tldts-core | 7.4.18 | MIT | dev |
| tmp | 0.2.7 | MIT | dev |
| tmp-promise | 3.0.3 | MIT | dev |
| toidentifier | 1.0.1 | MIT | runtime |
| tough-cookie | 6.0.2 | BSD-3-Clause | dev |
| tr46 | 7.0.0 | MIT | dev |
| trim-lines | 3.0.1 | MIT | dev |
| trough | 2.2.0 | MIT | dev |
| truncate-utf8-bytes | 1.0.2 | WTFPL | dev |
| ts-algebra | 2.0.0 | MIT | runtime |
| tslib | 2.8.1 | 0BSD | dev |
| type-fest | 0.13.1 | (MIT OR CC0-1.0) | dev, optional |
| type-is | 2.1.0 | MIT | runtime |
| typescript (direct) | 7.0.2 | Apache-2.0 | dev |
| undici | 6.29.1 | MIT | dev |
| undici | 7.30.1 | MIT | dev, optional |
| undici | 8.12.2 | MIT | dev |
| undici-types | 7.24.6 | MIT | dev |
| unified | 11.0.5 | MIT | dev |
| unist-util-find-after | 5.0.0 | MIT | dev |
| unist-util-is | 6.0.1 | MIT | dev |
| unist-util-position | 5.0.0 | MIT | dev |
| unist-util-stringify-position | 4.0.0 | MIT | dev |
| unist-util-visit | 5.1.0 | MIT | dev |
| unist-util-visit-parents | 6.0.2 | MIT | dev |
| universalify | 0.1.2 | MIT | dev |
| universalify | 2.0.1 | MIT | dev |
| unpipe | 1.0.0 | MIT | runtime |
| unzipper | 0.12.5 | MIT | dev |
| update-browserslist-db | 1.3.4 | MIT | dev |
| utf8-byte-length | 1.0.5 | (WTFPL OR MIT) | dev |
| util-deprecate | 1.0.2 | MIT | dev |
| vary | 1.1.2 | MIT | runtime |
| vfile | 6.0.3 | MIT | dev |
| vfile-message | 4.0.3 | MIT | dev |
| vite (direct) | 8.3.4 | MIT | dev |
| vitest (direct) | 5.0.5 | MIT | dev |
| w3c-xmlserializer | 6.0.0 | MIT | dev |
| webcrypto-core | 1.9.2 | MIT | dev |
| webidl-conversions | 8.0.1 | BSD-2-Clause | dev |
| whatwg-mimetype | 5.0.0 | MIT | dev |
| whatwg-url | 17.3.0 | MIT | dev |
| which | 2.0.2 | ISC | runtime |
| which | 5.0.0 | ISC | dev |
| which | 6.0.1 | ISC | dev |
| why-is-node-running | 3.2.1 | MIT | dev |
| wrap-ansi | 7.0.0 | MIT | dev |
| wrappy | 1.0.2 | ISC | runtime |
| xml-name-validator | 5.0.0 | Apache-2.0 | dev |
| xmlbuilder | 15.1.1 | MIT | dev |
| xmlchars | 2.2.0 | MIT | dev |
| y18n | 5.0.8 | ISC | dev |
| yallist | 3.1.1 | ISC | dev |
| yallist | 4.0.0 | ISC | dev |
| yallist | 5.0.0 | BlueOak-1.0.0 | dev |
| yargs | 17.7.3 | MIT | dev |
| yargs-parser | 21.1.1 | ISC | dev |
| yocto-queue | 0.1.0 | MIT | dev |
| zod (direct) | 4.6.7 | MIT | runtime |
| zod-to-json-schema | 3.25.2 | ISC | runtime |
| zwitch | 2.0.4 | MIT | dev |
