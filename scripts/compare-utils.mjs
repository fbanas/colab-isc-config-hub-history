// ---------------------------------------------------------------------------
// Canonical comparison for backup JSON objects (shared by backup + restore)
// ---------------------------------------------------------------------------

/**
 * Produce a canonical, order-independent representation of a JSON value so
 * that two semantically identical objects always stringify identically:
 *   - Object keys are sorted alphabetically (recursively)
 *   - Array elements are sorted by their canonical string representation
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    items.sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return items;
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

/**
 * Remove high-churn noise fields so we can compare meaningful content:
 * - jwsSignature — top-level on the item
 * - modified — inside item.object
 */
export function stripNoiseFields(item) {
  const copy = { ...item };
  delete copy.jwsSignature;
  if (copy.object && typeof copy.object === "object") {
    copy.object = { ...copy.object };
    delete copy.object.modified;
  }
  return copy;
}

/**
 * Match backup download normalization before noise stripping (see backup.mjs).
 */
export function normalizeExportItem(item) {
  return { jwsHeader: null, jwsSignature: null, ...item };
}

/**
 * Stable string for semantic equality (same rules as backup noise-only skip).
 */
export function strippedCanonicalJson(parsed) {
  return JSON.stringify(
    canonicalize(stripNoiseFields(normalizeExportItem(parsed))),
    null,
    2
  );
}

export function meaningfulBackupContentEqual(parsedA, parsedB) {
  return strippedCanonicalJson(parsedA) === strippedCanonicalJson(parsedB);
}
