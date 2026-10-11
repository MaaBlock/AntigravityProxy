import { describe, expect, test } from "bun:test";
import { parseGoogleError } from "../../src/utils/errors";

describe("Google error parsing", () => {
  test("keeps a location restriction distinct from an unavailable model", () => {
    const result = parseGoogleError(JSON.stringify({
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "User location is not supported for the API use.",
      },
    }));

    expect(result.reason).toBe("location_unsupported");
    expect(result.isLocationRestricted).toBe(true);
    expect(result.isModelUnsupported).toBe(false);
  });

  test("parses array-wrapped Google errors", () => {
    const parsed = parseGoogleError(JSON.stringify([{
      error: {
        code: 404,
        status: "NOT_FOUND",
        message: "Requested entity was not found.",
      },
    }]));

    expect(parsed.reason).toBe("model_not_found");
    expect(parsed.isModelUnsupported).toBe(true);
    expect(parsed.status).toBe(404);
  });

  test("extracts retry time from an array-wrapped quota error", () => {
    const parsed = parseGoogleError(JSON.stringify([{
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You have exhausted your capacity on this model. Your quota will reset after 41s.",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
        }],
      },
    }]));

    expect(parsed.reason).toBe("quota_exhausted");
    expect(parsed.retryAfterSeconds).toBe(41);
  });
});
