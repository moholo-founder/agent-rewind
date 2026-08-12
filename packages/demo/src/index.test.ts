import { describe, expect, it } from "vitest";
import { DEMO_PACKAGE } from "./index.js";

describe("@backstop/demo (M0 placeholder)", () => {
  it("exports the package marker", () => {
    expect(DEMO_PACKAGE).toBe("@backstop/demo");
  });
});
