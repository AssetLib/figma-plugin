import { parseBrowseResume } from '../shared/browse.js';
import type { UiMessage } from '../shared/protocol.js';
import { main, post } from './state.js';

const KEY = 'assetlib.browse.v1';
let saving = Promise.resolve();
type Message = Extract<UiMessage, { type: 'load-browse' | 'save-browse' }>;
function owner(message: Message): string | null {
  const connection = main.connection;
  return connection && message.connectionGeneration === main.connectionGeneration
    ? message.scope : null;
}
export async function browseMessage(message: Message): Promise<void> {
  const key = owner(message);
  if (message.type === 'save-browse') {
    const value = parseBrowseResume(message.value);
    if (!key || !value) return;
    saving = saving.then(async () => {
      if (owner(message) !== key) return;
      try { await figma.clientStorage.setAsync(KEY, { owner: key, value }); } catch { /* Resume is optional; current browsing still works. */ }
    });
    await saving;
  } else {
    let value = null;
    try {
      await saving;
      const saved = key && await figma.clientStorage.getAsync(KEY);
      if (saved && saved.owner === key && owner(message) === key) value = parseBrowseResume(saved.value);
    } catch { /* An unavailable record starts a fresh browsing session. */ }
    post({ ...message, type: 'browse-loaded', value });
  }
}
