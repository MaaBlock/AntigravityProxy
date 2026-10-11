const MODERN_FLASH_TIER = /^gemini-3\.(5|6|7|8)-flash(?:-(?:tiered|low|medium|high))?$/;

export const REQUIRED_CHAT_MODEL = "gemini-3.7-flash-high";
export const GEMINI_38_FLASH_HIGH_MODEL = "gemini-3.8-flash-high";
export const GEMINI_PRO_CHAT_MODEL = "gemini-3.1-pro-high";
export const IMAGE_GENERATION_MODEL = "gemini-3.1-flash-image";

export const CHAT_MODELS = [
  REQUIRED_CHAT_MODEL,
  GEMINI_38_FLASH_HIGH_MODEL,
  GEMINI_PRO_CHAT_MODEL,
];

export const SUPPORTED_MODELS = [
  ...CHAT_MODELS,
  IMAGE_GENERATION_MODEL,
  "imagen-3.0-generate-002",
  "dall-e-3"
];

export function isAllowedImageModel(model: unknown): model is string {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return normalized === IMAGE_GENERATION_MODEL ||
    normalized.includes("image") ||
    normalized.includes("imagen") ||
    normalized === "dall-e-3";
}

export function isAllowedChatModel(model: unknown): model is string {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return CHAT_MODELS.includes(normalized) || isAllowedImageModel(normalized);
}

export function isModernFlashTierModel(model: string): boolean {
  return MODERN_FLASH_TIER.test(model.toLowerCase());
}

export function isSandboxOnlyModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("gpt") ||
    normalized.includes("antigravity-") ||
    normalized.includes("gemini-3.1-pro") ||
    isAllowedImageModel(normalized) ||
    isModernFlashTierModel(normalized);
}

export function shouldPollNextEndpoint(reason: string, attemptedEndpoints: number, endpointCount: number): boolean {
  return reason === "subscription_required" && attemptedEndpoints < endpointCount;
}

export function isSandboxEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).host.endsWith(".sandbox.googleapis.com");
  } catch {
    return false;
  }
}
