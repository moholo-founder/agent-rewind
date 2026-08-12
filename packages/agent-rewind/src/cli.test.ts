import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedDemoSandbox } from "@agentrewind/connectors";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-pkg-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agent-rewind package", () => {
  it("seeds the default demo sandbox", () => {
    seedDemoSandbox(tmpDir);
    expect(fs.readdirSync(path.join(tmpDir, "quarterly-reports"))).toHaveLength(40);
  });
});
