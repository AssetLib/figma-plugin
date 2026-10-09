import type { CellBinding, DraftBody, DraftResult, ExportSettings, NodeSelection, Placement } from './types.js';
import { chooseExportSettings } from './export.js';
import { validateBinding } from './placements.js';
import { boundedString, isRecord, positiveDimension, validArm, validFileKey, validNodeId, validState } from './validation.js';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_BODY_BYTES = 6 * 1024 * 1024;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new Error('The selected node exported an empty PNG.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The export is too large (maximum 4 MiB). Use a smaller export constraint.');
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    chunk += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!
      + (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!)
      + (c === undefined ? '=' : alphabet[c & 63]!);
    if (chunk.length >= 16384) { chunks.push(chunk); chunk = ''; }
  }
  chunks.push(chunk);
  return chunks.join('');
}

export function decodedBase64Length(value: string): number {
  if (!value || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('The exported image is not valid base64.');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.slice(0, value.length - padding).includes('=')) throw new Error('The exported image is not valid base64.');
  const finalValue = alphabet.indexOf(value[value.length - padding - 1]!);
  if ((padding === 2 && (finalValue & 15) !== 0) || (padding === 1 && (finalValue & 3) !== 0)) {
    throw new Error('The exported image is not canonical base64.');
  }
  return (value.length / 4) * 3 - padding;
}

export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function assertDraftBodyLimit(value: unknown): void {
  if (utf8Length(JSON.stringify(value)) > MAX_BODY_BYTES) throw new Error('The draft request is too large (maximum 6 MiB). Use a smaller export constraint.');
}

export function buildDraftBody(input: {
  node: NodeSelection;
  fileKey: string;
  placement: Placement;
  bind: CellBinding;
  bytesBase64: string;
  settings: ExportSettings;
  rebind: boolean;
}): DraftBody {
  const { node, fileKey, placement, bytesBase64, settings, rebind } = input;
  if (!validFileKey(fileKey)) throw new Error('Enter a valid Figma file URL before sending.');
  if (!validNodeId(node.id)) throw new Error('The selected node id cannot be sent to the console.');
  if (typeof node.name !== 'string') throw new Error('The selected node has no valid name.');
  const expected = chooseExportSettings(node, placement);
  if (settings.format !== 'PNG' || settings.useAbsoluteBounds !== true
    || settings.constraint.type !== expected.constraint.type || settings.constraint.value !== expected.constraint.value) {
    throw new Error('The export settings no longer match the selected node and placement. Export again.');
  }
  if (decodedBase64Length(bytesBase64) > MAX_IMAGE_BYTES) throw new Error('The export is too large (maximum 4 MiB). Use a smaller export constraint.');
  const body: DraftBody = {
    schemaVersion: 1,
    name: (node.name.trim() || placement.key).slice(0, 120),
    mime: 'image/png',
    imageBase64: bytesBase64,
    source: { provider: 'figma', fileKey, nodeId: node.id, nodeName: node.name.slice(0, 200), versionId: null,
      export: { format: 'PNG', constraint: { ...settings.constraint } } },
    bind: validateBinding(placement, input.bind),
    rebind,
  };
  assertDraftBodyLimit(body);
  return body;
}

function parseBinding(value: unknown): CellBinding {
  if (!isRecord(value) || !boundedString(value.slotKey, 120)
    || (value.state !== null && !validState(value.state))
    || (value.appearance !== null && value.appearance !== 'light' && value.appearance !== 'dark')
    || (value.arm !== null && !validArm(value.arm))) throw new Error('The console returned an invalid draft binding.');
  return { slotKey: value.slotKey, state: value.state, appearance: value.appearance, arm: value.arm };
}

export function parseDraftResponse(value: unknown): DraftResult {
  if (!isRecord(value) || !isRecord(value.asset)) throw new Error('The console did not return the created draft asset.');
  const asset = value.asset;
  if (!boundedString(asset.id, 128) || !boundedString(asset.name, 120)
    || !positiveDimension(asset.width) || !positiveDimension(asset.height)
    || typeof asset.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(asset.sha256)
    || typeof asset.renditions !== 'number' || !Number.isInteger(asset.renditions) || asset.renditions < 0) {
    throw new Error('The console returned an invalid draft asset.');
  }
  if (!Array.isArray(value.rebound) || (value.bindError !== null && typeof value.bindError !== 'string')) {
    throw new Error('The console returned an invalid draft result.');
  }
  let previous: DraftResult['previous'] = null;
  if (value.previous !== null) {
    if (!isRecord(value.previous) || !boundedString(value.previous.assetId, 128) || !Array.isArray(value.previous.boundTo)) {
      throw new Error('The console returned invalid previous-source details.');
    }
    previous = { assetId: value.previous.assetId, boundTo: value.previous.boundTo.map(parseBinding) };
  }
  return {
    asset: { id: asset.id, name: asset.name, width: asset.width, height: asset.height, sha256: asset.sha256, renditions: asset.renditions },
    previous,
    bound: value.bound === null ? null : parseBinding(value.bound),
    bindError: value.bindError,
    rebound: value.rebound.map(parseBinding),
  };
}
