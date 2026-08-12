import { describe, expect, it } from "vitest";
import { API_PACKAGE } from "./index.js";

describe("@backstop/api (M0 placeholder)", () => {
  it("exports the package marker", () => {
    expect(API_PACKAGE).toBe("@backstop/api");
  });
});
