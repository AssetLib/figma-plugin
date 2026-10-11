# AGENTS.md

Public repository `AssetLib/figma-plugin`: Assetlib for Figma. A Figma design plugin that inserts an app's placement artwork as image-filled components and library images as image-filled frames, sends one selected node to an Assetlib placement as a draft, then re-syncs that node's later edits. It calls the hosted console's placements, artwork, image library, rendition, and drafts endpoints with an app-scoped `draft` token. Publishing stays in the console; this plugin never publishes. TypeScript, bundled with esbuild, no runtime dependencies. See README for install, connection, and data handling.

## Commands

Node.js 22 or later (`engines` in `package.json`).

```sh
npm ci
npm run typecheck   # tsc for the main thread (tsconfig.json) and the UI (tsconfig.ui.json); no emit
npm test            # scripts/test.mjs: compiles src/shared to .test-build/, then node --test tests/*.test.mjs
npm run build       # scripts/build.mjs: dist/code.js and a self-contained dist/ui.html
npm run verify      # typecheck, test, build
npm run e2e:local -- --connection <file>   # live local console; not part of npm test (README "Development and verification")
```

There is no CI and no lint script. `npm run verify` must pass before work is done. It cannot exercise real Figma exports, client storage across restarts, console CORS, or authenticated draft and rebind behavior. `npm run e2e:local` covers the authenticated reads, inserts, the draft round trip, and CORS preflights against a local console, still without real Figma; a change touching Figma behavior also needs a manual run in Figma desktop against a console (README "Development and verification").

## Layout

- `manifest.json`: Figma manifest. Plugin `id`, `main: dist/code.js`, `ui: dist/ui.html`, `documentAccess: "dynamic-page"`, network allowlist.
- `src/code.ts`: main thread in Figma's sandbox. Selection, `exportAsync`, inserting image components for placement art and frames for library images (`createImage`, `createComponent`, `createFrame`, pluginData), `figma.clientStorage`. No DOM and no HTTP here.
- `src/ui.ts`, `src/ui.html`: UI iframe and every HTTP call, with the Send and Insert tabs. `ui.html` must contain exactly one `<!-- ASSETLIB_SCRIPT -->` marker; the build inlines the bundled UI script there. `src/image.ts` is browser-only (WebP to PNG through a canvas) and is imported by `ui.ts` only.
- `src/shared/`: pure logic used by both sides (origin and connection validation, placement parsing, export settings, PNG header check, draft body and response parsing, error text, and in `library.ts` the artwork, image page, rendition choice, layer name, insert link, and preference rules, and in `marker.ts` the placement marker). It must run in the sandbox too, so avoid browser-only globals such as `URL`. `protocol.ts` defines the main and UI messages.
- `tests/shared.test.mjs` covers the compiled shared modules and checks that `manifest.json` and the origin picker list the same origins as `connection.ts`. `tests/plugin.test.mjs` bundles `code.ts` and `ui.ts` with esbuild and runs them in `node:vm` with the fake `figma`, DOM, console, and `fetch` from `tests/fakes.mjs` (not a test file itself). `scripts/e2e-local.mjs` reuses those fakes with Node's real `fetch` against a running local console.
- `dist/`, `.test-build/`, and `graft/` are generated and gitignored. Don't edit or commit them.
- `WORKSTREAM-G-REPORT.md` is a historical implementation report, not instructions.

## Invariants

- **Read and draft only.** Under `/api/apps/{orgId}/{appId}/` the plugin calls `GET placements`, `GET placements/artwork`, `GET assets`, `GET assets/{assetId}/renditions/{sha256}`, and `POST drafts`, nothing else. Insert and Send both require a token with the `draft` scope. Never add a publish, release, or restore call, never ask for a broader scope, never call the public delivery routes, and never accept a Figma token in its place.
- **Rendition URLs are built from validated ids, never taken from a response.** `renditionUrl` takes a uuid asset id and a 64-hex sha256; the `url` field the console sends is ignored. The bearer token must never go to a URL that came from a response body.
- **Inserted frames carry pluginData `assetlib.link.v1` without the token.** It names the origin, organization, app, cell, environment, asset, and the frame's own node id. `reportSelection` uses it only when no client storage target exists, and only when its node id equals the selected node's id (a Cmd+D copy keeps the data with another id) and the origin (legacy host mapped to production), organization, and app match the connection. A Sync of a linked frame binds exactly the cell it was inserted from; the draft wire shape is unchanged.
- **Placement art is a component carrying a marker.** An insert from a placement creates a component; a library image stays a frame. Either takes layers inside without changing its node id. `placementMarker` writes the component's `description` (the key, the declared size, and an instruction to use the generated accessor instead of exporting the image) and one `documentationLinks` entry, `{origin}/w/{orgId}/{appId}/placements` from validated IDs (legacy host mapped to production). Figma's MCP server returns both to coding agents in `get_design_context`, and returns neither shared nor private plugin data (tested live on October 11, 2026). Anyone with the file reads them, so never put the token, or anything beyond the key, size, and console link, in either. A documentation link Figma refuses is skipped; the insert still succeeds.
- **The `inserted` message carries `connectionGeneration`**, and the UI ignores one that does not match its pending insert. Main rejects an `insert` whose `connectionGeneration` is not current, and the UI drops a download that finishes after a connection change.
- **The `importing` and `exporting` guards are mutually exclusive:** main refuses an insert during an export and an export during an insert.
- **Placements are read, not created.** Placements are declared in the app's repository and synced to the console. The plugin lists them and binds to declared cells (state, appearance, arm). Don't add placement creation or editing.
- **Plugin id.** `manifest.json` carries the Figma-assigned `id`. Without one the plugin loads, but client storage fails with "Cannot access client storage without a plugin ID". Saved connections and sync targets are scoped to that id, so don't remove or change it. If you substitute your own development id (README "Install as a development plugin"), don't commit it.
- **`documentAccess: "dynamic-page"`** is required. Use the async document APIs (for example `figma.getNodeByIdAsync`); the synchronous variants throw under it.
- **Allowed origins** are production `https://console.assetlib.dev` and development `http://localhost:3100`; only these two can be chosen for a connection. They are set in `manifest.json` (`allowedDomains`, `devAllowedDomains`), `src/shared/connection.ts` (`PRODUCTION_ORIGIN`, `DEVELOPMENT_ORIGIN`), the origin `<select>` in `src/ui.html`, both test files, and README. Change them together. Figma rejects IP-literal development domains, so use `localhost`, never `127.0.0.1`. `devAllowedDomains` is not available to a published plugin. Local development needs the console server on port 3100.
- **Legacy production host.** `https://assetlib-console.vercel.app` (`LEGACY_PRODUCTION_ORIGIN`) was the production origin before October 9, 2026. The console still accepts app tokens there, never redirects it, and rejects sign-in and the console's own session API there. `loadSavedConnection` moves a saved connection on that host to `PRODUCTION_ORIGIN` with the same token and `code.ts` saves it back; `reportSelection` still reads sync targets keyed by the legacy origin. It stays in `allowedDomains` so a `dist/` built before the move keeps working. Don't offer it for new connections, don't drop that load path, and don't link people to it.
- **UI message guard.** Figma posts plugin messages from its top window, not from the iframe's direct parent, so `window.onmessage` in `src/ui.ts` accepts `event.source` of `parent` or `top`. Narrowing it to `parent` drops every message and the UI stays on "Saving connection…".
- **Connection generation.** Every `connection` and `selection` message carries `connectionGeneration`. The UI ignores selection replies from an older generation, and saving a connection clears the remembered binding, so a slow storage read cannot rebind another app's artwork. Any new main-to-UI message that depends on the connection needs the same check. `tests/plugin.test.mjs` covers app switches and token rotation.
- **Export bounds and limits.** `chooseExportSettings` exports PNG with `useAbsoluteBounds: true`, constrained to the placement's width, or its height when the node is proportionally taller. `buildDraftBody` rejects settings that no longer match the node and placement. Before upload the UI reads the PNG IHDR and stops if the aspect ratio differs from the placement by more than 2%. Size limits are 4 MiB decoded PNG (`MAX_IMAGE_BYTES`) and a 4,500,000-byte JSON body (`MAX_BODY_BYTES`), Vercel's request limit, so a base64 PNG above about 3.3 MB decoded does not fit.
- **Wire shapes.** `DraftBody` (`schemaVersion: 1`) and the placements, artwork, image page, and draft responses in `src/shared/types.ts` match the hosted console's API. Change them only together with the console.
- **HTTP 409** on a draft can still mean the asset was created. Keep showing the partial result and the console's message.
- **Token handling.** The token goes only as a bearer header to the chosen origin, with `credentials: 'omit'` and `redirect: 'error'`. Never log it, put it in a URL, or display more than `tokenPrefix()`.
- **Storage keys** `assetlib.connection.v1`, `assetlib.file-url.v1`, `assetlib.target.v1:…`, and `assetlib.preferences.v1` (tab, browse mode, environment, scale) hold users' saved state in client storage. Renaming them silently drops saved connections, sync targets, and preferences. Stored sync targets keep their original shape; `insertedFrom` is derived from a link, never stored.

## Dependencies and versions

Dev dependencies are exact pins: `@figma/plugin-typings` 1.117.0, `typescript` 5.9.3, `esbuild` 0.25.12. README records why each version was chosen; keep pins exact and update that table when one changes. Every lockfile entry has its registry `resolved` URL and `integrity` hash; keep it that way so `npm ci` verifies each package.

`package.json` is `private` at version 0.1.0 and nothing else reads that version. The plugin runs as a Figma development plugin and is not published to the Figma Community (as of 2026-10-09). There are no release tags. Ask the maintainer before any publication step.

## Writing rules

- The product is "Assetlib" in prose and UI copy. `AssetLib` is only the GitHub org slug.
- UI and error text is plain and says what to do next (see `src/shared/errors.ts`). No overstated claims such as "instantly". No emojis.

## Don'ts

- Don't add a publish or release path, or any network origin beyond the production, legacy production, and development origins above.
- Don't send anything beyond what README "Data and network access" lists. Never send the Figma document or a Figma token.
- Don't commit `dist/`, `.test-build/`, `graft/`, or a changed plugin id.
- Fix a confirmed defect you find in the same change, with a test. Defer only when a fix is unsafe now, and say when it will happen.
