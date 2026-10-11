
import { beforeAll, describe, expect, test } from "bun:test";
import { createOpenAIStreamTransformer, transformToGoogleBody, transformGoogleEventToOpenAI } from "../../src/utils/transform";
import { loadProxyConfig } from "../../src/config/manager";

beforeAll(async () => {
  await loadProxyConfig();
});

describe("Unit Tests: transformToGoogleBody", () => {
  test("Basic message transformation", () => {
    const openaiBody = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Hello Gemini" }
      ],
      temperature: 0.5
    };

    const result = transformToGoogleBody(openaiBody, "test-project", false, "us-central1");

    expect(result.project).toBe("test-project");
    expect(result.model).toBe("gpt-4o"); // It passes through if no antigravity prefix
    expect(result.request.contents).toHaveLength(1);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[0].parts[0].text).toBe("Hello Gemini");
    expect(result.request.generationConfig.temperature).toBe(0.5);
  });

  test("requires a usable final response after internal reasoning", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "system", content: "CLIENT_SYSTEM_PROMPT" },
        { role: "user", content: "Continue the unfinished task" }
      ],
      tools: [{ function: { name: "exec", description: "Run a command", parameters: { type: "object" } } }]
    }, "test-project", false, "");
    const instruction = result.request.systemInstruction.parts[0].text;

    expect(instruction).toContain("CLIENT_SYSTEM_PROMPT");
    expect(instruction).toContain("A response containing only internal thought/reasoning is invalid");
    expect(instruction).toContain("call the appropriate tool and continue the work");
    expect(instruction.indexOf("CLIENT_SYSTEM_PROMPT")).toBeLessThan(instruction.indexOf("<response_completion_protocol>"));
  });

  test("Antigravity model prefix removal", () => {
    const openaiBody = {
      model: "antigravity-gemini-2.0-flash",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.model).toBe("gemini-2.0-flash");
  });

  test("Thinking level extraction for CLI", () => {
    const openaiBody = {
      model: "gemini-3-flash-thinking-medium",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", true, "us-central1"); // isCli = true
    expect(result.model).toBe("gemini-3-flash-preview");
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
  });

  test("Multi-turn conversation", () => {
    const openaiBody = {
      model: "gemini-1.5-pro",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.contents).toHaveLength(3);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[1].role).toBe("model"); // OpenAI assistant -> Google model
    expect(result.request.contents[2].role).toBe("user");
  });

  test("does not invent a preview model for Gemini 3.6 Flash tiers", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.6-flash-high",
      messages: [{ role: "user", content: "Hi" }],
    }, "test-project", true, "");

    expect(result.model).toBe("gemini-3.6-flash-high");
  });

  test("does not invent a preview model for Gemini 3.7 Flash tiers", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [{ role: "user", content: "Hi" }],
    }, "test-project", true, "");

    expect(result.model).toBe("gemini-3.7-flash-high");
  });

  test("Gemini 3.7 respects client output limit and uses only thinkingLevel", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 16384,
      temperature: 0.6,
      top_p: 0.9
    }, "test-project", false, "");

    expect(result.request.generationConfig.maxOutputTokens).toBe(16384);
    expect(result.request.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "high"
    });
    expect(result.request.generationConfig.temperature).toBeUndefined();
    expect(result.request.generationConfig.topP).toBeUndefined();
    expect(result.request.generationConfig.candidateCount).toBeUndefined();
  });

  test("Gemini 3.1 Pro High uses the live Pro entrypoint with high thinking", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.1-pro-high",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 16384
    }, "test-project", false, "");

    expect(result.model).toBe("gemini-3.1-pro-low");
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  test("does not invent a preview model for Gemini 3.6 Flash tiered", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.6-flash-tiered",
      messages: [{ role: "user", content: "hello" }],
    }, "test-project", true, "", "test-session", false);

    expect(result.model).toBe("gemini-3.6-flash-tiered");
  });

  test("Multimodal OpenAI-compatible attachments become Gemini inlineData", () => {
    const openaiBody = {
      model: "gemini-3.6-flash-high",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect every attachment" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "mp3" } },
            { type: "file", file: { filename: "document.pdf", file_data: "data:application/pdf;base64,cGRm" } },
            { type: "file", file: { filename: "clip.mp4", file_data: "data:video/mp4;base64,dmlkZW8=" } },
          ],
        },
      ],
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.contents[0].parts).toEqual([
      { text: "Inspect every attachment" },
      { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
      { inlineData: { mimeType: "audio/mpeg", data: "YXVkaW8=" } },
      { inlineData: { mimeType: "application/pdf", data: "cGRm" } },
      { inlineData: { mimeType: "video/mp4", data: "dmlkZW8=" } },
    ]);
  });

  test("Tool transformation", () => {
    const openaiBody = {
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" }
              },
              required: ["location"]
            }
          }
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.tools).toBeDefined();
    expect(result.request.tools[0].functionDeclarations).toHaveLength(1);
    expect(result.request.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(result.request.tools[0].functionDeclarations[0].parameters.properties.location).toBeDefined();
  });

  test("DeepChat tool schemas stringify nested non-string enum members", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [{ role: "user", content: "Use the tool" }],
      tools: [{
        type: "function",
        function: {
          name: "nested_enum_tool",
          parameters: {
            type: "object",
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean", enum: [true, false] },
                    priority: { type: "integer", enum: [1, 2] }
                  }
                }
              }
            }
          }
        }
      }]
    }, "p", false, "us-central1");

    const properties = result.request.tools[0].functionDeclarations[0]
      .parameters.properties.entries.items.properties;
    expect(properties.enabled.enum).toEqual(["true", "false"]);
    expect(properties.priority.enum).toEqual(["1", "2"]);
  });

  test("Claude Opus 4.6 Thinking mapping and budget", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.model).toBe("claude-opus-4-6-thinking");
    expect(result.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(32768);
  });

  test("Claude Opus 4.6 Thinking Low budget", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-low",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test("Claude tool call transformation with ID", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }
          ]
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    const funcCallPart = result.request.contents[0].parts.find((p: any) => p.functionCall);
    expect(funcCallPart).toBeDefined();
    expect(funcCallPart.functionCall.id).toBe("call_abc123");
  });

  test("Claude tool response transformation with ID", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_abc123",
          name: "test_tool",
          content: '{"result": "ok"}'
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    const funcRespPart = result.request.contents[0].parts.find((p: any) => p.functionResponse);
    expect(funcRespPart).toBeDefined();
    expect(funcRespPart.functionResponse.id).toBe("call_abc123");
  });

  test("Gemini 3 uses a validator fallback for imported tool-call history without signatures", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "user", content: "Inspect the project" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_glob", type: "function", function: { name: "glob", arguments: '{"query":"*"}' } },
            { id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }
          ]
        },
        { role: "tool", tool_call_id: "call_glob", name: "glob", content: "[]" },
        { role: "tool", tool_call_id: "call_read", name: "read", content: "{}" }
      ]
    }, "p", false, "", "imported-session");

    const functionCallParts = result.request.contents[1].parts.filter((part: any) => part.functionCall);
    expect(functionCallParts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(functionCallParts[1].thoughtSignature).toBeUndefined();
    expect(result.request.contents).toHaveLength(3);
    expect(result.request.contents[2].parts.map((part: any) => part.functionResponse.id))
      .toEqual(["call_glob", "call_read"]);
  });

  test("Gemini 3 splits oversized imported parallel tool exchanges into valid steps", () => {
    const toolCalls = Array.from({ length: 40 }, (_, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: `file-${index}` }) }
    }));
    const toolResults = toolCalls.map((call, index) => ({
      role: "tool",
      tool_call_id: call.id,
      name: "read",
      content: JSON.stringify({ index })
    }));

    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "user", content: "Read the files" },
        { role: "assistant", content: null, tool_calls: toolCalls },
        ...toolResults,
        { role: "user", content: "Continue" }
      ]
    }, "p", false, "", "oversized-import");

    const contents = result.request.contents;
    const callSteps = contents.filter((content: any) => content.parts.every((part: any) => part.functionCall));
    const responseSteps = contents.filter((content: any) => content.parts.every((part: any) => part.functionResponse));

    expect(callSteps.map((content: any) => content.parts.length)).toEqual([16, 16, 8]);
    expect(responseSteps.map((content: any) => content.parts.length)).toEqual([16, 16, 8]);
    expect(callSteps.every((content: any) => content.parts[0].thoughtSignature === "skip_thought_signature_validator")).toBe(true);
    expect(contents.at(-1).parts[0].text).toBe("Continue");
  });

  test("matches reused tool call IDs to response names in chronological order", () => {
    const result = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "user", content: "Run two steps" },
        { role: "assistant", content: null, tool_calls: [
          { id: "call_reused", type: "function", function: { name: "glob", arguments: '{"query":"*"}' } }
        ] },
        { role: "tool", tool_call_id: "call_reused", content: "[]" },
        { role: "assistant", content: null, tool_calls: [
          { id: "call_reused", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }
        ] },
        { role: "tool", tool_call_id: "call_reused", content: "{}" },
        { role: "user", content: "Continue" }
      ]
    }, "p", false, "", "reused-id-session");

    const responses = result.request.contents
      .flatMap((content: any) => content.parts)
      .filter((part: any) => part.functionResponse)
      .map((part: any) => part.functionResponse.name);
    expect(responses).toEqual(["glob", "read"]);
  });
});

describe("Unit Tests: transformGoogleEventToOpenAI", () => {
  test("Basic text response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{ text: "Hello world" }]
        },
        finishReason: "STOP"
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro", "req-123");
    expect(result).not.toBeNull();
    expect(result.choices[0].delta.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  test("Tool call response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: "get_weather",
              args: { location: "London" }
            }
          }]
        }
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro");
    expect(result.choices[0].delta.tool_calls).toHaveLength(1);
    expect(result.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(result.choices[0].delta.tool_calls[0].function.arguments).location).toBe("London");
  });

  test("keeps Gemini thought signatures server-side instead of inflating DeepChat tool IDs", async () => {
    const sessionId = "deepchat-tool-session";
    const signature = "S".repeat(4096);
    const upstream = `data: ${JSON.stringify({ response: { candidates: [{
      content: { parts: [
        { thought: true, text: "Need to inspect files" },
        { functionCall: { id: "call_glob_1", name: "glob", args: { query: "*" } }, thoughtSignature: signature }
      ] },
      finishReason: "STOP"
    }] } })}\n\n`;
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(upstream));
        controller.close();
      }
    });
    const responseText = await new Response(
      source.pipeThrough(createOpenAIStreamTransformer("gemini-3.7-flash-high", "chatcmpl-tool", false, sessionId))
    ).text();
    const dataLine = responseText.split("\n").find(line => line.startsWith("data: {"))!;
    const chunk = JSON.parse(dataLine.slice(6));
    const toolCall = chunk.choices[0].delta.tool_calls[0];

    expect(toolCall.id).toBe("call_glob_1");
    expect(toolCall.id).not.toContain(signature);

    const nextRequest = transformToGoogleBody({
      model: "gemini-3.7-flash-high",
      messages: [
        { role: "assistant", reasoning_content: "Need to inspect files", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, name: "glob", content: "[]" }
      ]
    }, "p", false, "", sessionId);
    const functionCallPart = nextRequest.request.contents[0].parts.find((part: any) => part.functionCall);

    expect(functionCallPart.functionCall.id).toBe("call_glob_1");
    expect(functionCallPart.thoughtSignature).toBe(signature);
    expect(nextRequest.request.contents[1].parts[0].functionResponse.id).toBe("call_glob_1");
  });

  test("Empty/Invalid response", () => {
    const googleData = { candidates: [] };
    const result = transformGoogleEventToOpenAI(googleData, "model");
    expect(result).toBeNull();
  });

  test("Usage metadata with cached tokens and reasoning", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{ text: "Hello with cache" }]
        },
        finishReason: "STOP"
      }],
      usageMetadata: {
        promptTokenCount: 15000,
        candidatesTokenCount: 500,
        totalTokenCount: 15500,
        cachedContentTokenCount: 12000,
        thoughtsTokenCount: 200
      }
    };
    const result = transformGoogleEventToOpenAI(googleData, "gemini-2.0-flash");
    expect(result.usage).toBeDefined();
    expect(result.usage.prompt_tokens).toBe(15000);
    expect(result.usage.completion_tokens).toBe(500);
    expect(result.usage.total_tokens).toBe(15500);
    expect(result.usage.prompt_cache_hit_tokens).toBe(12000);
    expect(result.usage.prompt_cache_miss_tokens).toBe(3000);
    expect(result.usage.prompt_tokens_details.cached_tokens).toBe(12000);
    expect(result.usage.completion_tokens_details.reasoning_tokens).toBe(200);
  });

  test("DeepChat-compatible stream preserves cached usage before DONE", async () => {
    const upstream = [
      `data: ${JSON.stringify({ response: { candidates: [], usageMetadata: {
        promptTokenCount: 15000,
        candidatesTokenCount: 500,
        totalTokenCount: 15500,
        cachedContentTokenCount: 12000
      } } })}\n\n`,
      "data: [DONE]\n\n"
    ].join("");

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(upstream));
        controller.close();
      }
    });
    const responseText = await new Response(
      source.pipeThrough(createOpenAIStreamTransformer("gemini-2.0-flash", "chatcmpl-test", false))
    ).text();
    const dataLines = responseText.split("\n").filter(line => line.startsWith("data: "));
    const usageChunk = JSON.parse(dataLines[0].slice(6));

    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toBe(12000);
    expect(JSON.parse(dataLines[1].slice(6)).choices[0].finish_reason).toBe("stop");
    expect(dataLines[2]).toBe("data: [DONE]");
  });

  test("DeepChat-compatible stream synthesizes DONE when upstream closes at EOF", async () => {
    const upstream = `data: ${JSON.stringify({ response: { candidates: [{
      content: { parts: [{ text: "completed without marker" }] },
      finishReason: "STOP"
    }] } })}\n\n`;
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(upstream));
        controller.close();
      }
    });

    const responseText = await new Response(
      source.pipeThrough(createOpenAIStreamTransformer("gemini-3.7-flash-high", "chatcmpl-eof", false))
    ).text();
    const dataLines = responseText.split("\n").filter(line => line.startsWith("data: "));

    expect(JSON.parse(dataLines[0].slice(6)).choices[0].delta.content).toBe("completed without marker");
    expect(dataLines.filter(line => line !== "data: [DONE]")).toHaveLength(1);
    expect(dataLines.at(-1)).toBe("data: [DONE]");
  });

  test("synthesizes a terminal finish_reason before DONE when upstream omits it", async () => {
    const upstream = [
      `data: ${JSON.stringify({ response: { candidates: [{
        content: { parts: [{ text: "answer without finish reason" }] }
      }] } })}\n\n`,
      "data: [DONE]\n\n"
    ].join("");
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(upstream));
        controller.close();
      }
    });

    const responseText = await new Response(
      source.pipeThrough(createOpenAIStreamTransformer("gemini-3.7-flash-high", "chatcmpl-no-finish", false))
    ).text();
    const dataLines = responseText.split("\n").filter(line => line.startsWith("data: "));
    const terminalChunk = JSON.parse(dataLines.at(-2)!.slice(6));

    expect(terminalChunk.choices[0].delta).toEqual({});
    expect(terminalChunk.choices[0].finish_reason).toBe("stop");
    expect(dataLines.at(-1)).toBe("data: [DONE]");
  });
});
