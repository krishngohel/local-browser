import type { GridFrame } from "../../shared/types";
import { maybe } from "./dom";

/**
 * Live tile grid for OSR ("applications") tabs.
 *
 * Each tile is a `<canvas>` painted from `grid:frame` events (~12/s per tile, see
 * `GRID_FPS` in `src/main/browser.ts`). Visibility and the tile set are driven by
 * `syncGrid`, called from every `onState` update with the current OSR tab ids — the grid
 * shows for as long as any OSR tab is open, not tied to `apps_session_start`/`_end`, since
 * `apps_session_end({ close: false })` deliberately leaves tabs open outside any tracked
 * session. Input forwarding to a focused tile is out of scope: this is for watching, not
 * taking over.
 */

type Tile = {
  tabId: string;
  wrapper: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: HTMLImageElement;
};

const tiles = new Map<string, Tile>();
let container: HTMLElement | null = null;
let focusedTabId: string | null = null;
/**
 * The OSR tab ids `syncGrid` most recently said are open. A tab's `BrowserWindow` can emit a
 * final `paint` (and therefore a `grid:frame`) after it is already gone from the tab list —
 * `grid:frame` and the `state` broadcast are separate IPC channels with no ordering guarantee
 * between them — so frames for anything outside this set are dropped rather than silently
 * resurrecting a tile `syncGrid` already removed (or never knew about).
 */
let knownTabIds = new Set<string>();

/** Wires the frame stream. Call once at startup; the grid starts hidden until `syncGrid` says otherwise. */
export function initGrid(): void {
  container = maybe<HTMLElement>("apps-grid");
  window.lb.onGridFrame(({ tabId, dataUrl, width, height }: GridFrame) => {
    if (!knownTabIds.has(tabId)) return;
    const tile = tiles.get(tabId) ?? createTile(tabId);
    if (!tile) return;
    if (tile.canvas.width !== width || tile.canvas.height !== height) {
      tile.canvas.width = width;
      tile.canvas.height = height;
    }
    tile.img.onload = () => tile.ctx.drawImage(tile.img, 0, 0, width, height);
    tile.img.src = dataUrl;
  });
}

function createTile(tabId: string): Tile | null {
  if (!container) return null;
  const wrapper = document.createElement("div");
  wrapper.className = "grid-tile";
  wrapper.dataset.tabId = tabId;
  const canvas = document.createElement("canvas");
  wrapper.append(canvas);
  wrapper.addEventListener("click", () => setFocused(tabId));
  container.append(wrapper);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const tile: Tile = { tabId, wrapper, canvas, ctx, img: new Image() };
  tiles.set(tabId, tile);
  if (!focusedTabId) setFocused(tabId);
  return tile;
}

function setFocused(tabId: string): void {
  focusedTabId = tabId;
  for (const tile of tiles.values()) tile.wrapper.classList.toggle("focused", tile.tabId === tabId);
}

/**
 * Shows or hides the grid and reconciles its tiles against the currently open OSR tab ids.
 * Safe to call on every tab-list update: it is a no-op when nothing changed, drops tiles for
 * tabs that closed, and hides the whole grid once `osrTabIds` is empty.
 */
export function syncGrid(osrTabIds: string[]): void {
  if (!container) return;
  const keep = new Set(osrTabIds);
  knownTabIds = keep;
  const show = osrTabIds.length > 0;
  container.hidden = !show;
  document.documentElement.classList.toggle("grid-open", show);
  document.body.classList.toggle("grid-open", show);
  if (!show) {
    clearGrid();
    return;
  }
  for (const [tabId, tile] of tiles) {
    if (keep.has(tabId)) continue;
    tile.wrapper.remove();
    tiles.delete(tabId);
  }
  if (focusedTabId && !keep.has(focusedTabId)) focusedTabId = null;
  if (!focusedTabId && osrTabIds[0]) setFocused(osrTabIds[0]);
}

function clearGrid(): void {
  for (const tile of tiles.values()) tile.wrapper.remove();
  tiles.clear();
  focusedTabId = null;
}

/** The tabId of the tile with the focus highlight, or null when the grid is empty. */
export function focusedTile(): string | null {
  return focusedTabId;
}
