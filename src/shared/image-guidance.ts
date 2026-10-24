import { aspectMismatch } from './export.js';
import { fillRendition } from './library.js';
import type { LibraryAsset } from './types.js';
import type { FillPreview } from './protocol.js';

export function imageGuidance(asset: LibraryAsset, target: FillPreview | null): { matches: boolean; labels: string[]; detail: string } | null {
  if (!target || 'reason' in target || ![target.width, target.height].every(n => Number.isFinite(n) && n > 0)) return null;
  const matches = !aspectMismatch(asset, target);
  const rendition = fillRendition(asset, target.width, target.height);
  const labels: string[] = [];
  if (!rendition) return { matches, labels: ['No insertable image'], detail: 'No image version Figma can insert.' };
  if (target.mode === 'FILL' && !matches) labels.push('May crop');
  if (target.mode === 'FIT' && !matches) labels.push('Space around image');
  const ratios = [target.width / rendition.width, target.height / rendition.height];
  if ((target.mode === 'FILL' ? Math.max(...ratios) : Math.min(...ratios)) > 1) labels.push('May need enlargement');
  return { matches, labels, detail: `${target.mode} paint · ${rendition.width} × ${rendition.height} insertable image · enlargement checked at layer size (1×), not display resolution.` };
}
