import { expect, test, describe, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".config/opencode/opencode.json");

function parseConfig(text: string) {
  const cleaned = text.replace(/,(\s*[\]}])/g, "$1");
  return JSON.parse(cleaned);
}

describe("Antigravity Proxy Functional Tests", () => {
  let config: any;
  let provider: any;
  let baseURL: string;
  let headers: Record<string, string>;
  let modelIds: string[] = [];

  beforeAll(() => {
    if (!existsSync(CONFIG_PATH)) {
      console.warn(`[Skip] Config file not found at ${CONFIG_PATH}, skipping functional tests.`);
      return;
    }

    try {
      const content = readFileSync(CONFIG_PATH, "utf8");
      config = parseConfig(content);
      provider = config.provider?.["antigravity-proxy"];
      
      if (!provider) {
        console.warn("Provider 'antigravity-proxy' not found in config, skipping.");
        return;
      }

      baseURL = provider.options?.baseURL;
      if (!baseURL) {
        console.warn("baseURL not defined in provider options, skipping.");
        return;
      }

      headers = provider.options?.headers || {};
      modelIds = Object.keys(provider.models || {});

      if (!modelIds.includes("antigravity-claude-opus-4-6-thinking-high")) {
        modelIds.push("antigravity-claude-opus-4-6-thinking-high");
      }
    } catch (e: any) {
      console.warn(`Failed to initialize test config: ${e.message}`);
    }
  });

  test("Config should have models defined", () => {
    if (!config || !provider) return;
    expect(modelIds.length).toBeGreaterThan(0);
  });

  test("Proxy should be reachable", async () => {
    if (!config || !baseURL) return;
    const response = await fetch(`${baseURL}/models`, {
      headers: { ...headers }
    });
    expect(response.ok).toBe(true);
  });

  describe("Model Completions", () => {
    test("All models should respond to a basic prompt", async () => {
      if (!config || !baseURL) return;
      console.log(`\n🚀 Testing ${modelIds.length} models...`);
      
      const results = await Promise.all(modelIds.map(async (modelId) => {
        try {
          const response = await fetch(`${baseURL}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headers
            },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: "user", content: "Say 'OK'" }],
              max_tokens: 10,
              stream: false
            })
          });

          if (response.ok) {
            const data = await response.json() as any;
            return { modelId, success: true, status: response.status };
          } else {
            const error = await response.text();
            return { modelId, success: false, status: response.status, error };
          }
        } catch (e: any) {
          return { modelId, success: false, error: e.message };
        }
      }));

      const failures = results.filter(r => !r.success);
      if (failures.length > 0) {
        console.error("Failures detected:");
        failures.forEach(f => {
          console.error(`- ${f.modelId}: ${f.error || 'Status ' + f.status}`);
        });
      }

      expect(failures.length).toBe(0);
    }, 120000);
  });
});
