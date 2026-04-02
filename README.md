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

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<!-- CONTACT -->
## Discuss
[Click Here](https://developer.sailpoint.com/dicuss/tag/{tagName}) to discuss this tool with other users.
