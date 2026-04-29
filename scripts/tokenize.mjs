// ---------------------------------------------------------------------------
// ISC Configuration Tokenization Tool
//
// Subcommands:
//   create-template <tenant> [--template <name>]
//       Read backups/<tenant>/, replace environment-specific values with
//       {{TOKEN}} placeholders, write templates/<name>/<TYPE>/<name>.json,
//       and seed vars/<tenant>.vars.yaml with the actual values.
//
//   find-tokens <tenant> [--template <name>]
//       For each file in templates/<name>/, match against backups/<tenant>/
//       by self.name + self.type, extract the values at every {{TOKEN}}
//       position, and write vars/<tenant>.vars.yaml.
//
//   diff-tenants <tenant-a> <tenant-b>
//       Compare two tenants' backups by name+type and report fields that
//       differ — these are token candidates to add to TOKENIZABLE_PATHS.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import {
  tokenizeObject,
  extractTokenValues,
  matchBackupByName,
  sanitizeName,
  varsToYaml,
  parseVarsYaml,
  deepDiff,
} from "./token-utils.mjs";

// ---------------------------------------------------------------------------
// Context-aware template filename generation
// ---------------------------------------------------------------------------

/**
 * Build a template filename for a parsed backup object that avoids collisions
 * when the same self.name appears in multiple parent contexts.
 *
 * LIFECYCLE_STATE: "HR-Active.json" (identityProfileRef.name + self.name)
 * Everything else:  "<self.name>.json"
 */
function templateFileName(parsed) {
  const selfName = parsed?.self?.name ?? "unnamed";
  const type = parsed?.self?.type;

  if (type === "LIFECYCLE_STATE") {
    const profileName = parsed?.object?.identityProfileRef?.name;
    if (profileName) {
      return `${sanitizeName(profileName)}-${sanitizeName(selfName)}.json`;
    }
  }

  return `${sanitizeName(selfName)}.json`;
}

/**
 * When reading a template file, return the matching key used by find-tokens.
 * For LIFECYCLE_STATE we match on both type + name; the caller must also
 * compare identityProfileRef.name if the template encodes it in the filename.
 */
function templateMatchKey(parsed) {
  return `${parsed?.self?.type}::${parsed?.self?.name}`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const positional = [];
  let templateName = "default";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--template" && args[i + 1]) {
      templateName = args[++i];
    } else if (!args[i].startsWith("--")) {
      positional.push(args[i]);
    }
  }

  return { subcommand, positional, templateName };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read all backup JSON files from backups/<tenant>/ and return an array of
 * { objectType, objectId, content } objects.
 */
function readBackups(tenant) {
  const backupDir = join("backups", tenant);
  if (!existsSync(backupDir)) {
    throw new Error(`Backup directory not found: ${backupDir}`);
  }

  const objects = [];
  const typeDirs = readdirSync(backupDir).filter((d) =>
    statSync(join(backupDir, d)).isDirectory()
  );

  for (const objectType of typeDirs) {
    const typeDir = join(backupDir, objectType);
    for (const file of readdirSync(typeDir).filter((f) => f.endsWith(".json"))) {
      const objectId = basename(file, ".json");
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(typeDir, file), "utf-8"));
      } catch {
        console.warn(`  Warning: could not parse ${objectType}/${file}, skipping`);
        continue;
      }
      objects.push({ objectType, objectId, content: parsed });
    }
  }

  return objects;
}

/**
 * Read all template JSON files from templates/<name>/ and return an array of
 * { objectType, fileName, content } objects.
 */
function readTemplates(templateName) {
  const templateDir = join("templates", templateName);
  if (!existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }

  const objects = [];
  const typeDirs = readdirSync(templateDir).filter((d) =>
    statSync(join(templateDir, d)).isDirectory()
  );

  for (const objectType of typeDirs) {
    const typeDir = join(templateDir, objectType);
    for (const file of readdirSync(typeDir).filter((f) => f.endsWith(".json"))) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(typeDir, file), "utf-8"));
      } catch {
        console.warn(`  Warning: could not parse ${objectType}/${file}, skipping`);
        continue;
      }
      objects.push({ objectType, fileName: file, content: parsed });
    }
  }

  return objects;
}

// ---------------------------------------------------------------------------
// create-template
// ---------------------------------------------------------------------------

function cmdCreateTemplate(tenant, templateName) {
  console.log(`=== create-template: ${tenant} → templates/${templateName} ===`);
  console.log();

  const objects = readBackups(tenant);
  console.log(`Read ${objects.length} backup file(s) from backups/${tenant}/`);

  const mergedVars = {};
  let templateCount = 0;
  let skippedCount = 0;

  for (const { objectType, content } of objects) {
    const { tokenized, tokenMap } = tokenizeObject(content);

    if (Object.keys(tokenMap).length === 0) {
      skippedCount++;
      continue;
    }

    // Check for token name collisions with previously collected vars
    for (const [tokenName, value] of Object.entries(tokenMap)) {
      if (tokenName in mergedVars && mergedVars[tokenName] !== value) {
        console.warn(
          `  Warning: token name collision for ${tokenName} ` +
            `(keeping first value "${mergedVars[tokenName]}", discarding "${value}")`
        );
      } else {
        mergedVars[tokenName] = value;
      }
    }

    const fileName = templateFileName(content);
    const outDir = join("templates", templateName, objectType);
    mkdirSync(outDir, { recursive: true });

    const outPath = join(outDir, fileName);
    writeFileSync(outPath, JSON.stringify(tokenized, null, 2) + "\n");
    console.log(`  Wrote ${objectType}/${fileName}  (${Object.keys(tokenMap).length} token(s))`);
    templateCount++;
  }

  if (Object.keys(mergedVars).length > 0) {
    mkdirSync("vars", { recursive: true });
    const varsPath = join("vars", `${tenant}.vars.yaml`);
    writeFileSync(varsPath, varsToYaml(mergedVars, tenant));
    console.log();
    console.log(`Wrote vars/${tenant}.vars.yaml  (${Object.keys(mergedVars).length} token(s))`);
  }

  console.log();
  console.log(
    `Done: ${templateCount} template file(s) written, ${skippedCount} object(s) had no tokenizable fields`
  );
}

// ---------------------------------------------------------------------------
// find-tokens
// ---------------------------------------------------------------------------

function cmdFindTokens(tenant, templateName) {
  console.log(`=== find-tokens: templates/${templateName} × backups/${tenant} ===`);
  console.log();

  const templates = readTemplates(templateName);
  console.log(`Loaded ${templates.length} template file(s) from templates/${templateName}/`);

  const backupDir = join("backups", tenant);
  if (!existsSync(backupDir)) {
    throw new Error(`Backup directory not found: ${backupDir}`);
  }

  const mergedVars = {};
  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const { objectType, fileName, content: templateContent } of templates) {
    const selfName = templateContent?.self?.name;
    const selfType = templateContent?.self?.type ?? objectType;

    if (!selfName) {
      console.warn(`  Warning: template ${objectType}/${fileName} has no self.name, skipping`);
      unmatchedCount++;
      continue;
    }

    // For LIFECYCLE_STATE, also match on the parent identity profile name
    // (encoded in the composite filename as "<profileName>-<stateName>.json")
    const profileHint =
      selfType === "LIFECYCLE_STATE"
        ? templateContent?.object?.identityProfileRef?.name
        : undefined;

    const match = matchBackupByName(backupDir, selfType, selfName, profileHint);
    if (!match) {
      console.warn(
        `  No match in backups/${tenant}/ for ${selfType} "${selfName}" (from ${objectType}/${fileName})`
      );
      unmatchedCount++;
      continue;
    }

    const extracted = extractTokenValues(templateContent, match.parsed);
    const tokenCount = Object.keys(extracted).length;

    if (tokenCount === 0) {
      console.log(`  ${selfType}/${fileName}  → matched "${selfName}" but extracted 0 tokens`);
    } else {
      console.log(`  ${selfType}/${fileName}  → matched "${selfName}"  (${tokenCount} token(s))`);
    }

    for (const [tokenName, value] of Object.entries(extracted)) {
      if (tokenName in mergedVars && JSON.stringify(mergedVars[tokenName]) !== JSON.stringify(value)) {
        console.warn(
          `  Warning: token collision for ${tokenName} — keeping previous value`
        );
      } else {
        mergedVars[tokenName] = value;
      }
    }
    matchedCount++;
  }

  if (Object.keys(mergedVars).length > 0) {
    mkdirSync("vars", { recursive: true });
    const varsPath = join("vars", `${tenant}.vars.yaml`);
    writeFileSync(varsPath, varsToYaml(mergedVars, tenant));
    console.log();
    console.log(`Wrote vars/${tenant}.vars.yaml  (${Object.keys(mergedVars).length} token(s))`);
  } else {
    console.log();
    console.log("No tokens were extracted — vars file not written.");
  }

  if (unmatchedCount > 0) {
    console.log();
    console.log(
      `${unmatchedCount} template(s) had no matching object in backups/${tenant}/. ` +
        `Manually fill in their token values in vars/${tenant}.vars.yaml.`
    );
  }

  console.log();
  console.log(`Done: ${matchedCount} matched, ${unmatchedCount} unmatched`);
}

// ---------------------------------------------------------------------------
// diff-tenants
// ---------------------------------------------------------------------------

function cmdDiffTenants(tenantA, tenantB) {
  console.log(`=== diff-tenants: ${tenantA}  vs  ${tenantB} ===`);
  console.log();

  const objectsA = readBackups(tenantA);
  const objectsB = readBackups(tenantB);

  console.log(`${tenantA}: ${objectsA.length} object(s)`);
  console.log(`${tenantB}: ${objectsB.length} object(s)`);
  console.log();

  // Index tenant B by "type::name" for fast lookup
  const indexB = new Map();
  for (const obj of objectsB) {
    const key = `${obj.content?.self?.type}::${obj.content?.self?.name}`;
    indexB.set(key, obj);
  }

  let matchedCount = 0;
  let differentCount = 0;
  let onlyInA = 0;

  for (const objA of objectsA) {
    const nameA = objA.content?.self?.name;
    const typeA = objA.content?.self?.type ?? objA.objectType;
    const key = `${typeA}::${nameA}`;

    const objB = indexB.get(key);
    if (!objB) {
      onlyInA++;
      continue;
    }

    const diffs = deepDiff(objA.content, objB.content);
    if (diffs.length === 0) {
      matchedCount++;
      continue;
    }

    differentCount++;
    console.log(`${typeA}  "${nameA}":`);
    for (const { path, valueA, valueB } of diffs) {
      const pathStr = path.join(".");
      const vA = valueA === undefined ? "(missing)" : JSON.stringify(valueA);
      const vB = valueB === undefined ? "(missing)" : JSON.stringify(valueB);
      console.log(`  ${pathStr}`);
      console.log(`    ${tenantA}: ${vA}`);
      console.log(`    ${tenantB}: ${vB}`);
    }
    console.log();
  }

  // Objects only in tenant B
  let onlyInB = 0;
  for (const objB of objectsB) {
    const nameB = objB.content?.self?.name;
    const typeB = objB.content?.self?.type ?? objB.objectType;
    const key = `${typeB}::${nameB}`;
    const matchA = objectsA.find(
      (a) => (a.content?.self?.type ?? a.objectType) + "::" + a.content?.self?.name === key
    );
    if (!matchA) onlyInB++;
  }

  console.log("--- Summary ---");
  console.log(`  Identical (by name+type):     ${matchedCount}`);
  console.log(`  Different (by name+type):     ${differentCount}`);
  console.log(`  Only in ${tenantA}:  ${onlyInA}`);
  console.log(`  Only in ${tenantB}:  ${onlyInB}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
  console.error("Usage: node scripts/tokenize.mjs <subcommand> [args]");
  console.error("");
  console.error("Subcommands:");
  console.error("");
  console.error("  create-template <tenant> [--template <name>]");
  console.error("      Extract environment-specific values from backups/<tenant>/,");
  console.error("      write tokenized templates to templates/<name>/ (default: 'default'),");
  console.error("      and seed vars/<tenant>.vars.yaml with the actual values.");
  console.error("");
  console.error("  find-tokens <tenant> [--template <name>]");
  console.error("      Match templates/<name>/ files to backups/<tenant>/ by self.name,");
  console.error("      extract values at every {{TOKEN}} position, and write");
  console.error("      vars/<tenant>.vars.yaml.");
  console.error("");
  console.error("  diff-tenants <tenant-a> <tenant-b>");
  console.error("      Compare two tenants' backups by name+type and print every field");
  console.error("      that differs — useful for identifying token candidates.");
  console.error("");
  console.error("Examples:");
  console.error("  # Step 1: create a template set from an existing backup");
  console.error("  node scripts/tokenize.mjs create-template beta-15156 --template default");
  console.error("");
  console.error("  # Step 2: extract token values for a second tenant");
  console.error("  node scripts/tokenize.mjs find-tokens production --template default");
  console.error("");
  console.error("  # Discover token candidates between two tenants");
  console.error("  node scripts/tokenize.mjs diff-tenants beta-15156 production");
  console.error("");
  console.error("  # Restore a template to the current tenant with its vars");
  console.error("  node scripts/restore.mjs local --tenant default --vars production");
}

const { subcommand, positional, templateName } = parseArgs();

try {
  switch (subcommand) {
    case "create-template": {
      const tenant = positional[0];
      if (!tenant) {
        console.error("Error: create-template requires a <tenant> argument");
        printUsage();
        process.exit(1);
      }
      cmdCreateTemplate(tenant, templateName);
      break;
    }

    case "find-tokens": {
      const tenant = positional[0];
      if (!tenant) {
        console.error("Error: find-tokens requires a <tenant> argument");
        printUsage();
        process.exit(1);
      }
      cmdFindTokens(tenant, templateName);
      break;
    }

    case "diff-tenants": {
      const [tenantA, tenantB] = positional;
      if (!tenantA || !tenantB) {
        console.error("Error: diff-tenants requires two <tenant> arguments");
        printUsage();
        process.exit(1);
      }
      cmdDiffTenants(tenantA, tenantB);
      break;
    }

    default:
      if (subcommand) {
        console.error(`Error: unknown subcommand "${subcommand}"`);
      }
      printUsage();
      process.exit(1);
  }
} catch (err) {
  console.error("FATAL:", err.message || err);
  process.exit(1);
}
