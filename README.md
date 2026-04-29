[![Discourse Topics][discourse-shield]][discourse-url]
[![Issues][issues-shield]][issues-url]
[![Latest Releases][release-shield]][release-url]
[![Contributor Shield][contributor-shield]][contributors-url]

[discourse-shield]:https://img.shields.io/discourse/topics?label=Discuss%20This%20Tool&server=https%3A%2F%2Fdeveloper.sailpoint.com%2Fdiscuss
[discourse-url]:https://developer.sailpoint.com/discuss/tag/workflows
[issues-shield]:https://img.shields.io/github/issues/sailpoint-oss/repo-template?label=Issues
[issues-url]:https://github.com/sailpoint-oss/repo-template/issues
[release-shield]: https://img.shields.io/github/v/release/sailpoint-oss/repo-template?label=Current%20Release
[release-url]:https://github.com/sailpoint-oss/repo-template/releases
[contributor-shield]:https://img.shields.io/github/contributors/sailpoint-oss/repo-template?label=Contributors
[contributors-url]:https://github.com/sailpoint-oss/repo-template/graphs/contributors

# Config Hub CI/CD — ISC Configuration Backup

Automated daily backup of SailPoint Identity Security Cloud (ISC) tenant configuration using the Configuration Hub and SP-Config APIs. Configuration objects are stored as JSON files in this repository, with git history providing a complete audit trail of changes over time.

## How It Works

A GitHub Actions workflow runs daily (6:00 AM UTC) and:

1. Authenticates with your ISC tenant using OAuth client credentials
2. Fetches all exportable configuration object types
3. Creates an SP-Config export (backup) of all objects
4. Downloads every object from the backup, organized by type
5. Commits changes to this repository (only if objects changed)
6. Deletes old backups from SailPoint to keep the tenant tidy

## Setup

### 1. Use this template

Fork or use this repository as a template for your tenant.

### 2. Create a SailPoint API client

In your ISC tenant, create a Personal Access Token (PAT) or API client with the following scopes:

- `sp:scopes:all` (or at minimum: `sp:config:read`, `sp:config:manage`)

### 3. Configure GitHub Secrets

Go to **Settings > Secrets and variables > Actions** and add:

| Secret | Description | Example |
|---|---|---|
| `TENANT_URL` | Your ISC API base URL | `https://acme.api.identitynow.com` |
| `CLIENT_ID` | API client ID | `a1b2c3d4...` |
| `CLIENT_SECRET` | API client secret | `x9y8z7w6...` |

### 4. Run manually (optional)

Go to **Actions > Daily ISC Backup > Run workflow** to trigger immediately.

## Backup Structure

```
backups/
  {tenant-name}/
    ACCESS_PROFILE/
      {objectId}.json
    ROLE/
      {objectId}.json
    SOURCE/
      {objectId}.json
    WORKFLOW/
      {objectId}.json
    ...
```

Each `.json` file contains the decoded, pretty-printed configuration object. The tenant name is extracted from your `TENANT_URL` (e.g., `acme` from `https://acme.api.identitynow.com`).

## Tracking Drift

Since every backup is committed to git, you can use standard git tools to track changes:

```bash
# See what changed in the last backup
git log --oneline -5

# Diff a specific object over time
git log -p backups/{tenant}/WORKFLOW/{objectId}.json
```

## Browsing and Restoring with the UI Development Kit

The [SailPoint UI Development Kit](https://github.com/sailpoint-oss/ui-development-kit) includes a **Config Hub** component that provides a visual interface for exploring the backups stored in this repository and restoring previous versions directly to your ISC tenant — no command line required.

### Features

- **Browse by object** — Select a configuration type (e.g., ROLE, SOURCE, WORKFLOW), browse all objects with their last-modified timestamps, and view a line-by-line diff between any two historical versions.
- **Browse by commit** — View a timeline of recent backup commits, see every file changed in each commit, and compare versions inline.
- **Restore** — Restore a single object or an entire bundle of objects from a commit back to your ISC tenant via the SP-Config API, with live job status polling.

### Setup

Once the UI Development Kit is running, open the Config Hub component and click the **settings icon**. Enter the following in the Repository Settings dialog:

| Setting | Description | Example |
|---|---|---|
| **Repository URL** | HTTPS URL of this repository | `https://github.com/org/colab-isc-config-hub-history` |
| **Backups Path** | Folder containing backups | `backups` |
| **Default Branch** | Branch the workflow commits to | `main` |
| **GitHub PAT** | GitHub Personal Access Token with `repo` scope | `ghp_xxxxxx...` |

Settings are saved to browser localStorage for future sessions.

## Tokenization — Environment-Specific Values

Tokenization lets you store environment-specific values (hostnames, URLs,
credentials, SAML endpoints, email addresses, etc.) as `{{TOKEN}}` placeholders
in reusable template files, then resolve them against a per-tenant variable file
at restore time.

### How It Works

1. **Template files** mirror the backup JSON envelope but with tokenized fields:
   ```json
   { "object": { "attributes": { "url": "{{SERVICENOW_TICKET_VEN03769_URL}}" } }, ... }
   ```
2. **Vars files** (`vars/<tenant>.vars.yaml`) hold the resolved values for each tenant:
   ```yaml
   SERVICENOW_TICKET_VEN03769_URL: "https://ven03769.service-now.com/"
   ```
3. At restore time, `restore.mjs --vars <tenant>` substitutes every placeholder
   before uploading to the SailPoint API.

The token format `{{UPPER_SNAKE_CASE}}` is deliberately distinct from ISC's own
`{{$.path}}` workflow interpolation syntax, so there is no collision.

### Directory Layout

```
templates/
  default/
    SOURCE/
      new-features.json        ← tokenized, named by self.name
    SERVICE_DESK_INTEGRATION/
      ServiceNow-Ticket-ven03769.json
    AUTH_ORG/
      beta-15156.json
    ...
vars/
  beta-15156.vars.yaml         ← resolved values for beta-15156
  production.vars.yaml         ← resolved values for production
```

### Tokenization Script

```bash
npm run tokenize -- <subcommand> [args]
# or directly:
node scripts/tokenize.mjs <subcommand> [args]
```

#### `create-template <tenant> [--template <name>]`

Read `backups/<tenant>/`, replace known environment-specific fields with
`{{TOKEN}}` placeholders, write tokenized files to `templates/<name>/`
(default template name: `default`), and seed `vars/<tenant>.vars.yaml`
with the actual values from the source tenant.

```bash
node scripts/tokenize.mjs create-template beta-15156 --template default
# → templates/default/SERVICE_DESK_INTEGRATION/ServiceNow-Ticket-ven03769.json
# → vars/beta-15156.vars.yaml
```

The following field paths are automatically tokenized (per object type).
These defaults live in [`token-paths.json`](token-paths.json) at the project
root — edit that file to add or remove paths for your own connector types
without touching source code (see [Customising Tokenizable Paths](#customising-tokenizable-paths) below).

| Type | Tokenized fields |
|------|-----------------|
| `SOURCE` | `connectorAttributes.host/token/url/user/username/password/clientId/clientSecret/baseurl/spConnectorInstanceId/spConnectorSpecId/sources`, `owner.id` |
| `SERVICE_DESK_INTEGRATION` | `attributes.url/tokenUrl/username/requesterSource`, `clusterRef.id`, `ownerRef.id`, `beforeProvisioningRule.id`, `provisioningConfig.managedResourceRefs[].id` ¹ |
| `AUTH_ORG` | `orgConfig.domain`, `tenant`, SAML `alias/callbackUrl/entityId` |
| `IDENTITY_PROFILE` | `authoritativeSource.id`, `owner.id`, all `sourceId` fields inside attribute transforms ¹ |
| `LIFECYCLE_STATE` | `identityProfileRef.id`, `accountActions[]/accountActionRefs[]` source IDs ¹, `emailNotificationOption.emailAddressList` ¹ |
| `ACCESS_PROFILE` | `owner.id`, `source.id` |
| `ROLE` / `GOVERNANCE_GROUP` / `SEGMENT` / `FORM_DEFINITION` | `owner.id` |
| `SOD_POLICY` | `externalPolicyReference`, `ownerRef.id`, `creatorId`/`creatorRef.id` (shared token) ¹ |
| `WORKFLOW` | `owner.id`; per step: `sp:http` url/oauth fields/`jsonRequestBody` UUIDs, `sp:send-email` static recipients/from/replyTo, `sp:interactive-form` formDefinitionId, `sp:compare-*` UUID comparison values ¹ |
| `TRIGGER_SUBSCRIPTION` | `workflowConfig.workflowId` |

¹ Handled by a compiled custom scanner, not configurable via `token-paths.json`.

#### `find-tokens <tenant> [--template <name>]`

Match each template file against `backups/<tenant>/` by `self.name` and
`self.type`, extract the value at every `{{TOKEN}}` position, and write
`vars/<tenant>.vars.yaml`. Use this to populate vars for a second tenant
without manually editing the file.

```bash
node scripts/tokenize.mjs find-tokens production --template default
# → vars/production.vars.yaml
```

Objects are matched by display name (`self.name`). If a template has no matching
object in the target tenant's backup, a warning is printed and those tokens are
left for manual entry.

#### `diff-tenants <tenant-a> <tenant-b>`

Compare two tenants' backups by `self.type` + `self.name` and print every field
that differs between matched pairs. Use this to discover additional token
candidates that should be added to `token-paths.json`.

```bash
node scripts/tokenize.mjs diff-tenants beta-15156 production
```

### Restoring with Token Substitution

Pass `--vars <tenant>` to `restore.mjs` to apply a vars file before uploading:

```bash
# Restore the default template set to the current tenant using production vars
node --env-file=.env scripts/restore.mjs local --tenant default --vars production --full

# Restore a standard backup with vars substituted (e.g. cross-env promotion)
node --env-file=.env scripts/restore.mjs local --tenant beta-15156 --vars production
```

> **Windows / PowerShell note:** Use `node --env-file=.env scripts/restore.mjs` directly
> instead of `npm run restore --` when passing `--tenant`, `--vars`, `--base`, or `--name`
> flags. npm on Windows silently strips unknown `--flag` arguments even after the `--`
> separator, so the flags never reach the script.

When `--tenant` names a directory that does not exist under `backups/`, restore
automatically looks in `templates/<name>/` instead.

### End-to-End Example

```bash
# 1. Generate template + seed vars from an existing backup
node scripts/tokenize.mjs create-template beta-15156 --template default

# 2. Edit vars/beta-15156.vars.yaml to fill in any gaps, then commit templates/

# 3. For a new tenant, extract its values by matching against the template
node scripts/tokenize.mjs find-tokens production --template default

# 4. Manually fill any unmatched tokens in vars/production.vars.yaml

# 5. Restore the template to production with its vars
#    (use node directly on Windows — npm strips --flag args on PowerShell)
node --env-file=.env scripts/restore.mjs local --tenant default --vars production --full
```

### Customising Tokenizable Paths

`token-paths.json` at the project root controls which fields are tokenized for
each ISC object type. Edit it to extend coverage for connector types not
included by default — no source-code changes required.

```jsonc
// token-paths.json (excerpt)
{
  "tokenizablePaths": {
    "SOURCE": [
      ["object", "connectorAttributes", "host"],
      // add a custom REST connector field:
      ["object", "connectorAttributes", "apiEndpoint"]
    ]
  }
}
```

Each entry is an array of JSON keys and/or integer array indices that address a
field in the backup envelope.  Numeric entries index into arrays
(e.g. `["object", "serviceProviderConfig", "federationProtocolDetails", 0, "alias"]`).

You can also add a new object type entirely by creating a new key under
`tokenizablePaths`. Any type not listed in `typeAbbreviations` will fall back
to a 4-character auto-generated prefix.

> **Note** — The following behaviour is **not** configurable via `token-paths.json`
> and requires code changes to `scripts/token-utils.mjs`:
> - Workflow step scanning (sp:http, sp:send-email, sp:interactive-form, compare steps)
> - IDENTITY_PROFILE transform `sourceId` recursion
> - LIFECYCLE_STATE `accountActions`/`accountActionRefs` pairing
> - SERVICE_DESK_INTEGRATION `managedResourceRefs` scanning
> - SOD_POLICY `creatorId`/`creatorRef.id` token sharing

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<!-- CONTACT -->
## Discuss
[Click Here](https://developer.sailpoint.com/dicuss/tag/{tagName}) to discuss this tool with other users.
