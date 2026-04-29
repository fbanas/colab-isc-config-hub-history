import { execSync, execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import {
  TENANT_URL,
  API_VERSION,
  TENANT_NAME,
  authenticate,
  getAccessToken,
} from "./common.mjs";
import { meaningfulBackupContentEqual } from "./compare-utils.mjs";
import { applyTokens, parseVarsYaml } from "./token-utils.mjs";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let source = null;
  let sourceTenant = null;
  let backupName = null;
  let fullRestore = false;
  let baseRef = null;
  let varsRef = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tenant" && args[i + 1]) {
      sourceTenant = args[++i];
    } else if (a === "--name" && args[i + 1]) {
      backupName = args[++i];
    } else if (a === "--base" && args[i + 1]) {
      baseRef = args[++i];
    } else if (a === "--vars" && args[i + 1]) {
      varsRef = args[++i];
    } else if (a === "--full") {
      fullRestore = true;
    } else if (!source) {
      source = a;
    }
  }

  return { source, sourceTenant, backupName, fullRestore, baseRef, varsRef };
}

const { source, sourceTenant, backupName: customName, fullRestore, baseRef, varsRef } =
  parseArgs();

if (!source) {
  console.error("Usage: node scripts/restore.mjs <source> [options]");
  console.error("");
  console.error("  <source>   A git ref (commit, tag, branch) or 'local' to read from disk");
  console.error("");
  console.error("Options:");
  console.error("  --tenant <name>   Read backups from a different tenant folder (or a template");
  console.error("                    set under templates/ if backups/<name> does not exist)");
  console.error("                    (default: tenant from TENANT_URL in .env)");
  console.error("  --name <name>     Custom name for the backup in SailPoint");
  console.error("  --full            Upload the entire snapshot (skip semantic diff vs main)");
  console.error("  --base <ref>      Compare semantically to this git ref instead of main");
  console.error("  --vars <tenant>   Apply token substitution using vars/<tenant>.vars.yaml");
  console.error("                    before uploading (can also be a direct .yaml file path)");
  console.error("");
  console.error("By default, only objects whose meaningful content differs from the tip");
  console.error("of main are uploaded (same canonical compare as backup.mjs). Use --full");
  console.error("for a complete bundle.");
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
  console.error("");
  console.error("  # Full snapshot (no diff vs main)");
  console.error("  npm run restore -- abc1234 --full");
  console.error("");
  console.error("  # Restore a tokenized template set with production vars");
  console.error("  npm run restore -- local --tenant default --vars production --full");
  process.exit(1);
}

const isLocal = source === "local";
const resolvedTenant = sourceTenant || TENANT_NAME;

/**
 * Resolve the local source directory for a tenant name.
 * Prefers backups/<tenant>; falls back to templates/<tenant> when the backup
 * folder does not exist on disk (only relevant for the 'local' source).
 */
function resolveBackupDir(tenant) {
  const backupsPath = join("backups", tenant);
  if (existsSync(backupsPath)) return backupsPath;
  const templatesPath = join("templates", tenant);
  if (existsSync(templatesPath)) return templatesPath;
  // Return the canonical backups path; errors surface in readBackupFromDisk
  return backupsPath;
}

const backupDir = resolveBackupDir(resolvedTenant);
/** Git paths always use forward slashes (matches repo layout). */
const backupRootPosix = `backups/${resolvedTenant}`;
const backupName =
  customName ||
  (isLocal
    ? `Restore from ${resolvedTenant} (local)`
    : `Restore from ${resolvedTenant} @ ${source}`);

function ensureGitRepo() {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "Semantic diff needs a git checkout with the base branch available. Use --full to upload the entire snapshot."
    );
  }
}

function resolveComparisonBase(explicit) {
  if (explicit) {
    try {
      execFileSync("git", ["rev-parse", "--verify", explicit], {
        stdio: "pipe",
      });
      return explicit;
    } catch {
      throw new Error(`Invalid git ref for --base: ${explicit}`);
    }
  }
  const candidates = ["main", "origin/main", "master"];
  for (const c of candidates) {
    try {
      execFileSync("git", ["rev-parse", "--verify", c], { stdio: "pipe" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Could not resolve a comparison branch (tried main, origin/main, master). Pass --base <ref> or use --full."
  );
}

function gitRevParse(ref, extraArgs = []) {
  return execFileSync("git", ["rev-parse", ...extraArgs, ref], {
    encoding: "utf-8",
  }).trim();
}

function gitShowFileAtRef(ref, posixPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${posixPath}`], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 100,
    });
  } catch {
    return null;
  }
}

function filterToSemanticDiffFromBase(objects, comparisonBase, tenantFolderName) {
  let nUnchanged = 0;
  let nMissingOnBase = 0;
  const changed = [];

  for (const obj of objects) {
    const posixPath = `backups/${tenantFolderName}/${obj.objectType}/${obj.objectId}.json`;
    const baselineRaw = gitShowFileAtRef(comparisonBase, posixPath);
    if (baselineRaw === null) {
      nMissingOnBase++;
      changed.push(obj);
      continue;
    }
    let baselineParsed;
    try {
      baselineParsed = JSON.parse(baselineRaw);
    } catch {
      changed.push(obj);
      continue;
    }
    if (meaningfulBackupContentEqual(obj.content, baselineParsed)) {
      nUnchanged++;
    } else {
      changed.push(obj);
    }
  }

  const shortSha = gitRevParse(comparisonBase, ["--short"]);
  const fullSha = gitRevParse(comparisonBase);
  console.log("");
  console.log(
    `Semantic diff vs ${comparisonBase} (${shortSha} / ${fullSha}): ` +
      `${changed.length} object(s) to upload, ${nUnchanged} unchanged vs base, ` +
      `${nMissingOnBase} absent from base`
  );

  return changed;
}

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

  return objects;
}

// ---------------------------------------------------------------------------
// Read backup files from a git ref
// ---------------------------------------------------------------------------
function readBackupFromGit(ref) {
  console.log(`Reading backup files from git ref: ${ref} (${backupRootPosix}/)`);

  let fileList;
  try {
    fileList = execSync(
      `git ls-tree -r --name-only "${ref}" -- "${backupRootPosix}"`,
      { encoding: "utf-8" }
    ).trim();
  } catch (err) {
    throw new Error(
      `Could not read files from git ref "${ref}". Is it a valid commit/tag?\n${err.message}`
    );
  }

  if (!fileList) {
    throw new Error(
      `No backup files found at ref "${ref}" under ${backupRootPosix}/`
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
// Vars loading
// ---------------------------------------------------------------------------

/**
 * Load and parse a vars file. Accepts either:
 *   - a direct file path (if it contains a path separator or ends with .yaml)
 *   - a tenant name, resolved to vars/<tenant>.vars.yaml
 */
function loadVars(varsRef) {
  let varsPath;
  if (varsRef.includes("/") || varsRef.includes("\\") || varsRef.endsWith(".yaml")) {
    varsPath = varsRef;
  } else {
    varsPath = join("vars", `${varsRef}.vars.yaml`);
  }

  if (!existsSync(varsPath)) {
    throw new Error(
      `Vars file not found: ${varsPath}\n` +
        `Run "node scripts/tokenize.mjs find-tokens ${varsRef}" to generate it.`
    );
  }

  const content = readFileSync(varsPath, "utf-8");
  const vars = parseVarsYaml(content);
  console.log(`Loaded vars from ${varsPath}  (${Object.keys(vars).length} token(s))`);
  return vars;
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
  if (fullRestore) {
    console.log("Bundle: full snapshot (--full)");
  } else {
    console.log(
      `Bundle: semantic diff vs ${baseRef || "main (or origin/main/master)"}`
    );
  }
  if (varsRef) {
    console.log(`Token substitution: --vars ${varsRef}`);
  }
  if (resolvedTenant !== TENANT_NAME) {
    console.log(`Cross-tenant restore: ${resolvedTenant} → ${TENANT_NAME}`);
  }
  console.log();

  let objects = isLocal
    ? readBackupFromDisk()
    : readBackupFromGit(source);

  if (objects.length === 0) {
    console.log("No objects found — nothing to restore.");
    return;
  }

  console.log(`Restore snapshot: ${objects.length} object file(s)`);
  printSummary(objects);

  if (!fullRestore) {
    ensureGitRepo();
    const comparisonBase = resolveComparisonBase(baseRef);
    objects = filterToSemanticDiffFromBase(
      objects,
      comparisonBase,
      resolvedTenant
    );
    if (objects.length > 0) {
      console.log("Objects to upload (after filter):");
      printSummary(objects);
    }
  }

  if (objects.length === 0) {
    console.log("\nNo semantic changes vs base branch — nothing to upload.");
    return;
  }

  // Apply token substitution when --vars is provided
  if (varsRef) {
    const vars = loadVars(varsRef);
    console.log(`Applying token substitution to ${objects.length} object(s)...`);
    let substituteErrors = 0;
    objects = objects.map((obj) => {
      try {
        return { ...obj, content: applyTokens(obj.content, vars) };
      } catch (err) {
        console.error(
          `  Error substituting tokens in ${obj.objectType}/${obj.objectId}: ${err.message}`
        );
        substituteErrors++;
        return obj;
      }
    });
    if (substituteErrors > 0) {
      throw new Error(
        `Token substitution failed for ${substituteErrors} object(s). ` +
          `Ensure all required tokens are present in the vars file.`
      );
    }
    console.log("Token substitution complete.");
    console.log();
  }

  await authenticate();

  await uploadBackup(objects, backupName);

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
