import type { ExportSettings, NodeSelection, Placement } from './types.js';
import { isUint8Array, positiveDimension } from './validation.js';

// What Send says when Figma's export can't be used.
export const EXPORT_FAILED = 'Figma couldn’t export this layer. Try again, or flatten it first.';
// A layer, or a placement, without a size to export (main reports a zero-size layer the same way).
export const NO_AREA = 'This layer has no visible area to export.';

function checkDimensions(node: Pick<NodeSelection, 'width' | 'height'>, placement: Pick<Placement, 'width' | 'height'>): void {
  if (![node.width, node.height, placement.width, placement.height].every(positiveDimension)) throw new Error(NO_AREA);
}

export function aspectRatioDifference(node: Pick<NodeSelection, 'width' | 'height'>, placement: Pick<Placement, 'width' | 'height'>): number {
  checkDimensions(node, placement);
  const difference = Math.abs((node.width / node.height) / (placement.width / placement.height) - 1);
  // Avoid warning for an exact 2% change represented as 0.020000000000000018.
  return Math.round(difference * 1e12) / 1e12;
}

// Send and Sync stay disabled while the node's ratio differs from the placement's by more than this.
export const MAX_ASPECT_DIFFERENCE = 0.02;

/** True when Send and Sync must wait for the node to match the placement's ratio. */
export function aspectMismatch(node: Pick<NodeSelection, 'width' | 'height'>, placement: Pick<Placement, 'width' | 'height'>): boolean {
  return aspectRatioDifference(node, placement) > MAX_ASPECT_DIFFERENCE;
}

/** The height that gives a node of this width the placement's ratio: whole pixels, unless rounding misses by more than 2%. */
export function matchedHeight(width: number, placement: Pick<Placement, 'width' | 'height'>): number {
  checkDimensions({ width, height: 1 }, placement);
  const exact = (width * placement.height) / placement.width;
  const whole = Math.round(exact);
  if (whole >= 1 && !aspectMismatch({ width, height: whole }, placement)) return whole;
  return Math.max(0.01, Math.round(exact * 100) / 100);
}

/** A size for people: at most two decimals, no trailing zeros. */
export function sizeLabel(size: Pick<NodeSelection, 'width' | 'height'>): string {
  return `${Number(size.width.toFixed(2))} × ${Number(size.height.toFixed(2))}`;
}

/** The placement's ratio as "2.44 : 1", with no-break spaces, so a narrow window never wraps it at the colon. */
export function ratioLabel(placement: Pick<Placement, 'width' | 'height'>): string {
  return `${Number((placement.width / placement.height).toFixed(2))}\u00a0:\u00a01`;
}

export function chooseExportSettings(node: Pick<NodeSelection, 'width' | 'height'>, placement: Pick<Placement, 'width' | 'height'>): ExportSettings {
  checkDimensions(node, placement);
  // Phase 3 G1 explicitly prescribes HEIGHT for a proportionally taller node.
  const taller = node.height / node.width > placement.height / placement.width;
  return { format: 'PNG', useAbsoluteBounds: true, constraint: taller
    ? { type: 'HEIGHT', value: placement.height }
    : { type: 'WIDTH', value: placement.width } };
}

// The signature and IHDR header fields, or null; dimensions are returned unchecked.
function readIhdr(bytes: Uint8Array): { width: number; height: number } | null {
  // The signature and complete first IHDR chunk occupy 33 bytes, including its CRC.
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!isUint8Array(bytes) || bytes.byteLength < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
function validPngSize(size: { width: number; height: number }): boolean {
  return size.width > 0 && size.height > 0 && size.width <= 0x7fffffff && size.height <= 0x7fffffff;
}

/** PNG dimensions from the IHDR header, or null for anything that is not a well-formed PNG header. Never throws. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const size = readIhdr(bytes);
  return size && validPngSize(size) ? size : null;
}

export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const size = readIhdr(bytes);
  // Figma wrote something that is not a readable PNG (no complete IHDR header, or impossible dimensions).
  if (!size || !validPngSize(size)) throw new Error(EXPORT_FAILED);
  return size;
}
