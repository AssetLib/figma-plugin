import type { FillPreview } from '../shared/protocol.js';

const identity = (matrix: Transform): boolean => matrix[0][0] === 1 && matrix[0][1] === 0 && matrix[0][2] === 0 && matrix[1][0] === 0 && matrix[1][1] === 1 && matrix[1][2] === 0;

// Read-only: the fill path replaces a paint's hash and preserves all its other fields.
export function fillPreview(node: SceneNode | null): FillPreview {
  const no = (reason: string): FillPreview => ({ reason });
  if (!node) return no('Select one layer to preview its fill.');
  if (node.type !== 'RECTANGLE' && node.type !== 'FRAME' && node.type !== 'COMPONENT')
    return no('This preview supports one empty rectangle, frame, or component.');
  if ('children' in node && node.children.length)
    return no('This preview supports one empty rectangle, frame, or component.');
  if (![node.width, node.height].every(n => Number.isFinite(n) && n > 0)) return no('This layer has no visible area.');
  const transform = node.relativeTransform;
  if (!transform?.[0] || !transform[1]) return no('This layer’s transform cannot be read.');
  if (node.rotation || transform[0][0] !== 1 || transform[0][1] !== 0 || transform[1][0] !== 0 || transform[1][1] !== 1)
    return no('Rotated, flipped, or transformed layers cannot be previewed here.');
  if (['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'cornerSmoothing']
    .some(key => key in node && (node as unknown as Record<string, unknown>)[key] !== 0)) return no('Rounded corners cannot be previewed here.');
  let parent: BaseNode | null = node;
  for (let depth = 0; parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT'; parent = parent.parent, depth++) {
    if ('visible' in parent && parent.visible === false) return no('Hidden layers cannot be previewed here.');
    if (depth > 32 || 'isMask' in parent && parent.isMask || 'opacity' in parent && parent.opacity !== 1
      || 'blendMode' in parent && parent.blendMode !== 'NORMAL' && parent.blendMode !== 'PASS_THROUGH'
      || 'effects' in parent && parent.effects.some(effect => effect.visible !== false)
      || 'children' in parent && (parent.children.length > 2000 || parent.children.some(child => 'isMask' in child && child.isMask)))
      return no('Masks, effects, or compositing cannot be previewed here.');
  }
  if ('strokes' in node && node.strokes.some(paint => paint.visible !== false)) return no('Strokes cannot be previewed here.');
  if (!('fills' in node) || !Array.isArray(node.fills)) return no('This layer’s fills cannot be read.');
  const paints = node.fills.filter(paint => paint.visible !== false);
  if (paints.length > 1 || paints.length === 1 && paints[0]!.type !== 'IMAGE') return no('Multiple or non-image fills cannot be previewed here.');
  const paint = paints[0] as ImagePaint | undefined;
  if (paint && (paint.scaleMode !== 'FILL' && paint.scaleMode !== 'FIT')) return no('Crop and Tile paint settings cannot be previewed here.');
  if (paint && (paint.rotation || paint.opacity !== undefined && paint.opacity !== 1 || paint.blendMode && paint.blendMode !== 'NORMAL'
    || paint.imageTransform && !identity(paint.imageTransform) || paint.filters && Object.values(paint.filters).some(value => value !== 0)))
    return no('Paint rotation, transforms, filters, or compositing cannot be previewed here.');
  return { width: node.width, height: node.height, mode: paint?.scaleMode as 'FILL' | 'FIT' ?? 'FILL' };
}

/** Same-hash paint and shape edits must invalidate an open preview, not only image replacements. */
export function fillFingerprint(node: SceneNode | null): unknown {
  if (!node) return null;
  return [fillPreview(node), ...['visible', 'fills', 'relativeTransform', 'opacity', 'blendMode', 'effects', 'strokes', 'isMask', 'cornerRadius',
    'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'cornerSmoothing'].map(key =>
    (node as unknown as Record<string, unknown>)[key])];
}
