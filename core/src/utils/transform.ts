import { getSignature, cacheSignature, cacheToolCallSignature, getToolCallSignature } from "./cache";
import { cleanJSONSchemaForAntigravity } from "./schema";
import { getProxyConfig } from "../config/manager";

const TOOL_NAME_REMAP_CACHE = new Map<string, string>();
const MISSING_THOUGHT_SIGNATURE_FALLBACK = "skip_thought_signature_validator";
const MAX_PARALLEL_FUNCTION_CALLS_PER_STEP = 16;

function sanitizeFunctionName(name: string): string {
  if (/^[a-zA-Z_]/.test(name) && /^[a-zA-Z0-9_]+$/.test(name)) {
    return name;
  }

  const cached = TOOL_NAME_REMAP_CACHE.get(name);
  if (cached) return cached;

  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `fn_${sanitized}`;
  }
  if (!sanitized) {
    sanitized = `fn_${Math.random().toString(36).substring(7)}`;
  }

  TOOL_NAME_REMAP_CACHE.set(name, sanitized);
  console.log(`[Sanitize] Renamed tool "${name}" → "${sanitized}"`);
  return sanitized;
}

export function getOriginalToolName(sanitizedName: string): string | undefined {
  for (const [original, sanitized] of TOOL_NAME_REMAP_CACHE) {
    if (sanitized === sanitizedName) return original;
  }
  return undefined;
}

function splitToolCallId(value: unknown): { id: string; signature?: string } {
  const callId = typeof value === "string" ? value : "";
  if (!callId.startsWith("sig:")) return { id: callId };

  const [, signature, ...idParts] = callId.split(":");
  const id = idParts.join(":");
  return { id: id || callId, signature };
}

function mergeConsecutiveFunctionResponses(contents: any[]): any[] {
  const merged: any[] = [];

  for (const content of contents) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const containsOnlyFunctionResponses =
      content?.role === "user" &&
      parts.length > 0 &&
      parts.every((part: any) => Boolean(part?.functionResponse));
    const previous = merged.at(-1);
    const previousContainsOnlyFunctionResponses =
      previous?.role === "user" &&
      Array.isArray(previous.parts) &&
      previous.parts.length > 0 &&
      previous.parts.every((part: any) => Boolean(part?.functionResponse));

    if (containsOnlyFunctionResponses && previousContainsOnlyFunctionResponses) {
      previous.parts.push(...parts);
      continue;
    }

    merged.push(content);
  }

  return merged;
}

function splitOversizedFunctionCallSteps(contents: any[]): { contents: any[]; addedSignatures: number; splitSteps: number } {
  const normalized: any[] = [];
  let addedSignatures = 0;
  let splitSteps = 0;

  for (let index = 0; index < contents.length; index++) {
    const content = contents[index];
    const next = contents[index + 1];
    const calls = Array.isArray(content?.parts) ? content.parts : [];
    const responses = Array.isArray(next?.parts) ? next.parts : [];
    const isCompleteToolExchange =
      content?.role === "model" &&
      next?.role === "user" &&
      calls.length > MAX_PARALLEL_FUNCTION_CALLS_PER_STEP &&
      calls.every((part: any) => Boolean(part?.functionCall)) &&
      responses.length === calls.length &&
      responses.every((part: any) => Boolean(part?.functionResponse));

    if (!isCompleteToolExchange) {
      normalized.push(content);
      continue;
    }

    splitSteps++;
    for (let offset = 0; offset < calls.length; offset += MAX_PARALLEL_FUNCTION_CALLS_PER_STEP) {
      const callBatch = calls.slice(offset, offset + MAX_PARALLEL_FUNCTION_CALLS_PER_STEP);
      const responseBatch = responses.slice(offset, offset + MAX_PARALLEL_FUNCTION_CALLS_PER_STEP);
      if (!callBatch[0].thoughtSignature) {
        callBatch[0].thoughtSignature = MISSING_THOUGHT_SIGNATURE_FALLBACK;
        addedSignatures++;
      }
      normalized.push({ role: "model", parts: callBatch });
      normalized.push({ role: "user", parts: responseBatch });
    }
    index++;
  }

  return { contents: normalized, addedSignatures, splitSteps };
}

/** Convert a local base64 data URL to the Gemini/Antigravity inline-data shape.
 *
 * We deliberately do not fetch remote URLs here. OpenCode embeds local attachments
 * as data URLs, while fetching a user supplied URL from a proxy would be an SSRF and
 * privacy risk.
 */
function inlineDataFromDataUrl(value: unknown): { inlineData: { mimeType: string; data: string } } | undefined {
  if (typeof value !== "string") return undefined;

  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return undefined;

  return {
    inlineData: {
      mimeType: match[1],
      data: match[2].replace(/\s/g, ""),
    },
  };
}

function audioMimeType(format: unknown): string | undefined {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav") return "audio/wav";
  return undefined;
}

function appendMultimodalPart(parts: any[], part: any) {
  if (part?.type === "text" && typeof part.text === "string") {
    parts.push({ text: part.text });
    return;
  }

  if (part?.type === "image_url") {
    const inlineData = inlineDataFromDataUrl(part.image_url?.url);
    if (inlineData) parts.push(inlineData);
    return;
  }

  // @ai-sdk/openai-compatible serializes mp3/wav attachments this way.
  if (part?.type === "input_audio" && typeof part.input_audio?.data === "string") {
    const mimeType = audioMimeType(part.input_audio.format);
    if (mimeType) {
      parts.push({
        inlineData: {
          mimeType,
          data: part.input_audio.data.replace(/\s/g, ""),
        },
      });
    }
    return;
  }

  // PDFs and the video extension use OpenAI-compatible `file` parts with a
  // base64 data URL. Gemini accepts those media types directly as inlineData.
  if (part?.type === "file") {
    const inlineData = inlineDataFromDataUrl(part.file?.file_data);
    if (inlineData) parts.push(inlineData);
    return;
  }

  // Accept the common video_url extension too, but only for local data URLs.
  if (part?.type === "video_url") {
    const inlineData = inlineDataFromDataUrl(part.video_url?.url);
    if (inlineData) parts.push(inlineData);
  }
}

const CLAUDE_MODEL_REGISTRY = [
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-v2-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-thinking",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307"
];

function resolveModelId(modelId: string): string {
    let cleanId = modelId.toLowerCase().replace(/^(openai|antigravity|custom_openai|litellm|google)\//i, "");
    cleanId = cleanId.replace(/^antigravity-/i, "");
    cleanId = cleanId.replace(/^gemini-claude-/i, "claude-");

    if (cleanId.includes("image") || cleanId.includes("imagen") || cleanId === "dall-e-3") {
        return "gemini-3.1-flash-image";
    }

    if (cleanId.includes("claude")) {
        const exactMatch = CLAUDE_MODEL_REGISTRY.find(m => m === cleanId);
        if (exactMatch) return exactMatch;

        const baseId = cleanId.replace(/-(thinking|preview)(-(low|medium|high))?$/i, "");
        
        const fuzzyMatches = CLAUDE_MODEL_REGISTRY.filter(m => 
            m.startsWith(cleanId) || m.startsWith(baseId) || cleanId.startsWith(m)
        );

        if (fuzzyMatches.length > 0) {
            fuzzyMatches.sort((a, b) => b.localeCompare(a));
            return fuzzyMatches[0];
        }
    }

    return cleanId;
}

export function transformToGoogleBody(
  openaiBody: any, 
  projectId: string, 
  isCli: boolean, 
  location: string, 
  sessionId?: string, 
  aggressive: boolean = false
): any {
  const proxyConfig = getProxyConfig();
  const rawModel = (openaiBody.model || "").toLowerCase();
  const resolvedModel = resolveModelId(openaiBody.model);
  let googleModel = resolvedModel;
  
  const tierMatch = rawModel.match(/-(low|medium|high)$/i);
  const thinkingTierMatch = rawModel.match(/-thinking-(low|medium|high)$/i);
  const extractedTier = thinkingTierMatch ? thinkingTierMatch[1] : (tierMatch ? tierMatch[1] : undefined);
  
  let baseModel = googleModel;
  if (thinkingTierMatch) {
      baseModel = googleModel.replace(thinkingTierMatch[0], "");
  } else if (tierMatch) {
      baseModel = googleModel.replace(tierMatch[0], "");
  }
  
  const previewMatch = baseModel.match(/-preview$/i);
  if (previewMatch) {
      baseModel = baseModel.replace(previewMatch[0], "");
  }

  // Force Claude model IDs to strip tier for the backend
        if (googleModel.includes("claude")) {
            googleModel = baseModel;
            if (googleModel === "claude-opus-4-6") googleModel = "claude-opus-4-6-thinking";
            if (googleModel === "claude-sonnet-4-6") googleModel = "claude-sonnet-4-6-thinking";
            if (googleModel === "claude-sonnet-4-5") googleModel = "claude-sonnet-4-5-thinking";
        }

    const nativelySupported = [
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-thinking",
      "claude-sonnet-4-5", 
      "claude-sonnet-4-5-thinking", 
      "claude-opus-4-6-thinking",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3.1-pro",
      "gemini-3.1-pro-preview",
      "gemini-3-flash",
      "gemini-3-pro-high", 
      "gemini-3-pro-low",
      "gemini-3-pro",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-thinking",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview"
  ];
  
  const isNative = (nativelySupported.includes(googleModel) || nativelySupported.includes(baseModel));

  if (isCli) {
      if (!googleModel.includes("claude")) {
          // Standardize Gemini 3 CLI models to use -preview suffix
          // The newer 3.5/3.6/3.7/3.8 Flash tier IDs are sandbox-only. Preserve the
          // original identifier if a caller intentionally sends one here;
          // fabricating `gemini-3.6-flash-preview` produces a 404 upstream.
          const isModernFlashTier = /^gemini-3\.(5|6|7|8)-flash(?:-(?:tiered|low|medium|high))?$/.test(googleModel);
          if (isModernFlashTier) {
              // Keep the tiered ID unchanged.
          } else if (googleModel.includes("gemini-3")) {
              googleModel = baseModel; // Strip tiers
              if (!googleModel.endsWith("-preview")) {
                  googleModel = `${googleModel}-preview`;
              }
          } else if (googleModel.includes("gpt")) {
              if (googleModel.includes("thinking")) {
                   googleModel = "gemini-2.0-flash-thinking-exp";
              } else {
                   googleModel = "gemini-2.0-pro-exp";
              }
          } else {
               googleModel = baseModel;
          }
       } else {
           googleModel = baseModel;
           if (googleModel === "claude-sonnet-4-6") googleModel = "claude-sonnet-4-6-thinking";
           if (googleModel === "claude-sonnet-4-5") googleModel = "claude-sonnet-4-5-thinking";
       }
   } else {
       if (googleModel.endsWith("-preview")) {
           googleModel = googleModel.replace("-preview", "");
       }
       
       if (isNative) {
           if (baseModel.includes("gemini-3.1-pro")) {
               // Cloud Code exposes separate quota labels for High/Low, but the
               // live GenerateContent entrypoint is the low slug. The requested
               // tier is selected independently through thinkingLevel below.
               googleModel = "gemini-3.1-pro-low";
           } else if (baseModel.includes("gemini-3-pro")) {
               // Respect extracted tier for Gemini 3 Pro, fallback to high
               googleModel = `gemini-3-pro-${extractedTier || "high"}`;
           } else if (baseModel.includes("gemini-3-flash")) {
               googleModel = "gemini-3-flash";
           } else {
               googleModel = baseModel;
           }

             if (googleModel === "claude-opus-4-6" || googleModel === "antigravity-claude-opus-4-6") {
                 googleModel = "claude-opus-4-6-thinking";
             }
           if (googleModel === "claude-sonnet-4-6" || googleModel === "antigravity-claude-sonnet-4-6") {
               googleModel = "claude-sonnet-4-6-thinking";
           }
           if (googleModel === "claude-sonnet-4-5" || googleModel === "antigravity-claude-sonnet-4-5") {
               googleModel = "claude-sonnet-4-5-thinking";
           }
       }
   }

  // Extract system instruction (like plugin)
  const systemMessage = openaiBody.messages.find((m: any) => m.role === "system");
  const otherMessages = openaiBody.messages.filter((m: any) => m.role !== "system");
  const toolNames = new Map<string, string[]>();
  let substitutedThoughtSignatureCount = 0;

  for (const message of otherMessages) {
    for (const toolCall of message.tool_calls || []) {
      if (!toolCall?.id || !toolCall.function?.name) continue;
      const id = splitToolCallId(toolCall.id).id;
      const names = toolNames.get(id) || [];
      names.push(toolCall.function.name);
      toolNames.set(id, names);
    }
  }

  let contents = mergeConsecutiveFunctionResponses(otherMessages.map((msg: any) => {
    const parts = [];
    
    if (msg.role === "tool") {
      const toolCallId = splitToolCallId(msg.tool_call_id).id;
      const queuedNames = toolNames.get(toolCallId);
      const queuedName = queuedNames?.shift();
      let responseObj;
      try {
        responseObj = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      } catch {
        responseObj = msg.content;
      }

      if (typeof responseObj !== "object" || responseObj === null || Array.isArray(responseObj)) {
        responseObj = { result: responseObj };
      }

      const funcResp: any = {
        name: msg.name || queuedName || "function_result",
        response: responseObj
      };
      
      if (googleModel.includes("claude") || googleModel.includes("gemini-3")) {
          funcResp.id = toolCallId;
      }

      parts.push({
        functionResponse: funcResp
      });
    } else {
      if ((msg.role === "assistant" || msg.role === "model") && sessionId) {
        const thoughtText = msg.thought || msg.reasoning_content;
        if (thoughtText) {
          const sig = getSignature(sessionId, thoughtText);
          if (sig) {
            parts.push({ thought: true, text: thoughtText, thoughtSignature: sig });
          } else if (proxyConfig.features.keepThinking) {
            parts.push({ thought: true, text: thoughtText });
          }
        }
      }

      if (msg.content) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              appendMultimodalPart(parts, part);
            }
          } else {
             parts.push({ text: msg.content });
          }
      }

      if (msg.tool_calls) {
        const functionCallParts: any[] = [];
        for (const tc of msg.tool_calls) {
          if (tc.function) {
            const toolCallId = splitToolCallId(tc.id);
            const sig = toolCallId.signature || (sessionId ? getToolCallSignature(sessionId, toolCallId.id) : undefined) || "";

            const funcCall: any = {
              name: tc.function.name,
              args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || "{}") : tc.function.arguments
            };
            
            if (googleModel.includes("claude") || googleModel.includes("gemini-3")) {
                funcCall.id = toolCallId.id;
            }

            const funcPart: any = {
              functionCall: funcCall
            };
            
            if (sig) {
              funcPart.thoughtSignature = sig;
            }

            parts.push(funcPart);
            functionCallParts.push(funcPart);
          }
        }

        if (
          googleModel.includes("gemini-3") &&
          functionCallParts.length > 0 &&
          !functionCallParts[0].thoughtSignature
        ) {
          functionCallParts[0].thoughtSignature = MISSING_THOUGHT_SIGNATURE_FALLBACK;
          substitutedThoughtSignatureCount++;
        }
      }
    }

    if (parts.length === 0) {
        parts.push({ text: " " });
    }

    return {
      role: (msg.role === "assistant" || msg.role === "model") ? "model" : "user",
      parts
    };
  }));

  if (googleModel.includes("gemini-3")) {
    const normalized = splitOversizedFunctionCallSteps(contents);
    contents = normalized.contents;
    substitutedThoughtSignatureCount += normalized.addedSignatures;
    if (normalized.splitSteps > 0) {
      console.warn(
        `[Transform] Split ${normalized.splitSteps} oversized Gemini 3 tool-call exchange(s) into batches of at most ${MAX_PARALLEL_FUNCTION_CALLS_PER_STEP}.`
      );
    }
  }

  if (substitutedThoughtSignatureCount > 0) {
    console.warn(
      `[Transform] Added fallback thought signatures to ${substitutedThoughtSignatureCount} Gemini 3 tool-call message(s) with no recoverable signature.`
    );
  }

  const isThinkingModel = rawModel.includes("-thinking");
  const isImageModel = googleModel.includes("image") || googleModel.includes("imagen");
  const isGemini3Model = googleModel.includes("gemini-3") && !isImageModel;
  const hasExplicitBudget = openaiBody.thinking_budget !== undefined || 
                           openaiBody.thinking?.budget_tokens !== undefined ||
                           openaiBody.providerOptions?.thinkingBudget !== undefined;
  
  let thinkingBudget = openaiBody.thinking_budget;

  // Support OpenAI-standard `thinking` parameter: { type: "enabled", budget_tokens: N }
  if (!thinkingBudget && openaiBody.thinking?.budget_tokens) {
    thinkingBudget = openaiBody.thinking.budget_tokens;
  }

  // Support providerOptions from OpenCode variants: { providerOptions: { thinkingBudget: N } }
  if (!thinkingBudget && openaiBody.providerOptions?.thinkingBudget) {
    thinkingBudget = openaiBody.providerOptions.thinkingBudget;
  }

  if (!thinkingBudget && (isThinkingModel || googleModel.includes("gemini-3") || googleModel.includes("claude")) && !isImageModel) {
      if (extractedTier === "low") thinkingBudget = 8192;
      else if (extractedTier === "medium") thinkingBudget = 16000;
      else if (extractedTier === "high") thinkingBudget = 32768;
      else thinkingBudget = 16000;
  }
  
  const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>
`;

  // Gemini occasionally terminates after emitting only a `thought` part.  That
  // is not a usable assistant turn for OpenAI-compatible agent clients: there is
  // neither visible final content nor a function call to advance the loop.
  const RESPONSE_COMPLETION_PROTOCOL = `<response_completion_protocol>
A response containing only internal thought/reasoning is invalid. Before ending every turn, emit either non-thought final answer text or a function call.
If the user's task is not actually complete and tools are available, do not merely describe what you will do next: call the appropriate tool and continue the work.
Only emit a final answer when the requested work is complete or genuinely blocked on user input.
</response_completion_protocol>`;

  let systemInstruction: any = undefined;
  if (!isCli) {
      // Like plugin for Antigravity (Sandbox)
      const text = (ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + (systemMessage?.content || "") + "\n\n" + RESPONSE_COMPLETION_PROTOCOL).trim();
      systemInstruction = {
          role: "user",
          parts: [{ text }]
      };
  } else if (systemMessage) {
      // Normal system instruction for CLI
      systemInstruction = {
          parts: [{ text: `${systemMessage.content}\n\n${RESPONSE_COMPLETION_PROTOCOL}` }]
      };
  }

  const requestedMaxTokens = Number(openaiBody.max_tokens);
  const gemini3MaxOutputTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
    ? Math.min(Math.floor(requestedMaxTokens), 65535)
    : 65535;

  const generationConfig: any = {
      maxOutputTokens: isGemini3Model
        ? gemini3MaxOutputTokens
        : ((isThinkingModel || hasExplicitBudget || googleModel.includes("claude") || googleModel.includes("gemini-2"))
          ? Math.min(Math.max(openaiBody.max_tokens || 64000, 64000), 65535)
          : (openaiBody.max_tokens ?? 4096)),
      stopSequences: Array.isArray(openaiBody.stop) ? openaiBody.stop : (openaiBody.stop ? [openaiBody.stop] : undefined)
  };

  // Gemini 3.7 rejects/deprecates the legacy sampling fields. Let the model
  // use its supported defaults instead of forwarding OpenAI client settings.
  if (!isGemini3Model) {
    generationConfig.temperature = openaiBody.temperature ?? 0.7;
    generationConfig.topP = openaiBody.top_p ?? 0.95;
    generationConfig.candidateCount = 1;
  }

  const googleRequest: any = {
    contents,
    systemInstruction,
    generationConfig,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" }
    ],
    sessionId: sessionId || crypto.randomUUID()
  };

  if (isGemini3Model) {
    // Gemini 3 uses relative thinking levels. Sending the legacy token budget
    // at the same time can produce an empty STOP response on GenerateContent.
    googleRequest.generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: extractedTier || openaiBody.reasoning_effort || "medium"
    };
  } else if (isThinkingModel) {
    googleRequest.generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: thinkingBudget || 16000
    };
  }

  if (openaiBody.tools) {
    const sanitize = proxyConfig.features.sanitizeToolNames;
    googleRequest.tools = [{
      functionDeclarations: openaiBody.tools.map((t: any) => {
        const cleanParams = cleanJSONSchemaForAntigravity(t.function.parameters || { type: "object", properties: {} }, aggressive);
        
        let funcName = t.function.name;
        if (sanitize) {
          funcName = sanitizeFunctionName(funcName);
        }

        let description = t.function.description || "";
        const paramNames = Object.keys(cleanParams.properties || {}).filter(k => k !== "_placeholder");
        if (paramNames.length > 0) {
          description += ` [Parameters: ${paramNames.join(", ")}]`;
        }

        return {
          name: funcName,
          description: description,
          parameters: cleanParams
        };
      })
    }];
    
    if (googleModel.includes("claude")) {
        googleRequest.toolConfig = {
            functionCallingConfig: { mode: "VALIDATED" }
        };
    }
  }

  const isGeminiModel = googleModel.includes("gemini");
  if (isGeminiModel && proxyConfig.features.googleSearchGrounding) {
    const groundingTool: any = { googleSearchRetrieval: {} };
    if (proxyConfig.features.groundingMode === 'always') {
      groundingTool.googleSearchRetrieval.dynamicRetrievalConfig = {
        mode: "MODE_UNSPECIFIED",
        dynamicThreshold: 0.0
      };
    }
    if (!googleRequest.tools) {
      googleRequest.tools = [];
    }
    googleRequest.tools.push(groundingTool);
  }

  return {
    project: projectId,
    model: googleModel,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    requestType: "agent",
    request: googleRequest
  };
}

export function transformGoogleEventToOpenAI(googleData: any, model: string, requestId?: string, hasPriorToolCalls: boolean = false): any {
  const data = googleData.response || googleData;
  const requestIdActual = requestId || "chatcmpl-" + Math.random().toString(36).substring(7);
  
  let usage: any = undefined;
  if (data.usageMetadata) {
    const promptTokens = data.usageMetadata.promptTokenCount || 0;
    const completionTokens = data.usageMetadata.candidatesTokenCount || 0;
    const totalTokens = data.usageMetadata.totalTokenCount || (promptTokens + completionTokens);

    // Extract cached tokens from Google Gemini / Antigravity usageMetadata
    const cachedTokens = data.usageMetadata.cachedContentTokenCount ||
                         data.usageMetadata.cachedTokens ||
                         data.usageMetadata.prompt_cache_hit_tokens ||
                         (Array.isArray(data.usageMetadata.cacheTokensDetails)
                           ? data.usageMetadata.cacheTokensDetails.reduce((acc: number, item: any) => acc + (item.tokenCount || 0), 0)
                           : 0) ||
                         0;

    // Extract reasoning tokens if present
    const reasoningTokens = data.usageMetadata.thoughtsTokenCount ||
                            data.usageMetadata.reasoningTokens ||
                            data.usageMetadata.reasoning_tokens ||
                            0;

    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(cachedTokens > 0 ? {
        prompt_cache_hit_tokens: cachedTokens,
        prompt_cache_miss_tokens: Math.max(0, promptTokens - cachedTokens),
        prompt_tokens_details: {
          cached_tokens: cachedTokens,
        },
      } : {}),
      ...(reasoningTokens > 0 ? {
        completion_tokens_details: {
          reasoning_tokens: reasoningTokens,
        },
      } : {}),
    };
  }

  if (!data.candidates || data.candidates.length === 0) {
    if (usage) {
      return {
        id: requestIdActual,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [],
        usage: usage
      };
    }
    return null;
  }
  
  const candidate = data.candidates[0];
  const parts = candidate.content?.parts || [];
  const finishReason = candidate.finishReason;
  
  if (parts.length === 0 && !finishReason && !usage) return null;
  
  const delta: any = {};
  const toolCalls: any[] = [];
  let extractedSignature: string | undefined;
  let extractedThought: string | undefined;

  for (const part of parts) {
    const isThought = part.thought || part.thoughtText || part.type === "thinking";

    if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || "image/jpeg";
      const data = part.inlineData.data;
      if (data) {
        const markdownImage = `![Generated Image](data:${mimeType};base64,${data})`;
        delta.content = (delta.content || "") + markdownImage;
      }
    }
    
    if (part.text) {
      let cleanText = part.text;
      if (cleanText.includes("thoughtSignature:")) {
          cleanText = cleanText.replace(/thoughtSignature:[a-zA-Z0-9\-_]+/g, "").trim();
      }
      
      if (cleanText) {
          if (isThought) {
              delta.reasoning_content = (delta.reasoning_content || "") + cleanText;
              extractedThought = (extractedThought || "") + cleanText;
          } else {
              delta.content = (delta.content || "") + cleanText;
          }
      }
    }
    
    if (isThought && typeof isThought === 'string') {
       delta.reasoning_content = (delta.reasoning_content || "") + isThought;
       extractedThought = (extractedThought || "") + isThought;
    }

    if (part.thoughtSignature || part.thought_signature || part.signature) {
        extractedSignature = part.thoughtSignature || part.thought_signature || part.signature;
    }

    if (part.functionCall || part.function_call) {
      const call = part.functionCall || part.function_call;
      const sig = part.thoughtSignature || part.thought_signature || extractedSignature || "";
      const rawId = call.id || call.callId || call.call_id || "call_" + Math.random().toString(36).substring(7);
      // Never expose the opaque thought signature as part of the OpenAI tool-call
      // ID. Signatures can be several KiB long and DeepChat's execution journal
      // rejects/aborts such IDs. The stream transformer caches it server-side.
      const callId = splitToolCallId(rawId).id;
      
      const funcName = getOriginalToolName(call.name) || call.name;
      
      toolCalls.push({
        index: toolCalls.length,
        id: callId,
        type: "function",
        function: {
          name: funcName,
          arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args || {})
        }
      });
      if (sig) extractedSignature = sig;
    }
  }

  if (toolCalls.length > 0) {
    delta.tool_calls = toolCalls;
  }
  
  let openaiFinishReason: string | null = null;
  if (finishReason) {
    if (toolCalls.length > 0 || hasPriorToolCalls) {
      openaiFinishReason = "tool_calls";
    } else if (finishReason === "STOP") {
      openaiFinishReason = "stop";
    } else if (finishReason === "MAX_TOKENS") {
      openaiFinishReason = "length";
    } else if (finishReason === "SAFETY") {
      openaiFinishReason = "content_filter";
    } else if (finishReason === "MALFORMED_FUNCTION_CALL") {
      openaiFinishReason = "tool_calls";
    } else {
      openaiFinishReason = "stop";
    }
  }
  
  return {
    id: requestIdActual,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta,
      finish_reason: openaiFinishReason
    }],
    usage: usage,
    _signature: extractedSignature,
    _thought: extractedThought
  };
}

export function createOpenAIStreamTransformer(model: string, requestId: string, hasPriorToolCalls: boolean, sessionId?: string) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let currentHasPriorToolCalls = hasPriorToolCalls;
  let hasSemanticOutput = false;
  let emittedEventCount = 0;
  let sawDone = false;
  let sawFinishReason = false;
  let resultLogged = false;
  const startedAt = Date.now();

  const enqueueTerminalChunk = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (sawFinishReason) return;
    sawFinishReason = true;
    emittedEventCount++;
    const terminalEvent = {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: currentHasPriorToolCalls ? "tool_calls" : "stop"
      }]
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminalEvent)}\n\n`));
  };

  const logResult = (endedByDone: boolean) => {
    if (resultLogged) return;
    resultLogged = true;
    const durationMs = Date.now() - startedAt;
    if (!hasSemanticOutput) {
      console.warn(`[Response] Empty stream | Model: ${model} | Request: ${requestId} | Events: ${emittedEventCount} | DONE: ${endedByDone} | Duration: ${durationMs}ms`);
    } else {
      console.log(`[Response] Stream complete | Model: ${model} | Request: ${requestId} | Events: ${emittedEventCount} | DONE: ${endedByDone} | Duration: ${durationMs}ms`);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        if (trimmedLine.startsWith("data: ")) {
          const dataStr = trimmedLine.slice(6);
          if (dataStr === "[DONE]") {
            sawDone = true;
            enqueueTerminalChunk(controller);
            logResult(true);
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            continue;
          }
          try {
            const googleEvent = JSON.parse(dataStr);
            const openaiEvent = transformGoogleEventToOpenAI(googleEvent, model, requestId, currentHasPriorToolCalls);
            
            if (openaiEvent) {
              if (sessionId && openaiEvent._signature && openaiEvent._thought) {
                  cacheSignature(sessionId, openaiEvent._thought, openaiEvent._signature);
                  console.log(`[Cache] Signature cached for conversation ${sessionId}`);
              }

              if (sessionId && openaiEvent._signature) {
                for (const toolCall of openaiEvent.choices?.[0]?.delta?.tool_calls || []) {
                  if (toolCall?.id) {
                    cacheToolCallSignature(sessionId, toolCall.id, openaiEvent._signature);
                  }
                }
              }

              const choice = openaiEvent.choices?.[0];
              const delta = choice?.delta;
              if (choice?.finish_reason) sawFinishReason = true;
              const hasMeaningfulContent = (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) || 
                                          (choice && choice.finish_reason) || 
                                          openaiEvent.usage;
              
              if (hasMeaningfulContent) {
                if (delta?.tool_calls) {
                  currentHasPriorToolCalls = true;
                }
                
                const { _signature, _thought, ...cleanEvent } = openaiEvent;
                emittedEventCount++;
                if (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) {
                  hasSemanticOutput = true;
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanEvent)}\n\n`));
              }
            }
          } catch (e) {
            console.warn("[Stream] Failed to parse SSE line:", e);
          }
        }
      }
    },
    flush(controller) {
      if (buffer.trim().startsWith("data: ")) {
        const dataStr = buffer.trim().slice(6);
        if (dataStr !== "[DONE]") {
          try {
            const googleEvent = JSON.parse(dataStr);
            const openaiEvent = transformGoogleEventToOpenAI(googleEvent, model, requestId, currentHasPriorToolCalls);
            if (openaiEvent) {
              const { _signature, _thought, ...cleanEvent } = openaiEvent;
              emittedEventCount++;
              const delta = cleanEvent.choices?.[0]?.delta;
              if (cleanEvent.choices?.[0]?.finish_reason) sawFinishReason = true;
              if (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) {
                hasSemanticOutput = true;
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanEvent)}\n\n`));
            }
          } catch (e) {
            console.warn("[Stream] Failed to parse final line in flush:", e);
          }
        }
      }
      if (!sawDone) {
        // Some Google endpoints finish by closing the SSE body without emitting an
        // explicit [DONE]. OpenAI-compatible clients such as DeepChat rely on the
        // terminal frame, so normalize a clean upstream EOF into one here.
        enqueueTerminalChunk(controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        logResult(false);
      }
    }
  });
}
