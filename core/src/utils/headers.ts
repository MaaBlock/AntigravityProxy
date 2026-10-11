import { type DeviceFingerprint } from "../auth/types";
import { release } from "node:os";

export const OAUTH_CONFIG = {
  clientId: process.env.GOOGLE_CLIENT_ID || Buffer.from("313037313030363036303539312d746d687373696e326832316c63726532333576746f6c6f6a68346734303365702e617070732e676f6f676c6575736572636f6e74656e742e636f6d", "hex").toString("utf-8"),
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || Buffer.from("474f435350582d4b35384657523438364c644c4a316d4c4238735843347a3671444166", "hex").toString("utf-8"),
  authUri: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUri: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs"
  ],
  redirectUri: `http://localhost:${process.env.PORT || "8317"}/oauth-callback`
};

const ANTIGRAVITY_VERSION = "2.8.0";

const PLATFORMS = ["windows/amd64"] as const;

const ARCHITECTURES = ["amd64"] as const;

const IDE_TYPES = [
  "ANTIGRAVITY"
] as const;

const PLATFORM_NAMES = [
  "WINDOWS"
] as const;

const SDK_CLIENTS = [
  "google-cloud-sdk vscode_cloudshelleditor/0.1",
] as const;

const GEMINI_CLI_USER_AGENTS = [
  "google-api-nodejs-client/9.15.1",
  "google-api-nodejs-client/9.14.0",
  "google-api-nodejs-client/9.13.0",
  "google-api-nodejs-client/10.3.0",
] as const;

const GEMINI_CLI_API_CLIENTS = [
  "gl-node/22.17.0",
  "gl-node/22.12.0",
  "gl-node/20.18.0",
  "gl-node/21.7.0",
  "gl-node/22.18.0",
] as const;

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateDeviceId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateSessionToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateStableQuotaUser(email: string): string {
  const hash = Buffer.from(new Bun.CryptoHasher("sha256").update(email).digest()).toString("hex");
  return `device-${hash.substring(0, 16)}`;
}

function generateQuotaUser(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `device-${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function generateFingerprint(email?: string): DeviceFingerprint {
  const platform = randomFrom(PLATFORMS);
  const arch = "amd64";
  const ideType = "ANTIGRAVITY";
  const platformName = "WINDOWS";
  
  const osVersion = release();

  const apiClient = randomFrom(SDK_CLIENTS);
  const sqmId = crypto.randomUUID();

  return {
    userAgent: `antigravity/${ANTIGRAVITY_VERSION} ${platform}`,
    quotaUser: email ? generateStableQuotaUser(email) : generateQuotaUser(),
    deviceId: email ? generateStableQuotaUser(email).replace('device-', '') : generateDeviceId(),
    platform: platform,
    apiClient: apiClient,
    ideType: ideType,
    platformName: platformName,
    sessionToken: generateSessionToken(),
    cliUserAgent: randomFrom(GEMINI_CLI_USER_AGENTS),
    cliApiClient: randomFrom(GEMINI_CLI_API_CLIENTS),
    clientMetadata: {
      ideType: ideType,
      platform: platformName,
      pluginType: "GEMINI",
      osVersion: osVersion,
      arch: arch,
      sqmId: sqmId
    },
    createdAt: Date.now()
  };
}

export function getImpersonationHeaders(accessToken: string, fingerprint?: DeviceFingerprint, model?: string): Record<string, string> {
  const fp = fingerprint || generateFingerprint();
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": `antigravity/${ANTIGRAVITY_VERSION} windows/amd64`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-QuotaUser": fp.quotaUser,
    "X-Client-Device-Id": fp.deviceId,
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: "WINDOWS",
      pluginType: "GEMINI",
      osVersion: release(),
      arch: "amd64"
    })
  };

  return headers;
}

export function getGeminiCliHeaders(accessToken: string, fingerprint?: DeviceFingerprint): Record<string, string> {
  const fp = fingerprint || generateFingerprint();
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "User-Agent": fp.cliUserAgent,
    "X-Goog-Api-Client": fp.cliApiClient,
    "X-Goog-QuotaUser": fp.quotaUser,
    "X-Client-Device-Id": fp.deviceId,
    "Content-Type": "application/json; charset=utf-8",
  };

  if (fp.clientMetadata) {
    headers["Client-Metadata"] = Object.entries(fp.clientMetadata)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  } else {
    headers["Client-Metadata"] = "ideType=VSCODE,platform=MACOS,pluginType=GEMINI,osVersion=14.5,arch=arm64";
  }

  return headers;
}
