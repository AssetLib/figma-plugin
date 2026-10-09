import type { ExportSettings, NodeSelection, Placement } from './types.js';
import { isUint8Array, positiveDimension } from './validation.js';

function checkDimensions(node: Pick<NodeSelection, 'width' | 'height'>, placement: Pick<Placement, 'width' | 'height'>): void {
  if (![node.width, node.height, placement.width, placement.height].every(positiveDimension)) {
    throw new Error('Select a node with a non-zero width and height and a valid placement canvas.');
  }
}

export function aspectRatioDifference(node: Pick<NodeSelection, 'width' | 'height'>, placement: Pick<Placement, 'width' | 'height'>): number {
  checkDimensions(node, placement);
  const difference = Math.abs((node.width / node.height) / (placement.width / placement.height) - 1);
  // Avoid warning for an exact 2% change represented as 0.020000000000000018.
  return Math.round(difference * 1e12) / 1e12;
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
  if (!size) throw new Error('Figma returned a PNG with an invalid or incomplete IHDR header. Export the artwork again.');
  if (!validPngSize(size)) throw new Error('Figma returned a PNG with invalid dimensions. Export the artwork again.');
  return size;
}
