import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import {
  TENANT_URL,
  API_VERSION,
  TENANT_NAME,
  authenticate,
  getAccessToken,
} from "./common.mjs";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let source = null;
  let sourceTenant = null;
  let backupName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tenant" && args[i + 1]) {
      sourceTenant = args[++i];
    } else if (args[i] === "--name" && args[i + 1]) {
      backupName = args[++i];
    } else if (!source) {
      source = args[i];
    }
  }

  return { source, sourceTenant, backupName };
}

const { source, sourceTenant, backupName: customName } = parseArgs();

if (!source) {
  console.error("Usage: node scripts/restore.mjs <source> [options]");
  console.error("");
  console.error("  <source>   A git ref (commit, tag, branch) or 'local' to read from disk");
  console.error("");
  console.error("Options:");
  console.error("  --tenant <name>   Read backups from a different tenant folder");
  console.error("                    (default: tenant from TENANT_URL in .env)");
  console.error("  --name <name>     Custom name for the backup in SailPoint");
  console.error("");
  console.error("Examples:");
  console.error("  # Restore from local disk (current backups folder)");
  console.error("  npm run restore -- local");
  console.error("");
  console.error("  # Restore from a git commit");
  console.error("  npm run restore -- abc1234");
  console.error("");
  console.error("  # Restore from a tag with a custom name");
  console.error('  npm run restore -- v1.0.0 --name "Pre-migration snapshot"');
  console.error("");
  console.error("  # Cross-tenant: read from tenant-b's backup, upload to current tenant");
  console.error("  npm run restore -- local --tenant tenant-b");
  console.error("");
  console.error("  # Cross-tenant from git history");
  console.error("  npm run restore -- HEAD~5 --tenant prod-tenant");
  process.exit(1);
}

const isLocal = source === "local";
const resolvedTenant = sourceTenant || TENANT_NAME;
const backupDir = join("backups", resolvedTenant);
const backupName =
  customName ||
  (isLocal
    ? `Restore from ${resolvedTenant} (local)`
    : `Restore from ${resolvedTenant} @ ${source}`);

// ---------------------------------------------------------------------------
// Read backup files from local disk
// ---------------------------------------------------------------------------
function readBackupFromDisk() {
  console.log(`Reading backup files from disk: ${backupDir}/`);

  const objects = [];

  let typeDirs;
  try {
    typeDirs = readdirSync(backupDir).filter((d) =>
      statSync(join(backupDir, d)).isDirectory()
    );
  } catch (err) {
    throw new Error(`Could not read backup directory "${backupDir}": ${err.message}`);
  }

  for (const objectType of typeDirs) {
    const typeDir = join(backupDir, objectType);
    const files = readdirSync(typeDir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const objectId = basename(file, ".json");
      const content = readFileSync(join(typeDir, file), "utf-8");

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        console.warn(`  Warning: Could not parse ${objectType}/${file}, skipping`);
        continue;
      }

      objects.push({ objectType, objectId, content: parsed });
    }
  }

  printSummary(objects);
  return objects;
}

// ---------------------------------------------------------------------------
// Read backup files from a git ref
// ---------------------------------------------------------------------------
function readBackupFromGit(ref) {
  console.log(`Reading backup files from git ref: ${ref} (${backupDir}/)`);

  let fileList;
  try {
    fileList = execSync(
      `git ls-tree -r --name-only "${ref}" -- "${backupDir}"`,
      { encoding: "utf-8" }
    ).trim();
  } catch (err) {
    throw new Error(
      `Could not read files from git ref "${ref}". Is it a valid commit/tag?\n${err.message}`
    );
  }

  if (!fileList) {
    throw new Error(
      `No backup files found at ref "${ref}" under ${backupDir}/`
    );
  }

  const files = fileList.split("\n").filter((f) => f.endsWith(".json"));
  console.log(`  Found ${files.length} object files`);

  const objects = [];

  for (const filePath of files) {
    const parts = filePath.split("/");
    const objectType = parts[parts.length - 2];
    const objectId = basename(filePath, ".json");

    const content = execSync(`git show "${ref}:${filePath}"`, {
      encoding: "utf-8",
    });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(`  Warning: Could not parse ${filePath}, skipping`);
      continue;
    }

    objects.push({ objectType, objectId, content: parsed });
  }

  printSummary(objects);
  return objects;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function printSummary(objects) {
  const typeCounts = {};
  for (const obj of objects) {
    typeCounts[obj.objectType] = (typeCounts[obj.objectType] || 0) + 1;
  }
  console.log(`  ${objects.length} objects total:`);
  for (const [type, count] of Object.entries(typeCounts).sort()) {
    console.log(`    ${type}: ${count}`);
  }
}

// ---------------------------------------------------------------------------
// Upload objects to SailPoint via configuration-hub/backups/uploads
// Uses multipart/form-data matching the working Postman approach:
//   - "data" field: JSON file blob (one object at a time)
//   - "name" field: backup name string
// ---------------------------------------------------------------------------
async function uploadBackup(objects, name) {
  console.log(`Uploading ${objects.length} objects as "${name}"...`);

  // Bundle all objects into a single JSON array — same format as the
  // individual backup files (JWS envelope with self/object structure)
  const bundle = objects.map(({ content }) => content);
  const jsonStr = JSON.stringify(bundle, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });

  console.log(`  Bundle size: ${(jsonStr.length / 1024).toFixed(1)} KB`);

  const form = new FormData();
  form.append("data", blob, `${name}.json`);
  form.append("name", name);

  const url = `${TENANT_URL}/${API_VERSION}/configuration-hub/backups/uploads`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      Accept: "application/json",
    },
    body: form,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Upload failed: HTTP ${res.status}\n${errBody}`);
  }

  const data = await res.json();
  console.log("Upload response:");
  console.log(JSON.stringify(data, null, 2));
  return data;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== ISC Configuration Restore ===");
  console.log(`Target tenant: ${TENANT_NAME} (${TENANT_URL})`);
  console.log(`Source: ${isLocal ? "local disk" : `git ref "${source}"`}`);
  console.log(`Source tenant folder: ${resolvedTenant}`);
  console.log(`Backup name: ${backupName}`);
  if (resolvedTenant !== TENANT_NAME) {
    console.log(`Cross-tenant restore: ${resolvedTenant} → ${TENANT_NAME}`);
  }
  console.log();

  // Read objects from the appropriate source
  const objects = isLocal
    ? readBackupFromDisk()
    : readBackupFromGit(source);

  if (objects.length === 0) {
    console.log("No objects found — nothing to restore.");
    return;
  }

  // Authenticate with the target tenant
  await authenticate();

  // Upload each object via multipart form to Config Hub
  const results = await uploadBackup(objects, backupName);

  console.log();
  console.log("=== Restore upload complete! ===");
  console.log(
    "The backup(s) have been uploaded to Config Hub. You can now use"
  );
  console.log(
    "the Config Hub UI to review and deploy the configuration."
  );
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
