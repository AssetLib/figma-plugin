import { element, scheduleRender, setUnavailable } from './dom.js';
import { duplicateDestinations, resolveDuplicate } from './send-queue.js';
import { inspectSendPreview, localPreviewFor } from './send-preview.js';
import { actionsBlocked, hasCurrentSelection, state } from './state.js';
import { bindingLabel } from './send.js';

let signature = '';
const pictures = new Map<string, HTMLImageElement>();
export function renderSendConflicts(): void {
  const groups = duplicateDestinations(), root = element('send-conflicts'), list = element('send-conflict-list');
  root.hidden = state.prefs.tab !== 'send' || !hasCurrentSelection() || !groups.length;
  if (root.hidden) { signature = ''; pictures.clear(); list.replaceChildren(); return; }
  element('send-conflict-summary').textContent = `${groups.length} destination conflict${groups.length === 1 ? '' : 's'} · keep one layer per cell`;
  const generation = state.connectionGeneration, revision = state.selection.revision;
  const paint = () => {
    for (const [id, image] of pictures) {
      const src = localPreviewFor(id);
      if (!src) image.removeAttribute('src'); else if (image.getAttribute('src') !== src) image.src = src;
    }
  };
  const key = JSON.stringify([generation, revision, actionsBlocked(), groups.map(group => group.map(row => [row.node, row.target]))]);
  if (key === signature) { paint(); return; }
  signature = key;
  pictures.clear();
  list.replaceChildren(...groups.map(group => {
    const section = document.createElement('section'), title = document.createElement('p');
    const target = { ...group[0]!.target! }, members = group.map(row => row.node.id);
    title.className = 'title'; title.textContent = bindingLabel(target); section.append(title);
    for (const row of group) {
      const item = document.createElement('div'); item.className = 'conflict-layer';
      const image = document.createElement('img'); pictures.set(row.node.id, image);
      image.alt = row.node.name;
      const name = document.createElement('p'); name.textContent = row.node.name; name.className = 'title';
      const controls = document.createElement('div'); controls.className = 'inspector-actions';
      const act = (label: string, action: 'keep' | 'choose' | 'skip', preview = false) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary small'; button.textContent = label;
        setUnavailable(button, actionsBlocked() || preview && Boolean(row.reason));
        button.addEventListener('click', () => {
          if (generation !== state.connectionGeneration || revision !== state.selection.revision || preview && row.reason
            || !resolveDuplicate(row.node.id, target, members, action)) return;
          if (preview) inspectSendPreview(button);
          else if (action === 'choose') { element('placement-toggle').click(); element('placement-toggle').focus(); }
          else { scheduleRender(); element('placement-toggle').focus(); }
        });
        return button;
      };
      controls.append(act('Preview layer', 'choose', true), act('Keep this layer', 'keep'), act('Choose another cell', 'choose'), act('Skip', 'skip'));
      item.append(image, name, controls); section.append(item);
    }
    return section;
  }));
  paint();
}
