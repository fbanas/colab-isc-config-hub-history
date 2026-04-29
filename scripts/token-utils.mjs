// ---------------------------------------------------------------------------
// Shared tokenization utilities for tokenize.mjs and restore.mjs
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// token-paths.json — user-editable configuration
//
// TOKENIZABLE_PATHS and TYPE_ABBREVIATIONS are loaded from token-paths.json
// in the working directory (project root) so users can add or remove paths
// without editing source code.  The built-in values below serve as fallbacks
// when the file is absent.
//
// Custom scanners for complex nested structures (workflow steps, identity-
// profile transforms, lifecycle-state account-actions, SDIM managed-resources,
// SOD-policy creator pairing) are compiled in this file and cannot be
// configured via token-paths.json.
// ---------------------------------------------------------------------------

const TOKEN_PATHS_FILE = "token-paths.json";

const BUILTIN_TOKENIZABLE_PATHS = {
  SOURCE: [
    ["object", "connectorAttributes", "spConnectorInstanceId"],
    ["object", "connectorAttributes", "spConnectorSpecId"],
    ["object", "connectorAttributes", "host"],
    ["object", "connectorAttributes", "token"],
    ["object", "connectorAttributes", "clientId"],
    ["object", "connectorAttributes", "clientSecret"],
    ["object", "connectorAttributes", "url"],
    ["object", "connectorAttributes", "user"],
    ["object", "connectorAttributes", "baseurl"],
    ["object", "connectorAttributes", "username"],
    ["object", "connectorAttributes", "password"],
    ["object", "connectorAttributes", "sources"],
    ["object", "owner", "id"],
  ],
  SERVICE_DESK_INTEGRATION: [
    ["object", "attributes", "url"],
    ["object", "attributes", "tokenUrl"],
    ["object", "attributes", "username"],
    ["object", "attributes", "requesterSource"],
    ["object", "clusterRef", "id"],
    ["object", "ownerRef", "id"],
    ["object", "beforeProvisioningRule", "id"],
  ],
  AUTH_ORG: [
    ["object", "orgConfig", "domain"],
    ["object", "tenant"],
    ["object", "serviceProviderConfig", "federationProtocolDetails", 0, "alias"],
    ["object", "serviceProviderConfig", "federationProtocolDetails", 0, "callbackUrl"],
    ["object", "serviceProviderConfig", "federationProtocolDetails", 0, "entityId"],
  ],
  IDENTITY_PROFILE: [
    ["object", "authoritativeSource", "id"],
    ["object", "owner", "id"],
  ],
  LIFECYCLE_STATE: [
    ["object", "identityProfileRef", "id"],
  ],
  ACCESS_PROFILE: [
    ["object", "owner", "id"],
    ["object", "source", "id"],
  ],
  ROLE:             [["object", "owner", "id"]],
  GOVERNANCE_GROUP: [["object", "owner", "id"]],
  SEGMENT:          [["object", "owner", "id"]],
  SOD_POLICY: [
    ["object", "externalPolicyReference"],
    ["object", "ownerRef", "id"],
  ],
  WORKFLOW:             [["object", "owner", "id"]],
  TRIGGER_SUBSCRIPTION: [["object", "workflowConfig", "workflowId"]],
  FORM_DEFINITION:      [["object", "owner", "id"]],
};

const BUILTIN_TYPE_ABBREVIATIONS = {
  ACCESS_PROFILE:          "AP",
  AUTH_ORG:                "AUTH",
  CONNECTOR_RULE:          "RULE",
  FORM_DEFINITION:         "FORM",
  GOVERNANCE_GROUP:        "GG",
  IDENTITY_OBJECT_CONFIG:  "IOC",
  IDENTITY_PROFILE:        "IP",
  LIFECYCLE_STATE:         "LC",
  NOTIFICATION_TEMPLATE:   "NT",
  PASSWORD_POLICY:         "PP",
  ROLE:                    "ROLE",
  SEGMENT:                 "SEG",
  SERVICE_DESK_INTEGRATION:"SDIM",
  SOD_POLICY:              "SOD",
  SOURCE:                  "SRC",
  TAG:                     "TAG",
  TRANSFORM:               "XFORM",
  TRIGGER_SUBSCRIPTION:    "TRIG",
  WORKFLOW:                "WF",
};

/**
 * Load token-paths.json from the project root (current working directory).
 * Returns the parsed contents, or null if the file does not exist.
 * Throws on JSON parse errors so misconfiguration is caught immediately.
 */
function loadTokenPathsFile() {
  if (!existsSync(TOKEN_PATHS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATHS_FILE, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${TOKEN_PATHS_FILE}: ${err.message}`);
  }
}

const _config = loadTokenPathsFile();

/**
 * Tokenizable field paths per object type.
 * Sourced from token-paths.json when present, otherwise the built-in defaults.
 *
 * Each value is an array of path arrays. Each path array is an ordered list of
 * string keys and/or numeric array indices that address a field in the backup
 * JSON envelope (e.g. ["object", "connectorAttributes", "host"]).
 */
export const TOKENIZABLE_PATHS = _config?.tokenizablePaths ?? BUILTIN_TOKENIZABLE_PATHS;

/**
 * Short type prefix used to qualify token names, preventing collisions when
 * two different object types share the same self.name.
 * Sourced from token-paths.json when present, otherwise the built-in defaults.
 */
export const TYPE_ABBREVIATIONS = _config?.typeAbbreviations ?? BUILTIN_TYPE_ABBREVIATIONS;

// ── WORKFLOW: step attributes to check for sp:http actions ─────────────────
const WORKFLOW_HTTP_ATTRS = ["url", "oAuthTokenUrl", "oAuthClientId", "oAuthClientSecret"];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get a value deep in an object following an array of keys/indices.
 * Returns undefined if any segment of the path does not exist.
 */
export function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Set a value deep in an object following an array of keys/indices (mutates).
 * Creates intermediate objects as needed.
 */
export function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== "object") {
      cur[key] = typeof path[i + 1] === "number" ? [] : {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Token name helpers
// ---------------------------------------------------------------------------

/**
 * Convert a display name (self.name) to an UPPER_SNAKE_CASE token prefix.
 * e.g. "ServiceNow Ticket ven03769" → "SERVICENOW_TICKET_VEN03769"
 */
export function nameToPrefix(name) {
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Make a display name safe for use as a filesystem filename.
 */
export function sanitizeName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim() || "unnamed";
}

/**
 * Derive a descriptive field-name suffix from the tail of a path.
 * When the last key is exactly "id", prepend the parent key so the result
 * is e.g. "OWNER_ID" instead of just "ID".
 */
function fieldSuffix(path) {
  const lastSeg = path[path.length - 1];
  const lastKey = String(lastSeg).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (lastKey === "ID" && path.length >= 2) {
    const parentKey = String(path[path.length - 2]).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return `${parentKey}_ID`;
  }
  return lastKey;
}

/**
 * Return true when val looks like an ISC UUID (32 hex chars or standard
 * 8-4-4-4-12 dashed UUID).
 */
function isUuidLike(val) {
  if (typeof val !== "string" || !val) return false;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) ||
    /^[0-9a-f]{32}$/i.test(val)
  );
}

// ---------------------------------------------------------------------------
// WORKFLOW step scanning
// ---------------------------------------------------------------------------

/**
 * For a WORKFLOW object, scan all steps and return { path, tokenName, isArray? }
 * entries for every tokenizable attribute found:
 *
 *  sp:http           — url, oAuthTokenUrl, oAuthClientId, oAuthClientSecret;
 *                      jsonRequestBody fields that look like UUIDs
 *  sp:send-email     — static recipientEmailList; static from/replyTo addresses
 *  sp:interactive-form — formDefinitionId
 *  sp:compare-strings/numbers — choiceList[i].variableB when UUID-like
 *
 * @param {object} obj    - parsed backup object
 * @param {string} prefix - pre-computed type-qualified token prefix
 */
export function getWorkflowTokenPaths(obj, prefix) {
  const results = [];
  const steps = obj?.object?.definition?.steps;
  if (!steps || typeof steps !== "object") return results;

  for (const [stepName, step] of Object.entries(steps)) {
    if (!step || typeof step !== "object") continue;
    const stepPrefix = `${prefix}_STEP_${nameToPrefix(stepName)}`;
    const basePath = ["object", "definition", "steps", stepName];

    // ── sp:http ────────────────────────────────────────────────────────────
    if (step.actionId === "sp:http" && step.attributes) {
      for (const attr of WORKFLOW_HTTP_ATTRS) {
        const val = step.attributes[attr];
        if (val !== undefined && val !== null && val !== "") {
          results.push({
            path: [...basePath, "attributes", attr],
            tokenName: `${stepPrefix}_${attr.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
          });
        }
      }
      // jsonRequestBody: tokenize any UUID-valued fields
      const body = step.attributes.jsonRequestBody;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        for (const [key, val] of Object.entries(body)) {
          if (isUuidLike(val)) {
            results.push({
              path: [...basePath, "attributes", "jsonRequestBody", key],
              tokenName: `${stepPrefix}_REQUEST_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ID`,
            });
          }
        }
      }
    }

    // ── sp:send-email ──────────────────────────────────────────────────────
    if (step.actionId === "sp:send-email" && step.attributes) {
      const attrs = step.attributes;

      // Static recipient list (not a dynamic $. reference)
      if (
        Array.isArray(attrs.recipientEmailList) &&
        attrs.recipientEmailList.some((e) => typeof e === "string" && !e.startsWith("$."))
      ) {
        const staticEmails = attrs.recipientEmailList.filter(
          (e) => typeof e === "string" && !e.startsWith("$.")
        );
        if (staticEmails.length > 0) {
          results.push({
            path: [...basePath, "attributes", "recipientEmailList"],
            tokenName: `${stepPrefix}_RECIPIENT_EMAILS`,
            isArray: true,
          });
        }
      }

      // Static from address
      if (typeof attrs.from === "string" && attrs.from && !attrs.from.startsWith("$.")) {
        results.push({
          path: [...basePath, "attributes", "from"],
          tokenName: `${stepPrefix}_FROM_ADDRESS`,
        });
      }

      // Static replyTo address
      if (typeof attrs.replyTo === "string" && attrs.replyTo && !attrs.replyTo.startsWith("$.")) {
        results.push({
          path: [...basePath, "attributes", "replyTo"],
          tokenName: `${stepPrefix}_REPLY_TO_ADDRESS`,
        });
      }
    }

    // ── sp:interactive-form ────────────────────────────────────────────────
    if (step.actionId === "sp:interactive-form" && step.attributes?.formDefinitionId) {
      results.push({
        path: [...basePath, "attributes", "formDefinitionId"],
        tokenName: `${stepPrefix}_FORM_DEFINITION_ID`,
      });
    }

    // ── sp:compare-strings / sp:compare-numbers ────────────────────────────
    if (
      (step.actionId === "sp:compare-strings" || step.actionId === "sp:compare-numbers") &&
      Array.isArray(step.choiceList)
    ) {
      for (let ci = 0; ci < step.choiceList.length; ci++) {
        const choice = step.choiceList[ci];
        if (isUuidLike(choice?.variableB)) {
          results.push({
            path: [...basePath, "choiceList", ci, "variableB"],
            tokenName: `${stepPrefix}_CHOICE_${ci}_COMPARE_VALUE`,
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// LIFECYCLE_STATE custom scanner
// ---------------------------------------------------------------------------

/**
 * Scan a LIFECYCLE_STATE object for source IDs inside accountActions /
 * accountActionRefs, pairing the two arrays so they share the same token.
 * Also captures static emailAddressList entries.
 */
function getLifecycleStateTokenPaths(obj, prefix) {
  const results = [];

  const actions = obj?.object?.accountActions ?? [];
  const actionRefs = obj?.object?.accountActionRefs ?? [];
  const count = Math.max(actions.length, actionRefs.length);

  for (let i = 0; i < count; i++) {
    const action = actions[i];
    const actionRef = actionRefs[i];
    const actionName = nameToPrefix(actionRef?.action ?? action?.action ?? `ACTION_${i}`);
    const sourceRefs = actionRef?.sourceIdsRefs ?? [];
    const sourceIds = action?.sourceIds ?? [];
    const maxSources = Math.max(sourceRefs.length, sourceIds.length);

    for (let j = 0; j < maxSources; j++) {
      const ref = sourceRefs[j];
      const sourceName = ref?.name ? nameToPrefix(ref.name) : `SOURCE_${j}`;
      const tokenName = `${prefix}_${actionName}_${sourceName}_ID`;

      // accountActionRefs entry (has id + name)
      if (ref?.id) {
        results.push({
          path: ["object", "accountActionRefs", i, "sourceIdsRefs", j, "id"],
          tokenName,
        });
      }
      // accountActions entry (bare ID string — shares the same token)
      if (sourceIds[j]) {
        results.push({
          path: ["object", "accountActions", i, "sourceIds", j],
          tokenName,
        });
      }
    }
  }

  // Static email notification list
  const emailList = obj?.object?.emailNotificationOption?.emailAddressList;
  if (Array.isArray(emailList) && emailList.length > 0) {
    results.push({
      path: ["object", "emailNotificationOption", "emailAddressList"],
      tokenName: `${prefix}_NOTIFICATION_EMAILS`,
      isArray: true,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// SERVICE_DESK_INTEGRATION custom scanner
// ---------------------------------------------------------------------------

/**
 * Scan managedResourceRefs array for source ID references.
 * The catalogItem map (sourceId → ServiceNow sys_id) is intentionally left
 * for manual tokenization due to its unusual dict-key-as-ID structure.
 */
function getSdimTokenPaths(obj, prefix) {
  const results = [];

  const refs = obj?.object?.provisioningConfig?.managedResourceRefs;
  if (!Array.isArray(refs)) return results;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (!ref?.id) continue;
    const resourceName = ref.name ? nameToPrefix(ref.name) : `RESOURCE_${i}`;
    results.push({
      path: ["object", "provisioningConfig", "managedResourceRefs", i, "id"],
      tokenName: `${prefix}_MANAGED_${resourceName}_ID`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// IDENTITY_PROFILE custom scanner
// ---------------------------------------------------------------------------

/**
 * Recursively find all sourceId fields nested inside the identity attribute
 * transforms and return token path entries. Paths that share the same
 * sourceId value receive the same token name so one variable covers all
 * transform references to the same source.
 */
function getIdentityProfileTokenPaths(obj, prefix) {
  const results = [];
  // Track sourceId → tokenName to share tokens across transforms
  const sourceTokenMap = new Map();

  const transforms = obj?.object?.identityAttributeConfig?.attributeTransforms;
  if (!Array.isArray(transforms)) return results;

  function walk(node, pathSoFar) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;

    if (typeof node.sourceId === "string" && node.sourceId) {
      let tokenName = sourceTokenMap.get(node.sourceId);
      if (!tokenName) {
        const srcLabel = node.sourceName ? nameToPrefix(node.sourceName) : "SOURCE";
        tokenName = `${prefix}_${srcLabel}_SOURCE_ID`;
        sourceTokenMap.set(node.sourceId, tokenName);
      }
      results.push({ path: [...pathSoFar, "sourceId"], tokenName });
      return;
    }

    for (const [key, val] of Object.entries(node)) {
      if (val && typeof val === "object") {
        walk(val, [...pathSoFar, key]);
      }
    }
  }

  for (let i = 0; i < transforms.length; i++) {
    const td = transforms[i]?.transformDefinition;
    if (td) {
      walk(
        td,
        ["object", "identityAttributeConfig", "attributeTransforms", i, "transformDefinition"]
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// SOD_POLICY custom scanner
// ---------------------------------------------------------------------------

/**
 * SOD_POLICY stores the creator identity in two redundant fields:
 * creatorId (string) and creatorRef.id (object ref). Assign both the
 * same token so a single vars entry covers both.
 */
function getSodPolicyTokenPaths(obj, prefix) {
  const results = [];

  const creatorId = obj?.object?.creatorId;
  const creatorRefId = obj?.object?.creatorRef?.id;

  if (creatorId || creatorRefId) {
    const tokenName = `${prefix}_CREATOR_ID`;
    if (creatorId) {
      results.push({ path: ["object", "creatorId"], tokenName });
    }
    if (creatorRefId) {
      results.push({ path: ["object", "creatorRef", "id"], tokenName });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Master token path resolver
// ---------------------------------------------------------------------------

/**
 * Build the full list of { path, tokenName, isArray? } entries for an object.
 * Combines static TOKENIZABLE_PATHS entries with type-specific custom scanners.
 * Only includes entries where the value actually exists and is non-empty.
 *
 * Token names include a type abbreviation prefix (e.g. WF_, SRC_, LC_) to
 * prevent collisions between different object types that share the same name.
 */
export function getTokenPaths(obj) {
  const type = obj?.self?.type;
  const name = obj?.self?.name ?? "UNKNOWN";
  const typeAbbr = TYPE_ABBREVIATIONS[type] ?? nameToPrefix(type).slice(0, 4);

  // For LIFECYCLE_STATE include the parent identity profile name so that
  // states with the same self.name in different profiles get distinct tokens.
  let nameSegment = nameToPrefix(name);
  if (type === "LIFECYCLE_STATE") {
    const profileName = obj?.object?.identityProfileRef?.name;
    if (profileName) {
      nameSegment = `${nameToPrefix(profileName)}_${nameSegment}`;
    }
  }

  const prefix = `${typeAbbr}_${nameSegment}`;
  const results = [];

  // Static paths
  for (const path of TOKENIZABLE_PATHS[type] ?? []) {
    const value = getPath(obj, path);
    if (value === undefined || value === null || value === "") continue;
    // isArray check for array-typed static paths (e.g. connectorAttributes.sources)
    const isArray = Array.isArray(value);
    results.push({ path, tokenName: `${prefix}_${fieldSuffix(path)}`, ...(isArray ? { isArray } : {}) });
  }

  // Type-specific dynamic scanners (pass the pre-computed prefix)
  if (type === "WORKFLOW") {
    results.push(...getWorkflowTokenPaths(obj, prefix));
  }
  if (type === "LIFECYCLE_STATE") {
    results.push(...getLifecycleStateTokenPaths(obj, prefix));
  }
  if (type === "SERVICE_DESK_INTEGRATION") {
    results.push(...getSdimTokenPaths(obj, prefix));
  }
  if (type === "IDENTITY_PROFILE") {
    results.push(...getIdentityProfileTokenPaths(obj, prefix));
  }
  if (type === "SOD_POLICY") {
    results.push(...getSodPolicyTokenPaths(obj, prefix));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tokenization: backup → template + vars
// ---------------------------------------------------------------------------

/**
 * Deep-clone an object and replace all tokenizable field values with
 * {{TOKEN_NAME}} placeholders. Returns:
 *   tokenized — the cloned object with placeholders in place
 *   tokenMap  — { tokenName: actualValue } for writing to a vars file
 *
 * Array-valued tokens are stored in the template as ["{{TOKEN_NAME}}"] and
 * in tokenMap as a string[] for the vars file.
 *
 * When the same tokenName appears multiple times (e.g. the same source ID
 * referenced in many identity transforms), the value must be identical;
 * a warning is printed if it differs.
 */
export function tokenizeObject(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  const tokenMap = {};

  for (const { path, tokenName, isArray } of getTokenPaths(obj)) {
    const value = getPath(obj, path);
    if (value === undefined || value === null) continue;

    if (isArray && Array.isArray(value)) {
      if (tokenName in tokenMap && JSON.stringify(tokenMap[tokenName]) !== JSON.stringify(value)) {
        console.warn(`  Warning: token "${tokenName}" has conflicting values — keeping first`);
      } else {
        tokenMap[tokenName] = value;
      }
      setPath(clone, path, [`{{${tokenName}}}`]);
    } else {
      const strVal = String(value);
      if (tokenName in tokenMap && tokenMap[tokenName] !== strVal) {
        console.warn(`  Warning: token "${tokenName}" has conflicting values — keeping first`);
      } else {
        tokenMap[tokenName] = strVal;
      }
      setPath(clone, path, `{{${tokenName}}}`);
    }
  }

  return { tokenized: clone, tokenMap };
}

// ---------------------------------------------------------------------------
// Token application: template + vars → resolved object
// ---------------------------------------------------------------------------

/**
 * Apply a vars map to an object by substituting all {{TOKEN_NAME}} placeholders.
 * Operates on the JSON string representation to handle any nesting depth.
 *
 * Array-valued vars replace the sentinel array ["{{TOKEN}}"] with the full array.
 * Scalar vars replace the quoted placeholder "{{TOKEN}}" with the quoted value.
 *
 * Throws if any {{UPPER_CASE_TOKEN}} placeholders remain after substitution.
 * ISC's own {{$.path}} workflow interpolation is intentionally preserved
 * because it starts with "$." rather than an uppercase letter.
 */
export function applyTokens(obj, vars) {
  let jsonStr = JSON.stringify(obj);

  for (const [token, value] of Object.entries(vars)) {
    if (Array.isArray(value)) {
      // Template stores array tokens as ["{{TOKEN}}"] — replace with real array
      const arrayPlaceholder = JSON.stringify([`{{${token}}}`]);
      const arrayValue = JSON.stringify(value);
      jsonStr = jsonStr.replaceAll(arrayPlaceholder, arrayValue);
    }
    // Replace quoted scalar placeholder "{{TOKEN}}" with quoted real value
    const quotedPlaceholder = `"{{${token}}}"`;
    const quotedValue = JSON.stringify(String(value));
    jsonStr = jsonStr.replaceAll(quotedPlaceholder, quotedValue);
  }

  // Detect unresolved tokens: {{UPPER_SNAKE}} but not {{$.path}} style
  const unresolved = [...jsonStr.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map((m) => m[1]);
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved token(s) after substitution: ${[...new Set(unresolved)].join(", ")}\n` +
        `Ensure vars file contains entries for all required tokens.`
    );
  }

  return JSON.parse(jsonStr);
}

// ---------------------------------------------------------------------------
// Cross-tenant token extraction: template + backup → vars
// ---------------------------------------------------------------------------

/**
 * Recursively walk both a template object (with {{TOKEN}} placeholders) and a
 * matching backup object to extract { tokenName: actualValue } pairs.
 */
export function extractTokenValues(templateObj, backupObj) {
  const vars = {};

  function walk(tmpl, backup) {
    if (backup === undefined || backup === null) return;

    // Scalar token placeholder: "{{TOKEN_NAME}}"
    if (typeof tmpl === "string" && /^\{\{[A-Z][A-Z0-9_]*\}\}$/.test(tmpl)) {
      const tokenName = tmpl.slice(2, -2);
      vars[tokenName] = backup;
      return;
    }

    // Array token placeholder: ["{{TOKEN_NAME}}"]
    if (
      Array.isArray(tmpl) &&
      tmpl.length === 1 &&
      typeof tmpl[0] === "string" &&
      /^\{\{[A-Z][A-Z0-9_]*\}\}$/.test(tmpl[0])
    ) {
      const tokenName = tmpl[0].slice(2, -2);
      if (Array.isArray(backup)) {
        vars[tokenName] = backup;
      }
      return;
    }

    if (Array.isArray(tmpl) && Array.isArray(backup)) {
      const len = Math.min(tmpl.length, backup.length);
      for (let i = 0; i < len; i++) walk(tmpl[i], backup[i]);
      return;
    }

    if (tmpl !== null && typeof tmpl === "object" && typeof backup === "object") {
      for (const key of Object.keys(tmpl)) {
        if (key in backup) walk(tmpl[key], backup[key]);
      }
    }
  }

  walk(templateObj, backupObj);
  return vars;
}

// ---------------------------------------------------------------------------
// Backup file lookup by name
// ---------------------------------------------------------------------------

/**
 * Search a type subdirectory under backupDir for a file whose self.name
 * matches the given name. Returns { filePath, parsed } or null.
 *
 * @param {string} profileHint  Optional parent-context name for disambiguation.
 *   For LIFECYCLE_STATE, pass the identityProfileRef.name from the template to
 *   prefer the matching state over same-named states in other profiles.
 */
export function matchBackupByName(backupDir, type, name, profileHint = undefined) {
  const typeDir = join(backupDir, type);
  if (!existsSync(typeDir)) return null;

  let files;
  try {
    files = readdirSync(typeDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  const candidates = [];
  for (const file of files) {
    const filePath = join(typeDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed?.self?.name === name) {
        candidates.push({ filePath, parsed });
      }
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;

  // If a profile hint was given, prefer the candidate whose parent context matches
  if (profileHint && candidates.length > 1) {
    const hinted = candidates.find(
      (c) => c.parsed?.object?.identityProfileRef?.name === profileHint
    );
    if (hinted) return hinted;
  }

  return candidates[0];
}

// ---------------------------------------------------------------------------
// Deep diff
// ---------------------------------------------------------------------------

/**
 * Recursively compare two values and collect { path, valueA, valueB } entries
 * for every differing leaf. Skips self.id, jwsSignature, and object.modified.
 */
export function deepDiff(a, b, path = []) {
  const SKIP_KEYS = new Set(["jwsSignature", "modified"]);

  if (path.length === 1 && path[0] === "self") {
    const diff = [];
    for (const k of ["name", "type"]) {
      if (a?.[k] !== b?.[k]) diff.push({ path: [...path, k], valueA: a?.[k], valueB: b?.[k] });
    }
    return diff;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const diffs = [];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      diffs.push(...deepDiff(a[i], b[i], [...path, i]));
    }
    return diffs;
  }

  if (a !== null && typeof a === "object" && b !== null && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [];
    for (const k of keys) {
      if (SKIP_KEYS.has(k)) continue;
      diffs.push(...deepDiff(a[k], b[k], [...path, k]));
    }
    return diffs;
  }

  if (a !== b) {
    return [{ path, valueA: a, valueB: b }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// YAML serialization / parsing (minimal — no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Serialize a vars map to simple YAML. Supports string scalars and string arrays.
 */
export function varsToYaml(vars, tenantName) {
  const lines = [`# Variable values for tenant: ${tenantName}`, ""];
  for (const [key, value] of Object.entries(vars).sort()) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - "${String(item).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
      }
    } else {
      lines.push(`${key}: "${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse a simple YAML vars file written by varsToYaml().
 * Handles KEY: "value" scalar lines and YAML block sequences.
 */
export function parseVarsYaml(content) {
  const vars = {};
  const lines = content.split(/\r?\n/);
  let currentKey = null;
  let currentArray = null;

  for (const line of lines) {
    // Array item line
    if (currentArray !== null && /^\s+-\s/.test(line)) {
      const raw = line.replace(/^\s+-\s+/, "").trim();
      currentArray.push(raw.replace(/^"(.*)"$/s, "$1").replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
      continue;
    }

    // Non-item line while collecting array → commit it
    if (currentArray !== null) {
      vars[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    // Skip comments and blank lines
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // KEY: value  or  KEY:  (array start)
    const match = line.match(/^([A-Z][A-Z0-9_]*):\s*(.*)/);
    if (match) {
      const key = match[1];
      const rest = match[2].trim();
      if (rest === "") {
        currentKey = key;
        currentArray = [];
      } else {
        vars[key] = rest
          .replace(/^"(.*)"$/s, "$1")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    }
  }

  // Commit any trailing array
  if (currentArray !== null && currentKey !== null) {
    vars[currentKey] = currentArray;
  }

  return vars;
}
