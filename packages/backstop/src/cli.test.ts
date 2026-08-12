import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSandbox } from "./seed.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backstop-pkg-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("backstop package", () => {
  it("seeds the default demo sandbox", () => {
    seedSandbox(tmpDir);
    expect(fs.readdirSync(path.join(tmpDir, "quarterly-reports"))).toHaveLength(40);
  });
});
