// The selection as Send, Sync, and Insert see it, reported to the UI on every change, and the links that tie layers to cells.
import {
  LEGACY_PRODUCTION_ORIGIN, NO_AREA, PRODUCTION_ORIGIN, classifyInsertTarget, insideInstance, isPlacementMarker, linkInApp, parseStoredLink, syncDescription,
} from '../shared/index.js';
import type { CanvasTarget, Connection, InsertCandidate, InsertLink, NodeSelection, StoredLink } from '../shared/index.js';
import { MAX_SEND_NODES } from '../shared/protocol.js';
import type { RememberedTarget, SelectedLink, SelectionState } from '../shared/protocol.js';
import { validArm, validPlacementKey, validState } from '../shared/validation.js';
import { currentFileKey, fileIdentity, markDocument } from './identity.js';
import { LINK_KEY, main, post } from './state.js';

// Client storage targets keep their original shape; insertedFrom is only ever derived from a link.
export type StoredTarget = Omit<RememberedTarget, 'fileKey' | 'insertedFrom'> & { fileKey: string };

let selectionRevision = 0;
// The canvas part of the last report started. The canvas check compares it before reading storage again.
let reported: string | null = null;
// Layers a fill or replace relinked in this run whose earlier stored targets aren't deleted yet: the file key wasn't
// known, or storage failed. Until they are, reportSelection ignores those targets, so the link names the cell.
const staleTargets = new Set<string>();

function targetKey(config: Connection, fileKey: string, nodeId: string): string {
  return `assetlib.target.v1:${JSON.stringify([config.origin, config.orgId, config.appId, fileKey, nodeId])}`;
}
function choiceKey(config: Connection, fileKey: string, nodeId: string): string {
  return `assetlib.send-choice.v1:${JSON.stringify([config.origin, config.orgId, config.appId, fileKey, nodeId])}`;
}
const choiceWrites = new Map<string, Promise<void>>();
/** An unsent destination is a device preference, never a link or a successful-send target. */
export async function storeChoice(config: Connection, target: StoredTarget): Promise<void> {
  const key = choiceKey(config, target.fileKey, target.nodeId);
  const previous = choiceWrites.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => figma.clientStorage.setAsync(key, target));
  choiceWrites.set(key, write);
  try { await write; } finally { if (choiceWrites.get(key) === write) choiceWrites.delete(key); }
}
// Sync targets remembered before the console moved hosts stay keyed by the legacy origin.
function targetKeys(config: Connection, fileKey: string, nodeId: string): string[] {
  const keys = [targetKey(config, fileKey, nodeId)];
  if (config.origin === PRODUCTION_ORIGIN) keys.push(targetKey({ ...config, origin: LEGACY_PRODUCTION_ORIGIN }, fileKey, nodeId));
  return keys;
}
function staleKey(config: Connection, nodeId: string): string {
  return JSON.stringify([config.origin, config.orgId, config.appId, nodeId]);
}
async function deleteTargets(config: Connection, fileKey: string, nodeId: string): Promise<void> {
  try {
    for (const key of targetKeys(config, fileKey, nodeId)) await figma.clientStorage.deleteAsync(key);
    const choice = choiceKey(config, fileKey, nodeId);
    await choiceWrites.get(choice)?.catch(() => {});
    await figma.clientStorage.deleteAsync(choice);
    staleTargets.delete(staleKey(config, nodeId));
  } catch { /* Still ignored, and deleted on a later report. */ }
}

/**
 * A fill or replace wrote these layers' links. A target an earlier Send or Sync stored on this device would outrank
 * the new link, and Sync would send the new art to the old cell, so those targets go: now, or once the file key is known.
 */
export async function dropStoredTargets(config: Connection, nodeIds: readonly string[]): Promise<void> {
  const fileKey = currentFileKey();
  for (const nodeId of nodeIds) {
    staleTargets.add(staleKey(config, nodeId));
    if (fileKey) await deleteTargets(config, fileKey, nodeId);
  }
}

/** Saves the target a Send or Sync chose. It is newer than any relink, so it names the layer's cell from now on. */
export async function storeTarget(config: Connection, target: StoredTarget): Promise<void> {
  await figma.clientStorage.setAsync(targetKey(config, target.fileKey, target.nodeId), target);
  staleTargets.delete(staleKey(config, target.nodeId));
}
export function selectedNode(): SceneNode | null {
  return figma.currentPage.selection.length === 1 ? figma.currentPage.selection[0] ?? null : null;
}
export function describeNode(node: SceneNode): NodeSelection {
  return { id: node.id, name: node.name, width: node.width, height: node.height, type: node.type };
}
function isRemembered(value: unknown, fileKey: string, nodeId: string): value is StoredTarget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredTarget>;
  return item.fileKey === fileKey && item.nodeId === nodeId && validPlacementKey(item.placementKey)
    && (item.state === null || validState(item.state))
    && (item.appearance === null || item.appearance === 'light' || item.appearance === 'dark')
    && (item.arm === null || validArm(item.arm));
}

function storedLink(node: SceneNode): StoredLink | null {
  let raw = '';
  try { raw = node.getPluginData(LINK_KEY); } catch { raw = ''; }
  return parseStoredLink(raw);
}
/** The layer's link in the connected app, if it names this layer: a Cmd+D copy keeps the data with another id. */
export function nodeLink(node: SceneNode, config: Connection | null): StoredLink | null {
  const link = config ? storedLink(node) : null;
  return link && config && linkInApp(link, config) && link.nodeId === node.id ? link : null;
}
/** True when a layer shows an image; a hidden IMAGE paint alone is not an image to replace or update. */
export function hasImagePaint(node: BaseNode): boolean {
  return 'fills' in node && Array.isArray(node.fills) && node.fills.some((paint: Paint) => paint.type === 'IMAGE' && paint.visible !== false);
}
/** The layer's link as the Sync bar reads it: linked here, a copy of a linked layer, or another app's. */
function selectedLink(node: SceneNode, config: Connection | null): SelectedLink | null {
  const link = config ? storedLink(node) : null;
  if (!link || !config) return null;
  const { placementKey, state, appearance, arm, environment, assetId } = link;
  const image = hasImagePaint(node);
  const children = 'children' in node ? node.children.length : 0;
  // Another app's link names that app, so the Sync bar can offer to switch to it.
  if (!linkInApp(link, config)) {
    const origin = link.origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : link.origin;
    return { kind: 'other', placementKey, state, appearance, arm, environment, assetId, image, children, origin, orgId: link.orgId, appId: link.appId };
  }
  return { kind: link.nodeId === node.id ? 'linked' : 'copy', placementKey, state, appearance, arm, environment, assetId, image, children };
}

/**
 * Links the layer to the cell its image now comes from, with its own id, and gives it a **Sync to Assetlib** button in
 * the properties panel (relaunch data, one call); false where Figma keeps no plugin data (a layer inside an instance) or
 * refuses it. The document then keeps its identity and its Open Assetlib button (`markDocument`).
 */
export function writeLink(node: SceneNode, config: Connection, link: InsertLink): boolean {
  if (insideInstance(node.id)) return false;
  const stored: StoredLink = { v: 1, origin: config.origin, orgId: config.orgId, appId: config.appId, ...link, nodeId: node.id, insertedAt: new Date().toISOString() };
  try { node.setPluginData(LINK_KEY, JSON.stringify(stored)); } catch { return false; }
  try { node.setRelaunchData({ sync: syncDescription(link) }); } catch { /* linked, without the button */ }
  markDocument();
  return true;
}

/** A component, or a layer inside a component, a component set, or an instance: Figma puts no component there. */
export function inComponent(node: BaseNode): boolean {
  for (let item: BaseNode | null = node; item && item.type !== 'PAGE' && item.type !== 'DOCUMENT'; item = item.parent) {
    if (item.type === 'COMPONENT' || item.type === 'COMPONENT_SET' || item.type === 'INSTANCE') return true;
  }
  return false;
}

/** What Insert does with these layers. A link, and a component around the layer, are read only when one layer is selected. */
export async function insertTarget(nodes: readonly SceneNode[], config: Connection | null): Promise<CanvasTarget> {
  const one = nodes.length === 1;
  const candidates: InsertCandidate[] = [];
  for (const node of nodes) {
    const candidate: InsertCandidate = { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height,
      children: 'children' in node ? node.children.length : 0, image: hasImagePaint(node), linked: one && nodeLink(node, config) !== null, inComponent: one && inComponent(node) };
    if (node.type === 'INSTANCE') {
      if (nodes.length > 200) candidate.skipInstance = true;
      else try {
        const component = await node.getMainComponentAsync();
        // A library component, or a copied main, keeps the link with another node's id (or none, if Figma drops it on
        // publish); its marker still says it is placement art, whose instances must keep following it.
        const stored = component && config ? storedLink(component) : null;
        const link = stored && config && linkInApp(stored, config) ? stored : null;
        if (component && (link || isPlacementMarker(component.description))) candidate.placementMain = { id: component.id, name: component.name,
          width: component.width, height: component.height, image: hasImagePaint(component), remote: component.remote,
          ...(link ? { link: { placementKey: link.placementKey, state: link.state, appearance: link.appearance, arm: link.arm } } : {}) };
      } catch { /* An unavailable main is not an Assetlib main we can change. */ }
    }
    candidates.push(candidate);
  }
  return classifyInsertTarget(candidates);
}

type CanvasView = Omit<SelectionState, 'remembered' | 'insertTarget'>;
export function sendReason(node: SceneNode): string | null {
  if (![node.width, node.height].every(value => Number.isFinite(value) && value > 0)) return NO_AREA;
  return typeof node.exportAsync !== 'function' ? 'This layer can’t be exported. Select a frame or image layer.' : null;
}
/** Stable across Figma reordering the same selected set. */
export function selectedIds(): string[] { return figma.currentPage.selection.map(node => node.id).sort(); }
/** What a selection report shows of the canvas, read at once: everything but the target client storage remembers. */
function canvasView(config: Connection | null): { nodes: SceneNode[]; view: CanvasView } {
  const selection = figma.currentPage.selection;
  const nodes = [...selection].slice(0, MAX_SEND_NODES);
  const node = selection.length === 1 ? selection[0] ?? null : null;
  const { fileKey, source, name } = fileIdentity();
  const truncated = selection.length > MAX_SEND_NODES;
  const reason = truncated ? `Select up to ${MAX_SEND_NODES} layers to send together.`
    : !node ? (selection.length === 0 ? 'Select a frame or layer to send.' : null) : sendReason(node);
  return { nodes, view: { node: node ? describeNode(node) : null, reason, fileKey,
    link: node ? selectedLink(node, config) : null, file: { source, name }, truncated,
    selectionIds: nodes.map(item => item.id).sort(),
    sendNodes: nodes.map(item => ({ node: describeNode(item), reason: sendReason(item), link: selectedLink(item, config), remembered: null })) } };
}

/** The visible image paints' hashes on a layer, compared by the canvas check (never posted): an image swap changes nothing else it reads. */
function imageHashes(node: SceneNode | null): (string | null)[] {
  if (!node || !('fills' in node) || !Array.isArray(node.fills)) return [];
  return (node.fills as readonly Paint[]).filter(paint => paint.type === 'IMAGE' && paint.visible !== false).map(paint => (paint as ImagePaint).imageHash);
}

export async function reportSelection(): Promise<void> {
  const revision = ++selectionRevision;
  // Client storage can resolve after a different app or token has been saved.
  const generation = main.connectionGeneration;
  const config = main.connection;
  const { nodes, view } = canvasView(config);
  reported = JSON.stringify([generation, view, nodes.map(imageHashes)]);
  const selection = [...figma.currentPage.selection];
  const target = await insertTarget(selection, config);
  const { fileKey } = view;
  const sendNodes = await Promise.all((view.sendNodes ?? []).map(async (item, index) => {
    const node = nodes[index]!;
    let remembered: RememberedTarget | null = null;
    let choice: RememberedTarget | null = null;
    if (fileKey && config && staleTargets.has(staleKey(config, node.id))) await deleteTargets(config, fileKey, node.id);
    else if (fileKey && config) {
      try {
        for (const key of targetKeys(config, fileKey, node.id)) {
          const value: unknown = await figma.clientStorage.getAsync(key);
          if (isRemembered(value, fileKey, node.id)) { remembered = { ...value, insertedFrom: null }; break; }
        }
      } catch { /* A storage read failure must not prevent a new send. */ }
    }
    if (fileKey && config && !staleTargets.has(staleKey(config, node.id))) {
      try {
        const value: unknown = await figma.clientStorage.getAsync(choiceKey(config, fileKey, node.id));
        if (isRemembered(value, fileKey, node.id)) choice = { ...value, insertedFrom: null };
      } catch { /* A preference read failure leaves the current destination available. */ }
    }
    if (!remembered && config) {
      // An inserted, filled, or replaced layer names its cell in pluginData. A copy keeps the data but not the node id, so it is ignored.
      const link = nodeLink(node, config);
      if (link) remembered = { fileKey, nodeId: node.id, placementKey: link.placementKey,
        state: link.state, appearance: link.appearance, arm: link.arm, insertedFrom: { environment: link.environment, assetId: link.assetId } };
    }
    return { ...item, remembered, choice };
  }));
  if (revision !== selectionRevision || generation !== main.connectionGeneration) return;
  const remembered = view.node ? sendNodes[0]?.remembered ?? null : null;
  const choice = view.node ? sendNodes[0]?.choice ?? null : null;
  post({ type: 'selection', connectionGeneration: generation, selection: { ...view, remembered, choice, sendNodes, insertTarget: target } });
}

/** True after a canvas edit Figma sent the plugin no event for, including an edit to any member of a batch. */
export function selectionStale(): boolean {
  if (reported === null) return false;
  const { nodes, view } = canvasView(main.connection);
  return JSON.stringify([main.connectionGeneration, view, nodes.map(imageHashes)]) !== reported;
}

/** Metadata and link guard for a pending export. No bytes or token leave the sandbox in this snapshot. */
export function sendSnapshot(node: SceneNode): string {
  return JSON.stringify([describeNode(node), node.getPluginData(LINK_KEY), imageHashes(node)]);
}
