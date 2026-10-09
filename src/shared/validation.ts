export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

export function validFileKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:;-]{1,64}$/.test(value);
}

const reservedArms = new Set(['control', 'any', 'constructor', 'prototype', '__proto__']);
export function validArm(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,19}$/.test(value) && !reservedArms.has(value);
}

export function validState(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value)
    && !['constructor', 'prototype', '__proto__'].includes(value);
}
