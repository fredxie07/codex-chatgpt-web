import { describe, expect, test } from "bun:test";
import { compatibleVersionFor } from "../scripts/prepare-compatible-release";

describe("compatible release versioning", () => {
  test("keeps an update-safe track above the corresponding upstream patch", () => {
    expect(compatibleVersionFor("v6.1.9")).toBe("6.1.1009");
    expect(compatibleVersionFor("6.2.0")).toBe("6.2.1000");
    expect(compatibleVersionFor("v7.0.12")).toBe("7.0.1012");
  });

  test("rejects prereleases and malformed tags", () => {
    expect(() => compatibleVersionFor("v6.2.0-beta.1")).toThrow("stable upstream tag");
    expect(() => compatibleVersionFor("latest")).toThrow("stable upstream tag");
  });
});
