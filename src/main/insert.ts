// Insert: a new frame, a child of the selected container, or the selected layers filled; a fill of one linked layer
// replaces its image and relinks it to the chosen cell. A row or tile dropped on the canvas makes a placeholder where it
// landed (or replaces the image of the image frame it landed on), which its insert then fills. Each ends with one
// figma.commitUndo(), so it is one undo step, a drop's placeholder included. A toast's Undo restores the fill as its own step.
import {
  MAX_INSERT_PIXELS, environmentLabel, insideInstance, isPlacementMarker, isUint8Array, placementMarker, pngSize, sanitizeName, validateInsertLink,
} from '../shared/index.js';
import type { CanvasTarget, Connection, InsertLink, InsertMode, StoredLink } from '../shared/index.js';
import { dropRequestId, isAssetlibDrop, parseDropMetadata, toastText } from '../shared/protocol.js';
import type { DropMetadata, InsertDestination, UiMessage } from '../shared/protocol.js';
import { describeNode, dropStoredTargets, hasImagePaint, inComponent, insertTarget, nodeLink, reportSelection, writeLink } from './selection.js';
import { LINK_KEY, SELECTION_MOVED, main, post } from './state.js';

// A transcoded 2048 px PNG fits.
const MAX_INSERT_BYTES = 24 * 1024 * 1024;
const UNUSABLE = 'The console returned an image Figma cannot use. Refresh and try again.';
// A new frame inserted with a selection sits this far right of it.
const GAP = 40;
const BUSY = 'An image is already being inserted or exported.';
const UPDATE_CHANGED = 'This layer changed since the plugin checked it. Select it again.';
// A drop's placeholder until its image arrives: the brand's light surface.
const PLACEHOLDER_FILL: SolidPaint = { type: 'SOLID', color: { r: 238 / 255, g: 240 / 255, b: 243 / 255 } };
// Layers a drop can go inside. An instance, or anything inside one, takes no new layers; a component set only variants.
const DROP_PARENTS = ['FRAME', 'GROUP', 'SECTION', 'COMPONENT'];
export const INSTANCE_LAYERS = 'Filled. Layers inside instances can’t be linked, so Sync isn’t available for them.';
// Layers outside an instance whose plugin data Figma refused.
export function notLinked(count: number): string {
  return `Filled. Figma didn’t let ${count === 1 ? 'one layer' : `${count} layers`} be linked, so Sync isn’t available for ${count === 1 ? 'it' : 'them'}.`;
}
export const NOT_UNDONE = 'Not undone. These layers changed after the fill.';
export const UNDO_REFUSED = 'Not undone. Figma didn’t let the plugin change these layers back.';

type InsertMessage = Extract<UiMessage, { type: 'insert' }>;
type Frame = { width: number; height: number };
type Marker = NonNullable<ReturnType<typeof placementMarker>>;
// A drop main answered: the layer its insert fills, and whether main made it (a placeholder, removed if the image never comes).
type PendingDrop = { node: SceneNode; placeholder: boolean; generation: number };
type Paintable = SceneNode & MinimalFillsMixin;
type Before = { fills: Paintable['fills']; link: string; relaunch: Record<string, string>; name: string;
  component: Pick<ComponentNode, 'description' | 'documentationLinks'> | null };
type Fill = { node: Paintable; before: Before };
// relinked: existing layers whose link now names the chosen cell.
type Inserted = { node: SceneNode; mode: InsertMode; linked: boolean; notice: string; undo: Fill[] | null; relinked: string[] };
// A filled layer, and what the fill left on it (`snapshot`).
type Filled = Fill & { state: string };

// The toast whose Undo can still take back the last fill or replace. A selection change, a page change, another plugin
// edit, or a change main's canvas check finds on the one selected layer retires it.
let undoToast: NotificationHandler | null = null;
export function retireUndo(): void {
  undoToast?.cancel();
  undoToast = null;
}
// The paints and properties that must still show what the fill left, so restoring it never overwrites a later change.
const KEPT = ['fills', 'name', 'x', 'y', 'rotation', 'relativeTransform', 'width', 'height', 'visible', 'locked', 'opacity', 'blendMode', 'isMask',
  'strokes', 'strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'effects',
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'constraints', 'clipsContent', 'layoutSizingHorizontal', 'layoutSizingVertical'];
// A layer's link as stored, and its relaunch data; a layer Figma keeps no data on reads as none.
function rawLink(node: SceneNode): string { try { return node.getPluginData(LINK_KEY); } catch { return ''; } }
function relaunchOf(node: SceneNode): Record<string, string> { try { return node.getRelaunchData(); } catch { return {}; } }
// The guard also covers the layer's parent, child count, raw link, relaunch data, and a component's marker.
function snapshot(node: SceneNode): string {
  const read = (key: string): unknown => { try { return key in node ? (node as unknown as Record<string, unknown>)[key] : null; } catch { return null; } };
  return JSON.stringify([node.parent?.id ?? null, 'children' in node ? node.children.length : 0, node.type === 'COMPONENT' ? node.description : null,
    rawLink(node), relaunchOf(node), node.type === 'COMPONENT' ? node.documentationLinks : null, ...KEPT.map(read)]);
}

/**
 * The marker coding agents read on a component (`placementMarker`), for the placement its image now comes from. A
 * description the designer wrote stays; one Assetlib wrote, or none, takes the new key, or is cleared for a key the
 * marker refuses. A documentation link is replaced only with Assetlib's own description, or where there was none.
 */
export function writeMarker(node: SceneNode, config: Connection, key: string, frame: Frame): void {
  if (node.type !== 'COMPONENT') return;
  const ours = isPlacementMarker(node.description);
  if (!ours && node.description.trim()) return;
  const marker = placementMarker(config, key, frame);
  // A marker Figma refuses (on a variant, say) must not cost the fill.
  try { node.description = marker?.description ?? ''; } catch { return; }
  if (!ours && node.documentationLinks.length) return;
  try { node.documentationLinks = marker?.documentationUrl ? [{ uri: marker.documentationUrl }] : []; } catch { /* description only */ }
}

/**
 * A layer still named for the placement its link named (Insert names it by the key, then its cell) takes the name of the
 * cell it is now linked to, as its marker does; a name the designer gave it stays.
 */
export function renameRelinked(node: SceneNode, previous: StoredLink | null, name: string): void {
  const key = previous?.placementKey;
  if (!key || node.name === name || (node.name !== key && !node.name.startsWith(`${key} · `))) return;
  try { node.name = name; } catch { /* keeps its name */ }
}

/** A new component's marker. The description is what agents need; a link Figma refuses must not cost the insert. */
function writeNewMarker(component: ComponentNode, marker: Marker): void {
  component.description = marker.description;
  if (marker.documentationUrl) try { component.documentationLinks = [{ uri: marker.documentationUrl }]; } catch { /* description only */ }
}

/** The toast for a new layer: placement art names the environment it came from. */
function insertedNotice(name: string, link: InsertLink | null): string {
  return link ? `Inserted ${name} from ${environmentLabel(link.environment)}` : `Inserted ${name}`;
}

/** A side in Figma when Insert at divides it, to two decimals. */
function side(value: number, scale: number): number { return Math.round((value / scale) * 100) / 100; }

/** The topmost visible image's hash replaced, keeping its paint fields; append an image when none is visible. */
function withImage(fills: MinimalFillsMixin['fills'], hash: string): Paint[] {
  const paints: Paint[] = Array.isArray(fills) ? [...(fills as readonly Paint[])] : [];
  for (let index = paints.length - 1; index >= 0; index -= 1) {
    const paint = paints[index]!;
    if (paint.type === 'IMAGE' && paint.visible !== false) { paints[index] = { ...paint, imageHash: hash }; return paints; }
  }
  return [...paints, { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }];
}

/** A layer's bounds in page coordinates. */
function pageBounds(node: SceneNode): Rect {
  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  return box ?? { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2], width: node.width, height: node.height };
}

/** True when the destination still names the selection Insert classified when the UI chose it. */
function stillSelected(target: InsertDestination, current: CanvasTarget): boolean {
  if (target.kind === 'into') return current.mode === 'into' && current.nodeIds[0] === target.nodeId;
  if (target.kind === 'fill') {
    return (current.mode === 'fill' || current.mode === 'replace') && current.nodeIds.length === target.nodeIds.length
      && target.nodeIds.every(id => current.nodeIds.includes(id));
  }
  return true;
}

/** A new frame (or component, for placement art with a marker): in the selected container, beside the selection, or centered in the view. */
function place(config: Connection, target: InsertDestination, selection: readonly SceneNode[], hash: string, frame: Frame, scale: number,
  link: InsertLink | null, name: string): Inserted {
  const width = side(frame.width, scale);
  const height = side(frame.height, scale);
  // Not a rectangle: designers can add layers inside without changing the node id. A placement's art is a
  // component, whose description Figma's MCP server passes to coding agents; any other image, or a placement
  // key outside the catalog's grammar, is a frame.
  const marker = link ? placementMarker(config, link.placementKey, frame) : null;
  const container = target.kind === 'into' ? selection[0] as FrameNode | ComponentNode : null;
  // Figma puts no component inside another; the UI offers Insert beside one instead.
  if (container && marker && inComponent(container)) throw new Error(`Placement art is a component, and Figma can’t put one inside ${container.name}. Choose Insert as new layer.`);
  const component = marker ? figma.createComponent() : null;
  const node: ComponentNode | FrameNode = component ?? figma.createFrame();
  node.name = name;
  node.resize(width, height);
  node.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }];
  node.clipsContent = true;
  if (component && marker) writeNewMarker(component, marker);
  if (container) {
    try { container.appendChild(node); }
    catch {
      node.remove();
      throw new Error(`Figma couldn’t put the image inside ${container.name}. Choose Insert as new layer.`);
    }
    // Auto layout places the child itself; any other container centers it.
    if (!container.layoutMode || container.layoutMode === 'NONE') {
      node.x = Math.round((container.width - width) / 2);
      node.y = Math.round((container.height - height) / 2);
    }
  } else if (selection.length) {
    const boxes = selection.map(pageBounds);
    node.x = Math.round(Math.max(...boxes.map(box => box.x + box.width)) + GAP);
    node.y = Math.round(Math.min(...boxes.map(box => box.y)));
  } else {
    const center = figma.viewport.center;
    node.x = Math.round(center.x - width / 2);
    node.y = Math.round(center.y - height / 2);
  }
  const linked = link ? writeLink(node, config, link) : false;
  // Select only after the link is written, so the selection report finds it.
  figma.currentPage.selection = [node];
  const box = pageBounds(node);
  const view = figma.viewport.bounds;
  if (box.x < view.x || box.y < view.y || box.x + box.width > view.x + view.width || box.y + box.height > view.y + view.height) {
    figma.viewport.scrollAndZoomIntoView([node]);
  }
  return { node, mode: container ? 'into' : 'new', linked, notice: insertedNotice(name, link), undo: null, relinked: [] };
}

/**
 * Each layer's topmost visible image paint gets the new image (or one is appended); other paints, size, constraints, and
 * position stay. Placement art links each layer with its own id, except inside an instance; a library image never
 * writes or removes a link, so a linked layer stays linked to its cell.
 */
function fill(config: Connection, target: Extract<InsertDestination, { kind: 'fill' }>, selection: readonly SceneNode[], hash: string,
  frame: Frame, link: InsertLink | null, name: string, update = false): Inserted {
  const layers = target.nodeIds.map(id => selection.find(node => node.id === id)).filter((node): node is Paintable => Boolean(node && 'fills' in node));
  const replacing = layers.length === 1 && nodeLink(layers[0]!, config) !== null && hasImagePaint(layers[0]!);
  const filled: Fill[] = [];
  const relinked: string[] = [];
  const unlinked: SceneNode[] = [];
  for (const node of layers) {
    const previous = link ? nodeLink(node, config) : null;
    let before: Before;
    try {
      before = { fills: node.fills, link: rawLink(node), relaunch: relaunchOf(node), name: node.name,
        component: node.type === 'COMPONENT' ? { description: node.description, documentationLinks: node.documentationLinks } : null };
      node.fills = withImage(before.fills, hash);
    } catch { continue; }
    filled.push({ node, before });
    if (!link) continue;
    if (writeLink(node, config, link)) {
      relinked.push(node.id);
      writeMarker(node, config, link.placementKey, frame);
      renameRelinked(node, previous, name);
    } else unlinked.push(node);
  }
  const first = filled[0]?.node;
  if (!first) throw new Error('Figma couldn’t fill this layer. Choose Insert as new layer.');
  const skipped = layers.length - filled.length;
  // Placement art is named by its key; a library image by its name.
  const art = link ? link.placementKey : name;
  const others = skipped === 1 ? 'one' : skipped;
  const notice = skipped && unlinked.length
    ? `Filled ${filled.length} of ${layers.length} layers. Figma couldn’t fill the other ${others}, and Sync isn’t available for ${
      unlinked.length === filled.length ? (filled.length === 1 ? 'it' : 'them') : `${unlinked.length === 1 ? 'one' : unlinked.length} of them`}.`
    : skipped ? `Filled ${filled.length} of ${layers.length} layers with ${art}. Figma couldn’t fill the other ${others}.`
      : unlinked.length ? (unlinked.some(node => insideInstance(node.id)) ? INSTANCE_LAYERS : notLinked(unlinked.length))
        : update && link ? `Updated ${first.name} with the latest ${environmentLabel(link.environment)} art`
          : replacing ? `Replaced image in ${first.name}`
          : filled.length === 1 ? `Filled ${first.name} with ${art}` : `Filled ${filled.length} layers with ${art}`;
  return { node: first, mode: replacing ? 'replace' : 'fill', linked: relinked.length > 0, notice, undo: filled, relinked };
}

/** A fill's toast restores only what it overwrote, while the page, selection, and filled layers still match. */
function notifyUndo(notice: string, filled: Filled[]): void {
  const page = figma.currentPage.id;
  const selected = new Set(figma.currentPage.selection.map(node => node.id));
  const toast = figma.notify(toastText(notice), { timeout: 6000, button: { text: 'Undo', action: () => {
    // A retired toast is gone; a click that raced its removal takes nothing back.
    if (undoToast !== toast) return;
    undoToast = null;
    // The selection event may not have retired the toast yet.
    const selection = figma.currentPage.selection;
    if (figma.currentPage.id !== page || selection.length !== selected.size || !selection.every(node => selected.has(node.id))) {
      figma.notify(NOT_UNDONE); return;
    }
    const unchanged = (layer: Filled) => { try { return !layer.node.removed && snapshot(layer.node) === layer.state; } catch { return false; } };
    if (!filled.every(unchanged)) { figma.notify(NOT_UNDONE); return; }
    const written: (() => void)[] = [];
    const put = <T>(current: T, before: T, write: (value: T) => void, json = false): void => {
      if (json ? JSON.stringify(current) === JSON.stringify(before) : current === before) return;
      write(before);
      written.push(() => write(current));
    };
    let refused = false;
    try {
      for (const { node, before } of filled) {
        put(node.fills, before.fills, value => { node.fills = value; }, true);
        put(node.name, before.name, value => { node.name = value; });
        if (node.type === 'COMPONENT' && before.component) {
          put(node.description, before.component.description, value => { node.description = value; });
          put(node.documentationLinks, before.component.documentationLinks, value => { node.documentationLinks = value; }, true);
        }
        put(relaunchOf(node), before.relaunch, value => node.setRelaunchData(value), true);
        put(rawLink(node), before.link, value => node.setPluginData(LINK_KEY, value));
      }
    } catch {
      for (const restore of written.reverse()) try { restore(); } catch { /* Figma may refuse a rollback too. */ }
      figma.notify(UNDO_REFUSED);
      refused = true;
    }
    if (written.length) figma.commitUndo();
    if (refused) return;
    // Undo puts back the layers' earlier link too, which no selection change reports.
    void reportSelection();
  } } });
  undoToast = toast;
}

/** The checks every insert passes: no insert or export running, the current connection, bytes Figma can use, a valid size and link. */
function checkInsert(message: InsertMessage): { config: Connection; link: InsertLink | null; name: string } {
  if (main.importing || main.exporting) throw new Error(BUSY);
  const config = main.connection;
  if (!config || message.connectionGeneration !== main.connectionGeneration) throw new Error('The connection changed. Choose the image again.');
  const { bytes, frame, scale } = message;
  if (!isUint8Array(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_INSERT_BYTES) throw new Error(UNUSABLE);
  const size = pngSize(bytes);
  if (!size || size.width > MAX_INSERT_PIXELS || size.height > MAX_INSERT_PIXELS) throw new Error(UNUSABLE);
  checkFrame(frame, scale);
  return { config, link: message.link ? validateInsertLink(message.link) : null, name: sanitizeName(message.name) };
}
function checkFrame(frame: Frame, scale: number): void {
  if (![1, 2, 3].includes(scale) || !frame || typeof frame !== 'object' || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)
    || frame.width < 1 || frame.height < 1 || frame.width > MAX_INSERT_PIXELS || frame.height > MAX_INSERT_PIXELS) throw new Error('Choose a valid size.');
}

/** Makes the image, runs the edit, and commits it as one undo step; then the toast, `inserted`, and the new selection. */
async function apply(message: InsertMessage, config: Connection, edit: (hash: string) => Inserted): Promise<void> {
  retireUndo();
  main.importing = true;
  try {
    let image: Image;
    try { image = figma.createImage(message.bytes); } catch { throw new Error('Figma could not read this image. Refresh and try again.'); }
    const result = edit(image.hash);
    const filled = result.undo ? result.undo.map(layer => ({ ...layer, state: snapshot(layer.node) })) : null;
    // One undo step for the whole insert (and a drop's placeholder, made without a commit of its own).
    figma.commitUndo();
    await dropStoredTargets(config, result.relinked);
    const selected = figma.currentPage.selection;
    if (filled && filled.every(({ node, before }) => Array.isArray(before.fills) && selected.some(item => item.id === node.id))) notifyUndo(result.notice, filled);
    else figma.notify(toastText(result.notice));
    post({ type: 'inserted', requestId: message.requestId, connectionGeneration: main.connectionGeneration, node: describeNode(result.node),
      linked: result.linked, mode: result.mode, notice: result.notice });
  } finally { main.importing = false; }
  // selectionchange is asynchronous and coalesced; report the new selection (or the newly linked layers) now.
  await reportSelection();
}

export async function insert(message: InsertMessage): Promise<void> {
  // An Update always edits the single selected layer, never a drop's placeholder.
  if (message.update && message.drop !== undefined) { await reportSelection(); throw new Error(UPDATE_CHANGED); }
  if (message.drop !== undefined) { await insertDropped(message, message.drop); return; }
  if (dropPending()) throw new Error(BUSY);
  const { config, link, name } = checkInsert(message);
  const { frame, scale, target } = message;
  // Insert into, Fill, and Replace name the layers the UI saw selected; they must still be the selection.
  const selection = figma.currentPage.selection;
  if (message.update) {
    const node = selection.length === 1 ? selection[0] : null;
    const previous = node ? nodeLink(node, config) : null;
    if (!node || target.kind !== 'fill' || target.nodeIds.length !== 1 || target.nodeIds[0] !== node.id
      || !link || !previous || previous.assetId !== message.update.from || previous.placementKey !== link.placementKey
      || previous.state !== link.state || previous.appearance !== link.appearance || previous.arm !== link.arm
      || previous.environment !== link.environment || !hasImagePaint(node) || ('children' in node && node.children.length !== 0)) {
      await reportSelection();
      throw new Error(UPDATE_CHANGED);
    }
  }
  if (!stillSelected(target, insertTarget(selection, config))) {
    await reportSelection();
    throw new Error(message.update ? UPDATE_CHANGED : SELECTION_MOVED);
  }
  await apply(message, config, hash => target.kind === 'fill' ? fill(config, target, selection, hash, frame, link, name, Boolean(message.update))
    : place(config, target, selection, hash, frame, scale, link, name));
}

// ---- Drag to canvas ----
// Drops main answered and whose insert hasn't come, by drop id. Main takes one at a time.
const drops = new Map<number, PendingDrop>();
/** A drop's placeholder waits for its image: an edit that commits its own undo step now would take the placeholder with it. */
export function dropPending(): boolean { return drops.size > 0; }

/** A placeholder whose image never came goes; a layer the drop only landed on stays. */
function removePlaceholder(pending: PendingDrop): void {
  if (pending.placeholder && !pending.node.removed) try { pending.node.remove(); } catch { /* already gone */ }
}
function forgetDrop(dropId: number): void {
  const pending = drops.get(dropId);
  drops.delete(dropId);
  if (pending) removePlaceholder(pending);
}
/** The UI gave up on the drop that made or found this layer. Only a placeholder main made is removed. */
export function discardPlaceholder(nodeId: string): void {
  for (const [dropId, pending] of [...drops]) if (pending.node.id === nodeId) forgetDrop(dropId);
}
/** A connection change, or the plugin closing: no drop's image will come now. */
export function discardDrops(): void {
  for (const dropId of [...drops.keys()]) forgetDrop(dropId);
}

/** An image frame a drop replaces: a layer with a visible image paint and nothing inside, or one this app's art is linked to. */
function replaceable(node: BaseNode, config: Connection): node is Paintable {
  if (node.type === 'PAGE' || node.type === 'DOCUMENT' || !('fills' in node) || !Array.isArray(node.fills)) return false;
  if (!hasImagePaint(node)) return false;
  return !('children' in node) || node.children.length === 0 || nodeLink(node as SceneNode, config) !== null;
}
/** Where a drop's new layer goes: the frame, group, section, or component it landed on, else the page. */
function dropParent(node: BaseNode, component: boolean): (BaseNode & ChildrenMixin) | null {
  if (!DROP_PARENTS.includes(node.type) || insideInstance(node.id)) return null;
  // Figma puts no component inside a component; placement art then goes on the page where it was dropped.
  if (component && inComponent(node)) return null;
  return node as BaseNode & ChildrenMixin;
}
/**
 * A placeholder where the drop landed, sized as Insert would make it and centered on the drop point (or added last to an
 * auto layout frame), named "{name} · loading", and selected. Placement art with a marker is a component, as Insert makes it.
 */
function placeholder(config: Connection, meta: DropMetadata, link: InsertLink | null, name: string, event: DropEvent): SceneNode {
  const marker = link ? placementMarker(config, link.placementKey, meta.frame) : null;
  const width = side(meta.frame.width, meta.scale);
  const height = side(meta.frame.height, meta.scale);
  const node: ComponentNode | FrameNode = marker ? figma.createComponent() : figma.createFrame();
  try {
    node.name = `${name} · loading`;
    node.resize(width, height);
    node.fills = [PLACEHOLDER_FILL];
    node.clipsContent = true;
    const parent = dropParent(event.node, marker !== null);
    let flow = false;
    if (parent) {
      // A refusal leaves it on the page, where Figma made it.
      try { parent.appendChild(node); flow = 'layoutMode' in parent && parent.layoutMode !== 'NONE'; } catch { /* on the page */ }
    }
    if (!flow) {
      // Moved by what separates it from the drop point on the page, whatever its parent's coordinates are.
      const box = pageBounds(node);
      node.x += Math.round(event.absoluteX - width / 2 - box.x);
      node.y += Math.round(event.absoluteY - height / 2 - box.y);
    }
    figma.currentPage.selection = [node];
    return node;
  } catch (error) {
    node.remove();
    throw error;
  }
}

/**
 * Figma's drop handler. A drop without Assetlib's metadata (a file from the desktop, say) is left to Figma (undefined).
 * Ours is always handled (false): a stale connection or a running insert is refused with an error naming the drop;
 * otherwise main replaces the image of the image frame it landed on, or makes a placeholder there, and posts `dropped`.
 * The UI then sends the downloaded image as an insert naming the drop. Nothing here commits an undo step: the insert's
 * commit makes the placeholder and its image one step.
 */
export function drop(event: DropEvent): false | undefined {
  const metadata: unknown = event.dropMetadata;
  if (!isAssetlibDrop(metadata)) return undefined;
  const dropId = dropRequestId(metadata);
  const refuse = (message: string): false => {
    post({ type: 'error', message, ...(dropId === undefined ? {} : { requestId: dropId }) });
    return false;
  };
  try {
    const meta = parseDropMetadata(metadata);
    const config = main.connection;
    if (!config || meta.connectionGeneration !== main.connectionGeneration) return refuse('The connection changed. Drag the image again.');
    if (main.importing || main.exporting) return refuse(BUSY);
    // The UI waits for one drop at a time, so a newer drop means it gave up on the older one (answered too late): that
    // placeholder goes.
    if ([...drops.keys()].some(id => id >= meta.dropId)) return refuse(BUSY);
    discardDrops();
    checkFrame(meta.frame, meta.scale);
    const link = meta.link ? validateInsertLink(meta.link) : null;
    const name = sanitizeName(meta.name);
    retireUndo();
    const target = event.node;
    let pending: PendingDrop;
    if (replaceable(target, config)) {
      figma.currentPage.selection = [target];
      pending = { node: target, placeholder: false, generation: main.connectionGeneration };
    } else {
      try { pending = { node: placeholder(config, meta, link, name, event), placeholder: true, generation: main.connectionGeneration }; }
      catch { return refuse('Figma couldn’t place the image there. Select a frame and choose Insert instead.'); }
    }
    drops.set(meta.dropId, pending);
    post({ type: 'dropped', dropId: meta.dropId, nodeId: pending.node.id, connectionGeneration: pending.generation });
    void reportSelection();
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'The plugin could not complete that action.');
  }
  return false;
}

/**
 * A drop's placeholder gets its image, name, marker, and link. It is a new layer, so it takes the image alone, and Undo
 * takes back the layer, as for Insert.
 */
function fillPlaceholder(config: Connection, node: SceneNode, hash: string, frame: Frame, link: InsertLink | null, name: string): Inserted {
  node.name = name;
  (node as FrameNode).fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }];
  const marker = link && node.type === 'COMPONENT' ? placementMarker(config, link.placementKey, frame) : null;
  if (marker) writeNewMarker(node as ComponentNode, marker);
  const linked = link ? writeLink(node, config, link) : false;
  const into = node.parent !== null && node.parent.type !== 'PAGE';
  return { node, mode: into ? 'into' : 'new', linked, notice: insertedNotice(name, link), undo: null, relinked: [] };
}

/** The insert for a drop: its placeholder filled, or the image frame it landed on filled as Fill does. A failure removes the placeholder. */
async function insertDropped(message: InsertMessage, dropId: number): Promise<void> {
  // The drop is over either way.
  const pending = drops.get(dropId);
  drops.delete(dropId);
  let filled = false;
  try {
    const { config, link, name } = checkInsert(message);
    if (!pending || pending.generation !== main.connectionGeneration) throw new Error('The connection changed. Drag the image again.');
    const { target, frame } = message;
    if (target.kind !== 'fill' || target.nodeIds.length !== 1 || target.nodeIds[0] !== pending.node.id) throw new Error(SELECTION_MOVED);
    if (pending.node.removed) {
      throw new Error(pending.placeholder ? 'The placeholder was deleted before its image arrived. Drag the image again.'
        : 'The layer the image was dropped on was deleted. Drag the image again.');
    }
    await apply(message, config, hash => {
      const result = pending.placeholder ? fillPlaceholder(config, pending.node, hash, frame, link, name)
        : fill(config, target, [pending.node], hash, frame, link, name);
      filled = true;
      return result;
    });
  } finally {
    // A placeholder its image never reached goes.
    if (!filled && pending) removePlaceholder(pending);
  }
}
