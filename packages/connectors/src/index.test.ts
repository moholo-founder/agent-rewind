import { describe, expect, it } from "vitest";
import { CONNECTORS_PACKAGE } from "./index.js";

describe("@backstop/connectors (M0 placeholder)", () => {
  it("exports the package marker", () => {
    expect(CONNECTORS_PACKAGE).toBe("@backstop/connectors");
  });
});
