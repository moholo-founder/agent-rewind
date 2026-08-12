import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@backstop/web (M0 placeholder)", () => {
  it("exports the App component", () => {
    expect(typeof App).toBe("function");
  });
});
