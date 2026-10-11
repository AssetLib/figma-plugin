// The document's identity: the file key a Send records as the art's source and this device keys its sync targets by.
// Figma's own key where the plugin gets one (a development or organization-private plugin), else the key saved on the
// document root, which everyone who opens the file shares, else a link pasted this session that the document couldn't
// keep (a view-only file). A Community plugin never gets figma.fileKey, so a file's link is asked for once per document,
// at its first Send or Sync. A duplicated file keeps its original's identity until its own link is pasted.
import { parseFileIdentity, validFileKey } from '../shared/index.js';
import type { FileIdentity } from '../shared/index.js';
import type { FileState } from '../shared/protocol.js';

export const FILE_KEY = 'assetlib.file.v1';
// The document's relaunch button (Open Assetlib), shown in the properties panel when nothing is selected.
export const OPEN_DESCRIPTION = 'Insert and sync your app’s images';

let session: { fileKey: string; name: string } | null = null;

function liveKey(): string | null {
  try { return validFileKey(figma.fileKey) ? figma.fileKey : null; } catch { return null; }
}
function savedIdentity(): FileIdentity | null {
  try { return parseFileIdentity(figma.root.getPluginData(FILE_KEY)); } catch { return null; }
}
function save(fileKey: string, source: FileIdentity['source']): boolean {
  const identity: FileIdentity = { v: 1, fileKey, source, savedAt: new Date().toISOString(), name: figma.root.name };
  try { figma.root.setPluginData(FILE_KEY, JSON.stringify(identity)); return true; } catch { return false; }
}

/** The file key, and where it came from: Figma, a link pasted this session, or the document. */
export function fileIdentity(): FileState & { fileKey: string | null } {
  const live = liveKey();
  if (live) return { fileKey: live, source: 'figma', name: '' };
  if (session) return { fileKey: session.fileKey, source: 'session', name: session.name };
  const saved = savedIdentity();
  return saved ? { fileKey: saved.fileKey, source: 'document', name: saved.name } : { fileKey: null, source: null, name: '' };
}
export function currentFileKey(): string | null { return fileIdentity().fileKey; }

/** A pasted file link: saved in the document for everyone, or kept for this session where the document refuses it. */
export function linkFile(fileKey: string): 'document' | 'session' {
  if (save(fileKey, 'link')) { session = null; return 'document'; }
  session = { fileKey, name: figma.root.name };
  return 'session';
}

/**
 * Runs with every link the plugin writes, in that edit's undo step: the document keeps Figma's own key (where it has
 * none, or another, as a duplicated file does) and shows Open Assetlib when nothing is selected. Neither may cost the edit.
 */
export function markDocument(): void {
  const live = liveKey();
  if (live && savedIdentity()?.fileKey !== live) save(live, 'figma');
  try { if (!figma.root.getRelaunchData().open) figma.root.setRelaunchData({ open: OPEN_DESCRIPTION }); } catch { /* the button only */ }
}
