#!/usr/bin/env bun
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
    process.env.HTTP_PROXY = "http://127.0.0.1:7897";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
}
import { loadProxyConfig, getProxyConfig, updateProxyConfig } from "./config/manager";

await loadProxyConfig();

import { join } from "path";

let APP_VERSION = "0.7.0";
try {
    const pkgPath = join(import.meta.dir, "../package.json");
    const pkgFile = Bun.file(pkgPath);
    if (await pkgFile.exists()) {
        const pkg = await pkgFile.json();
        if (pkg.version) APP_VERSION = pkg.version;
    }
} catch {
    // fallback to default
}

import { initManager, getBestAccount, updateAccountUsage, addAccount, getAccounts, getPublicAccounts, removeAccount, getStrategy, setStrategy, saveAccounts, emitAccountFlash, eventBus, getEarliestReset, markCooldown, ensureFingerprint, regenerateFingerprint, getCooldowns, resetAccount, flagAccountChallenge, flagModelUnsupported, updateAccountProject, getFamilyName, resetAllCooldowns } from "./auth/manager";
import { type SelectionStrategy, type AntigravityAccount } from "./auth/types";
import { generateAuthUrl, exchangeCode, getUserEmail, getProjectId } from "./auth/oauth";
import { transformToGoogleBody, transformGoogleEventToOpenAI, createOpenAIStreamTransformer, getOriginalToolName } from "./utils/transform";
import { chatCompletionToResponse, createResponsesStreamTransformer, responsesRequestToChat } from "./utils/responses";
import { createAntigravityGeminiBody, createGeminiNativeStreamTransformer, matchGeminiNativeRoute, probeGeminiNativeStream, readGeminiNativeResponse } from "./utils/gemini-native";
import { getImpersonationHeaders, getGeminiCliHeaders, generateFingerprint } from "./utils/headers";
import { refreshAllQuotas, fetchQuota, supportedModelsCache } from "./api/quota";
import { parseGoogleError } from "./utils/errors";
import { isAllowedChatModel, isAllowedImageModel, isModernFlashTierModel, isSandboxEndpoint, isSandboxOnlyModel as requiresSandbox, shouldPollNextEndpoint, CHAT_MODELS, SUPPORTED_MODELS, REQUIRED_CHAT_MODEL, IMAGE_GENERATION_MODEL } from "./utils/routing";
import { ipcServer } from "./ipc/server";

const logBuffer: string[] = [];
const MAX_LOGS = 200;
const MAX_REQUEST_LOG_CHARS = 24000;
let logIdSeq = 1;
const PORT = parseInt(process.env.PORT || "8317", 10);

function sanitizeRequestBodyForLog(value: any, key: string = "", depth: number = 0): any {
    if (depth > 16) return "<max-depth>";
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") {
        if (key === "data" || key === "file_data" || value.startsWith("data:")) {
            return `<redacted data: ${value.length} chars>`;
        }
        if (key === "text" || key === "content") {
            const preview = value.slice(0, 120).replace(/\s+/g, " ");
            return `<text: ${value.length} chars${preview ? `; preview=${JSON.stringify(preview)}` : ""}>`;
        }
        return value.length > 500 ? `${value.slice(0, 500)}…<${value.length} chars>` : value;
    }
    if (Array.isArray(value)) {
        const items = value.slice(0, 100).map((item) => sanitizeRequestBodyForLog(item, key, depth + 1));
        if (value.length > 100) items.push(`<${value.length - 100} more items>`);
        return items;
    }
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            sanitizeRequestBodyForLog(childValue, childKey, depth + 1)
        ]));
    }
    return String(value);
}

function logRequestBody(stage: "OpenAI" | "Gemini Native" | "Antigravity", body: any) {
    const serialized = JSON.stringify(sanitizeRequestBodyForLog(body));
    const rendered = serialized.length > MAX_REQUEST_LOG_CHARS
        ? `${serialized.slice(0, MAX_REQUEST_LOG_CHARS)}…<truncated ${serialized.length - MAX_REQUEST_LOG_CHARS} chars>`
        : serialized;
    console.log(`[Request Body][${stage}] ${rendered}`);
}

function captureLog(level: string, args: any[]) {
    try {
        const msg = args.map(a => 
            (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))
        ).join(' ');
        const timeStr = new Date().toLocaleTimeString();
        const line = `[${timeStr}] [${level.toUpperCase()}] ${msg}`;
        
        logBuffer.push(line);
        if (logBuffer.length > MAX_LOGS) logBuffer.shift();
        
        eventBus.emit('log', line);

        let detectedLvl: 'info' | 'warn' | 'error' | 'request' | 'system' = 'info';
        if (level === 'error' || msg.includes('Error:') || msg.includes('error:')) detectedLvl = 'error';
        else if (level === 'warn' || msg.includes('Warning:')) detectedLvl = 'warn';
        else if (msg.includes('POST /v1/') || msg.includes('GET /v1/') || msg.includes('[Request Body]')) detectedLvl = 'request';

        ipcServer.broadcast('logs', {
            id: logIdSeq++,
            timestamp: timeStr,
            level: detectedLvl,
            message: msg,
            raw: line
        });
    } catch (e) {
    }
}


const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { originalLog(...args); captureLog('info', args); };
console.error = (...args) => { originalError(...args); captureLog('error', args); };
console.warn = (...args) => { originalWarn(...args); captureLog('warn', args); };

await initManager();

const proxyConfig = getProxyConfig();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function getSandboxEndpointsForModel(config: ReturnType<typeof getProxyConfig>, model: string): string[] {
  const configured = Array.isArray(config.endpoints.sandbox)
    ? config.endpoints.sandbox
    : [config.endpoints.sandbox];
  if (!requiresSandbox(model)) return configured;

  const compatible = configured.filter(isSandboxEndpoint);
  return compatible.length > 0 ? compatible : configured;
}

function geminiError(status: number, message: string, code = "UPSTREAM_ERROR", attempts?: any[]) {
  return new Response(JSON.stringify({
    error: {
      code: status,
      message,
      status: code,
      ...(attempts ? { details: [{ attempts }] } : {}),
    },
  }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function handleGeminiNativeRequest(
  req: Request,
  url: URL,
  route: NonNullable<ReturnType<typeof matchGeminiNativeRoute>>,
): Promise<Response> {
  let nativeBody: Record<string, any>;
  try {
    nativeBody = await req.json() as Record<string, any>;
  } catch {
    return geminiError(400, "Request body must be valid JSON.", "INVALID_ARGUMENT");
  }

  const model = route.model;

  logRequestBody("Gemini Native", nativeBody);
  const config = getProxyConfig();
  const endpoints = getSandboxEndpointsForModel(config, model);
  const accountCount = Math.max(getAccounts().length, 1);
  const maxAttempts = Math.max(config.retry.maxAttempts, accountCount * endpoints.length);
  const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "gemini-native";
  const seed = `${clientId}:${JSON.stringify(nativeBody.contents || [])}`;
  const sessionId = req.headers.get("x-session-id") || new Bun.CryptoHasher("sha256").update(seed).digest("hex");
  const triedEmails: string[] = [];
  const attemptLogs: Array<{ email: string; status: number; reason: string }> = [];
  let endpointAttempt = 0;
  let lastStatus = 0;
  let routeRetryAccount: AntigravityAccount | null = null;
  const endpointAttemptsByAccount = new Map<string, number>();
  let sawSubscriptionRequired = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let account: AntigravityAccount | null = routeRetryAccount;
    routeRetryAccount = null;
    if (!account) {
      account = await getBestAccount("sandbox", model, clientId, triedEmails, true);
    }
    if (!account) {
      account = await getBestAccount("sandbox", model, clientId, triedEmails, false);
    }
    if (!account || !account.accessToken) {
      if (sawSubscriptionRequired && triedEmails.length > 0) break;
      triedEmails.length = 0;
      continue;
    }

    const endpoint = endpoints[endpointAttempt % endpoints.length];
    endpointAttempt++;
    const accountEndpointAttempt = (endpointAttemptsByAccount.get(account.email) || 0) + 1;
    endpointAttemptsByAccount.set(account.email, accountEndpointAttempt);
    ensureFingerprint(account);
    const antigravityBody = createAntigravityGeminiBody(
      nativeBody,
      model,
      account.projectId!,
      sessionId,
    );
    logRequestBody("Antigravity", antigravityBody);
    console.log(`[Gemini Native] Model: ${model} | Account: ${account.email} | Attempt: ${attempt}/${maxAttempts} | Endpoint: ${new URL(endpoint).host} | Streaming: ${route.streaming}`);

    const timeoutKey = Object.keys(config.models.timeouts || {}).find((key) => model.toLowerCase().includes(key)) || "default";
    const timeoutMs = config.models.timeouts?.[timeoutKey] || 30000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      if (config.features.jitterEnabled) {
        const jitterMs = config.features.jitterMinMs + Math.random() * (config.features.jitterMaxMs - config.features.jitterMinMs);
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
      }

      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: getImpersonationHeaders(account.accessToken, account.fingerprint!, model),
        body: JSON.stringify(antigravityBody),
        signal: abortController.signal,
        ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY
          ? { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY }
          : {}),
      });
      clearTimeout(timeoutId);
      if (!upstream.ok) {
        const errorText = await upstream.text();
        const parsed = parseGoogleError(errorText);
        lastStatus = upstream.status;
        attemptLogs.push({ email: account.email, status: upstream.status, reason: parsed.reason });
        console.error(`[Gemini Native] Google API (${account.email}) returned ${upstream.status} (${parsed.reason}):`, errorText);

        if (upstream.status === 503 || parsed.isLocationRestricted) {
          routeRetryAccount = account;
          continue;
        }
        if (parsed.reason === "subscription_required") {
          sawSubscriptionRequired = true;
          if (shouldPollNextEndpoint(parsed.reason, accountEndpointAttempt, endpoints.length)) {
            routeRetryAccount = account;
            console.warn(`[Gemini Native] ${new URL(endpoint).host} requires a subscription; polling the next endpoint for ${account.email} (${accountEndpointAttempt + 1}/${endpoints.length}).`);
            continue;
          }
          if (!triedEmails.includes(account.email)) triedEmails.push(account.email);
          console.warn(`[Gemini Native] All ${endpoints.length} endpoints returned subscription_required for ${account.email}; trying another account.`);
          continue;
        }
        if (upstream.status === 429) {
          if (accountEndpointAttempt < endpoints.length) {
            routeRetryAccount = account;
            console.warn(`[Gemini Native] Endpoint rate limited; retrying ${account.email} immediately on the next endpoint (${accountEndpointAttempt + 1}/${endpoints.length}).`);
            continue;
          }
          markCooldown(account.email, "sandbox", getFamilyName(model));
          triedEmails.push(account.email);
          await updateAccountUsage(account.email, false, model, "sandbox", clientId, upstream.status);
          if (triedEmails.length >= getAccounts().length) break;
          continue;
        }

        await updateAccountUsage(account.email, false, model, "sandbox", clientId, upstream.status);
        return new Response(errorText, {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!upstream.body) {
        clearTimeout(timeoutId);
        return geminiError(502, "No response body from Antigravity upstream.", "BAD_GATEWAY");
      }

      if (route.streaming) {
        const probe = await probeGeminiNativeStream(upstream.body);
        if (!probe.body) {
          clearTimeout(timeoutId);
          lastStatus = 502;
          attemptLogs.push({ email: account.email, status: 502, reason: "empty_model_response" });
          const detail = [...probe.finishReasons, ...probe.finishMessages].join(" | ") || "no finish metadata";
          console.warn(`[Gemini Native] Empty upstream response | Model: ${model} | Account: ${account.email} | Events: ${probe.eventCount} | ${detail} | Retrying`);
          await updateAccountUsage(account.email, false, model, "sandbox", clientId);
          continue;
        }
        await updateAccountUsage(account.email, true, model, "sandbox", clientId);
        const startedAt = Date.now();
        const stream = probe.body.pipeThrough(createGeminiNativeStreamTransformer({
          onComplete: ({ eventCount, usableEventCount, empty }) => {
            clearTimeout(timeoutId);
            const label = empty ? "Empty stream recovered" : "Stream complete";
            console.log(`[Gemini Native] ${label} | Model: ${model} | Events: ${eventCount} | Usable: ${usableEventCount} | Duration: ${Date.now() - startedAt}ms`);
          },
        }));
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Antigravity-Attempts": attempt.toString(),
            ...corsHeaders,
          },
        });
      }

      const response = await readGeminiNativeResponse(upstream.body);
      clearTimeout(timeoutId);
      await updateAccountUsage(account.email, true, model, "sandbox", clientId);
      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "X-Antigravity-Attempts": attempt.toString(),
          ...corsHeaders,
        },
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastStatus = error?.name === "AbortError" ? 504 : 500;
      attemptLogs.push({ email: account.email, status: lastStatus, reason: error?.message || "request_failed" });
      console.error(`[Gemini Native] Request failed for ${account.email}:`, error);
      await updateAccountUsage(account.email, false, model, "sandbox", clientId);
    }
  }

  if (sawSubscriptionRequired) {
    return geminiError(403, "Access denied: subscription_required after polling every compatible Antigravity endpoint/account.", "PERMISSION_DENIED", attemptLogs);
  }

  const status = lastStatus === 429 ? 429 : 502;
  return geminiError(status, "Antigravity upstream failed for all available routes/accounts.", status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE", attemptLogs);
}

setInterval(refreshAllQuotas, proxyConfig.quota.refreshIntervalMs);
// Initial quota refresh on startup
refreshAllQuotas();

Bun.serve({
  port: PORT,
  // Default to loopback so an unauthenticated proxy is never exposed by accident.
  hostname: process.env.HOST || "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const cleanPath = url.pathname.replace(/\/+/g, "/");
    console.log(`[${new Date().toISOString()}] ${req.method} ${cleanPath} - Agent: ${req.headers.get("user-agent")}`);

    if (req.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            }
        });
    }
    if (cleanPath === "/oauth/start") {
      return Response.redirect(generateAuthUrl());
    }

    if (cleanPath === "/v1/models") {
        const models = SUPPORTED_MODELS.map(id => ({
            id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity"
        }));

        return new Response(JSON.stringify({
            object: "list",
            data: models
        }), { headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
        } });
    }

    if (cleanPath === "/v1beta/models" && req.method === "GET") {
      return new Response(JSON.stringify({
        models: [
          {
            name: `models/${REQUIRED_CHAT_MODEL}`,
            version: REQUIRED_CHAT_MODEL,
            displayName: REQUIRED_CHAT_MODEL,
            description: "Gemini native forwarding through AntigravityProxy",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65535,
            supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
          },
          {
            name: `models/${IMAGE_GENERATION_MODEL}`,
            version: IMAGE_GENERATION_MODEL,
            displayName: IMAGE_GENERATION_MODEL,
            description: "Gemini image generation through AntigravityProxy",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65535,
            supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
          }
        ],
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const geminiNativeRoute = matchGeminiNativeRoute(cleanPath);
    if (geminiNativeRoute && req.method === "POST") {
      return handleGeminiNativeRequest(req, url, geminiNativeRoute);
    }

    if (cleanPath === "/v1/images/generations" && req.method === "POST") {
      let imgBody: any;
      try {
        imgBody = await req.json();
      } catch {
        return new Response(JSON.stringify({
          error: { message: "Request body must be valid JSON.", type: "invalid_request_error" }
        }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      const prompt = imgBody.prompt;
      if (!prompt || typeof prompt !== "string") {
        return new Response(JSON.stringify({
          error: { message: "Missing required string field 'prompt'.", type: "invalid_request_error", code: "missing_prompt" }
        }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      const targetModel = IMAGE_GENERATION_MODEL;
      const responseFormat = imgBody.response_format || "b64_json";
      const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "openai-image";
      const config = getProxyConfig();
      const triedEmails: string[] = [];
      let lastStatus = 500;
      let lastErrorText = "";
      const MAX_ATTEMPTS = Math.max(1, config.retry.maxAttempts);

      for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
        const account = await getBestAccount("sandbox", targetModel, clientId, triedEmails, false);
        if (!account || !account.accessToken) break;
        triedEmails.push(account.email);
        ensureFingerprint(account);

        const googleBody = {
          project: account.projectId,
          model: targetModel,
          userAgent: "antigravity",
          requestId: `agent-${crypto.randomUUID()}`,
          requestType: "agent",
          request: {
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              temperature: 0.7,
              topP: 0.95,
              candidateCount: 1
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" }
            ],
            sessionId: crypto.randomUUID()
          }
        };

        const SANDBOX_ENDPOINTS = Array.isArray(config.endpoints.sandbox) ? config.endpoints.sandbox : [config.endpoints.sandbox];

        for (const ep of SANDBOX_ENDPOINTS) {
          try {
            const upstream = await fetch(ep, {
              method: "POST",
              headers: getImpersonationHeaders(account.accessToken, account.fingerprint, targetModel),
              body: JSON.stringify(googleBody),
              ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY } : {})
            });

            if (!upstream.ok) {
              lastStatus = upstream.status;
              lastErrorText = await upstream.text();
              console.warn(`[ImageGen] Upstream ${account.email} on ${ep.split('/')[2]} returned ${upstream.status}: ${lastErrorText.slice(0, 200)}`);
              continue;
            }

            const text = await upstream.text();
            const lines = text.split("\n");
            let imageBase64: string | null = null;
            let mimeType = "image/jpeg";

            for (const line of lines) {
              let cleaned = line.trim();
              if (cleaned.startsWith("Response: ")) cleaned = cleaned.slice(10);
              if (cleaned.startsWith("data: ")) {
                try {
                  const json = JSON.parse(cleaned.slice(6));
                  const cand = json.response?.candidates?.[0];
                  for (const part of cand?.content?.parts || []) {
                    if (part.inlineData?.data) {
                      imageBase64 = part.inlineData.data;
                      if (part.inlineData.mimeType) mimeType = part.inlineData.mimeType;
                      break;
                    }
                  }
                } catch(e) {}
              }
            }

            if (imageBase64) {
              await updateAccountUsage(account.email, true, targetModel, "sandbox", clientId);
              const dataItem: any = {
                revised_prompt: prompt
              };
              if (responseFormat === "b64_json") {
                dataItem.b64_json = imageBase64;
              }
              dataItem.url = `data:${mimeType};base64,${imageBase64}`;

              return new Response(JSON.stringify({
                created: Math.floor(Date.now() / 1000),
                data: [dataItem]
              }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }
          } catch (e: any) {
            console.warn(`[ImageGen] Fetch error for ${account.email} on ${ep}:`, e.message);
          }
        }
      }

      return new Response(JSON.stringify({
        error: {
          message: "Failed to generate image. Upstream quota exhausted or temporarily unavailable.",
          type: "api_error",
          code: "image_generation_failed"
        }
      }), {
        status: lastStatus || 502,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (cleanPath === "/v1/responses" && req.method === "POST") {
      let responsesBody: any;
      try {
        responsesBody = await req.json();
      } catch {
        return new Response(JSON.stringify({
          error: { message: "Request body must be valid JSON.", type: "invalid_request_error" }
        }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      const chatBody = responsesRequestToChat(responsesBody);
      logRequestBody("OpenAI", responsesBody);
      const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "codex-responses";
      const chatUrl = new URL("/v1/chat/completions", url.origin);
      chatUrl.searchParams.set("client_id", clientId);

      let chatResponse: Response;
      try {
        chatResponse = await fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Client-Id": clientId },
          body: JSON.stringify(chatBody),
        });
      } catch (error: any) {
        return new Response(JSON.stringify({
          error: { message: error?.message || "Chat Completions bridge failed.", type: "api_error" }
        }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      if (!chatResponse.ok) {
        return new Response(chatResponse.body, {
          status: chatResponse.status,
          headers: { "Content-Type": chatResponse.headers.get("Content-Type") || "application/json", ...corsHeaders },
        });
      }

      if (responsesBody.stream === true) {
        if (!chatResponse.body) {
          return new Response(JSON.stringify({
            error: { message: "Chat Completions bridge returned no stream.", type: "api_error" }
          }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
        return new Response(chatResponse.body.pipeThrough(createResponsesStreamTransformer(responsesBody)), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...corsHeaders,
          },
        });
      }

      const chatJson = await chatResponse.json() as any;
      return new Response(JSON.stringify(chatCompletionToResponse(chatJson, responsesBody)), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (cleanPath === "/v1/chat/completions" && req.method === "POST") {
      const openaiBody = await req.json() as any;
      const requestId = "chatcmpl-" + Math.random().toString(36).substring(7);
      logRequestBody("OpenAI", openaiBody);

      if (!isAllowedChatModel(openaiBody.model)) {
        console.warn(`[Model] Rejected ${String(openaiBody.model || "<missing>")}; allowed chat models: ${CHAT_MODELS.join(", ")}.`);
        return new Response(JSON.stringify({
          error: {
            message: `请使用以下模型之一：${CHAT_MODELS.join(", ")}。`,
            type: "invalid_request_error",
            code: "model_not_allowed",
            requested_model: openaiBody.model,
            required_model: REQUIRED_CHAT_MODEL,
            allowed_models: CHAT_MODELS,
          },
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      
      const modelLower = openaiBody.model.toLowerCase();
      const isClaudeModel = modelLower.includes("claude");
      const isGptModel = modelLower.includes("gpt");
      const isModernFlashTier = isModernFlashTierModel(modelLower);

      let useCliPool: boolean;
      if (isClaudeModel) {
          useCliPool = false;
      } else if (isGptModel) {
          useCliPool = false;
      } else {
          const isAntigravityThinking = modelLower.includes("antigravity") && 
                                       (modelLower.includes("thinking-high") || 
                                        modelLower.includes("thinking-medium") || 
                                        modelLower.includes("thinking-low"));

          const isExplicitAntigravity = modelLower.includes("antigravity-");
          const isExplicitSandboxModel = isAntigravityThinking || isExplicitAntigravity ||
              modelLower.includes("image") || modelLower.includes("gemini-3.1-pro");

          useCliPool = !isExplicitSandboxModel && (
              modelLower.includes("-preview") || 
              modelLower.includes("gemini-2.0") || 
              modelLower.includes("gemini-2.5") ||
              (modelLower.includes("gemini-3") && !modelLower.includes("flash"))
          );
      }
      
       let attempts = 0;
       let aggressive = false;
       const config = getProxyConfig();
       const availableAccountsCount = Math.max(getAccounts().length, 1);
       const sandboxEndpoints = getSandboxEndpointsForModel(config, openaiBody.model);
       const cliEndpoints = Array.isArray(config.endpoints.cli) ? config.endpoints.cli : [config.endpoints.cli];
       const routeCount = requiresSandbox(modelLower) ? sandboxEndpoints.length : Math.max(sandboxEndpoints.length, cliEndpoints.length);
       const MAX_ATTEMPTS = Math.max(config.retry.maxAttempts, availableAccountsCount * routeCount);
       const triedEmails: string[] = [];
       const attemptLogs: Array<{ email: string, status: number, reason: string }> = [];
       let systemicErrorCount = 0;
      
      // Modern tiered Flash IDs are exposed by the Antigravity Sandbox API.
      // The CLI endpoint returns model_not_found for these exact identifiers,
      // so never fall back to CLI when Sandbox is busy or rate-limited.
      const isSandboxOnlyModel = requiresSandbox(modelLower);
      const isCliOnlyModel = false;
      const CLAUDE_REGIONS = ["us-central1", "us-east5", "europe-west1"];
      
      const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "unknown";
      const firstMsg = openaiBody.messages?.[0]?.content || "";
      const userIdent = openaiBody.user || clientId;
      const stableSeed = `${userIdent}:${typeof firstMsg === 'string' ? firstMsg : JSON.stringify(firstMsg)}`;
      const sessionId = firstMsg ? new Bun.CryptoHasher("sha256").update(stableSeed).digest("hex") : crypto.randomUUID();

        let lastStatus = 0;
        let lastGoogleUrl = "";
        let sandboxEndpointAttempt = 0;
        let cliEndpointAttempt = 0;
        let routeRetryAccount: AntigravityAccount | null = null;
        const endpointAttemptsByAccount = new Map<string, number>();
        let sawSubscriptionRequired = false;

        while (attempts < MAX_ATTEMPTS) {
            attempts++;

            // A 503 UNAVAILABLE is an endpoint failure, not an account or pool
            // failure. Retry the same account on the next endpoint immediately.
            if (attempts > 1 && lastStatus !== 503) {
                const delayMs = Math.min(500 * attempts, 3000);
                await new Promise(r => setTimeout(r, delayMs));
                
                if (!isSandboxOnlyModel && !isCliOnlyModel) {
                    useCliPool = !useCliPool;
                    console.log(`[Switch] Switching to ${useCliPool ? 'CLI' : 'Sandbox'} pool for attempt ${attempts}`);
                } else {
                    console.log(`[Switch] Skipping pool switch for ${isCliOnlyModel ? 'CLI-only' : 'sandbox-only'} model (attempt ${attempts})`);
                }
            }

            let account: AntigravityAccount | null = routeRetryAccount;
            routeRetryAccount = null;
            if (!account) {
                account = await getBestAccount(useCliPool ? "cli" : "sandbox", openaiBody.model, clientId, triedEmails, true);
            }
            
            if (!account && !isSandboxOnlyModel && !isCliOnlyModel) {
                console.log(`[Manager] No READY accounts in ${useCliPool ? 'CLI' : 'Sandbox'} pool, trying the other pool first...`);
                const otherPool = useCliPool ? "sandbox" : "cli";
                account = await getBestAccount(otherPool, openaiBody.model, clientId, triedEmails, true);
                if (account) {
                    useCliPool = !useCliPool;
                    console.log(`[Switch] Found ready account in ${useCliPool ? 'CLI' : 'Sandbox'} pool.`);
                }
            }

            if (!account) {
                account = await getBestAccount(useCliPool ? "cli" : "sandbox", openaiBody.model, clientId, triedEmails, false);
            }
            
            if (!account || !account.accessToken) {
                if (sawSubscriptionRequired && triedEmails.length > 0) break;
                if (attempts < MAX_ATTEMPTS) {
                    console.log(`[Switch] Exhausted all accounts in both pools, retrying...`);
                    triedEmails.length = 0;
                    continue; 
                }
                break;
            }

            const SANDBOX_ENDPOINTS = sandboxEndpoints;
            const CLI_ENDPOINTS = cliEndpoints;
            
            let GOOGLE_URL: string;
            if (useCliPool) {
                const cliEndpointIndex = isClaudeModel
                    ? CLI_ENDPOINTS.length - 1
                    : Math.min(cliEndpointAttempt, CLI_ENDPOINTS.length - 1);
                cliEndpointAttempt++;
                GOOGLE_URL = CLI_ENDPOINTS[cliEndpointIndex];
            } else {
                const sandboxEndpointIndex = Math.min(sandboxEndpointAttempt, SANDBOX_ENDPOINTS.length - 1);
                sandboxEndpointAttempt++;
                GOOGLE_URL = SANDBOX_ENDPOINTS[sandboxEndpointIndex];
            }

            const endpointSet = useCliPool ? CLI_ENDPOINTS : SANDBOX_ENDPOINTS;
            const endpointAttemptKey = `${useCliPool ? 'cli' : 'sandbox'}|${account.email}`;
            const accountEndpointAttempt = (endpointAttemptsByAccount.get(endpointAttemptKey) || 0) + 1;
            endpointAttemptsByAccount.set(endpointAttemptKey, accountEndpointAttempt);

            if (lastStatus === 503) {
                console.log(`[Capacity] Retrying account ${account.email} on next endpoint ${GOOGLE_URL.split('/')[2]}...`);
            } else {
                triedEmails.push(account.email);
            }


          if (isClaudeModel && !GOOGLE_URL.includes("v1internal")) {
              console.warn(`[Warning] Claude model ${openaiBody.model} is being routed to a non-v1internal endpoint: ${GOOGLE_URL}`);
          }

          let effectiveProjectId = account.projectId!;
          ensureFingerprint(account);
          
          const googleBody = transformToGoogleBody(openaiBody, effectiveProjectId, useCliPool, "", sessionId, aggressive); 
          logRequestBody("Antigravity", googleBody);

          const isClaudeModelTarget = googleBody.model.toLowerCase().includes("claude");
          const headers = (useCliPool && !isClaudeModelTarget)
            ? getGeminiCliHeaders(account.accessToken!, account.fingerprint!)
            : getImpersonationHeaders(account.accessToken!, account.fingerprint!, googleBody.model);

          console.log(`[Request] Model: ${openaiBody.model} | Account: ${account.email} | Project: ${effectiveProjectId} | Attempt: ${attempts}/${MAX_ATTEMPTS} | Pool: ${useCliPool ? 'CLI' : 'Sandbox'} | Endpoint: ${GOOGLE_URL.split('/')[2]} | Target Model: ${googleBody.model}`);

          const timeoutKey = Object.keys(config.models.timeouts || {}).find(k => openaiBody.model.toLowerCase().includes(k)) || 'default';
          const timeoutMs = (config.models.timeouts && config.models.timeouts[timeoutKey]) || 30000;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

          try {
            if (config.features.jitterEnabled) {
              const jitterMs = config.features.jitterMinMs + Math.random() * (config.features.jitterMaxMs - config.features.jitterMinMs);
              await new Promise(r => setTimeout(r, jitterMs));
            }

            const googleRes = await fetch(GOOGLE_URL, {
              method: "POST",
              headers: headers,
              body: JSON.stringify(googleBody),
              signal: controller.signal,
              // Bun does not consistently apply HTTP(S)_PROXY from the
              // environment on Windows. Use the desktop client's local route
              // explicitly when the launcher provides it.
              ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY
                ? { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY }
                : {})
            });
            clearTimeout(timeoutId);

            if (!googleRes.ok) {
               const errText = await googleRes.text();
               const parsedError = parseGoogleError(errText);
                const status = googleRes.status;
                lastStatus = status;
                lastGoogleUrl = GOOGLE_URL;
                
                console.error(`[Error] Google API (${account.email}) returned ${status} (${parsedError.reason}):`, errText);

                emitAccountFlash(account.email, 'error');
               attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

                if (parsedError.isLocationRestricted) {
                    // Try the next sandbox endpoint.  This is not a model or
                    // account failure, and must never trigger a CLI rewrite or
                    // exclude the only usable account from the next endpoint.
                    console.warn(`[Route] ${GOOGLE_URL.split('/')[2]} rejected the current egress location; trying the next compatible endpoint.`);
                    triedEmails.length = 0;
                    continue;
                }

                if (status === 403 || status === 404) {
                    if (parsedError.isChallengeRequired) {
                        if (parsedError.reason === "subscription_required") {
                            sawSubscriptionRequired = true;
                            if (shouldPollNextEndpoint(parsedError.reason, accountEndpointAttempt, endpointSet.length)) {
                                for (let i = triedEmails.length - 1; i >= 0; i--) {
                                    if (triedEmails[i] === account.email) triedEmails.splice(i, 1);
                                }
                                routeRetryAccount = account;
                                console.warn(`[Route] ${GOOGLE_URL.split('/')[2]} requires a subscription; polling the next compatible endpoint for ${account.email} (${accountEndpointAttempt + 1}/${endpointSet.length}).`);
                                continue;
                            }
                            console.warn(`[Route] All ${endpointSet.length} compatible endpoints returned subscription_required for ${account.email}; trying another account.`);
                            continue;
                        }
                        console.log(`[Auth] ${parsedError.reason} for ${account.email}, flagging pool ${useCliPool ? 'cli' : 'sandbox'} for family ${getFamilyName(openaiBody.model)}.`);
                        flagAccountChallenge(account.email, useCliPool ? 'cli' : 'sandbox', getFamilyName(openaiBody.model), { 
                            type: 'CAPTCHA', 
                            url: parsedError.validationUrl || 'https://cloud.google.com/gemini/docs/codeassist/request-license',
                            reason: parsedError.reason,
                            message: parsedError.message
                        });
                        continue;
                    } else if (parsedError.isModelUnsupported) {
                       console.log(`[Model] Unsupported model ${openaiBody.model} for ${account.email}, marking capability.`);
                       flagModelUnsupported(account.email, openaiBody.model);
                   }
                   await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId, status);
                   return new Response(JSON.stringify({ 
                       error: { message: "Access denied: " + parsedError.reason, type: "access_denied", code: status.toString() } 
                   }), { 
                       status, 
                       headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() } 
                   });
               }

               if (status === 503) {
                   systemicErrorCount++;

                   // This account was added to triedEmails before the request,
                   // but UNAVAILABLE only means this endpoint could not serve it.
                   // Keep it eligible and retry without applying a health penalty.
                   for (let i = triedEmails.length - 1; i >= 0; i--) {
                       if (triedEmails[i] === account.email) triedEmails.splice(i, 1);
                   }
                   routeRetryAccount = account;
                   console.log(`[Capacity] ${GOOGLE_URL.split('/')[2]} unavailable; switching to the next ${useCliPool ? 'CLI' : 'Sandbox'} endpoint immediately for ${account.email}.`);
                   continue;
               }

               if (status === 500) {
                   systemicErrorCount++;
                   if (systemicErrorCount > 2) {
                       console.log(`[Systemic] Detected systemic outage (${systemicErrorCount} errors), breaking retry loop.`);
                       break;
                   }
               }

               const resetSeconds = parsedError.retryAfterSeconds;

                if (status === 429 && resetSeconds > 0 && resetSeconds <= config.retry.transientRetryThresholdSeconds) {
                    console.log(`[Skip] Account ${account.email} transiently limited (${resetSeconds}s), rotating...`);
                    markCooldown(
                        account.email,
                        useCliPool ? "cli" : "sandbox",
                        getFamilyName(openaiBody.model),
                        `${Math.ceil(resetSeconds)}s`
                    );
                    triedEmails.push(account.email);
                    continue;
                }


               if (status === 400 && (errText.toLowerCase().includes("tool schema") || errText.includes("Invalid JSON payload") || errText.toLowerCase().includes("function_declarations")) && !aggressive) {
                  console.log(`[Schema] Detected tool schema error for ${account.email}, retrying with aggressive cleaning...`);
                  aggressive = true;
                  attempts--;
                  continue;
               }

               if (status === 400) {
                  console.warn(`[Request] Upstream rejected the request body; returning 400 without rotating endpoints or penalizing ${account.email}.`);
                  return new Response(JSON.stringify({
                    error: {
                      message: parsedError.message || "Request contains an invalid argument.",
                      type: "invalid_request_error",
                      code: "invalid_argument"
                    }
                  }), {
                    status: 400,
                    headers: {
                      "Content-Type": "application/json",
                      "Access-Control-Allow-Origin": "*",
                      "X-Antigravity-Attempts": attempts.toString()
                    }
                  });
               }
               aggressive = false;

               await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId, status);
               
                if (status === 429) {
                    markCooldown(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(openaiBody.model));
                }
               continue;
            }

            const decoder = new TextDecoder();
            const isStreaming = openaiBody.stream === true;
            
             if (isStreaming) {
                 if (!googleRes.body) {
                     return new Response(JSON.stringify({ error: { message: "No response body from upstream" } }), { 
                         status: 502,
                         headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() }
                     });
                 }

                 const stream = googleRes.body.pipeThrough(createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId));

                 await updateAccountUsage(account.email, true, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId);
                 return new Response(stream, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                    "X-Antigravity-Attempts": attempts.toString()
                  }
                });
              } else {
                if (!googleRes.body) throw new Error("No response body");
                
                const stream = googleRes.body.pipeThrough(createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId));
                const reader = stream.getReader();
               
                let fullContent = "";
                let reasoningContent = "";
                let aggregatedToolCalls: any[] = [];
                let finalFinishReason = "stop";
                let finalUsage: any = undefined;

                let buffer = "";
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  
        for (const line of lines) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.usage) finalUsage = event.usage;
              if (event.choices?.[0]) {
                const choice = event.choices[0];
                if (choice.delta?.content) fullContent += choice.delta.content;
                if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
                if (choice.delta?.tool_calls) aggregatedToolCalls.push(...choice.delta.tool_calls);
                if (choice.finish_reason) finalFinishReason = choice.finish_reason;
              }
            } catch (e) {
              console.warn("[Stream] Failed to parse non-streaming chunk:", e);
            }
          }
        }
      }

      if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
          try {
              const event = JSON.parse(buffer.slice(6));
              if (event.usage) finalUsage = event.usage;
              if (event.choices?.[0]) {
                  const choice = event.choices[0];
                  if (choice.delta?.content) fullContent += choice.delta.content;
                  if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
                  if (choice.delta?.tool_calls) aggregatedToolCalls.push(...choice.delta.tool_calls);
                  if (choice.finish_reason) finalFinishReason = choice.finish_reason;
              }
          } catch (e) {
              console.warn("[Stream] Failed to parse final non-streaming chunk:", e);
          }
      }

                 const finalResponse = {
                    id: requestId,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: openaiBody.model,
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant",
                            content: fullContent,
                            reasoning_content: reasoningContent || undefined,
                            tool_calls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined
                        },
                        finish_reason: finalFinishReason
                    }],
                    usage: finalUsage
                };

                if (!fullContent && aggregatedToolCalls.length === 0 && finalFinishReason !== "length") {
                    console.warn(`[Empty] Account ${account.email} returned empty response for ${openaiBody.model}, retrying with another account...`);
                    markCooldown(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(openaiBody.model), "30s");
                    continue;
                }

                await updateAccountUsage(account.email, true, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId);
               return new Response(JSON.stringify(finalResponse), { 
                   headers: { 
                       "Content-Type": "application/json", 
                       "Access-Control-Allow-Origin": "*",
                       "X-Antigravity-Attempts": attempts.toString()
                   } 
               });
             }
            } catch (e: any) {
             if (e.name === 'AbortError') {
                 console.error(`[Timeout] Request timed out for ${account.email} after ${timeoutMs}ms`);
                 account.healthScore = Math.max(config.scoring.healthRange.min, account.healthScore - 5);
             } else {
                 console.error(`Proxy error for ${account.email}:`, e);
             }
             await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId);
             attemptLogs.push({ email: account.email || 'unknown', status: 500, reason: e.message });
             if (attempts < MAX_ATTEMPTS) continue;
             return new Response(JSON.stringify({ error: { message: `Proxy exception: ${e.message}` } }), { 
                 status: 500, 
                 headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() } 
             });
           }
      }

      // Do not present an upstream access/route failure as quota exhaustion.
      // OpenCode otherwise tells the user to wait for a reset even when every
      // quota is still available, hiding the actionable Google response.
      if (sawSubscriptionRequired) {
        return new Response(JSON.stringify({
          error: {
            message: "Access denied: subscription_required after polling every compatible Antigravity endpoint/account.",
            type: "access_denied",
            code: "403",
            attempts: attemptLogs
          }
        }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Antigravity-Attempts": attempts.toString()
          }
        });
      }

      const lastAttempt = attemptLogs.at(-1);
      if (lastAttempt?.reason === "location_unsupported") {
        return new Response(JSON.stringify({
          error: {
            message: "Access denied: the current network location is not supported by this Antigravity endpoint.",
            type: "access_denied",
            code: "400",
            attempts: attemptLogs
          }
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Antigravity-Attempts": attempts.toString()
          }
        });
      }

      // Reaching this point does not necessarily mean quota exhaustion.  In
      // particular, token refresh failures and stale capability metadata can
      // result in zero upstream attempts, while 5xx/network failures have no
      // relation to the account's remaining model quota.
      if (attemptLogs.length === 0) {
        return new Response(JSON.stringify({
          error: {
            message: "No ready Antigravity account. Token refresh or account routing failed before an upstream request was sent.",
            type: "upstream_unavailable",
            code: "no_ready_account",
            attempts: attemptLogs
          }
        }), {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Antigravity-Attempts": attempts.toString()
          }
        });
      }

      const quotaFailures = attemptLogs.filter(attempt =>
        attempt.status === 429 || attempt.reason === "quota_exhausted"
      );
      if (quotaFailures.length === 0) {
        return new Response(JSON.stringify({
          error: {
            message: `Antigravity upstream failed: ${lastAttempt?.reason || "unknown_error"}.`,
            type: "upstream_unavailable",
            code: "upstream_unavailable",
            attempts: attemptLogs
          }
        }), {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Antigravity-Attempts": attempts.toString()
          }
        });
      }

      const resetTime = getEarliestReset(useCliPool ? "cli" : "sandbox");
      const resetMsg = resetTime ? ` Next reset in ${resetTime}.` : "";
      return new Response(JSON.stringify({ 
        error: { 
            message: `Quota Exhausted: All accounts failed or are exhausted for this model.${resetMsg} Try a different model or wait for quota reset.`,
            type: "insufficient_quota",
            code: "insufficient_quota",
            attempts: attemptLogs
        } 
      }), { 
        status: 429, 
        headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Antigravity-Attempts": attempts.toString()
        } 
      });
    }

    if (url.pathname === "/api/sse") {
        let onUpdate: (data: any) => void;
        let onFlash: (data: { email: string, status: 'success' | 'error' }) => void;
        let onLog: (msg: string) => void;
        let onCooldown: (data: any) => void;

        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                
                const send = (event: string, data: any) => {
                    try {
                        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                    } catch (e) {
                    }
                };

                send("init", {
                    version: APP_VERSION,
                    accounts: getPublicAccounts(),
                    strategy: getStrategy(),
                    supportedModels: Array.from(supportedModelsCache).sort(),
                    cooldowns: getCooldowns(),
                    logs: logBuffer
                });

                onUpdate = (data: any) => send("update", { ...data, supportedModels: Array.from(supportedModelsCache).sort() });
                onFlash = (data: { email: string, status: 'success' | 'error' }) => send("flash", data);
                onLog = (msg: string) => send("log", { message: msg });
                onCooldown = (data: any) => send("cooldown", data);

                eventBus.on("update", onUpdate);
                eventBus.on("flash", onFlash);
                eventBus.on("log", onLog);
                eventBus.on("cooldown", onCooldown);
            },
            cancel() {
                if (onUpdate) eventBus.off("update", onUpdate);
                if (onFlash) eventBus.off("flash", onFlash);
                if (onLog) eventBus.off("log", onLog);
                if (onCooldown) eventBus.off("cooldown", onCooldown);
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }

    if (url.pathname === "/api/status") {
        return new Response(JSON.stringify({
            version: APP_VERSION,
            accounts: getPublicAccounts(),
            strategy: getStrategy(),
            supportedModels: Array.from(supportedModelsCache).sort()
        }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/strategy" && req.method === "POST") {
        const body = await req.json() as any;
        if (body.strategy) {
             setStrategy(body.strategy as SelectionStrategy);
             await updateProxyConfig({ rotation: { ...getProxyConfig().rotation, strategy: body.strategy } });
             return new Response("OK", { status: 200 });
        }
        return new Response("Missing strategy", { status: 400 });
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
        return new Response(JSON.stringify(getProxyConfig()), { 
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            } 
        });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
        const body = await req.json() as any;
        try {
            const updated = await updateProxyConfig(body);
            return new Response(JSON.stringify(updated), { 
                headers: { 
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                } 
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { 
                status: 400,
                headers: { 
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }
    }

    if (url.pathname === "/api/accounts/reset-all" && req.method === "POST") {
        const accounts = getAccounts();
        for (const acc of accounts) {
            acc.healthScore = 100;
            acc.consecutiveFailures = 0;
            acc.cooldowns = {};
            acc.modelScores = {};
            acc.history = [];
            acc.quota = [];
            delete acc.capabilities;
            delete acc.challenge;
        }
        
        await resetAllCooldowns();
        
        await saveAccounts(accounts);
        console.log(`[Manager] Reset state for all ${accounts.length} accounts via API`);
        return new Response("OK", { status: 200 });
    }

    if (url.pathname.startsWith("/api/accounts/") && req.method === "DELETE") {
        const email = url.pathname.replace("/api/accounts/", "");
        if (email) {
            await removeAccount(email);
            return new Response("OK", { status: 200 });
        }
        return new Response("Bad Request", { status: 400 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/reset") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        await resetAccount(email);
        return new Response("OK", { status: 200 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/project/rediscover") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        const accounts = getAccounts();
        const account = accounts.find(a => a.email === email);
        if (account && account.accessToken) {
            try {
                const newProjectId = await getProjectId(account.accessToken);
                if (newProjectId) {
                    await updateAccountProject(email, newProjectId);
                    return new Response(JSON.stringify({ projectId: newProjectId }), { status: 200 });
                }
                return new Response("No project found via discovery", { status: 404 });
            } catch (e: any) {
                return new Response(e.message, { status: 500 });
            }
        }
        return new Response("Account not found or no token", { status: 400 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/project") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        const body = await req.json() as any;
        if (body.projectId) {
            await updateAccountProject(email, body.projectId);
            return new Response("OK", { status: 200 });
        }
        return new Response("Missing projectId", { status: 400 });
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/cooldown") && req.method === "POST") {
        const email = url.pathname.split("/")[3];
        const body = await req.json() as any;
        const pool = body.pool || 'cli';
        markCooldown(email, pool as any, "3600s");
        return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/oauth-callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      try {
          const tokenRes = await exchangeCode(code);
          const email = await getUserEmail(tokenRes.access_token);
          const projectId = await getProjectId(tokenRes.access_token);

          const newAccount: AntigravityAccount = {
            email,
            refreshToken: tokenRes.refresh_token!,
            accessToken: tokenRes.access_token,
            expiresAt: Date.now() + (tokenRes.expires_in * 1000),
            projectId,
            healthScore: 100,
            lastUsed: 0,
            tokenUsage: 0
          };

          if (!newAccount.refreshToken) {
              return new Response("No refresh token received. Revoke access and try again.", { status: 400 });
          }

          if (newAccount.projectId) {
              const quota = await fetchQuota(newAccount);
              if (quota) {
                  newAccount.quota = quota;
              }
          }

          await addAccount(newAccount);
          
          return Response.redirect(`http://127.0.0.1:${PORT}/frontend/index.html`);
      } catch (e) {
          return new Response(`Auth error: ${e}`, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/frontend/")) {
        const path = url.pathname.replace("/frontend/", "");
        try {
            const file = Bun.file(`${import.meta.dir}/frontend/${path}`);
            return new Response(file);
        } catch {
            return new Response("Not Found", { status: 404 });
        }
    }
    
    if (url.pathname === "/") {
        return Response.redirect("/frontend/index.html");
    }

    return new Response("Not Found", { status: 404 });
  }
});

// Register JSON-RPC 2.0 Methods on Named Pipe IPC Server
ipcServer.registerMethod('ping', () => 'pong');

ipcServer.registerMethod('status.get', () => {
    const accs = getPublicAccounts();
    return {
        state: 'RUNNING',
        version: APP_VERSION,
        pid: process.pid,
        host: process.env.HOST || "127.0.0.1",
        port: PORT,
        uptime: Math.floor(process.uptime()),
        startTime: Date.now() - Math.floor(process.uptime() * 1000),
        activeAccountsCount: accs.length,
        accounts: accs,
        supportedModels: Array.from(supportedModelsCache).sort(),
        strategy: getStrategy(),
        outboundProxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null
    };
});

ipcServer.registerMethod('config.get', () => getProxyConfig());

ipcServer.registerMethod('config.set', async (params: any) => {
    if (params) {
        await updateProxyConfig(params);
    }
    return getProxyConfig();
});

ipcServer.registerMethod('strategy.set', async (params: any) => {
    if (params?.strategy) {
        setStrategy(params.strategy as SelectionStrategy);
        await updateProxyConfig({ rotation: { ...getProxyConfig().rotation, strategy: params.strategy } });
        return { success: true, strategy: params.strategy };
    }
    throw new Error("Missing strategy parameter");
});

ipcServer.registerMethod('accounts.list', () => getPublicAccounts());

ipcServer.registerMethod('accounts.reset', (params: any) => {
    if (params?.email) {
        resetAccount(params.email);
        return { success: true };
    }
    throw new Error("Missing email parameter");
});

ipcServer.registerMethod('accounts.resetAll', () => {
    resetAllCooldowns();
    return { success: true };
});

ipcServer.registerMethod('quota.refresh', async () => {
    await refreshAllQuotas();
    return getPublicAccounts();
});

ipcServer.registerMethod('logs.get', () => logBuffer);

ipcServer.registerMethod('logs.clear', () => {
    logBuffer.length = 0;
    return { success: true };
});

// Event bus forwards to IPC Subscribers
eventBus.on('update', (data: any) => {
    ipcServer.broadcast('accounts', { ...data, supportedModels: Array.from(supportedModelsCache).sort() });
});
eventBus.on('flash', (data: any) => {
    ipcServer.broadcast('flash', data);
});
eventBus.on('cooldown', (data: any) => {
    ipcServer.broadcast('cooldown', data);
});

// Start Windows Named Pipe IPC Server
await ipcServer.start().catch((err: any) => {
    console.error("[IPC] Failed to bind Named Pipe:", err.message);
});

console.log(`Antigravity Proxy running on http://127.0.0.1:${PORT}`);
