import { expect, test, describe } from "bun:test";
import { getFamilyName, shouldForceSingleAccountProbe } from "../../src/auth/manager";

describe("Manager Utils", () => {
  test("getFamilyName should correctly classify models", () => {
    expect(getFamilyName("gemini-1.5-flash")).toBe("Gemini 3 Flash");
    expect(getFamilyName("gemini-1.5-pro")).toBe("Gemini 3 Pro");
    expect(getFamilyName("claude-3-5-sonnet")).toBe("Claude/GPT");
    expect(getFamilyName("gpt-4o")).toBe("Claude/GPT");
    expect(getFamilyName("gemini-2.5-flash")).toBe("Gemini 2.5");
    expect(getFamilyName("unknown-model")).toBe("Other");
  });

  test("forces an upstream probe when rescue mode has only one usable account", () => {
    expect(shouldForceSingleAccountProbe(1, false)).toBe(true);
    expect(shouldForceSingleAccountProbe(1, true)).toBe(false);
    expect(shouldForceSingleAccountProbe(2, false)).toBe(false);
    expect(shouldForceSingleAccountProbe(0, false)).toBe(false);
  });
});
