import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSandbox } from "./seed-files.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-demo-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("demo seed", () => {
  it("creates a 40-file quarterly-reports folder (trips the 25-file hold)", () => {
    seedSandbox(tmpDir);
    const reports = fs.readdirSync(path.join(tmpDir, "quarterly-reports"));
    expect(reports).toHaveLength(40);
    expect(fs.existsSync(path.join(tmpDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "notes/meeting-notes.md"))).toBe(true);
  });
});
