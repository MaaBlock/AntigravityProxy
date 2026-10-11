import { readFileSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";

const SERVICE = "exa.language_server_pb.LanguageServerService";
const CACHE_TTL_MS = 60_000;

type NativeConnection = {
  port: number;
  csrf: string;
};

let cachedAt = 0;
let cachedConnectionKey = "";
let cachedModels = new Map<string, string>();

function lastMatch(source: string, pattern: RegExp): string | undefined {
  let value: string | undefined;
  for (const match of source.matchAll(pattern)) value = match[1];
  return value;
}

function discoverNativeConnection(): NativeConnection | undefined {
  const appData = process.env.APPDATA;
  if (!appData) return undefined;

  try {
    const log = readFileSync(join(appData, "Antigravity", "logs", "main.log"), "utf8");
    const csrf = lastMatch(log, /--csrf_token\s+(\S+)/g);
    const portText = lastMatch(log, /https:\/\/127\.0\.0\.1:(\d+)\//g);
    const port = Number(portText);
    if (!csrf || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { port, csrf };
  } catch {
    return undefined;
  }
}

function callNativeRpc(connection: NativeConnection, method: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = https.request({
      hostname: "127.0.0.1",
      port: connection.port,
      path: `/${SERVICE}/${method}`,
      method: "POST",
      rejectUnauthorized: false,
      timeout: 3_000,
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        "x-codeium-csrf-token": connection.csrf,
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`native RPC returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new Error("native RPC returned invalid JSON"));
        }
      });
    });

    request.on("timeout", () => request.destroy(new Error("native RPC timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

async function refreshNativeModels(): Promise<void> {
  const connection = discoverNativeConnection();
  if (!connection) throw new Error("Antigravity desktop service was not discovered");

  const connectionKey = String(connection.port);
  if (cachedModels.size > 0 && cachedConnectionKey === connectionKey && Date.now() - cachedAt < CACHE_TTL_MS) return;

  const response = await callNativeRpc(connection, "GetUserStatus", {});
  const configs = response?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) throw new Error("Antigravity desktop returned no model configuration");

  const models = new Map<string, string>();
  for (const config of configs) {
    const publicId = typeof config?.modelId === "string" ? config.modelId.toLowerCase() : "";
    const upstreamId = typeof config?.modelOrAlias?.model === "string" ? config.modelOrAlias.model : "";
    if (publicId && upstreamId) models.set(publicId, upstreamId);
  }

  cachedModels = models;
  cachedConnectionKey = connectionKey;
  cachedAt = Date.now();
}

/**
 * Resolve the public model ID shown by Antigravity to the opaque model enum
 * accepted by its generation endpoint. The desktop session stays private: its
 * CSRF token is read into memory only and is never returned or logged.
 */
export async function resolveNativeModelId(publicModelId: string): Promise<string | undefined> {
  try {
    await refreshNativeModels();
    return cachedModels.get(publicModelId.toLowerCase());
  } catch (error) {
    console.warn(`[Native Models] ${error instanceof Error ? error.message : "lookup failed"}`);
    return undefined;
  }
}

export async function getNativePublicModelIds(): Promise<string[]> {
  try {
    await refreshNativeModels();
    return [...cachedModels.keys()];
  } catch {
    return [];
  }
}
