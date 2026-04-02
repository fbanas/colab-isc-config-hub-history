// ---------------------------------------------------------------------------
// Shared configuration and helpers for backup/restore scripts
// ---------------------------------------------------------------------------

export const TENANT_URL = requiredEnv("TENANT_URL").replace(/\/+$/, "");
export const CLIENT_ID = requiredEnv("CLIENT_ID");
export const CLIENT_SECRET = requiredEnv("CLIENT_SECRET");

export const API_VERSION = "v2025";
export const MAX_RETRIES = 3;

// Extract tenant name from URL (e.g. "https://beta-15156.api.identitynow-demo.com" → "beta-15156")
export const TENANT_NAME = new URL(TENANT_URL).hostname.split(".")[0];

let accessToken = "";

export function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`ERROR: Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an authenticated API call with retry logic for 429/5xx errors.
 */
export async function apiCall(method, path, body = undefined) {
  const url = `${TENANT_URL}${path}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (res.ok) {
      if (res.status === 204) return null;
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text);
    }

    if (res.status === 429 || res.status >= 500) {
      const wait = attempt * 5_000;
      console.warn(
        `  Retry ${attempt}/${MAX_RETRIES}: HTTP ${res.status} on ${method} ${path} — waiting ${wait / 1000}s`
      );
      await sleep(wait);
      continue;
    }

    const errBody = await res.text().catch(() => "");
    throw new Error(
      `API error: HTTP ${res.status} on ${method} ${path}\n${errBody}`
    );
  }

  throw new Error(
    `API call failed after ${MAX_RETRIES} retries: ${method} ${path}`
  );
}

/**
 * Authenticate with SailPoint using OAuth client credentials.
 */
export async function authenticate() {
  console.log("Authenticating...");

  const res = await fetch(`${TENANT_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Authentication failed: HTTP ${res.status}\n${errBody}`);
  }

  const data = await res.json();
  accessToken = data.access_token;

  if (!accessToken) {
    throw new Error("Authentication response missing access_token");
  }

  console.log("Authenticated successfully");
}

/**
 * Get the current access token (must call authenticate() first).
 */
export function getAccessToken() {
  return accessToken;
}
