// A local index of this app's links. Loading other pages is an explicit session choice.
import { linkInApp, parseStoredLink } from '../shared/index.js';
import type { FileLink } from '../shared/protocol.js';
import { hasImagePaint, reportSelection } from './selection.js';
import { currentFileKey, fileIdentity } from './identity.js';
import { LINK_KEY, main, post } from './state.js';

let queue = Promise.resolve();
export function scanLinks(requestId?: number): Promise<void> {
  const run = async () => {
    const generation = main.connectionGeneration, config = main.connection;
    const current = figma.currentPage, identity = fileIdentity(), fileKey = identity.fileKey, fileName = figma.root.name;
    // A copied file can retain its original's saved identity. Confirm a changed name before reporting under that key.
    const reportKey = identity.source === 'figma' || identity.name === fileName ? fileKey : null;
    const allPages = main.scanAllPages, documentPages = [...figma.root.children];
    const pages = allPages ? documentPages : [current];
    const entries: FileLink[] = [];
    let truncated = false, complete = true;
    if (config) for (const page of pages) {
      try {
        if (page !== current) await page.loadAsync();
        for (const node of page.findAllWithCriteria({ pluginData: { keys: [LINK_KEY] } })) {
          try {
            const link = parseStoredLink(node.getPluginData(LINK_KEY));
            if (!link || !linkInApp(link, config) || node.removed) continue;
            if (entries.length === 2000) { truncated = true; break; }
            let frame: BaseNode = node;
            while (frame.parent && frame.parent !== page) frame = frame.parent;
            const { placementKey, state, appearance, arm, environment, assetId } = link;
            entries.push({ nodeId: node.id, sourceNodeId: link.nodeId, name: node.name, pageId: page.id, pageName: page.name,
              frameId: frame === node ? null : frame.id, frameName: frame === node ? null : frame.name,
              kind: link.nodeId === node.id ? 'linked' : 'copy', placementKey, state, appearance, arm, environment, assetId,
              image: hasImagePaint(node), children: 'children' in node ? node.children.length : 0, instance: node.type === 'INSTANCE' });
          } catch { complete = false; }
        }
      } catch { complete = false; }
      if (truncated) break;
    }
    if (generation !== main.connectionGeneration || fileKey !== currentFileKey()) return;
    if (documentPages.length !== figma.root.children.length || documentPages.some((page, index) => figma.root.children[index]?.id !== page.id)) complete = false;
    post({ type: 'file-links', connectionGeneration: generation, scope: allPages ? 'file' : 'page', pageCount: documentPages.length,
      currentPageId: current.id, fileKey: reportKey, fileName, entries, truncated, complete, ...(requestId === undefined ? {} : { requestId }) });
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}
let trailing: ReturnType<typeof setTimeout> | null = null;
export function scheduleScan(): void {
  if (trailing !== null) return;
  trailing = setTimeout(() => { trailing = null; void scanLinks(); }, 1000);
}

export async function selectNode(nodeId: string): Promise<void> {
  const missing = 'That layer is no longer in this file. Refresh the list.';
  let node: BaseNode | null;
  try { node = await figma.getNodeByIdAsync(nodeId); } catch { throw new Error(missing); }
  if (!node || node.removed || node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(missing);
  let page: BaseNode | null = node.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (!page || page.removed) throw new Error(missing);
  if (page !== figma.currentPage) await figma.setCurrentPageAsync(page as PageNode);
  if (node.removed) throw new Error(missing);
  figma.currentPage.selection = [node as SceneNode];
  figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
  await reportSelection();
}
