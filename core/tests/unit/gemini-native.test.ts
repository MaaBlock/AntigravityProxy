import { describe, expect, test } from "bun:test";
import {
  createAntigravityGeminiBody,
  createGeminiNativeStreamTransformer,
  matchGeminiNativeRoute,
  mergeGeminiResponses,
  probeGeminiNativeStream,
} from "../../src/utils/gemini-native";

describe("Gemini native forwarding", () => {
  test("matches both native generation routes", () => {
    expect(matchGeminiNativeRoute("/v1beta/models/gemini-3.7-flash-high:streamGenerateContent")).toEqual({
      model: "gemini-3.7-flash-high",
      streaming: true,
    });
    expect(matchGeminiNativeRoute("/v1beta/models/gemini-3.7-flash-high:generateContent")).toEqual({
      model: "gemini-3.7-flash-high",
      streaming: false,
    });
  });

  test("wraps the request without converting Gemini contents or tools", () => {
    const request = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "OBJECT" } }] }],
    };
    const wrapped = createAntigravityGeminiBody(request, "gemini-3.7-flash-high", "project", "session");
    expect(wrapped.request.contents).toEqual(request.contents);
    expect(wrapped.request.tools).toEqual(request.tools);
    expect(wrapped.request.sessionId).toBe("session");
    expect(wrapped.request.systemInstruction.role).toBe("user");
    expect(wrapped.request.systemInstruction.parts.at(-1).text).toContain(
      "Never call a function that is not present in the request's function declarations",
    );
  });

  test("preserves the client system instruction before the completion protocol", () => {
    const wrapped = createAntigravityGeminiBody({
      systemInstruction: { role: "system", parts: [{ text: "CLIENT_SYSTEM" }] },
      contents: [{ role: "user", parts: [{ text: "continue" }] }],
    }, "gemini-3.7-flash-high", "project", "session");

    expect(wrapped.request.systemInstruction.role).toBe("system");
    expect(wrapped.request.systemInstruction.parts[0].text).toBe("CLIENT_SYSTEM");
    expect(wrapped.request.systemInstruction.parts[1].text).toContain(
      "A response containing only internal thought/reasoning is invalid",
    );
  });

  test("stringifies deeply nested non-string schema enum members", () => {
    const request = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      tools: [{
        functionDeclarations: [{
          name: "nested",
          parameters: {
            type: "OBJECT",
            properties: {
              rows: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: { enabled: { type: "STRING", enum: [true, false, 1, "auto"] } },
                },
              },
            },
          },
        }],
      }],
    };
    const wrapped = createAntigravityGeminiBody(request, "gemini-3.7-flash-high", "project", "session");
    expect(wrapped.request.tools[0].functionDeclarations[0].parameters.properties.rows.items.properties.enabled.enum)
      .toEqual(["true", "false", "1", "auto"]);
    expect(request.tools[0].functionDeclarations[0].parameters.properties.rows.items.properties.enabled.enum)
      .toEqual([true, false, 1, "auto"]);
  });

  test("forces nested properties and required schemas to OBJECT", () => {
    const request = {
      tools: [{
        functionDeclarations: [{
          name: "verify_state",
          parameters: {
            type: "OBJECT",
            properties: {
              expect: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    window: {
                      type: ["object", "null"],
                      properties: {
                        bounds: {
                          properties: { width: { type: "NUMBER" } },
                          required: ["width"],
                        },
                      },
                    },
                    element: {
                      properties: { selector: { type: "STRING" } },
                      required: ["selector"],
                    },
                  },
                },
              },
            },
          },
        }],
      }],
    };
    const wrapped = createAntigravityGeminiBody(request, "gemini-3.7-flash-high", "project", "session");
    const item = wrapped.request.tools[0].functionDeclarations[0].parameters.properties.expect.items;
    expect(item.properties.window.type).toBe("OBJECT");
    expect(item.properties.window.properties.bounds.type).toBe("OBJECT");
    expect(item.properties.element.type).toBe("OBJECT");
  });

  test("unwraps Antigravity SSE without emitting OpenAI DONE", async () => {
    const upstream = new Response(
      'data: {"response":{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"hi"}]}}]}}\n\n',
    ).body!;
    const text = await new Response(upstream.pipeThrough(createGeminiNativeStreamTransformer())).text();
    expect(text).toContain('data: {"candidates"');
    expect(text).not.toContain("[DONE]");
    expect(JSON.parse(text.slice(6).trim()).candidates[0].content.parts[0].text).toBe("hi");
  });

  test("turns an empty native stream into a visible response", async () => {
    let summary: any;
    const upstream = new Response(
      'data: {"response":{"candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}}\n\n',
    ).body!;
    const text = await new Response(upstream.pipeThrough(createGeminiNativeStreamTransformer({
      onComplete: (value) => { summary = value; },
    }))).text();
    const events = text.trim().split(/\n\n/).map((line) => JSON.parse(line.slice(6)));
    expect(events.at(-1).candidates[0].content.parts[0].text).toContain("no usable response");
    expect(summary).toEqual({ eventCount: 1, usableEventCount: 0, empty: true });
  });

  test("probes empty streams and replays usable streams without losing chunks", async () => {
    const empty = await probeGeminiNativeStream(new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}\n\n',
    ).body!);
    expect(empty.body).toBeNull();
    expect(empty.eventCount).toBe(1);
    expect(empty.finishReasons).toEqual(["STOP"]);

    const raw = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}}\n\ndata: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n';
    const usable = await probeGeminiNativeStream(new Response(raw).body!);
    expect(usable.body).not.toBeNull();
    expect(await new Response(usable.body!).text()).toBe(raw);
  });

  test("aggregates native chunks for generateContent", () => {
    const merged = mergeGeminiResponses([
      { response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hel" }] } }] } },
      { response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 3 } } },
    ]);
    expect(merged.candidates[0].content.parts[0].text).toBe("hello");
    expect(merged.candidates[0].finishReason).toBe("STOP");
    expect(merged.usageMetadata.totalTokenCount).toBe(3);
  });
});
