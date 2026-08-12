import fs from "node:fs";
import path from "node:path";

/**
 * Sandbox guard for the filesystem connector.
 *
 * Every path the connector touches must resolve inside the configured root.
 * Two layers of defense:
 *   1. Lexical containment: reject absolute paths and `..` traversal after
 *      normalization.
 *   2. Physical containment: realpath the deepest existing ancestor of the
 *      target and verify it is still inside the (realpath'd) root, so a
 *      symlink inside the sandbox cannot smuggle operations outside it.
 */
export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

export class Sandbox {
  /** Physical (symlink-resolved) root. */
  readonly root: string;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
  }

  /**
   * Resolve a sandbox-relative path to an absolute path, or throw
   * SandboxViolation. Accepts only relative paths.
   */
  resolve(relative: string): string {
    if (typeof relative !== "string" || relative.length === 0) {
      throw new SandboxViolation("Path must be a non-empty string");
    }
    if (path.isAbsolute(relative)) {
      throw new SandboxViolation(
        `Absolute paths are not allowed; paths are relative to the sandbox root (got ${relative})`,
      );
    }
    const resolved = path.resolve(this.root, relative);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new SandboxViolation(
        `Path escapes the sandbox root: ${relative}`,
      );
    }

    // Physical check: walk up to the deepest lstat-existing ancestor.
    // lstat (not exists/stat) is load-bearing: existsSync FOLLOWS symlinks
    // and reports false for a dangling link, which would skip the link
    // entirely and let a later write land wherever the link points.
    let probe = resolved;
    for (;;) {
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(probe);
      } catch {
        /* does not exist at this level */
      }
      if (st) {
        if (st.isSymbolicLink()) {
          // A symlink on the path must physically resolve inside the root;
          // a dangling link has no realpath and is refused outright.
          let physical: string;
          try {
            physical = fs.realpathSync(probe);
          } catch {
            throw new SandboxViolation(
              `Path traverses a dangling symlink: ${relative}`,
            );
          }
          if (physical !== this.root && !physical.startsWith(this.root + path.sep)) {
            throw new SandboxViolation(
              `Path resolves outside the sandbox via symlink: ${relative}`,
            );
          }
        }
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const physical = fs.realpathSync(probe);
    if (physical !== this.root && !physical.startsWith(this.root + path.sep)) {
      throw new SandboxViolation(
        `Path resolves outside the sandbox via symlink: ${relative}`,
      );
    }
    return resolved;
  }

  /** Convert an absolute path inside the sandbox back to a relative one. */
  relative(absolute: string): string {
    return path.relative(this.root, absolute);
  }
}
