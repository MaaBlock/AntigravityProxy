type JsonObject = Record<string, any>;

function textFromContent(content: any): string | any[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);

  const chatParts: any[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      chatParts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;

    if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") {
      chatParts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "input_image") {
      const imageUrl = part.image_url || part.url;
      if (imageUrl) chatParts.push({ type: "image_url", image_url: { url: imageUrl } });
      continue;
    }
    if (part.type === "input_file") {
      const label = part.filename ? `File ${part.filename}` : "Attached file";
      chatParts.push({ type: "text", text: `[${label} is not supported by this compatibility endpoint]` });
    }
  }

  if (chatParts.every((part) => part.type === "text")) {
    return chatParts.map((part) => part.text).join("\n");
  }
  return chatParts;
}

function appendMessage(messages: JsonObject[], message: JsonObject) {
  if (!message.content && !message.tool_calls) return;
  const previous = messages[messages.length - 1];
  if (
    previous &&
    previous.role === "system" &&
    message.role === "system" &&
    typeof previous.content === "string" &&
    typeof message.content === "string"
  ) {
    previous.content = `${previous.content}\n\n${message.content}`;
    return;
  }
  messages.push(message);
}

function normalizeToolChoice(toolChoice: any): any {
  if (toolChoice == null || typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  if (toolChoice.type === "allowed_tools") return toolChoice.mode || "auto";
  return "auto";
}

export function responsesRequestToChat(body: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  if (body.instructions) {
    appendMessage(messages, { role: "system", content: textFromContent(body.instructions) });
  }

  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "message") {
      const role = item.role === "developer" || item.role === "system" ? "system" : item.role;
      appendMessage(messages, { role: role || "user", content: textFromContent(item.content) });
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const argumentsText = item.type === "custom_tool_call"
        ? JSON.stringify({ input: item.input || "" })
        : (typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}));
      appendMessage(messages, {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: argumentsText },
        }],
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      appendMessage(messages, {
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    }
  }

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === "function" && tool.name)
    .map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    }));

  const requestedMaxTokens = Number(body.max_output_tokens);
  const defaultMaxTokens = 65535;
  const maxTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
    ? Math.min(Math.floor(requestedMaxTokens), defaultMaxTokens)
    : defaultMaxTokens;

  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice != null ? { tool_choice: normalizeToolChoice(body.tool_choice) } : {}),
    ...(body.parallel_tool_calls != null ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    max_tokens: maxTokens,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(body.user ? { user: body.user } : {}),
  };
}

function usageFromChat(usage: any) {
  if (!usage) return null;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
  return {
    input_tokens: usage.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: usage.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
  };
}

function baseResponse(body: JsonObject, responseId: string, createdAt: number): JsonObject {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output: [],
    parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning || null,
    store: body.store === true,
    temperature: body.temperature ?? null,
    text: body.text || { format: { type: "text" } },
    tool_choice: body.tool_choice || "auto",
    tools: body.tools || [],
    top_p: body.top_p ?? null,
    truncation: body.truncation || "disabled",
    usage: null,
  };
}

function messageItem(id: string, text: string, status = "completed") {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", annotations: [], text }],
  };
}

function functionCallItem(id: string, call: any, status = "completed") {
  return {
    id,
    type: "function_call",
    status,
    call_id: call.id || id,
    name: call.function?.name || "",
    arguments: call.function?.arguments || "",
  };
}

export function chatCompletionToResponse(chat: JsonObject, body: JsonObject): JsonObject {
  const responseId = chat.id?.replace(/^chatcmpl-/, "resp_") || `resp_${crypto.randomUUID()}`;
  const createdAt = chat.created || Math.floor(Date.now() / 1000);
  const response = baseResponse(body, responseId, createdAt);
  const message = chat.choices?.[0]?.message || {};
  const output: JsonObject[] = [];

  if (message.content) output.push(messageItem(`msg_${crypto.randomUUID()}`, message.content));
  for (const call of message.tool_calls || []) {
    output.push(functionCallItem(`fc_${crypto.randomUUID()}`, call));
  }

  response.status = "completed";
  response.completed_at = Math.floor(Date.now() / 1000);
  response.output = output;
  response.usage = usageFromChat(chat.usage);
  return response;
}

function sseEvent(type: string, payload: JsonObject): Uint8Array {
  const data = JSON.stringify({ type, ...payload });
  return new TextEncoder().encode(`event: ${type}\ndata: ${data}\n\n`);
}

export function createResponsesStreamTransformer(body: JsonObject, responseId = `resp_${crypto.randomUUID()}`) {
  const decoder = new TextDecoder();
  const createdAt = Math.floor(Date.now() / 1000);
  const response = baseResponse(body, responseId, createdAt);
  let buffer = "";
  let sequenceNumber = 0;
  let message: JsonObject | null = null;
  let messageIndex = -1;
  let text = "";
  let usage: any = null;
  const toolCalls = new Map<number, { outputIndex: number; item: JsonObject }>();
  let started = false;
  let completed = false;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, type: string, payload: JsonObject) => {
    controller.enqueue(sseEvent(type, { sequence_number: sequenceNumber++, ...payload }));
  };

  const start = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return;
    started = true;
    emit(controller, "response.created", { response: { ...response } });
    emit(controller, "response.in_progress", { response: { ...response } });
  };

  const ensureMessage = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (message) return message;
    messageIndex = response.output.length;
    message = messageItem(`msg_${crypto.randomUUID()}`, "", "in_progress");
    message.content = [];
    response.output.push(message);
    emit(controller, "response.output_item.added", { output_index: messageIndex, item: { ...message } });
    emit(controller, "response.content_part.added", {
      item_id: message.id,
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    });
    return message;
  };

  const applyChunk = (controller: TransformStreamDefaultController<Uint8Array>, chunk: JsonObject) => {
    start(controller);
    if (chunk.usage) usage = usageFromChat(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.content === "string" && delta.content) {
      const item = ensureMessage(controller);
      text += delta.content;
      emit(controller, "response.output_text.delta", {
        item_id: item.id,
        output_index: messageIndex,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      });
    }

    for (const callDelta of delta.tool_calls || []) {
      const index = Number.isInteger(callDelta.index) ? callDelta.index : toolCalls.size;
      let aggregate = toolCalls.get(index);
      if (!aggregate) {
        const outputIndex = response.output.length;
        const id = `fc_${crypto.randomUUID()}`;
        const item = functionCallItem(id, {
          id: callDelta.id || `call_${crypto.randomUUID()}`,
          function: { name: callDelta.function?.name || "", arguments: "" },
        }, "in_progress");
        aggregate = { outputIndex, item };
        toolCalls.set(index, aggregate);
        response.output.push(item);
        emit(controller, "response.output_item.added", { output_index: outputIndex, item: { ...item } });
      }
      if (callDelta.id) aggregate.item.call_id = callDelta.id;
      if (callDelta.function?.name) aggregate.item.name = callDelta.function.name;
      if (typeof callDelta.function?.arguments === "string" && callDelta.function.arguments) {
        aggregate.item.arguments += callDelta.function.arguments;
        emit(controller, "response.function_call_arguments.delta", {
          item_id: aggregate.item.id,
          output_index: aggregate.outputIndex,
          delta: callDelta.function.arguments,
        });
      }
    }
  };

  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (completed) return;
    completed = true;
    start(controller);

    if (message) {
      message.status = "completed";
      message.content = [{ type: "output_text", annotations: [], text }];
      emit(controller, "response.output_text.done", {
        item_id: message.id,
        output_index: messageIndex,
        content_index: 0,
        text,
        logprobs: [],
      });
      emit(controller, "response.content_part.done", {
        item_id: message.id,
        output_index: messageIndex,
        content_index: 0,
        part: message.content[0],
      });
      emit(controller, "response.output_item.done", { output_index: messageIndex, item: message });
    }

    for (const { outputIndex, item } of toolCalls.values()) {
      item.status = "completed";
      emit(controller, "response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
      emit(controller, "response.output_item.done", { output_index: outputIndex, item });
    }

    response.status = "completed";
    response.completed_at = Math.floor(Date.now() / 1000);
    response.usage = usage;
    emit(controller, "response.completed", { response });
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            finish(controller);
            continue;
          }
          try {
            applyChunk(controller, JSON.parse(data));
          } catch {
          }
        }
      }
    },
    flush(controller) {
      const lastData = buffer.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (lastData) {
        const data = lastData.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            applyChunk(controller, JSON.parse(data));
          } catch {
          }
        }
      }
      finish(controller);
    },
  });
}
