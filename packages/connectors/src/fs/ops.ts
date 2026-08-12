import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "./sandbox.js";

/**
 * The actual filesystem operations, shared by the downstream MCP server
 * (which executes agent calls) and by tests. All paths are sandbox-relative
 * and validated by the Sandbox guard.
 */

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  bytes: number | null;
}

export function readFile(sandbox: Sandbox, relPath: string): string {
  return fs.readFileSync(sandbox.resolve(relPath), "utf8");
}

export function listDir(sandbox: Sandbox, relPath: string): DirEntry[] {
  const abs = sandbox.resolve(relPath);
  return fs.readdirSync(abs, { withFileTypes: true }).map((d) => {
    const type = d.isSymbolicLink()
      ? "symlink"
      : d.isDirectory()
        ? "dir"
        : d.isFile()
          ? "file"
          : "other";
    let bytes: number | null = null;
    if (type === "file") {
      bytes = fs.statSync(path.join(abs, d.name)).size;
    }
    return { name: d.name, type, bytes };
  });
}

export function writeFile(sandbox: Sandbox, relPath: string, content: string): void {
  const abs = sandbox.resolve(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

export function move(sandbox: Sandbox, src: string, dest: string): void {
  const absSrc = sandbox.resolve(src);
  const absDest = sandbox.resolve(dest);
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  fs.renameSync(absSrc, absDest);
}

export function deleteFile(sandbox: Sandbox, relPath: string): void {
  const abs = sandbox.resolve(relPath);
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    throw new Error(`${relPath} is a directory; use delete_dir`);
  }
  fs.unlinkSync(abs);
}

export function deleteDir(sandbox: Sandbox, relPath: string): void {
  const abs = sandbox.resolve(relPath);
  if (!fs.lstatSync(abs).isDirectory()) {
    throw new Error(`${relPath} is not a directory; use delete_file`);
  }
  fs.rmSync(abs, { recursive: true });
}

/** Count files under a path (recursive); 1 for a plain file. */
export function countFiles(sandbox: Sandbox, relPath: string): number {
  const abs = sandbox.resolve(relPath);
  if (!fs.existsSync(abs)) return 0;
  const st = fs.lstatSync(abs);
  if (!st.isDirectory()) return 1;
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(p);
      else count += 1;
    }
  };
  walk(abs);
  return count;
}
