# Assetlib for Figma

Send one selected Figma node to an Assetlib placement as a draft, then sync that node's later edits. Sending and syncing update drafts; publishing remains a separate action in the Assetlib console.

## Install as a development plugin

Use Node.js 22 or newer and the Figma desktop app.

```sh
npm ci
npm run verify
```

The build creates `dist/code.js` and a self-contained `dist/ui.html`. Both outputs must exist before importing the plugin.

1. In Figma desktop, open a design file and select **Plugins → Development → New plugin**. Choose **Figma design** and **Custom UI**, name it **Assetlib**, and save the generated starter in a separate temporary folder.
2. Copy the Figma-assigned `id` from that starter's `manifest.json` into this repository's `manifest.json` as a top-level string. This repository does not invent a published plugin ID. Importing a manifest without an `id` appears to succeed, but the plugin then cannot save its connection: Figma reports `Cannot access client storage without a plugin ID`. Keep your assigned ID stable: local connection and sync storage is scoped to the plugin ID.
3. Select **Plugins → Development → Import plugin from manifest…** and choose this repository's `manifest.json`. If Figma already lists the temporary starter under the same ID, remove that development entry before importing this manifest; retain the assigned ID.
4. Run **Plugins → Development → Assetlib**. Rebuild after source changes; use Figma's development hot reload or reopen the plugin.

See Figma's [development plugin instructions](https://help.figma.com/hc/en-us/articles/360042786733-Create-a-classic-plugin-for-development), [manifest reference](https://developers.figma.com/docs/plugins/manifest/), and [client storage reference](https://developers.figma.com/docs/plugins/api/figma-clientStorage/). The manifest uses Plugin API `1.0.0` and the required `documentAccess: "dynamic-page"`; it does not request private APIs.

## Connect

Create an **app-scoped API token with the `draft` scope** in the Assetlib console's **Tokens** panel. A Figma access token is neither needed nor accepted as a substitute.

In the plugin's connection settings, enter the console origin, organization ID, app ID, and draft token. The default origin is `https://assetlib-console.vercel.app`. Development also supports exactly `http://localhost:3100`; Figma rejects IP-literal development domains such as `http://127.0.0.1:3100`, and the console accepts the `localhost` host for token routes in local mode. Other origins are rejected. Choose **Test connection** to save the settings, call the placements endpoint, and load the available placements.

Settings and the token are saved through `figma.clientStorage` on this device. The password field is cleared after saving, and only a short prefix is displayed afterward. The plugin does not log the token. Figma client storage is local plugin storage, not an encrypted credential vault; clearing it or changing the plugin ID loses the connection and remembered sync destinations.

When `figma.fileKey` is available, the plugin uses it. Availability depends on the plugin's publication state. Otherwise the plugin asks for the current file URL and parses the key from `https://www.figma.com/file/<key>/…` or `https://www.figma.com/design/<key>/…`. It remembers the URL as a suggestion and asks for confirmation once each time the plugin opens in this fallback mode: node IDs alone cannot safely identify a file across documents. Use the URL of the currently open file.

## Send artwork

1. Select exactly one exportable node. The plugin shows its name, ID, type, width, and height, or explains why the selection cannot be sent.
2. Choose a placement. State, appearance, and arm choices are limited to what that placement declares. **Any** appearance and **Control** arm map to `null` in the API. Omitting a state uses the placement's declared default state; an explicit state must be declared.
3. Review any aspect-ratio warning, then choose **Send to draft**. The plugin warns when the selected node's ratio differs from the placement by more than 2%.
4. Read the result: created asset dimensions, binding success or the console's binding error, and a link back to the console.

Exports are PNG. The plugin chooses the placement's width as the export constraint, or the placement's height when the node is proportionally taller, as required by the Phase 3 contract. Figma preserves the node's aspect ratio; the plugin does not crop or stretch it. Match the node's aspect ratio to the placement when you need exact canvas dimensions.

If a binding fails with HTTP 409, the console may still have created the asset. The plugin shows that partial result and the console's message; check the console before retrying to avoid unnecessary duplicate assets. A send does not publish a release.

## Sync later edits

After the console creates an asset successfully, the plugin remembers the file key, node ID, placement, state, appearance, and arm for that node and connection. Select the same node again to see **Sync to &lt;placement&gt;**. Sync re-exports the node, sends its remembered binding, and sets `rebind: true`.

The console replaces references to the previous asset from that same file and node in draft cells and states within the connected app. The result lists what was rebound. Sync can therefore update several draft destinations that already reference that source. If the remembered placement or cell options no longer exist, refresh the placements and choose a current destination before sending again.

## Data and network access

The plugin sends only the selected node's exported PNG bytes (base64 in JSON), node ID and name, file key, PNG export settings, chosen placement coordinates, asset name, schema version, and sync flag. `source.versionId` is `null`. The app-scoped draft token is sent as a bearer token to the chosen console origin.

It never sends the Figma document, unrelated layers, or a Figma token. Selecting a frame or group exports its visible contents as one PNG; it does not upload its editable layer tree.

The manifest declares:

```json
{
  "allowedDomains": ["https://assetlib-console.vercel.app"],
  "devAllowedDomains": ["http://localhost:3100"],
  "reasoning": "Sends exported artwork to the Assetlib console you connect."
}
```

Requests use `GET /api/apps/{orgId}/{appId}/placements` and `POST /api/apps/{orgId}/{appId}/drafts`. The placements endpoint accepts `draft` or `declare`; sending requires `draft`. The console must implement the Phase 3 draft/placements contract and allow requests from the Figma plugin UI. Local development requires that console server to be running on port 3100. The development-only origin is not available to a published plugin.

HTTP 401/403 messages explain the token or scope; HTTP 409 preserves the console's message; HTTP 413 suggests reducing the export constraint; network failures name the origin that was called. The shared contract allows at most 4 MiB decoded PNG bytes and 6 MiB for the JSON body.

## Development and verification

There are no runtime dependencies. The only devDependencies are exact pins:

| Package | Version | Age evidence checked for October 8, 2026 |
| --- | --- | --- |
| `@figma/plugin-typings` | `1.117.0` | npm registry `time` metadata: `2025-08-13T21:50:04.952Z`; [registry metadata](https://registry.npmjs.org/@figma/plugin-typings). [Figma's matching release tag](https://github.com/figma/plugin-typings/tree/v1.117.0) is dated `2025-08-13T21:46:41Z`. |
| `typescript` | `5.9.3` | npm registry `time` metadata: `2025-09-30T21:19:38.784Z`; [registry metadata](https://registry.npmjs.org/typescript). |
| `esbuild` | `0.25.12` | npm registry `time` metadata: `2025-11-01T23:36:22.605Z`; [registry metadata](https://registry.npmjs.org/esbuild). |

All three releases predate the September 24, 2026 cutoff by more than two weeks.

Every lockfile entry records the registry `resolved` URL and `integrity` hash, so `npm ci` fetches exactly these versions and verifies each tarball. The `@figma/plugin-typings` entry was refreshed from the registry on October 9, 2026; its hash matches the registry's published `dist.integrity` for 1.117.0.

```sh
npm run typecheck # Figma main-thread types; separate browser UI types
npm test          # Compile shared modules, then run Node's built-in test runner
npm run build     # Bundle main and inline the UI script
npm run verify    # Typecheck, tests, and build
```

`src/code.ts` handles selection, Figma exports, and client storage. `src/ui.ts` and `src/ui.html` provide the interface and HTTP calls. `src/shared/` holds pure request, picker, export, file-key, and error logic. Tests under `tests/` exercise the compiled shared logic with `node --test`; they do not execute the Figma main thread or UI.

Known limits: one node at a time; PNG only; no OAuth; no document-wide sync; no automatic release publication; local-device settings and sync history. Actual Figma exports, client storage across restarts, console CORS, and authenticated draft/rebind behavior require a manual Figma-and-console integration check in addition to the local verification command.

## License

[MIT](LICENSE), copyright 2026 Assetlib contributors.
