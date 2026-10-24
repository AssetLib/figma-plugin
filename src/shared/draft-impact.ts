import type { PlacementArtwork } from './types.js';
import type { CellCoordinate } from './library.js';

type Resolved = { assetId: string | null; via: { arm: string | null; appearance: CellCoordinate['appearance'] } } | null;
export type DraftImpact = {
  cells: { cell: CellCoordinate; before: Resolved; after: Resolved }[];
  missingStates: (string | null)[]; fingerprint: string;
};
const replacement = '$selected-figma-layer';
const familyKey = (cell: Pick<CellCoordinate, 'arm' | 'appearance'>) => JSON.stringify([cell.arm, cell.appearance]);
const coordinateKey = (cell: CellCoordinate) => JSON.stringify([cell.state, cell.arm, cell.appearance]);

/** Reconstruct explicit families only from a complete resolved matrix. First nonempty family wins every state. */
export function draftImpact(placement: PlacementArtwork, target: CellCoordinate): DraftImpact | null {
  const states = placement.states ?? [null];
  const coordinates = states.flatMap(state => [null, ...(placement.variants?.arm ?? [])].flatMap(arm =>
    [null, ...(placement.variants?.appearance ?? [])].map(appearance => ({ state, arm, appearance }))));
  if (coordinates.length !== placement.cells.length || coordinates.length > 240) return null;
  const cells = new Map(placement.cells.map(cell => [coordinateKey(cell), cell]));
  if (cells.size !== coordinates.length || coordinates.some(cell => !cells.has(coordinateKey(cell)))) return null;
  target = { ...target, state: target.state ?? placement.defaultState };
  if (!cells.has(coordinateKey(target))) return null;
  const families = new Map<string, Map<string | null, string>>();
  for (const cell of placement.cells) if (cell.draft && familyKey(cell.draft.via) === familyKey(cell)) {
    const key = familyKey(cell), family = families.get(key) ?? new Map<string | null, string>();
    family.set(cell.state, cell.draft.assetId); families.set(key, family);
  }
  const resolve = (cell: CellCoordinate): Resolved => {
    for (const via of [cell, { arm: cell.arm, appearance: null }, { arm: null, appearance: cell.appearance }, { arm: null, appearance: null }]) {
      const family = families.get(familyKey(via));
      if (family?.size) return { assetId: family.get(cell.state) ?? null, via: { arm: via.arm, appearance: via.appearance } };
    }
    return null;
  };
  const before = coordinates.map(resolve);
  // Sparse or inconsistent older responses must not claim an exact zero impact.
  if (coordinates.some((cell, i) => {
    const declared = cells.get(coordinateKey(cell))!.draft, resolved = before[i];
    return declared ? declared.assetId !== resolved?.assetId || familyKey(declared.via) !== familyKey(resolved!.via) : Boolean(resolved?.assetId);
  })) return null;
  const key = familyKey(target), family = families.get(key) ?? new Map<string | null, string>();
  family.set(target.state, replacement); families.set(key, family);
  const changed: DraftImpact['cells'] = [];
  coordinates.forEach((cell, i) => {
    const after = resolve(cell), previous = before[i] ?? null;
    if (coordinateKey(cell) !== coordinateKey(target) && JSON.stringify(previous) !== JSON.stringify(after)) changed.push({ cell, before: previous, after });
  });
  const missingStates = states.filter(state => !family.has(state));
  return { cells: changed, missingStates, fingerprint: JSON.stringify([changed, missingStates]) };
}
