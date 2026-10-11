import { OAUTH_CONFIG, getImpersonationHeaders } from "../utils/headers";
import { type GoogleTokenResponse } from "./types";

const OAUTH_NETWORK_ATTEMPTS = 3;

async function postTokenForm(params: URLSearchParams): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= OAUTH_NETWORK_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(OAUTH_CONFIG.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });

      // OAuth 4xx responses are deterministic (invalid grant, revoked token,
      // etc.) and should be surfaced immediately. Retry only transient server
      // responses and network/TLS handshake failures.
      if (res.status < 500 || attempt === OAUTH_NETWORK_ATTEMPTS) return res;
    } catch (error) {
      lastError = error;
      if (attempt === OAUTH_NETWORK_ATTEMPTS) throw error;
      const code = (error as any)?.code || "network_error";
      console.warn(`[OAuth] Token endpoint ${code}; retrying (${attempt}/${OAUTH_NETWORK_ATTEMPTS}).`);
    }

    await new Promise(resolve => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
  }

  throw lastError || new Error("OAuth token request failed");
}

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    response_type: "code",
    scope: OAUTH_CONFIG.scopes.join(" "),
    access_type: "offline",
    prompt: "consent", 
    // Static challenge to match repo analysis
    code_challenge: "cFH3lPzU2FhJjQhHlGqKqQhHlGqKqQhHlGqKqQhHlGq", 
    code_challenge_method: "plain"
  });
  return `${OAUTH_CONFIG.authUri}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    client_secret: OAUTH_CONFIG.clientSecret, // REQUIRED for this Client ID
    redirect_uri: OAUTH_CONFIG.redirectUri,
    grant_type: "authorization_code",
    code: code,
    code_verifier: "cFH3lPzU2FhJjQhHlGqKqQhHlGqKqQhHlGqKqQhHlGq" 
  });

  const res = await postTokenForm(params);

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return await res.json() as GoogleTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    client_secret: OAUTH_CONFIG.clientSecret, // REQUIRED for this Client ID
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await postTokenForm(params);

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return await res.json() as GoogleTokenResponse;
}

export async function getProjectId(accessToken: string): Promise<string> {
  // Antigravity 2.x uses its own product identity. Trying legacy IDE types
  // first can bind the OAuth account to a Code Assist/CLOUD_SHELL project
  // whose model catalog differs from the desktop Antigravity session.
  const ideTypes = ["ANTIGRAVITY", "VSCODE", "JETBRAINS", "CLOUD_SHELL", "IDE_UNSPECIFIED"];
  const endpoints = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  ];

  for (const endpoint of endpoints) {
    for (const ideType of ideTypes) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: getImpersonationHeaders(accessToken),
          body: JSON.stringify({
            metadata: {
              ideType,
              platform: ideType === "ANTIGRAVITY" ? "WINDOWS" : "PLATFORM_UNSPECIFIED",
              pluginType: "GEMINI"
            }
          })
        });

        if (res.ok) {
          const data = await res.json() as any;
          const project = data?.cloudaicompanionProject;
          const projectId = typeof project === "string" ? project : project?.id;

          if (projectId) {
            console.log(`[OAuth] Discovered Project ID using ${ideType} via ${new URL(endpoint).hostname}: ${projectId}`);
            return projectId;
          }
        }
      } catch (e) {
        console.warn(`[OAuth] Failed to fetch project ID with ${ideType} via ${new URL(endpoint).hostname}:`, e);
      }
    }
  }

  return "";
}

export async function getUserEmail(accessToken: string): Promise<string> {
   const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
   });
   if (!res.ok) throw new Error("Failed to fetch user info");
   const data = await res.json() as any;
   return data.email as string;
}
