import type { Appearance, CellBinding, Placement, Variants } from './types.js';
import { boundedString, isRecord, positiveDimension, validArm, validState } from './validation.js';

function parseVariants(value: unknown): Variants | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'appearance' && key !== 'arm')) {
    throw new Error('The console returned an unsupported placement variant axis.');
  }
  const result: Variants = {};
  if ('appearance' in value) {
    const appearance = value.appearance;
    if (!Array.isArray(appearance) || appearance.length < 1 || appearance.length > 2
      || new Set(appearance).size !== appearance.length
      || appearance.some(item => item !== 'light' && item !== 'dark')) {
      throw new Error('The console returned invalid appearance options.');
    }
    result.appearance = [...appearance] as Appearance[];
  }
  if ('arm' in value) {
    const arm = value.arm;
    if (!Array.isArray(arm) || arm.length < 1 || arm.length > 4
      || new Set(arm).size !== arm.length || !arm.every(validArm)) {
      throw new Error('The console returned invalid arm options.');
    }
    result.arm = [...arm];
  }
  if (!result.appearance && !result.arm) throw new Error('The console returned empty placement variants.');
  return result;
}

export function parsePlacements(value: unknown): Placement[] {
  if (!isRecord(value) || !Array.isArray(value.placements)) {
    throw new Error('The console did not return a placements list.');
  }
  const keys = new Set<string>();
  return value.placements.map((item: unknown): Placement => {
    if (!isRecord(item) || !boundedString(item.key, 120) || !boundedString(item.screen, 120)
      || !positiveDimension(item.width) || !Number.isInteger(item.width)
      || !positiveDimension(item.height) || !Number.isInteger(item.height)
      || (item.origin !== 'console' && item.origin !== 'declared')) {
      throw new Error('The console returned an invalid placement.');
    }
    if (keys.has(item.key)) throw new Error('The console returned duplicate placement keys.');
    keys.add(item.key);
    let states: string[] | null = null;
    let defaultState: string | null = null;
    if (item.states !== undefined && item.states !== null) {
      if (!Array.isArray(item.states) || item.states.length < 2 || item.states.length > 16
        || new Set(item.states).size !== item.states.length || !item.states.every(validState)
        || typeof item.defaultState !== 'string' || !item.states.includes(item.defaultState)) {
        throw new Error('The console returned an invalid placement state set.');
      }
      states = [...item.states];
      defaultState = item.defaultState;
    } else if (item.defaultState !== undefined && item.defaultState !== null) {
      throw new Error('The console returned a default state without a state set.');
    }
    return { key: item.key, screen: item.screen, width: item.width, height: item.height,
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
  if (!options.states.includes(bind.state)) throw new Error('This state is not declared by the placement.');
  if (!options.appearances.includes(bind.appearance)) throw new Error('This appearance is not declared by the placement.');
  if (!options.arms.includes(bind.arm)) throw new Error('This arm is not declared by the placement.');
  return { slotKey: bind.slotKey, state: bind.state, appearance: bind.appearance, arm: bind.arm };
}
