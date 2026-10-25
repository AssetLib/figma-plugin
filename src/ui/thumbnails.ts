// Previews: the smallest WebP (else PNG) as a data: URL, since <img> cannot send the bearer header.
// Only list images within 300 px of the list's view load, the latest to scroll in first; an image that scrolls away
// before its request starts gives up its place. The footer's image is always in view. A network error or 5xx is
// retried twice; Refresh retries every failed preview.
import { encodeBase64, renditionPath, thumbnailRendition } from '../shared/index.js';
import type { LibraryAsset, RenditionInfo } from '../shared/index.js';
import { markConnected } from './connection.js';
import { element, scheduleRender } from './dom.js';
import { send } from './http.js';
import { state } from './state.js';

type ThumbnailJob = { assetId: string; rendition: RenditionInfo };
const THUMBNAIL_RETRY_DELAYS: readonly number[] = [1000, 4000];
// sha256 → data: URL for this connection generation, at most 200 (oldest dropped first).
const thumbnails = new Map<string, string>();
let thumbnailChars = 0;
const thumbnailWaiting = new Map<string, Set<HTMLImageElement>>();
const thumbnailJobs = new WeakMap<Element, ThumbnailJob>();
// Images the observer reports within the margin; without an observer every waiting image counts as visible.
const thumbnailVisible = new Set<Element>();
// Images outside the scrolling list (the footer's), which are in view whenever they show.
const alwaysVisible = new WeakSet<Element>();
const thumbnailActive = new Set<string>();
const thumbnailRetrying = new Set<string>();
const thumbnailRetries = new Map<string, number>();
const thumbnailFailed = new Set<string>();
// The images inside the current rows and tiles, so a rebuild can stop observing them.
const listImages = new Map<Element, HTMLImageElement[]>();
// Jobs not yet started; the last one is taken first.
let thumbnailQueue: ThumbnailJob[] = [];
let thumbnailsPaused = false;
let thumbnailEpoch = 0;
const thumbnailObservers = new Map<Element, IntersectionObserver>();

function mediaType(value: string): string { return value.split(';')[0]!.trim().toLowerCase(); }

export function resetThumbnails(): void {
  thumbnails.clear(); thumbnailChars = 0; thumbnailWaiting.clear(); thumbnailVisible.clear(); thumbnailActive.clear(); thumbnailRetrying.clear();
  thumbnailRetries.clear(); thumbnailFailed.clear(); thumbnailQueue = []; listImages.clear();
  thumbnailsPaused = false; thumbnailEpoch += 1; state.previewNote = '';
  for (const observer of thumbnailObservers.values()) observer.disconnect();
  thumbnailObservers.clear();
}
function observingThumbnails(): boolean { return typeof IntersectionObserver === 'function'; }
function thumbnailWanted(sha256: string): boolean {
  for (const img of thumbnailWaiting.get(sha256) ?? []) if (!observingThumbnails() || thumbnailVisible.has(img) || alwaysVisible.has(img)) return true;
  return false;
}
/** The image no longer waits for the preview it showed. */
function stopWaiting(img: HTMLImageElement): void {
  const sha256 = img.getAttribute('data-sha');
  const waiting = sha256 ? thumbnailWaiting.get(sha256) : undefined;
  waiting?.delete(img);
  if (sha256 && waiting && !waiting.size) thumbnailWaiting.delete(sha256);
}
export function releaseThumbnail(img: HTMLImageElement, root: HTMLElement): void {
  thumbnailObservers.get(root)?.unobserve(img); thumbnailVisible.delete(img); stopWaiting(img); pruneThumbnails();
  img.removeAttribute('src'); img.removeAttribute('data-sha');
}
/** Drops jobs not yet started whose images all left the view or the list. */
function pruneThumbnails(): void {
  thumbnailQueue = thumbnailQueue.filter(job => thumbnailWanted(job.rendition.sha256));
}
/** Shows an asset's preview in `img`. A list image (`observed`) loads once it nears the list's view; any other at once. */
export function showThumbnail(img: HTMLImageElement, asset: LibraryAsset | null, observed: boolean | HTMLElement = false, large = false): void {
  const rendition = asset ? thumbnailRendition(asset, large) : null;
  const previous = img.getAttribute('data-sha');
  if (previous && previous !== rendition?.sha256) { stopWaiting(img); pruneThumbnails(); }
  // data-sha="" marks an image with no preview at all; it, like a failed preview, stays a plain placeholder.
  if (!asset || !rendition) { img.setAttribute('data-sha', ''); img.removeAttribute('src'); return; }
  if (previous === rendition.sha256 && img.src) return;
  img.setAttribute('data-sha', rendition.sha256);
  const cached = thumbnails.get(rendition.sha256);
  if (cached) { img.src = cached; return; }
  img.removeAttribute('src');
  if (thumbnailFailed.has(rendition.sha256)) return;
  const waiting = thumbnailWaiting.get(rendition.sha256) ?? new Set<HTMLImageElement>();
  waiting.add(img);
  thumbnailWaiting.set(rendition.sha256, waiting);
  const job = { assetId: asset.id, rendition };
  thumbnailJobs.set(img, job);
  if (!observingThumbnails() || !observed) { alwaysVisible.add(img); queueThumbnail(job); pumpThumbnails(); return; }
  // The list scrolls inside #list-region, so that is the root: the 300 px lookahead applies to its view. (An explicit
  // root also keeps the margin in Figma's cross-origin iframe, where the implicit root ignores it.)
  const root = observed === true ? element('list-region') : observed;
  let observer = thumbnailObservers.get(root);
  if (!observer) { observer = new IntersectionObserver(thumbnailsIntersected, { root, rootMargin: '300px 0px' }); thumbnailObservers.set(root, observer); }
  observer.observe(img);
}
function thumbnailsIntersected(entries: IntersectionObserverEntry[]): void {
  const shown: ThumbnailJob[] = [];
  let hidden = false;
  for (const entry of entries) {
    if (!entry.isIntersecting) { hidden = thumbnailVisible.delete(entry.target) || hidden; continue; }
    thumbnailVisible.add(entry.target);
    const job = thumbnailJobs.get(entry.target);
    if (job && entry.target.getAttribute('data-sha') === job.rendition.sha256) shown.push(job);
  }
  if (hidden) pruneThumbnails();
  // Entries arrive in document order; queued in reverse, one batch loads top to bottom, ahead of older batches.
  for (const job of shown.reverse()) queueThumbnail(job);
  pumpThumbnails();
}
/** Queues a job as the newest, unless its preview is loaded, loading, waiting to retry, or failed. */
function queueThumbnail(job: ThumbnailJob): void {
  const { sha256 } = job.rendition;
  if (thumbnails.has(sha256) || thumbnailActive.has(sha256) || thumbnailRetrying.has(sha256) || thumbnailFailed.has(sha256)) return;
  thumbnailQueue = thumbnailQueue.filter(item => item.rendition.sha256 !== sha256);
  thumbnailQueue.push(job);
}
function pumpThumbnails(): void {
  while (!thumbnailsPaused && thumbnailActive.size < 3) {
    const job = thumbnailQueue.pop();
    if (!job) return;
    const { sha256 } = job.rendition;
    if (!thumbnailWanted(sha256)) continue;
    const epoch = thumbnailEpoch;
    thumbnailActive.add(sha256);
    void loadThumbnail(job, epoch).then(outcome => {
      if (epoch !== thumbnailEpoch) return;
      thumbnailActive.delete(sha256);
      if (outcome === 'limited') pauseThumbnails(job, epoch);
      else if (outcome === 'retry') retryThumbnail(job, epoch);
      pumpThumbnails();
    });
  }
}
/** HTTP 429 pauses every preview for 15 s; the job goes back on the queue. */
function pauseThumbnails(job: ThumbnailJob, epoch: number): void {
  queueThumbnail(job);
  if (thumbnailsPaused) return;
  thumbnailsPaused = true;
  state.previewNote = 'Previews paused: too many requests. They resume shortly.';
  scheduleRender();
  window.setTimeout(() => {
    if (epoch !== thumbnailEpoch) return;
    thumbnailsPaused = false; state.previewNote = ''; scheduleRender(); pumpThumbnails();
  }, 15000);
}
/** A network error or 5xx: tries again after 1 s, then 4 s, if an image still wants it; then it fails until Refresh. */
function retryThumbnail(job: ThumbnailJob, epoch: number): void {
  const { sha256 } = job.rendition;
  const attempt = thumbnailRetries.get(sha256) ?? 0;
  const delay = THUMBNAIL_RETRY_DELAYS[attempt];
  if (delay === undefined) { failThumbnail(sha256); return; }
  thumbnailRetries.set(sha256, attempt + 1);
  thumbnailRetrying.add(sha256);
  window.setTimeout(() => {
    if (epoch !== thumbnailEpoch) return;
    thumbnailRetrying.delete(sha256);
    // An image that scrolls back later queues it again, with the retries left.
    if (thumbnailWanted(sha256)) { queueThumbnail(job); pumpThumbnails(); }
  }, delay);
}
/** Never rejects. */
async function loadThumbnail(job: ThumbnailJob, epoch: number): Promise<'done' | 'retry' | 'limited' | 'failed'> {
  const config = state.connection;
  if (!config) return 'done';
  const { sha256, mime, bytes } = job.rendition;
  const attention = state.attentionCount;
  let result: Awaited<ReturnType<typeof send>>;
  // Previews keep their own retry and pause rules, so the request itself is tried once.
  try { result = await send(config, { path: renditionPath(job.assetId, sha256), bytes, retry: false }); }
  catch { failThumbnail(sha256); return 'failed'; }
  if (epoch !== thumbnailEpoch || result.kind === 'aborted') return 'done';
  if (result.kind === 'network' || result.kind === 'timeout' || result.status >= 500) return 'retry';
  if (result.status === 429) return 'limited';
  // Any other failure leaves the neutral placeholder; previews never use the error line.
  if (result.status !== 200 || mediaType(result.contentType) !== mime || result.bytes.byteLength !== bytes) { failThumbnail(sha256); return 'failed'; }
  // A preview already in flight when a read failed says nothing about the connection now.
  if (attention === state.attentionCount) markConnected();
  const url = `data:${mime};base64,${encodeBase64(result.bytes)}`;
  // An evicted preview is fetched again if a row shows it later.
  while (thumbnails.size && (thumbnails.size >= 200 || thumbnailChars + url.length > 8 * 1024 * 1024)) {
    const oldest = thumbnails.keys().next().value!;
    thumbnailChars -= thumbnails.get(oldest)!.length; thumbnails.delete(oldest);
  }
  thumbnails.set(sha256, url); thumbnailChars += url.length;
  thumbnailRetries.delete(sha256);
  for (const img of thumbnailWaiting.get(sha256) ?? []) if (img.getAttribute('data-sha') === sha256) img.src = url;
  thumbnailWaiting.delete(sha256);
  return 'done';
}
function failThumbnail(sha256: string): void { thumbnailFailed.add(sha256); thumbnailRetries.delete(sha256); thumbnailWaiting.delete(sha256); }

/** Refresh: failed previews are tried again when their rows are rebuilt. */
export function retryFailedThumbnails(): void { thumbnailFailed.clear(); thumbnailRetries.clear(); }

/** A row or tile's thumbnail; `slot` draws an empty slot for a cell with nothing in this environment. */
export function thumbnailFrame(asset: LibraryAsset | null, slot = false, ratio?: { width: number; height: number }, observed: boolean | HTMLElement = true, bounds = { width: 56, height: 40 }): HTMLElement {
  const frame = document.createElement('span');
  frame.className = slot ? 'thumb slot' : 'thumb';
  if (ratio) {
    frame.style.width = `${Math.max(8, Math.round(Math.min(bounds.width, bounds.height * ratio.width / ratio.height)))}px`;
    frame.style.height = `${Math.max(8, Math.round(Math.min(bounds.height, bounds.width * ratio.height / ratio.width)))}px`;
  }
  const img = document.createElement('img');
  img.alt = '';
  // The row or tile is what drags onto the canvas, never its preview's data: URL.
  img.draggable = false;
  frame.append(img);
  if (observed) {
    const root = observed === true ? element('list-region') : observed;
    const images = listImages.get(root) ?? []; images.push(img); listImages.set(root, images);
  }
  showThumbnail(img, asset, observed);
  return frame;
}

/** Before the list is rebuilt: its images stop waiting for previews, and jobs only they wanted are dropped. */
export function releaseListImages(root: HTMLElement = element('list-region')): void {
  for (const img of listImages.get(root) ?? []) { thumbnailObservers.get(root)?.unobserve(img); thumbnailVisible.delete(img); stopWaiting(img); }
  listImages.delete(root);
  pruneThumbnails();
}
