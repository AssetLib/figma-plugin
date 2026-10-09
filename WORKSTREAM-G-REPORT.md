# Workstream G implementation report

Historical record of the plugin's first implementation, kept unchanged apart from local paths. Its open items in section 4 have since been closed: `manifest.json` carries the Figma-assigned plugin ID, the lockfile records the registry `resolved` URL and `integrity` hash for every package, `npm ci && npm run verify` passes, and the plugin was checked live in Figma desktop. README describes the current behavior.

## 1. Files added and changed, migrations added

Changed: `README.md`.

Added:

- `manifest.json`, `package.json`, `package-lock.json`, `.gitignore`, `LICENSE`.
- `tsconfig.base.json`, `tsconfig.json`, `tsconfig.ui.json`, `tsconfig.test.json`.
- `scripts/build.mjs`, `scripts/test.mjs`.
- `src/code.ts`, `src/ui.ts`, `src/ui.html`.
- `src/shared/types.ts`, `validation.ts`, `placements.ts`, `export.ts`, `connection.ts`, `errors.ts`, `drafts.ts`, `index.ts`, `protocol.ts`.
- `tests/shared.test.mjs` and this report.

Generated ignored outputs: `dist/code.js`, `dist/ui.html`, and compiled test modules in `.test-build/`.

No migrations. No commits, stashes, or discarding changes. The pre-existing untracked `graft/` directory was left untouched. Work remains on `main`.

Implemented: connection storage and token-prefix display; placement lookup; single-node selection and URL fallback; PNG export and aspect warning; declared state/appearance/arm pickers; draft upload and 409 partial-success results; app/file/node-scoped sync destinations and rebind results; bounded payloads and actionable errors. Geometry changes between the displayed selection and export stop the send so its aspect warning can be reviewed.

## 2. Exact verification output, including failures

Required command: `npm ci && npm run verify` — exit 1. Environment overrides only directed the npm cache to a writable temporary directory and disabled fetch retries with a 15-second fetch timeout. The second command did not execute because install failed.

```text
npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error errno ENOTFOUND
npm error network request to https://registry.npmjs.org/@figma%2fplugin-typings failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
npm error network This is a problem related to network connectivity.
npm error network In most cases you are behind a proxy or have bad network settings.
npm error network
npm error network If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'
npm error A complete log of this run can be found in: <npm cache>/_logs/2026-10-09T01_47_15_416Z-debug-0.log
```

A separate `npm run verify` before locally supplying the dependencies exited 2:

```text

> @assetlib/figma-plugin@0.1.0 verify
> npm run typecheck && npm test && npm run build


> @assetlib/figma-plugin@0.1.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json

error TS2688: Cannot find type definition file for '@figma/plugin-typings'.
  The file is in the program because:
    Entry point of type library '@figma/plugin-typings' specified in compilerOptions
```

The initial online lockfile-only attempt also exited 1 because npm could not resolve the registry. A lockfile was then produced from cached TypeScript/esbuild registry metadata and the independently verified Figma version entry. The successful command was:

`npm install --package-lock-only --ignore-scripts --offline --cache <npm cache>`

Exact output (exit 0):

```text

up to date, audited 5 packages in 96ms

found 0 vulnerabilities
```

The Figma lock entry contains the exact version but lacks registry resolution/integrity metadata. This is recorded in the README; no integrity value was invented.

To verify the source without claiming a successful npm installation, cached TypeScript 5.9.3 and esbuild 0.25.12 were installed in a temporary directory outside the repository. The complete required Figma declarations and package metadata were obtained unchanged from the official [v1.117.0 release tag](https://github.com/figma/plugin-typings/tree/v1.117.0), whose tag points to commit `05ef5e70867630ddda390c30c901090bdfaf3b01`, and stored in another temporary directory. Their Git blob hashes were checked against the retrieved originals. Ignored local `node_modules` symlinks expose these exact versions to the normal repository scripts. These temporary links are local verification aids, not an npm-registry installation or files to distribute.

With those exact local dependencies, `npm run verify` exited 0:

```text

> @assetlib/figma-plugin@0.1.0 verify
> npm run typecheck && npm test && npm run build


> @assetlib/figma-plugin@0.1.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json


> @assetlib/figma-plugin@0.1.0 test
> node scripts/test.mjs

✔ file URL fallback accepts both file and design links and excludes non-Figma URLs (0.595709ms)
✔ connection origin is limited to the two manifest origins (0.287958ms)
✔ placements parse stateless and stateful picker data without importing bindings (0.511833ms)
✔ placements reject malformed response shapes, states, dimensions, and duplicate keys (0.126458ms)
✔ arm validation enforces all contract restrictions and rejects unknown axes (0.166625ms)
✔ binding permits only declared cells, with null for control/any/default (0.1525ms)
✔ export constraint follows G1: HEIGHT for taller nodes, WIDTH otherwise (0.111625ms)
✔ aspect warning is relative to the placement aspect and uses a two percent threshold (0.059042ms)
✔ base64 is browser-portable and matches Node for all remainder lengths (1.580917ms)
✔ draft body contains only the source export and chosen binding contract (0.494625ms)
✔ decoded upload and UTF-8 JSON body limits are bounded independently (104.785958ms)
✔ successful draft results retain returned dimensions and remembered source details (0.329333ms)
✔ 409 binding failure remains a created draft with the console error and any rebindings (0.108917ms)
✔ errors explain token scopes, payload size, console conflicts, and the called origin (0.121542ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 161.402834

> @assetlib/figma-plugin@0.1.0 build
> node scripts/build.mjs

Built dist/code.js and dist/ui.html.
```

This run typechecked the main entry with the genuine pinned Figma typings and the UI with DOM typings, compiled and ran all 14 pure-module tests, and built both output files. Neither the Figma main entry nor UI entry was executed as a test.

Additional checks: `git diff --check`, `node --check dist/code.js`, and `node --check` on the extracted inline UI script each exited 0 with no output. A structural assertion checked one inline script, no unresolved template marker/external script, the exact network declaration, and absence of private-API enablement; it exited 0 with this output:

```text
Built UI has one inline script; manifest network declaration matches G1.
```

During development, UI checking caught `TS18047: 'connection' is possibly 'null'`; the nullable access was corrected before the successful run above. An earlier attempt to use the installed Figma tool's standalone reference declarations was abandoned because those tool-specific declarations omit plugin UI/storage APIs. They were not substituted for the pinned Figma plugin package in the passing verification.

## 3. Deviations from the spec and why

- The fallback file URL is stored, but must be confirmed once per plugin session when `figma.fileKey` is unavailable. Client storage alone cannot safely distinguish Figma documents with colliding node IDs. This interprets “ask once” as once per session, avoiding accidental cross-file source/rebind attribution without changing the document.
- The exact prescribed `HEIGHT`-for-taller / `WIDTH`-otherwise export rule is implemented. For mismatched aspect ratios that rule fits within the placement dimensions; it does not guarantee the specification's stated “covers the canvas” outcome. The UI warns above 2%, and the README makes no crop/stretch/cover guarantee.
- Added `documentAccess: "dynamic-page"` for the current Figma manifest. A Figma-assigned plugin ID must be added using the README's development setup; a published identity was not fabricated. No private API is enabled.
- Registry access prevented a clean npm installation and a complete Figma registry-integrity lock entry. The exact-source local verification above is explicitly separate from `npm ci`.

## 4. Anything left unfinished

- On a network-enabled machine, refresh the missing registry metadata with `npm install --package-lock-only --ignore-scripts`, then run `npm ci && npm run verify`. The required clean-install sequence has not passed in this environment.
- Register a development plugin to obtain its stable Figma ID, add that ID to the manifest, and import it as documented.
- Actual Figma export/storage behavior, authenticated requests/CORS to a running Phase 3 console, and draft/rebind behavior require a live integration check. Those surfaces were not exercised; no deployment, publication, console migration, or external draft was performed.

Implementation of Workstream G is complete within this repository; the remaining items are installation metadata and live integration verification.
