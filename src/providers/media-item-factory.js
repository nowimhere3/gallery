// Shared MediaItem construction, used by every provider (Classic Picker's
// LocalFileInputProvider today; FileSystemAccessProvider in a later
// milestone). Extracted verbatim from LocalFileInputProvider's previous
// inline logic — field names, field order, and id/kind/mediaType/systemTags
// derivation are all unchanged, only moved here so a second provider can
// reuse them instead of duplicating this logic.
//
// Deliberately NOT included here: relativePath/path computation. Each
// provider derives those from a genuinely different source (a
// webkitRelativePath string vs. a directory-handle walk) — that's real,
// separate logic per provider, not duplicated MediaItem-shape logic, so it
// stays in each provider and is passed into createMediaItem() already
// computed.

const SUPPORTED_PREFIXES = ["image/", "video/"];

export function isSupportedFile(file) {
  return SUPPORTED_PREFIXES.some((prefix) => file.type.startsWith(prefix));
}

export function getKind(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "unknown";
}

/**
 * Builds one MediaItem. `idPrefix` exists only so ids from different
 * providers are visually distinguishable in logs/devtools — it has no
 * functional meaning downstream (ProfileStore, filterMedia, and
 * Runtime.load all key on `relativePath`, never `id`).
 *
 * @param {object} params
 * @param {string} params.idPrefix - e.g. "local" or "fsa"
 * @param {number} params.index - position within the current load batch
 * @param {File} params.file
 * @param {string} params.relativePath - already computed by the caller
 * @param {string} params.path - already computed by the caller
 * @param {string} params.url - already computed by the caller (object URL)
 */
export function createMediaItem({ idPrefix, index, file, relativePath, path, url }) {
  const kind = getKind(file);

  return {
    id: `${idPrefix}-${index}-${file.name}-${file.lastModified}`,
    name: file.name,
    path,
    relativePath,
    type: file.type,
    kind,
    size: file.size,
    lastModified: file.lastModified,
    file,
    url,
    // Metadata foundation (Filtering & Tagging Phase 1). mediaType mirrors
    // `kind` under the name the filtering pipeline and future tagging UI
    // use; systemTags are auto-derived and read-only from the user's
    // perspective, userTags is reserved for a future tag-editing UI and
    // stays empty for now.
    mediaType: kind,
    systemTags: [kind],
    userTags: [],
  };
}
