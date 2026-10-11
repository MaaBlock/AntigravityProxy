import { cleanJSONSchemaForAntigravity } from "./schema";

const NATIVE_RESPONSE_COMPLETION_PROTOCOL = `<response_completion_protocol>
A response containing only internal thought/reasoning is invalid. Before ending every turn, emit either non-thought final answer text or a declared function call.
Never call a function that is not present in the request's function declarations. If no suitable declared function is available, respond with non-thought text instead.
If the task is unfinished and a suitable declared function is available, call it instead of merely describing the next step.
</response_completion_protocol>`;

export interface GeminiNativeRoute {
  model: string;
  streaming: boolean;
}

function normalizeFunctionDeclaration(declaration: any): any {
  if (!declaration || typeof declaration !== "object") return declaration;
  return {
    ...declaration,
    ...(declaration.parameters
      ? { parameters: cleanJSONSchemaForAntigravity(declaration.parameters) }
      : {}),
    ...(declaration.parametersJsonSchema
      ? { parametersJsonSchema: cleanJSONSchemaForAntigravity(declaration.parametersJsonSchema) }
      : {}),
  };
}

function normalizeGeminiToolSchemas(tool: any): any {
  if (!tool || typeof tool !== "object") return tool;
  return {
    ...tool,
    ...(Array.isArray(tool.functionDeclarations)
      ? { functionDeclarations: tool.functionDeclarations.map(normalizeFunctionDeclaration) }
      : {}),
    ...(Array.isArray(tool.function_declarations)
      ? { function_declarations: tool.function_declarations.map(normalizeFunctionDeclaration) }
      : {}),
  };
}

export function normalizeGeminiNativeRequestSchemas(request: Record<string, any>): Record<string, any> {
  const generationConfig = request.generationConfig;
  return {
    ...request,
    ...(Array.isArray(request.tools)
      ? { tools: request.tools.map(normalizeGeminiToolSchemas) }
      : {}),
    ...(generationConfig && typeof generationConfig === "object"
      ? {
          generationConfig: {
            ...generationConfig,
            ...(generationConfig.responseSchema
              ? { responseSchema: cleanJSONSchemaForAntigravity(generationConfig.responseSchema) }
              : {}),
            ...(generationConfig.responseJsonSchema
              ? { responseJsonSchema: cleanJSONSchemaForAntigravity(generationConfig.responseJsonSchema) }
              : {}),
          },
        }
      : {}),
  };
}

function appendNativeCompletionProtocol(request: Record<string, any>): Record<string, any> {
  const existing = request.systemInstruction;
  const parts = Array.isArray(existing?.parts) ? [...existing.parts] : [];
  parts.push({ text: NATIVE_RESPONSE_COMPLETION_PROTOCOL });

  return {
    ...request,
    systemInstruction: {
      ...(existing && typeof existing === "object" ? existing : {}),
      role: existing?.role || "user",
      parts,
    },
  };
}

export function matchGeminiNativeRoute(pathname: string): GeminiNativeRoute | null {
  const match = pathname.match(/^\/v1beta\/models\/(.+):(streamGenerateContent|generateContent)$/i);
  if (!match) return null;

  return {
    model: decodeURIComponent(match[1]).replace(/^models\//i, ""),
    streaming: match[2].toLowerCase() === "streamgeneratecontent",
  };
}

export function createAntigravityGeminiBody(
  request: Record<string, any>,
  model: string,
  project: string,
  sessionId: string,
): { project: string; model: string; userAgent: string; requestId: string; requestType: string; request: Record<string, any> } {
  const normalizedRequest = appendNativeCompletionProtocol(normalizeGeminiNativeRequestSchemas(request));
  return {
    project,
    model,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    requestType: "agent",
    request: {
      ...normalizedRequest,
      sessionId: normalizedRequest.sessionId || sessionId,
    },
  };
}

function unwrapAntigravityEvent(value: any): any {
  if (value && typeof value === "object" && value.response && typeof value.response === "object") {
    return value.response;
  }
  return value;
}

export interface GeminiNativeStreamOptions {
  onComplete?: (summary: { eventCount: number; usableEventCount: number; empty: boolean }) => void;
}

const EMPTY_NATIVE_RESPONSE_TEXT =
  "The model returned no usable response. Please retry the current step.";

export function hasUsableNativeContent(event: any): boolean {
  return (Array.isArray(event?.candidates) ? event.candidates : []).some((candidate: any) =>
    (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []).some((part: any) =>
      (typeof part?.text === "string" && part.text.length > 0) ||
      Boolean(part?.functionCall || part?.function_call || part?.toolCall || part?.inlineData || part?.fileData),
    ),
  );
}

export async function probeGeminiNativeStream(body: ReadableStream<Uint8Array>): Promise<{
  body: ReadableStream<Uint8Array> | null;
  eventCount: number;
  finishReasons: string[];
  finishMessages: string[];
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: Uint8Array[] = [];
  let textBuffer = "";
  let eventCount = 0;
  const finishReasons = new Set<string>();
  const finishMessages = new Set<string>();

  const inspectLines = (flush = false): boolean => {
    const lines = textBuffer.split(/\r?\n/);
    const remainder = lines.pop() || "";
    textBuffer = flush ? "" : remainder;
    if (flush && remainder) lines.push(remainder);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        eventCount++;
        const event = unwrapAntigravityEvent(JSON.parse(data));
        for (const candidate of Array.isArray(event?.candidates) ? event.candidates : []) {
          if (candidate?.finishReason) finishReasons.add(String(candidate.finishReason));
          if (candidate?.finishMessage) finishMessages.add(String(candidate.finishMessage));
        }
        if (hasUsableNativeContent(event)) return true;
      } catch {
        // The normal transformer will report malformed upstream events.
      }
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      inspectLines(true);
      return { body: null, eventCount, finishReasons: [...finishReasons], finishMessages: [...finishMessages] };
    }
    bufferedChunks.push(value);
    textBuffer += decoder.decode(value, { stream: true });
    if (!inspectLines()) continue;

    const replay = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const chunk of bufferedChunks) controller.enqueue(chunk);
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            controller.enqueue(next.value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { body: replay, eventCount, finishReasons: [...finishReasons], finishMessages: [...finishMessages] };
  }
}

export function createGeminiNativeStreamTransformer(options: GeminiNativeStreamOptions = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let eventCount = 0;
  let usableEventCount = 0;

  const emitLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;

    try {
      const event = unwrapAntigravityEvent(JSON.parse(data));
      eventCount++;
      if (hasUsableNativeContent(event)) usableEventCount++;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch (error) {
      console.warn("[Gemini Native] Failed to parse upstream SSE event:", error);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) emitLine(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) emitLine(buffer, controller);
      if (usableEventCount === 0) {
        const fallback = {
          candidates: [{
            index: 0,
            content: { role: "model", parts: [{ text: EMPTY_NATIVE_RESPONSE_TEXT }] },
            finishReason: "STOP",
          }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(fallback)}\n\n`));
      }
      options.onComplete?.({
        eventCount,
        usableEventCount,
        empty: usableEventCount === 0,
      });
    },
  });
}

function mergeParts(target: any[], incoming: any[]) {
  for (const part of incoming) {
    if (typeof part?.text === "string" && Object.keys(part).every((key) => key === "text" || key === "thought")) {
      const previous = target.at(-1);
      if (
        previous &&
        typeof previous.text === "string" &&
        Boolean(previous.thought) === Boolean(part.thought) &&
        Object.keys(previous).every((key) => key === "text" || key === "thought")
      ) {
        previous.text += part.text;
        continue;
      }
    }
    target.push(part);
  }
}

export function mergeGeminiResponses(events: any[]): any {
  const result: any = {};
  const candidates = new Map<number, any>();

  for (const rawEvent of events) {
    const event = unwrapAntigravityEvent(rawEvent);
    if (!event || typeof event !== "object") continue;

    for (const [key, value] of Object.entries(event)) {
      if (key !== "candidates") result[key] = value;
    }

    for (const incoming of Array.isArray(event.candidates) ? event.candidates : []) {
      const index = typeof incoming.index === "number" ? incoming.index : 0;
      let candidate = candidates.get(index);
      if (!candidate) {
        candidate = { index, content: { role: incoming.content?.role || "model", parts: [] } };
        candidates.set(index, candidate);
      }

      for (const [key, value] of Object.entries(incoming)) {
        if (key !== "content") candidate[key] = value;
      }
      if (Array.isArray(incoming.content?.parts)) {
        mergeParts(candidate.content.parts, incoming.content.parts);
      }
    }
  }

  if (candidates.size) result.candidates = [...candidates.values()].sort((a, b) => a.index - b.index);
  return result;
}

export async function readGeminiNativeResponse(body: ReadableStream<Uint8Array>): Promise<any> {
  const text = await new Response(body).text();
  const events: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data));
  }
  return mergeGeminiResponses(events);
}
