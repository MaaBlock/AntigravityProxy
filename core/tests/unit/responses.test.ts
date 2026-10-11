import { describe, expect, test } from "bun:test";
import {
  chatCompletionToResponse,
  createResponsesStreamTransformer,
  responsesRequestToChat,
} from "../../src/utils/responses";

describe("Responses API compatibility", () => {
  test("converts Codex messages, calls, outputs, and function tools", () => {
    const chat = responsesRequestToChat({
      model: "gemini-3.1-pro-high",
      instructions: "Follow the project rules.",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Be concise." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect it." }] },
        { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
        { type: "function_call_output", call_id: "call_1", output: "G:\\repo" },
      ],
      tools: [
        { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object" } },
        { type: "web_search" },
      ],
      max_output_tokens: 123,
      stream: true,
    });

    expect(chat.model).toBe("gemini-3.1-pro-high");
    expect(chat.stream).toBe(true);
    expect(chat.max_tokens).toBe(123);
    expect(chat.messages[0]).toEqual({ role: "system", content: "Follow the project rules.\n\nBe concise." });
    expect(chat.messages[2].tool_calls[0].function.name).toBe("exec_command");
    expect(chat.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "G:\\repo" });
    expect(chat.tools).toHaveLength(1);
    expect(chat.tools[0].function.name).toBe("exec_command");
  });

  test("converts a non-streaming chat completion", () => {
    const response = chatCompletionToResponse({
      id: "chatcmpl-test",
      created: 123,
      choices: [{ message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }, { model: "gemini-3.1-pro-high" });

    expect(response.id).toBe("resp_test");
    expect(response.status).toBe("completed");
    expect(response.output[0].content[0].text).toBe("OK");
    expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  });

  test("uses the accepted Antigravity output limit when Codex omits one", () => {
    const chat = responsesRequestToChat({
      model: "gemini-3.1-pro-high",
      input: "Reply OK",
      stream: true,
    });

    expect(chat.max_tokens).toBe(65535);
  });

  test("converts chat SSE text and tool calls into Responses events", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"there"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const output = await new Response(upstream.pipeThrough(createResponsesStreamTransformer({
      model: "gemini-3.1-pro-high",
      stream: true,
    }, "resp_test"))).text();

    expect(output).toContain("event: response.created");
    expect(output).toContain('"type":"response.output_text.delta"');
    expect(output).toContain('"delta":"Hi "');
    expect(output).toContain('"type":"response.function_call_arguments.done"');
    expect(output).toContain('"arguments":"{\\"cmd\\":\\"pwd\\"}"');
    expect(output).toContain('"type":"response.completed"');
    expect(output).toContain('"total_tokens":7');
  });
});
