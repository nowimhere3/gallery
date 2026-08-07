// Persistence for the ONE remembered File System Access directory handle
// ("Open Last Library"). Deliberately its own database, separate from
// ProfileStore's ("loop-browser-gallery") — a directory handle is local
// browser/device state (meaningless on another machine, or after the
// folder moves), not portable user data like Favorites/Hidden/Tags. The
// two must never be merged into one store or one record.
//
// FileSystemDirectoryHandle objects are structured-cloneable in Chromium
// specifically so they can be persisted like this — that capability is
// the entire reason this feature is possible at all.

const DATABASE_NAME = "loop-browser-gallery-library";
const DATABASE_VERSION = 1;
const STORE_NAME = "handles";
const LIBRARY_KEY = "last-library";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the library database."));
  });
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Library database operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Library database operation was aborted."));
  });
}

/**
 * Returns the remembered library as { handle, name, savedAt, itemCount },
 * or null if nothing has been remembered yet. `handle` is the live
 * FileSystemDirectoryHandle — permission may still need to be
 * (re-)requested on it before use (see FileSystemAccessProvider.
 * ensurePermission); this layer only concerns itself with storage, never
 * permission state, which can change independently of what's remembered.
 */
export async function loadLibraryHandle() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(LIBRARY_KEY);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read the remembered library."));
    });

    await completeTransaction(transaction);
    if (!result || !result.handle) return null;

    return {
      handle: result.handle,
      name: typeof result.name === "string" ? result.name : "",
      savedAt: typeof result.savedAt === "number" ? result.savedAt : null,
      itemCount: typeof result.itemCount === "number" ? result.itemCount : null,
    };
  } finally {
    database.close();
  }
}

/**
 * Remembers a directory handle as "the last library", replacing whatever
 * was remembered before. `itemCount` is optional and purely for display
 * (e.g. "Reopen MyPhotos (2,148 items)") — never used for anything
 * functional, so a stale count here can never cause the count-mismatch
 * class of bug this feature's earlier implementation ran into.
 */
export async function saveLibraryHandle(handle, { name = "", itemCount = null } = {}) {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      id: LIBRARY_KEY,
      handle,
      name,
      itemCount,
      savedAt: Date.now(),
    });
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/**
 * Forgets the remembered library entirely. Per the spec's permission-
 * recovery rule: if the user denies a re-requested permission, the
 * remembered handle is forgotten (this), and the caller falls back to the
 * classic picker — it is NOT retried automatically, since a denial is a
 * deliberate signal, not a transient failure.
 */
export async function clearLibraryHandle() {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(LIBRARY_KEY);
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}
