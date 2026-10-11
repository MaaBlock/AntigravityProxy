export interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      "@type": string;
      reason?: string;
      domain?: string;
      metadata?: Record<string, string>;
      errorInfo?: {
        reason: string;
      };
      validation_url?: string;
      retryDelay?: string;
    }>;
  };
}

export function parseGoogleError(body: string): { 
  reason: string; 
  validationUrl?: string;
  isQuotaExhausted: boolean;
  isChallengeRequired: boolean;
  isLocationRestricted: boolean;
  isModelUnsupported: boolean;
  status: number;
  message?: string;
  retryAfterSeconds: number;
} {
  let reason = "unknown_error";
  let validationUrl: string | undefined;
  let isQuotaExhausted = false;
  let isChallengeRequired = false;
  let isLocationRestricted = false;
  let isModelUnsupported = false;
  let status = 500;
  let message: string | undefined;
  let retryAfterSeconds = 0;

  try {
    const decoded: GoogleApiError | GoogleApiError[] = JSON.parse(body);
    const json: GoogleApiError = Array.isArray(decoded) ? (decoded[0] || {}) : decoded;
    const err = json.error;
    
    if (err) {
      message = err.message;
      const resetMatch = err.message?.match(/reset after\s+([0-9.]+)s/i);
      if (resetMatch) retryAfterSeconds = Number.parseFloat(resetMatch[1]);
      if (err.status === "RESOURCE_EXHAUSTED" || err.message?.includes("quota")) {
        isQuotaExhausted = true;
        reason = "quota_exhausted";
        status = 429;
      }

      if (err.status === "INVALID_ARGUMENT") {
        reason = "invalid_argument";
        status = 400;
      }

      if (err.message?.includes("VALIDATION_REQUIRED")) {
        isChallengeRequired = true;
        reason = "validation_required";
        status = 403;
      }

      if (err.message?.includes("Gemini Code Assist license") || err.message?.includes("SUBSCRIPTION_REQUIRED")) {
        isChallengeRequired = true;
        reason = "subscription_required";
        status = 403;
      }

      // "User location is not supported for the API use" is a route/egress
      // restriction, not evidence that the requested model does not exist.
      // The latter used to disable otherwise healthy models in the account
      // cache and made the OpenAI client show a misleading unknown_error.
      if (err.status === "FAILED_PRECONDITION" && /location is not supported/i.test(err.message || "")) {
        isLocationRestricted = true;
        reason = "location_unsupported";
        status = 400;
      }

      if (err.status === "NOT_FOUND" || err.message?.includes("Requested entity was not found.")) {
        isModelUnsupported = true;
        reason = "model_not_found";
        status = 404;
      }

      if (err.details) {
        for (const detail of err.details) {
          const resetDelay = detail.metadata?.quotaResetDelay || detail.retryDelay;
          if (resetDelay) {
            const parsedDelay = Number.parseFloat(resetDelay);
            if (Number.isFinite(parsedDelay)) retryAfterSeconds = parsedDelay;
          }

          if (detail.reason === "VALIDATION_REQUIRED" || detail.errorInfo?.reason === "VALIDATION_REQUIRED") {
            isChallengeRequired = true;
            reason = "validation_required";
            status = 403;
            if (detail.validation_url) validationUrl = detail.validation_url;
            if (detail.metadata?.validation_url) validationUrl = detail.metadata.validation_url;
          }
          
          if (detail.reason === "RATE_LIMIT_EXCEEDED") {
            isQuotaExhausted = true;
            reason = "quota_exhausted";
            status = 429;
          }

          if (detail.reason === "SUBSCRIPTION_REQUIRED" || detail.errorInfo?.reason === "SUBSCRIPTION_REQUIRED") {
            isChallengeRequired = true;
            reason = "subscription_required";
            status = 403;
          }
        }
      }
    }
  } catch (e) {
    if (body.includes("automated queries")) {
      isQuotaExhausted = true;
      reason = "quota_exhausted";
      status = 429;
    }
  }

  return { reason, validationUrl, isQuotaExhausted, isChallengeRequired, isLocationRestricted, isModelUnsupported, status, message, retryAfterSeconds };
}
