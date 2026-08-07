import { isSupportedFile, createMediaItem } from "./media-item-factory.js";

const DEFAULT_BATCH_SIZE = 250;

function safeRelativePath(file) {
  return file.webkitRelativePath || file.name;
}

// A portable path for Profile matching: the file's path *inside* whatever
// folder was picked, with the picked folder's own name stripped off. The
// picked folder's name is a local, arbitrary choice (e.g. "MyPhotos" vs
// "Photos_Backup" on another machine) and must not be baked into the key,
// or favorites would stop matching as soon as someone renamed/re-picked
// the parent folder — even though the files themselves didn't move.
function computeRelativePath(file) {
  if (!file.webkitRelativePath) return file.name;

  const segments = file.webkitRelativePath.split("/");
  segments.shift();
  return segments.join("/") || file.name;
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export class LocalFileInputProvider {
  #items = [];
  #activeUrls = [];
  #loadToken = 0;

  /**
   * Turns a (possibly very large) FileList into gallery items.
   *
   * Processes files in batches (default 250) and yields to the browser
   * between batches via requestAnimationFrame, instead of creating object
   * URLs for every file in one synchronous pass. This keeps very large
   * folder selections (1000+ files) from blocking the main thread and
   * spiking memory all at once.
   *
   * Only one permission prompt is ever involved — the browser already
   * hands back the full FileList in a single event; batching only affects
   * how we process that list afterward.
   *
   * options:
   *   - batchSize: number of files processed per batch (default 250)
   *   - onProgress: (loadedCount, totalCount) => void, called after each batch
   *   - onBatch: (batchItems, allItemsSoFar) => void, called after each batch
   */
  async loadFromFileList(fileList, options = {}) {
    // dispose() clears prior state AND invalidates any load already in
    // flight (see #loadToken), so a stale batched load can't keep
    // appending items after a newer load (or Clear Media) has started.
    this.dispose();
    const token = this.#loadToken;

    const { batchSize = DEFAULT_BATCH_SIZE, onProgress, onBatch } = options;

    const files = Array.from(fileList || []).filter(isSupportedFile);
    const total = files.length;
    const items = [];

    for (let start = 0; start < total; start += batchSize) {
      // Another load (or dispose/clear) superseded this one — stop here.
      if (token !== this.#loadToken) {
        return [...this.#items];
      }

      const batchFiles = files.slice(start, start + batchSize);

      const batchItems = batchFiles.map((file, offset) => {
        const index = start + offset;
        const objectUrl = URL.createObjectURL(file);

        this.#activeUrls.push(objectUrl);

        return createMediaItem({
          idPrefix: "local",
          index,
          file,
          path: safeRelativePath(file),
          relativePath: computeRelativePath(file),
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
