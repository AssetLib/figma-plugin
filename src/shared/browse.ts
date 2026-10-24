import type { CellCoordinate } from './library.js';
import type { Preferences } from './types.js';
import { isRecord, validArm, validPlacementKey, validState, validUuid } from './validation.js';

export type BrowseChoice = { kind: 'placement'; key: string; cell: CellCoordinate }
  | { kind: 'image'; assetId: string } | { kind: 'file'; nodeId: string };
export type BrowseContext = { query: string; selected: BrowseChoice | null; active: string | null; scroll: number; pages?: number };
export type BrowseResume = { browse: Preferences['browse']; filter: 'all' | 'with' | 'empty'; contexts: Partial<Record<Preferences['browse'], BrowseContext>> };

/** Only bounded identifiers and navigation metadata; never artwork, tokens, or cached list authority. */
export function parseBrowseResume(value: unknown): BrowseResume | null {
  if (!isRecord(value) || !['placements', 'images'].includes(String(value.browse)) || !isRecord(value.contexts)) return null;
  const result: BrowseResume = { browse: value.browse as BrowseResume['browse'], filter: value.filter === 'with' || value.filter === 'empty' ? value.filter : 'all', contexts: {} };
  for (const kind of ['placements', 'images'] as const) {
    const context = value.contexts[kind];
    if (!isRecord(context)) continue;
    const choice = context.selected;
    let selected: BrowseChoice | null = null;
    if (isRecord(choice)) {
      if (kind === 'images' && choice.kind === 'image' && validUuid(choice.assetId)) selected = { kind: 'image', assetId: choice.assetId };
      else if (kind === 'placements' && choice.kind === 'placement' && validPlacementKey(choice.key) && isRecord(choice.cell)) {
        const { state, appearance, arm } = choice.cell;
        if ((state === null || validState(state)) && (appearance === null || appearance === 'light' || appearance === 'dark') && (arm === null || validArm(arm)))
          selected = { kind: 'placement', key: choice.key, cell: { state, appearance, arm } };
      }
    }
    const validActive = kind === 'images' ? validUuid : validPlacementKey;
    result.contexts[kind] = { query: typeof context.query === 'string' ? context.query.slice(0, 120) : '', selected,
      active: validActive(context.active) ? context.active : null,
      scroll: typeof context.scroll === 'number' && Number.isFinite(context.scroll) ? Math.max(0, Math.min(1000000, context.scroll)) : 0,
      ...(kind === 'images' ? { pages: Number.isSafeInteger(context.pages) ? Math.max(1, Math.min(5, context.pages as number)) : 1 } : {}) };
  }
  return result;
}
