# Assetlib for Figma

Insert your app's placement artwork and library images into Figma, send one selected Figma node to an Assetlib placement as a draft, then sync that node's later edits. Inserting only reads; sending and syncing update drafts; publishing remains a separate action in the Assetlib console.

## Install as a development plugin

Use Node.js 22 or newer and the Figma desktop app.

```sh
npm ci
npm run verify
```

The build creates `dist/code.js` and a self-contained `dist/ui.html`. Both outputs must exist before importing the plugin.

1. In Figma desktop, open a design file, select **Plugins → Development → Import plugin from manifest…**, and choose this repository's `manifest.json`.
2. Run **Plugins → Development → Assetlib**. Rebuild after source changes; use Figma's development hot reload or reopen the plugin.

`manifest.json` commits the plugin `id` `1690264758934826227`, which Figma assigned when this plugin was created as a development plugin. The plugin is not published to the Figma Community. Figma scopes client storage to the plugin ID, so saved connections and sync destinations belong to that ID; don't change it in the repository. A manifest without an `id` imports, but the plugin then cannot save its connection: Figma reports `Cannot access client storage without a plugin ID`.

To use a development ID of your own instead: select **Plugins → Development → New plugin**, choose **Figma design** and **Custom UI**, save the generated starter in a separate temporary folder, and copy its `id` into your local `manifest.json` before importing. If Figma lists that starter under the same ID, remove its development entry first. Don't commit your ID. Client storage under a different ID starts empty, so connections and sync destinations saved under the other ID don't carry over.

See Figma's [development plugin instructions](https://help.figma.com/hc/en-us/articles/360042786733-Create-a-classic-plugin-for-development), [manifest reference](https://developers.figma.com/docs/plugins/manifest/), and [client storage reference](https://developers.figma.com/docs/plugins/api/figma-clientStorage/). The manifest uses Plugin API `1.0.0` and the required `documentAccess: "dynamic-page"`; it does not request private APIs.

## Connect

Create an **app-scoped API token with the `draft` scope** in the **Tokens** panel of the [Assetlib console](https://console.assetlib.dev). A Figma access token is neither needed nor accepted as a substitute. A draft token can read every image in its app, as well as update draft placement bindings; treat it accordingly.

In the plugin's connection settings, enter the console origin, organization ID, app ID, and draft token. The default origin is `https://console.assetlib.dev`. Development also supports exactly `http://localhost:3100`; Figma rejects IP-literal development domains such as `http://127.0.0.1:3100`, and the console accepts the `localhost` host for token routes in local mode. Other origins are rejected. Choose **Test connection** to save the settings, call the placements endpoint, and load the available placements.

Connections saved by earlier builds may name the console's previous host, `https://assetlib-console.vercel.app`. The plugin loads such a connection on `https://console.assetlib.dev` with the same token and saves the change, and sync destinations remembered under the previous host still apply. The console still accepts app tokens on the previous host, and the manifest keeps it allowed so an unrebuilt `dist/` keeps working. New connections cannot choose it.

Settings and the token are saved through `figma.clientStorage` on this device. The password field is cleared after saving, and only a short prefix is displayed afterward. The plugin does not log the token. Figma client storage is local plugin storage, not an encrypted credential vault; clearing it or changing the plugin ID loses the connection and remembered sync destinations.

When `figma.fileKey` is available, the plugin uses it. Availability depends on the plugin's publication state. Otherwise the plugin asks for the current file URL and parses the key from `https://www.figma.com/file/<key>/…` or `https://www.figma.com/design/<key>/…`. It remembers the URL as a suggestion and asks for confirmation once each time the plugin opens in this fallback mode: node IDs alone cannot safely identify a file across documents. Use the URL of the currently open file.

## Insert artwork

The **Insert** tab brings the app's artwork into the current page. Choose **Placements** or **Images**:

- **Placements** lists the app's placements, grouped by screen, with the art each one shows. Pick an environment: **Draft** (the default, and what Send and Sync change), **Staging**, or **Production**; an environment with nothing published yet cannot be chosen. A row with no art is tagged **Not set**, one whose image the console did not return **Unavailable**, and one whose image has no prepared versions **Re-upload needed**. In Draft, a row whose base art differs from production is tagged **Differs from production**, or **Not in production** when production has no art for it. Select a row, then choose its state, appearance, and arm when the placement declares them. A cell without its own art shows the art it inherits (for example **Inherits Control · Any**), as the app would.
- **Images** lists every active image in the app, newest first, with search by name and **Load more**.

Choose **Insert**. The image arrives as a frame with an image fill, centered in the current view and selected. Placement inserts are named after the placement and cell (for example `onboarding.hero · b · dark`) and sized to the placement's width and height; image inserts take the image's name and size. **Insert at** sets the scale: **1× pixels** keeps that size, **@2x (½)** and **@3x (⅓)** divide it, for device frames drawn in points; the footer then shows both sizes (for example `1000 × 1000 → 333.33 × 333.33`). The choice, the tab, the browse mode, and the environment are remembered on this device.

The plugin downloads the largest prepared version of the image that is PNG or WebP and at most 4 MiB, preferring PNG. Figma accepts PNG but not WebP, so a WebP version (photos have only WebP versions) is converted to PNG in the plugin window first. An image larger than 4 MiB in every version cannot be inserted; download it from the console instead. Originals are never downloaded. An animated (Lottie) image is inserted as its still poster, and an SVG image as its PNG version, not as editable vectors. An image uploaded before the console prepared versions has none; upload it again to use it in Figma.

Previews are downloaded the same way, from the smallest version up to 512 KiB, and shown from memory; an image without such a version shows **No preview**. If the console limits requests, previews pause and resume shortly.

## Send artwork

On the **Send** tab:

1. Select exactly one exportable node. The plugin shows its name, ID, type, width, and height, or explains why the selection cannot be sent.
2. Choose a placement. State, appearance, and arm choices are limited to what that placement declares. **Any** appearance and **Control** arm map to `null` in the API. Omitting a state uses the placement's declared default state; an explicit state must be declared.
3. Review any aspect-ratio warning, then choose **Send to draft**. The plugin warns when the selected node's ratio differs from the placement by more than 2%.
4. Read the result: created asset dimensions, binding success or the console's binding error, and a link back to the console.

Exports are PNG. The plugin uses the placement's width as the export constraint, or the placement's height when the node is proportionally taller. Figma preserves the node's aspect ratio; the plugin does not crop or stretch it. Match the node's aspect ratio to the placement when you need exact canvas dimensions.

If a binding fails with HTTP 409, the console may still have created the asset. The plugin shows that partial result and the console's message; check the console before retrying to avoid unnecessary duplicate assets. A send does not publish a release.

## Sync later edits

After the console creates an asset successfully, the plugin remembers the file key, node ID, placement, state, appearance, and arm for that node and connection. Select the same node again to see **Sync to &lt;placement&gt;**. Sync re-exports the node, sends its remembered binding, and sets `rebind: true`.

The console replaces references to the previous asset from that same file and node in draft cells and states within the connected app. The result lists what was rebound. Sync can therefore update several draft destinations that already reference that source. If the remembered placement or cell options no longer exist, refresh the placements and choose a current destination before sending again.

A frame inserted from a placement is linked to the cell it came from, so **Sync to &lt;placement&gt;** appears as soon as it is selected, including for teammates who open the file with a connection to the same app. Edit the frame, adding layers inside it if needed, then choose Sync: its first Sync fills exactly that cell in draft, never the cell it inherited from, and later syncs replace that layer's earlier sends wherever they are bound in draft. After the first successful Sync the plugin also remembers the target on this device, as for any sent node. A copy of a linked frame (for example with Cmd+D) is not linked; send it with **Send to draft** like any other node. Library images are not linked to a placement. When Figma does not supply the file key, confirm the file URL before Sync is enabled.

## Data and network access

The plugin sends only the selected node's exported PNG bytes (base64 in JSON), node ID and name, file key, PNG export settings, chosen placement coordinates, asset name, schema version, and sync flag. `source.versionId` is `null`. The app-scoped draft token is sent as a bearer token to the chosen console origin.

It never sends the Figma document, unrelated layers, or a Figma token. Selecting a frame or group exports its visible contents as one PNG; it does not upload its editable layer tree.

It receives the app's placements; for each placement cell, which image it shows in draft, staging, and production, and when staging and production were published; the app's image names, sizes, and prepared versions; and the bytes of the versions it previews or inserts. Rendition URLs are built from the image ID and hash; the plugin never sends the token to a URL taken from a response.

A frame inserted from a placement stores plugin data `assetlib.link.v1`: the console origin, organization and app IDs, placement key, state, appearance, arm, environment, image ID, the frame's node ID, and the insert time. It never holds the token. Plugin data is private to this plugin but travels with the file, so anyone with a copy of the file can read it; organization and app IDs are not secret, since they appear in public delivery URLs.

The manifest declares:

```json
{
  "allowedDomains": ["https://console.assetlib.dev", "https://assetlib-console.vercel.app"],
  "devAllowedDomains": ["http://localhost:3100"],
  "reasoning": "Reads images from, and sends exported artwork to, the Assetlib console you connect."
}
```

Requests use exactly these five calls under `/api/apps/{orgId}/{appId}/`: `GET placements`, `GET placements/artwork`, `GET assets` (with `limit`, `cursor`, and `q`), `GET assets/{assetId}/renditions/{sha256}`, and `POST drafts`. The placements endpoint accepts `draft` or `declare`; the other four require `draft`. All of them authenticate only with that bearer token, never cookies, and must allow cross-origin requests from the Figma plugin UI. The hosted console does so for placements and drafts on both production hosts; the artwork, image, and rendition reads exist only in a console that includes them, and until the hosted console does, Insert shows that the console does not support it yet while Send keeps working. Rendition bytes are served `private, no-store`. The plugin never calls the public delivery routes. Local development requires that console server to be running on port 3100. The development-only origin is not available to a published plugin.

HTTP 401/403 messages explain the token or scope; HTTP 409 preserves the console's message; HTTP 413 suggests reducing the export constraint; network failures name the origin that was called. A console without the Insert endpoints is reported as such while Send keeps working, and an image removed after the list loaded asks for a Refresh. The shared contract allows at most 4 MiB decoded PNG bytes and 6 MiB for the JSON body.

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

`src/code.ts` handles selection, Figma exports, inserted frames, and client storage. `src/ui.ts` and `src/ui.html` provide the interface and HTTP calls; `src/image.ts` converts WebP to PNG in the plugin window. `src/shared/` holds pure request, picker, export, file-key, library, link, and error logic. `tests/shared.test.mjs` runs the compiled shared logic with `node --test`. `tests/plugin.test.mjs` bundles `src/code.ts` and `src/ui.ts` with esbuild and runs both in `node:vm` against the fake `figma` API, DOM, console, and `fetch` in `tests/fakes.mjs`, covering saved and new connections, connection switches, Send, Sync, the exported PNG checks, Insert from placements and images, links, preferences, and previews. Neither runs real Figma or a real console.

`npm run e2e:local` runs the same bundles and fakes against a running local console with Node's real `fetch`. Start the console on port 3100 (`npm run setup && npm run dev` in `apps/console`), create a **Draft** token in Settings › Tokens, copy the organization and app IDs from Settings › General, and write `{"origin":"http://localhost:3100","orgId":"…","appId":"…","token":"…"}` to a file outside both repositories with mode 600. Then:

```sh
npm run e2e:local -- --connection /path/to/local-connection.json
```

It inserts `travel.coast` from each published environment and the first image with a PNG version, syncs the draft insert back (the app's draft `travel.coast` then shows the synced test image), reads the artwork again, checks the new image's bytes and CORS preflights, and checks that the token appears only in the bearer header. WebP-only images are skipped, because converting them needs a browser. It is not part of `npm test`.

Known limits: one node or image at a time; PNG only for sending; inserts are raster images, not editable vectors; no update or relink of an inserted frame yet; no OAuth; no document-wide sync; no automatic release publication; local-device settings and sync history. Actual Figma exports and inserts, client storage across restarts, preview rendering, and WebP conversion require a manual check in Figma desktop against a console in addition to the local verification commands.

## License

[MIT](LICENSE), copyright 2026 Assetlib contributors.
