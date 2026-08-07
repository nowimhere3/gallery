import { isSupportedFile, createMediaItem } from "./media-item-factory.js";

const DEFAULT_BATCH_SIZE = 250;
// How many files to discover before yielding to the browser during the
// recursive walk itself (separate from the load/convert batching below) —
// large folders (thousands of files, deep nesting) would otherwise block
// the main thread for the entire walk before any batching logic even runs.
const DISCOVERY_YIELD_EVERY = 250;

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export class PermissionDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class FileSystemAccessProvider {
  #items = [];
  #activeUrls = [];
  #loadToken = 0;

  static isSupported() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
  }

  /**
   * Opens the native folder picker and returns the chosen
   * FileSystemDirectoryHandle, or null if the user cancelled. Deliberately
   * does not load anything itself — obtaining a handle (this) and loading
   * from one (loadFromDirectoryHandle) are separate so a remembered handle
   * from a previous session can reuse the same loading path without going
   * through the picker again.
   */
  static async requestDirectory() {
    try {
      return await window.showDirectoryPicker();
    } catch (error) {
      if (error && error.name === "AbortError") return null; // user cancelled
      throw error;
    }
  }

  /**
   * Ensures read permission on a directory handle, requesting it if
   * necessary. Works for both a handle fresh out of the picker (already
   * granted) and a remembered handle from a previous session (permission
   * may have lapsed and need re-requesting). requestPermission() requires
   * a user gesture, so this must be called from a click handler, not on
   * page load.
   */
  static async ensurePermission(directoryHandle) {
    const opts = { mode: "read" };

    if ((await directoryHandle.queryPermission(opts)) === "granted") return;
    if ((await directoryHandle.requestPermission(opts)) === "granted") return;

    throw new PermissionDeniedError(`Read permission was not granted for "${directoryHandle.name}".`);
  }

  /**
   * Recursively walks a directory handle into a flat list of
   * { file, relativePath, path } — relativePath excludes the picked root
   * folder's own name (matching LocalFileInputProvider's convention, so
   * ProfileStore favorites/hidden keyed on relativePath match regardless
   * of which provider loaded the folder); path includes it, mirroring
   * LocalFileInputProvider's webkitRelativePath-based `path` field.
   *
   * A single unreadable file (permission hiccup, races with the file being
   * deleted mid-walk, etc.) is skipped rather than aborting the whole
   * load — but skips are never silent: they're counted, and a single
   * summary warning is logged at the end if any occurred, naming exactly
   * how many. No per-file logging, no broad instrumentation — just enough
   * that a real data-loss bug can never again hide invisibly the way it
   * did in the version this was rebuilt from.
   */
  async #discoverFiles(directoryHandle, token, onDiscover) {
    const results = [];
    let skippedCount = 0;
    let sinceYield = 0;

    const walk = async (dirHandle, prefix) => {
      for await (const entry of dirHandle.values()) {
        if (token !== this.#loadToken) return; // superseded — stop discovering

        if (entry.kind === "directory") {
          await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
          continue;
        }

        if (entry.kind !== "file") continue;

        let file;
        try {
          file = await entry.getFile();
        } catch (error) {
          skippedCount += 1;
          continue;
        }

        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        results.push({ file, relativePath, path: `${directoryHandle.name}/${relativePath}` });

        if (onDiscover) onDiscover(results.length);

        sinceYield += 1;
        if (sinceYield >= DISCOVERY_YIELD_EVERY) {
          sinceYield = 0;
          await nextFrame();
        }
      }
    };

    await walk(directoryHandle, "");

    if (skippedCount > 0) {
      console.warn(`[FileSystemAccessProvider] Skipped ${skippedCount} file(s) that could not be read.`);
    }

    return results;
  }

  /**
   * Loads every supported file under a directory handle into gallery
   * items. Mirrors LocalFileInputProvider.loadFromFileList's shape and
   * batching convention (default 250/batch, yields via requestAnimationFrame
   * between batches) so the two providers behave identically from
   * main.js's point of view.
   *
   * options:
   *   - batchSize: number of files converted per batch (default 250)
   *   - onProgress: (loadedCount, totalCount) => void, called after each batch
   *   - onBatch: (batchItems, allItemsSoFar) => void, called after each batch
   *   - onDiscover: (discoveredSoFar) => void, called during the initial
   *     walk, before totals are known — lets UI show "Found N files…"
   *     instead of sitting blank during a large folder's discovery phase.
   */
  async loadFromDirectoryHandle(directoryHandle, options = {}) {
    await FileSystemAccessProvider.ensurePermission(directoryHandle);

    // dispose() clears prior state AND invalidates any load already in
    // flight (see #loadToken), so a stale batched load can't keep
    // appending items after a newer load (or Clear Media) has started.
    this.dispose();
    const token = this.#loadToken;

    const { batchSize = DEFAULT_BATCH_SIZE, onProgress, onBatch, onDiscover } = options;

    const discovered = await this.#discoverFiles(directoryHandle, token, onDiscover);
    if (token !== this.#loadToken) return [...this.#items]; // superseded mid-walk

    const supported = discovered.filter(({ file }) => isSupportedFile(file));
    const total = supported.length;
    const items = [];

    for (let start = 0; start < total; start += batchSize) {
      if (token !== this.#loadToken) {
        return [...this.#items];
      }

      const batchEntries = supported.slice(start, start + batchSize);

      const batchItems = batchEntries.map(({ file, relativePath, path }, offset) => {
        const index = start + offset;
        const objectUrl = URL.createObjectURL(file);
        this.#activeUrls.push(objectUrl);

        return createMediaItem({
          idPrefix: "fsa",
          index,
          file,
          path,
          relativePath,
          url: objectUrl,
        });
      });

      items.push(...batchItems);
      this.#items = items;

      if (onProgress) onProgress(items.length, total);
      if (onBatch) onBatch(batchItems, [...items]);

      const isLastBatch = start + batchSize >= total;
      if (!isLastBatch) {
        await nextFrame();
      }
    }

    return [...this.#items];
  }

  getItems() {
    return [...this.#items];
  }

  dispose() {
    this.#loadToken += 1;

    for (const url of this.#activeUrls) {
      URL.revokeObjectURL(url);
    }

    this.#activeUrls = [];
    this.#items = [];
  }
}
