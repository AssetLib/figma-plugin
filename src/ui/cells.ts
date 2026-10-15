// The footer's cell radiogroup. Cells choose art; only Enter or a double-click inserts it.
import { appearanceLabel, artworkAsset, environmentLabel, sameCoordinate } from '../shared/index.js';
import type { ArtworkResponse, CellCoordinate, EnvironmentName, PlacementArtwork } from '../shared/index.js';
import { cellAxes } from './infile.js';
import { element } from './dom.js';
import { thumbnailFrame } from './thumbnails.js';

let previous: PlacementArtwork | null = null, environment: EnvironmentName | null = null;
let radios: { element: HTMLElement; cell: CellCoordinate; row: number; column: number }[] = [];
let choose: (cell: CellCoordinate) => void, insert: () => void;
export function renderCells(placement: PlacementArtwork | null, cell: CellCoordinate | null, shown: EnvironmentName,
  artwork: ArtworkResponse | null, onChoose: (cell: CellCoordinate) => void, onInsert: () => void): void {
  const strip = element('insert-cells');
  const focused = radios.find(radio => radio.element === document.activeElement)?.cell;
  strip.hidden = !placement || placement.cells.length <= 1;
  choose = onChoose; insert = onInsert;
  if (previous !== placement || environment !== shown) {
    previous = placement; environment = shown; radios = []; strip.replaceChildren();
    if (placement && artwork && !strip.hidden) {
      const states = [placement.defaultState, ...(placement.states ?? [])].filter((value, i, values) => values.indexOf(value) === i && placement.cells.some(cell => cell.state === value));
      const arms = [null, ...(placement.variants?.arm ?? [])];
      const columns = arms.flatMap(arm => ([null, 'light', 'dark'] as const).filter(appearance => placement.cells.some(cell => cell.arm === arm && cell.appearance === appearance)).map(appearance => ({ arm, appearance })));
      const stateColumn = states.length > 1;
      const manyArms = new Set(columns.map(column => column.arm)).size > 1;
      const manyAppearances = new Set(columns.map(column => column.appearance)).size > 1;
      strip.style.gridTemplateColumns = `${stateColumn ? 'minmax(0, 64px) ' : ''}repeat(${columns.length}, minmax(64px, 1fr))`;
      const header = (text: string, state = false) => { const item = document.createElement('span'); item.className = state ? 'cell-header cell-state' : 'cell-header'; item.textContent = text; item.title = text; item.setAttribute('aria-hidden', 'true'); return item; };
      if (columns.length > 1) {
        if (stateColumn) strip.append(header(''));
        for (const column of columns) strip.append(header([manyArms ? column.arm ?? 'Control' : '', manyAppearances ? appearanceLabel(column.appearance) : ''].filter(Boolean).join('\n')));
      }
      states.forEach((state, row) => {
        if (stateColumn) strip.append(header(state ?? 'Default', true));
        columns.forEach((column, col) => {
          const value = placement.cells.find(cell => cell.state === state && cell.arm === column.arm && cell.appearance === column.appearance);
          if (!value) { strip.append(header('')); return; }
          const art = value[shown];
          const inherited = art && (art.via.arm !== value.arm || art.via.appearance !== value.appearance);
          const label = (cellAxes(placement, value) || 'Default') + (inherited ? `, inherits ${art.via.arm ?? 'Control'} · ${appearanceLabel(art.via.appearance)} art` : !art ? `, no image in ${environmentLabel(shown)}` : '');
          const radio = document.createElement('div'); radio.className = 'cell'; radio.setAttribute('role', 'radio'); radio.setAttribute('aria-label', label); radio.title = label;
          for (const axis of ['state', 'appearance', 'arm'] as const) radio.setAttribute(`data-${axis}`, value[axis] ?? '');
          const thumb = thumbnailFrame(artworkAsset(artwork, art), !art, placement, false);
          if (inherited) thumb.className += ' inherits';
          radio.append(thumb);
          radio.addEventListener('click', () => { choose(value); radio.focus(); });
          radio.addEventListener('dblclick', () => { choose(value); insert(); });
          radio.addEventListener('keydown', event => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const peers = radios.filter(item => item.row === row);
            const index = peers.findIndex(item => item.element === radio);
            let next: typeof radios[number] | undefined;
            switch (event.key) {
              case 'ArrowLeft': next = peers[index - 1]; break;
              case 'ArrowRight': next = peers[index + 1]; break;
              case 'Home': next = peers[0]; break;
              case 'End': next = peers[peers.length - 1]; break;
              case 'ArrowUp': case 'ArrowDown': {
                const candidates = radios.filter(item => item.row === row + (event.key === 'ArrowUp' ? -1 : 1));
                next = candidates.sort((a, b) => Math.abs(a.column - col) - Math.abs(b.column - col))[0]; break;
              }
              case ' ': event.preventDefault(); choose(value); return;
              case 'Enter': event.preventDefault(); if (!event.repeat) { choose(value); insert(); } return;
              default: return;
            }
            event.preventDefault();
            if (next) { choose(next.cell); next.element.focus(); next.element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
          });
          radios.push({ element: radio, cell: value, row, column: col }); strip.append(radio);
        });
      });
    }
  }
  for (const radio of radios) {
    const checked = Boolean(placement && cell && sameCoordinate(placement, radio.cell, cell));
    radio.element.setAttribute('aria-checked', String(checked)); radio.element.setAttribute('tabindex', checked ? '0' : '-1');
    if (focused && placement && sameCoordinate(placement, radio.cell, focused) && !strip.hidden) radio.element.focus({ preventScroll: true });
  }
}
