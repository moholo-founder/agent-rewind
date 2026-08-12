import { describe, expect, it } from "vitest";
import { CORE_PACKAGE } from "./index.js";

describe("@backstop/core (M0 placeholder)", () => {
  it("exports the package marker", () => {
    expect(CORE_PACKAGE).toBe("@backstop/core");
  });
});
