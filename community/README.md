# Community listing assets

Build `1466cb2` was submitted on 2026-10-21 under plugin ID `1690264758934826227`. [Community Version 1](https://www.figma.com/community/plugin/1690264758934826227/assetlib) became publicly available on 2026-11-16. An agent installed and ran it in an isolated browser client using an existing account, completed a first staging draft transfer, and verified connection and file-link persistence after reopening. Independent outside-designer acceptance remains unverified.

## Prepare the next update

The next update brings the existing source's batch Send, visual destination and Draft review, conditional replacement checks, and browsing improvements to Community. Runtime source is `f9bb167150f177f82f61e615cfdc7296525057bb`; these additions are pending Community publication.

1. Run `npm run verify` and `npm run test:browser` from this repository. Keep the plugin ID and release network allowlist unchanged.
2. In Figma desktop, open a design file, then **Plugins → Manage plugins**. For Assetlib, choose **Publish new version**. If needed, choose **Locate local version** and select this repository's `manifest.json` first.
3. Enter release notes and publish the verified build. Figma updates every installed copy. Record the new public version and the hashes of `dist/code.js` and `dist/ui.html`.
4. Reopen the actual Community plugin in an isolated client and verify the changed workflow against the staging console. Keep the founder's existing production connection and unrelated files intact.

To roll back, rebuild the earlier verified source and publish it as another update. Figma's [developer management guide](https://help.figma.com/hc/en-us/articles/360042293714-Manage-classic-plugins-as-a-developer) describes the update and rollback process.

## Listing artwork

Upload `icon.png` (128 × 128) and `cover.png` (1920 × 1080). The cover is typographic; it contains no product screenshot or customer artwork. Listing text is in [LISTING.md](LISTING.md).

Editable sources are `icon.svg` and `cover.html`. The icon preserves the canonical mark geometry and uses 44px clear space around its 40px mark box. The cover uses the repository’s licensed Instrument Sans font and the Assetlib paper/ink palette. Brand masters are unchanged.

To reproduce the PNGs with Node and Playwright installed, run `node community/render.mjs`. Set `PLAYWRIGHT_MODULE` to a Playwright module path when using an existing installation elsewhere. `CHROME_PATH` optionally selects Chrome; otherwise the renderer uses Chrome on macOS or Playwright’s Chromium. It renders local files, waits for the font, checks exact copy and text bounds, and records PNG dimensions and hashes in `verification.json`.

Figma’s [classic plugin publishing guide](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community) specifies a recommended 128 × 128 icon and 1920 × 1080 thumbnail. Preparing these files does not submit or publish the plugin.
