import type { ArtworkResponse, EnvironmentName, Placement } from './types.js';

export const usageContract = (item: Placement) => JSON.stringify([item.key, item.slotId, item.screen, item.width, item.height, item.states, item.defaultState, item.variants]);

/** Artwork lists current catalog coordinates; removed release-only placements are outside this scope. */
export function imageUsage(artwork: ArtworkResponse, catalog: readonly Placement[] | null, assetId: string) {
  const current = new Map(catalog?.map(item => [item.key, usageContract(item)]));
  let complete = catalog !== null && current.size === artwork.placements.length;
  const uses = artwork.placements.flatMap(placement => {
    if (current.get(placement.key) !== usageContract(placement)) { complete = false; return []; }
    const expected = (placement.states?.length ?? 1) * (1 + (placement.variants?.arm?.length ?? 0)) * (1 + (placement.variants?.appearance?.length ?? 0));
    if (placement.cells.length !== expected) complete = false;
    const environments = (['draft', 'staging', 'production'] as EnvironmentName[]).filter(environment => {
      if (environment !== 'draft' && !artwork.environments[environment]) {
        if (placement.cells.some(cell => cell[environment])) complete = false;
        return false;
      }
      return placement.cells.some(cell => cell[environment]?.assetId === assetId);
    });
    for (const cell of placement.cells) for (const environment of ['draft', 'staging', 'production'] as const) {
      const art = cell[environment]; if (art && !artwork.assets[art.assetId]) complete = false;
    }
    return environments.length ? [{ placement, environments }] : [];
  });
  return { complete, uses };
}
