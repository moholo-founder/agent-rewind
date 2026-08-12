import { describe, expect, it } from "vitest";
import { classifyPlaceholder, PROXY_PACKAGE } from "./index.js";

describe("@backstop/proxy (M0 placeholder)", () => {
  it("exports the package marker", () => {
    expect(PROXY_PACKAGE).toBe("@backstop/proxy");
  });

  it("defaults unknown classification (safety-by-default)", () => {
    expect(classifyPlaceholder()).toBe("unknown");
  });
});
