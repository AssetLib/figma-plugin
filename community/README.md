# Community listing assets

Upload `icon.png` (128 × 128) and `cover.png` (1920 × 1080). The cover is typographic; it contains no product screenshot or customer artwork. Listing text is in [LISTING.md](LISTING.md).

Editable sources are `icon.svg` and `cover.html`. The icon preserves the canonical mark geometry and uses 44px clear space around its 40px mark box. The cover uses the repository’s licensed Instrument Sans font and the Assetlib paper/ink palette. Brand masters are unchanged.

To reproduce the PNGs with Node and Playwright installed, run `node community/render.mjs`. Set `PLAYWRIGHT_MODULE` to a Playwright module path when using an existing installation elsewhere. `CHROME_PATH` optionally selects Chrome; otherwise the renderer uses Chrome on macOS or Playwright’s Chromium. It renders local files, waits for the font, checks exact copy and text bounds, and records PNG dimensions and hashes in `verification.json`.

Figma’s [classic plugin publishing guide](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community) specifies a recommended 128 × 128 icon and 1920 × 1080 thumbnail. Preparing these files does not submit or publish the plugin.
