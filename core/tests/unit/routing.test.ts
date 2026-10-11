import { describe, expect, test } from "bun:test";
import { isAllowedChatModel, isModernFlashTierModel, isSandboxEndpoint, isSandboxOnlyModel, shouldPollNextEndpoint, REQUIRED_CHAT_MODEL } from "../../src/utils/routing";

describe("model pool routing", () => {
  test("keeps modern Gemini Flash tiers out of the CLI pool", () => {
    expect(isModernFlashTierModel("gemini-3.7-flash-high")).toBe(true);
    expect(isSandboxOnlyModel("gemini-3.7-flash-high")).toBe(true);
    expect(isModernFlashTierModel("gemini-3.8-flash-high")).toBe(true);
    expect(isSandboxOnlyModel("gemini-3.8-flash-high")).toBe(true);
    expect(isSandboxOnlyModel("gemini-3.1-pro-high")).toBe(true);
    expect(isSandboxOnlyModel("gemini-3.6-flash-tiered")).toBe(true);
  });

  test("does not lock ordinary CLI-compatible Gemini models to Sandbox", () => {
    expect(isSandboxOnlyModel("gemini-2.5-flash")).toBe(false);
    expect(isSandboxOnlyModel("gemini-3-pro-preview")).toBe(false);
  });

  test("only accepts configured chat and image generation models", () => {
    expect(isAllowedChatModel(REQUIRED_CHAT_MODEL)).toBe(true);
    expect(isAllowedChatModel("GEMINI-3.7-FLASH-HIGH")).toBe(true);
    expect(isAllowedChatModel("gemini-3.8-flash-high")).toBe(true);
    expect(isAllowedChatModel("gemini-3.1-pro-high")).toBe(true);
    expect(isAllowedChatModel("gemini-3.1-flash-image")).toBe(true);
    expect(isAllowedChatModel("imagen-3.0-generate-002")).toBe(true);
    expect(isAllowedChatModel("dall-e-3")).toBe(true);
    expect(isAllowedChatModel("gemini-2.5-flash")).toBe(false);
    expect(isAllowedChatModel("gemini-3.7-flash")).toBe(false);
    expect(isAllowedChatModel(undefined)).toBe(false);
  });

  test("polls every compatible endpoint before accepting subscription_required", () => {
    expect(shouldPollNextEndpoint("subscription_required", 1, 3)).toBe(true);
    expect(shouldPollNextEndpoint("subscription_required", 2, 3)).toBe(true);
    expect(shouldPollNextEndpoint("subscription_required", 3, 3)).toBe(false);
    expect(shouldPollNextEndpoint("quota_exhausted", 1, 3)).toBe(false);
  });

  test("only treats actual sandbox hosts as sandbox endpoints", () => {
    expect(isSandboxEndpoint("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent")).toBe(true);
    expect(isSandboxEndpoint("https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent")).toBe(true);
    expect(isSandboxEndpoint("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent")).toBe(false);
    expect(isSandboxEndpoint("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent")).toBe(false);
  });
});
