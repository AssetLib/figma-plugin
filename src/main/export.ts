// Native raster density bounds Send without enlarging raster artwork unnecessarily.
export async function rasterDensity(root: SceneNode): Promise<number | null> {
  const pending: SceneNode[] = [root];
  const sizes = new Map<string, { width: number; height: number } | null>();
  let density: number | null = null, count = 0;
  while (pending.length && count++ < 2000) {
    const node = pending.pop()!;
    try {
      if ('children' in node) for (let i = node.children.length - 1; i >= 0 && pending.length + count < 2000; i--) pending.push(node.children[i]!);
      if (!('fills' in node) || !Array.isArray(node.fills) || node.width <= 0 || node.height <= 0) continue;
      for (const paint of node.fills as Paint[]) {
        if (paint.type !== 'IMAGE' || paint.visible === false || !paint.imageHash) continue;
        try {
          if (!sizes.has(paint.imageHash)) sizes.set(paint.imageHash, await figma.getImageByHash(paint.imageHash)?.getSizeAsync() ?? null);
          const size = sizes.get(paint.imageHash);
          if (!size) continue;
          const x = size.width / node.width, y = size.height / node.height;
          const value = paint.scaleMode === 'FILL' ? Math.min(x, y) : paint.scaleMode === 'FIT' ? Math.max(x, y) : x;
          if (Number.isFinite(value) && value > 0) density = Math.max(density ?? 0, value);
        } catch { /* An unreadable paint does not prevent an export. */ }
      }
    } catch { /* A removed descendant is skipped. */ }
  }
  return density;
}
