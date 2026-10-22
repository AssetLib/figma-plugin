import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundlePlugin, clone, createHarness, descendants, fakeConsole, flush, pngHeader } from './fakes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = await bundlePlugin(root);
const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: `alk_${'a'.repeat(43)}` };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const placement = { key: 'hero.artwork', screen: 'Home', width: 100, height: 100, states: null, defaultState: null, variants: null, origin: 'declared' };
const node = { id: '12:1', name: 'Hero', type: 'FRAME', width: 100, height: 100 };
const binding = { slotKey: placement.key, state: null, appearance: null, arm: null };
const asset = id => ({ id, name: 'Draft artwork', width: 100, height: 100, createdAt: '2026-10-21T12:00:00.000Z', processingIntent: 'artwork',
  renditions: [{ sha256: 'a'.repeat(64), mime: 'image/png', bytes: 33, width: 100, height: 100 }] });
const response = (status, body) => ({ status, headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null }, async json() { return clone(body); } });
async function settle() { for (let i = 0; i < 8; i++) await flush(); }
async function harness({ source = sources, conflictAfterPreflight = false, ...options } = {}) {
  const state = { placements: [clone(placement)], artwork: { environments: { staging: null, production: null },
    placements: [{ ...placement, cells: [{ state: null, appearance: null, arm: null, draft: { assetId: uuid(1), via: { arm: null, appearance: null } }, staging: null, production: null }] }],
    assets: { [uuid(1)]: asset(uuid(1)), [uuid(2)]: asset(uuid(2)), [uuid(3)]: asset(uuid(3)) } } };
  const fallback = fakeConsole(state);
  let raced = false;
  const setDraft = id => { state.artwork.placements[0].cells[0].draft.assetId = id; };
  const app = createHarness({ ...source, selection: [{ ...node, pluginData: { 'assetlib.link.v1': JSON.stringify({ v: 1, ...connection, token: undefined,
    nodeId: node.id, placementKey: placement.key, state: null, appearance: null, arm: null, environment: 'draft', assetId: uuid(1), insertedAt: '2026-10-21T00:00:00.000Z' }) } }],
    exportBytes: () => pngHeader(100, 100), storage: [['assetlib.connection.v1', connection], ['assetlib.preferences.v1', { tab: 'send' }]], ...options,
    fetch: async (url, options, request) => {
      if (!url.endsWith('/drafts')) return fallback(url, options, request);
      request.route = 'drafts';
      if (conflictAfterPreflight && !raced) {
        raced = true; setDraft(uuid(2)); state.failures.add('artwork');
        return response(409, { code: 'draft_changed', error: 'The draft changed.' });
      }
      assert.equal(request.body.expectedAssetId, state.artwork.placements[0].cells[0].draft.assetId);
      setDraft(uuid(3));
      return response(201, { asset: { id: uuid(3), name: node.name, width: 100, height: 100, sha256: 'a'.repeat(64), renditions: 1 },
        previous: null, bound: binding, bindError: null, rebound: [] });
    } });
  await settle();
  return { ...app, console: state, setDraft };
}
const button = (container, label) => descendants(container).find(item => item.tagName === 'BUTTON' && item.textContent === label);
const rowState = app => app.element('send-items').children[0].getAttribute('data-state');
async function send(app) { app.element('send').dispatch('click'); await settle(); }

async function reviewAfterReselect(source = sources) {
  const app = await harness({ source });
  const live = app.figma.currentPage.selection[0];
  app.setDraft(uuid(2)); await send(app);
  assert.equal(rowState(app), 'conflict');
  app.select([]); await settle();
  app.select([live]); await settle();
  await send(app); assert.equal(rowState(app), 'conflict');
  button(app.element('send-review'), 'Use this layer instead').dispatch('click'); await settle();
  assert.equal(rowState(app), 'ready', 'the review action must update the current row after reselecting it');
  await send(app);
  assert.equal(app.drafts().length, 1);
  assert.equal(app.drafts()[0].body.expectedAssetId, uuid(2));
}

test('conflict review updates a reselected row even when its node and remote asset IDs are unchanged', async () => {
  await reviewAfterReselect();
});

test('conflict review regression fails with the former captured-row handler', async () => {
  const result = await build({ absWorkingDir: root, entryPoints: ['src/ui/main.ts'], bundle: true, write: false, format: 'iife',
    plugins: [{ name: 'former-conflict-handler', setup(builder) {
      builder.onLoad({ filter: /send-queue\.ts$/ }, async args => {
        const source = await readFile(args.path, 'utf8');
        const before = "const current = activeSendRow();\n      if (actionsBlocked() || !current || current.node.id !== row.node.id || current.status !== 'conflict'";
        assert.ok(source.includes(before), 'the mutation still targets the review handler');
        return { contents: source.replace(before, "const current = row;\n      if (actionsBlocked() || !current || current.node.id !== row.node.id || current.status !== 'conflict'"), loader: 'ts' };
      });
    } }] });
  await assert.rejects(reviewAfterReselect({ ...sources, uiSource: result.outputFiles[0].text }), /review action must update the current row/);
});

test('a failed conflict refresh offers a read-only retry before replacement can be approved', async () => {
  const app = await harness({ conflictAfterPreflight: true });
  await send(app);
  assert.equal(rowState(app), 'conflict');
  assert.equal(button(app.element('send-review'), 'Use this layer instead').getAttribute('aria-disabled'), 'true');
  assert.equal(app.drafts().length, 1);
  app.console.failures.clear();
  const retry = descendants(app.element('send-review')).find(item => item.tagName === 'BUTTON' && /retry|refresh|try again/i.test(item.textContent) && !item.hidden);
  assert.ok(retry, 'a failed conflict read needs a visible recovery action');
  retry.dispatch('click'); await settle();
  assert.equal(app.drafts().length, 1, 'review recovery only reads current artwork');
  assert.notEqual(button(app.element('send-review'), 'Use this layer instead').getAttribute('aria-disabled'), 'true');
  button(app.element('send-review'), 'Use this layer instead').dispatch('click'); await settle();
  await send(app);
  assert.equal(app.drafts().length, 2);
  assert.equal(app.drafts()[1].body.expectedAssetId, uuid(2));
});

test('sending while a replacement file link is being saved never uses the previous file identity', async () => {
  const identity = { v: 1, fileKey: 'abc123', source: 'link', savedAt: '2026-10-21T00:00:00.000Z', name: 'Test design' };
  const app = await harness({ fileKey: null, rootName: identity.name, rootPluginData: { 'assetlib.file.v1': JSON.stringify(identity) } });
  app.element('file-change').dispatch('click');
  app.element('file-url').value = 'https://www.figma.com/design/newKey2/Test-design';
  app.element('file-url').dispatch('input');
  await send(app);
  assert.equal(app.drafts().length, 0, 'Send must wait for the edited file link instead of using the previous file key');
  app.fireTimers(350); await settle();
  assert.equal(app.drafts().length, 0, 'saving file setup never starts an upload');
  await send(app);
  assert.equal(app.drafts().length, 1);
  assert.equal(app.drafts()[0].body.source.fileKey, 'newKey2');
});

test('a refused conflict-review retry exposes connection recovery instead of an endless read retry', async () => {
  const app = await harness({ conflictAfterPreflight: true });
  await send(app);
  app.console.failures.clear(); app.console.statuses.artwork = 401;
  button(app.element('send-review'), 'Retry review').dispatch('click'); await settle();
  assert.equal(app.element('connection-label').textContent, 'Needs attention');
  assert.equal(app.element('error-action').textContent, 'Connect again');
  assert.equal(app.drafts().length, 1, 'connection recovery never repeats the draft write');
});
