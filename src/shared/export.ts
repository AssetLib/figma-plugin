import type { ExportSettings, NodeSelection, Placement } from './types.js';
import { positiveDimension } from './validation.js';

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
  return { format: 'PNG', constraint: taller
    ? { type: 'HEIGHT', value: placement.height }
    : { type: 'WIDTH', value: placement.width } };
}
