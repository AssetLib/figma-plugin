import type { Appearance, CellBinding, Placement, Variants } from './types.js';
import { boundedString, isRecord, positiveDimension, validArm, validState, validUuid } from './validation.js';

// A placements list or variant set the plugin can't use: one plain sentence for people, whatever the detail.
const invalidPlacements = 'The console sent placements the plugin can’t read. Try again.';

function parseVariants(value: unknown): Variants | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'appearance' && key !== 'arm')) {
    throw new Error(invalidPlacements);
  }
  const result: Variants = {};
  if ('appearance' in value) {
    const appearance = value.appearance;
    if (!Array.isArray(appearance) || appearance.length < 1 || appearance.length > 2
      || new Set(appearance).size !== appearance.length
      || appearance.some(item => item !== 'light' && item !== 'dark')) {
      throw new Error(invalidPlacements);
    }
    result.appearance = [...appearance] as Appearance[];
  }
  if ('arm' in value) {
    const arm = value.arm;
    if (!Array.isArray(arm) || arm.length < 1 || arm.length > 4
      || new Set(arm).size !== arm.length || !arm.every(validArm)) {
      throw new Error(invalidPlacements);
    }
    result.arm = [...arm];
  }
  if (!result.appearance && !result.arm) throw new Error(invalidPlacements);
  return result;
}

export function parsePlacements(value: unknown): Placement[] {
  if (!isRecord(value) || !Array.isArray(value.placements)) {
    throw new Error(invalidPlacements);
  }
  const keys = new Set<string>();
  return value.placements.map((item: unknown): Placement => {
    if (!isRecord(item) || !boundedString(item.key, 120) || !boundedString(item.screen, 120)
      || !positiveDimension(item.width) || !Number.isInteger(item.width)
      || !positiveDimension(item.height) || !Number.isInteger(item.height)
      || (item.origin !== 'console' && item.origin !== 'declared')) {
      throw new Error(invalidPlacements);
    }
    if (keys.has(item.key)) throw new Error(invalidPlacements);
    keys.add(item.key);
    let states: string[] | null = null;
    let defaultState: string | null = null;
    if (item.states !== undefined && item.states !== null) {
      if (!Array.isArray(item.states) || item.states.length < 2 || item.states.length > 16
        || new Set(item.states).size !== item.states.length || !item.states.every(validState)
        || typeof item.defaultState !== 'string' || !item.states.includes(item.defaultState)) {
        throw new Error(invalidPlacements);
      }
      states = [...item.states];
      defaultState = item.defaultState;
    } else if (item.defaultState !== undefined && item.defaultState !== null) {
      throw new Error(invalidPlacements);
    }
    return { key: item.key, ...(validUuid(item.slotId) ? { slotId: item.slotId } : {}), screen: item.screen, width: item.width, height: item.height,
      states, defaultState, variants: parseVariants(item.variants), origin: item.origin };
  });
}

export function cellOptions(placement: Placement): {
  states: (string | null)[];
  appearances: (Appearance | null)[];
  arms: (string | null)[];
} {
  return {
    states: [null, ...(placement.states ?? [])],
    appearances: [null, ...(placement.variants?.appearance ?? [])],
    arms: [null, ...(placement.variants?.arm ?? [])],
  };
}

export function validateBinding(placement: Placement, bind: CellBinding): CellBinding {
  if (bind.slotKey !== placement.key) throw new Error('Choose a placement before sending.');
  const options = cellOptions(placement);
  if (!options.states.includes(bind.state)) throw new Error('Choose one of this placement’s states.');
  if (!options.appearances.includes(bind.appearance)) throw new Error('Choose one of this placement’s appearances.');
  if (!options.arms.includes(bind.arm)) throw new Error('Choose one of this placement’s A/B arms.');
  return { slotKey: bind.slotKey, state: bind.state, appearance: bind.appearance, arm: bind.arm };
}
