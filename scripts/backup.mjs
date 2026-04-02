import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from "fs";
import { join } from "path";
import {
  API_VERSION,
  TENANT_NAME,
  authenticate,
  apiCall,
  sleep,
} from "./common.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 60;
const BACKUP_DIR = join("backups", TENANT_NAME);

// ---------------------------------------------------------------------------
// Step 1: Fetch exportable object types
// ---------------------------------------------------------------------------
async function getExportableTypes() {
  console.log("Fetching exportable object types...");

  const data = await apiCall(
    "GET",
    `/${API_VERSION}/sp-config/config-objects?filters=exportable%20eq%20%22true%22`
  );

  const types = [...new Set(data.map((obj) => obj.objectType))];
  console.log(`Found ${types.length} exportable types: ${types.join(", ")}`);
  return types;
}

// ---------------------------------------------------------------------------
// Step 2: Create export job
// ---------------------------------------------------------------------------
async function createExport(includeTypes) {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Creating export (${today})...`);

  const data = await apiCall("POST", `/${API_VERSION}/sp-config/export`, {
    description: `Daily backup ${today}`,
    includeTypes,
  });

  const jobId = data.jobId;
  console.log(`Export job created: ${jobId}`);
  return jobId;
}

// ---------------------------------------------------------------------------
// Step 3: Poll until the export job is COMPLETE
// ---------------------------------------------------------------------------
async function pollExport(jobId) {
  console.log("Polling export status...");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const data = await apiCall(
      "GET",
      `/${API_VERSION}/sp-config/export/${jobId}`
    );
    const status = data.status;
    console.log(
      `  Status: ${status} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`
    );

    if (status === "COMPLETE") {
      console.log("  Export complete.");
      return;
    }
    if (status === "FAILED") {
      throw new Error(`Export failed:\n${JSON.stringify(data, null, 2)}`);
    }
    if (status === "CANCELLED") {
      throw new Error("Export was cancelled");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Export timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000} seconds`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a canonical, order-independent representation of a JSON value so
 * that two semantically identical objects always stringify identically:
 *   - Object keys are sorted alphabetically (recursively)
 *   - Array elements are sorted by their canonical string representation
 */
function canonicalize(value) {
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
 * Build a set of all existing backup file paths (relative to BACKUP_DIR)
 * so we can detect deletions after the download completes.
 */
function collectExistingFiles(dir) {
  const existing = new Set();
  if (!existsSync(dir)) return existing;

  for (const typeName of readdirSync(dir, { withFileTypes: true })) {
    if (!typeName.isDirectory()) continue;
    const typeDir = join(dir, typeName.name);
    for (const file of readdirSync(typeDir, { withFileTypes: true })) {
      if (file.isFile()) {
        existing.add(join(typeName.name, file.name));
      }
    }
  }
  return existing;
}

// ---------------------------------------------------------------------------
// Step 4: Download export and write individual object files
//
// The download endpoint returns a single JSON document:
//   { version, timestamp, tenant, description, options, objects: [ ... ] }
//
// Each item in `objects` has the shape:
//   { version, self: { type, id, name }, object: { ... }, jwsHeader, jwsSignature }
//
// We write the full item (canonicalized) as backups/<objectType>/<objectId>.json
// so that the on-disk format is stable and git diffs are easy to read.
// ---------------------------------------------------------------------------
async function downloadObjects(jobId) {
  console.log("Downloading export...");

  const response = await apiCall(
    "GET",
    `/${API_VERSION}/sp-config/export/${jobId}/download`
  );

  const items = response?.objects;
  if (!Array.isArray(items)) {
    throw new Error(
      `Unexpected download response — no 'objects' array found.\n` +
        JSON.stringify(response, null, 2).slice(0, 500)
    );
  }

  console.log(`  Export contains ${items.length} objects`);

  // Snapshot existing files so we can remove any that have been deleted
  const existingFiles = collectExistingFiles(BACKUP_DIR);
  const seenFiles = new Set();

  let totalCount = 0;
  let writtenCount = 0;

  for (const item of items) {
    // The export download format identifies objects via the `self` field.
    const objectType = item.self?.type;
    const objectId = item.self?.id;

    if (!objectType || !objectId) {
      console.warn("  Skipping item with missing self.type / self.id:", item);
      continue;
    }

    const typeDir = join(BACKUP_DIR, objectType);
    mkdirSync(typeDir, { recursive: true });

    // Ensure jwsHeader and jwsSignature are always present for backward
    // compatibility, then canonicalize so all keys/arrays are in a stable
    // alphabetical order (jwsHeader → jwsSignature → object → self → version).
    const itemWithJws = { jwsHeader: null, jwsSignature: null, ...item };
    const newContent = JSON.stringify(canonicalize(itemWithJws), null, 2) + "\n";

    const relPath = join(objectType, `${objectId}.json`);
    const filePath = join(BACKUP_DIR, relPath);
    seenFiles.add(relPath);

    const existingContent = existsSync(filePath)
      ? readFileSync(filePath, "utf8")
      : null;

    if (newContent !== existingContent) {
      writeFileSync(filePath, newContent);
      writtenCount++;
    }

    totalCount++;
  }

  // Remove files that were in the previous backup but absent from this one
  let deletedCount = 0;
  for (const relPath of existingFiles) {
    if (!seenFiles.has(relPath)) {
      rmSync(join(BACKUP_DIR, relPath));
      console.log(`  Removed deleted object: ${relPath}`);
      deletedCount++;
    }
  }

  // Remove any type directories that are now empty
  if (existsSync(BACKUP_DIR)) {
    for (const entry of readdirSync(BACKUP_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const typeDir = join(BACKUP_DIR, entry.name);
        if (readdirSync(typeDir).length === 0) {
          rmSync(typeDir, { recursive: true });
        }
      }
    }
  }

  console.log(
    `Processed ${totalCount} objects: ${writtenCount} updated, ` +
      `${deletedCount} deleted, ${totalCount - writtenCount - deletedCount} unchanged`
  );
  return totalCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== ISC Configuration Backup ===");
  console.log(`Tenant: ${TENANT_NAME}`);
  console.log(`Backup directory: ${BACKUP_DIR}`);
  console.log();

  await authenticate();

  const types = await getExportableTypes();
  const jobId = await createExport(types);
  await pollExport(jobId);

  // Re-authenticate in case the export took a while
  await authenticate();

  await downloadObjects(jobId);

  console.log();
  console.log("=== Backup complete! ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
