# How we made arbitrary Bash commands (mostly) undoable

*Publish on dev.to, cross-post to Hashnode. Tags: ai, node, devops, opensource*

---

"You can't undo a shell command" is one of those statements that's true
enough to stop most people from trying. An AI agent runs `sed -i` across
your config files, or a `make clean` that was greedier than expected, and
the conventional wisdom says: hope you committed recently.

We ship a flight recorder for AI agents ([Agent
Rewind](https://github.com/moholo-founder/agent-rewind)), and "the agent ran
a shell command" was the biggest hole in our undo story. Here's how we
closed most of it — and exactly where the hole still is, because the honest
boundary is the interesting part.

## Don't parse the command. Snapshot the world.

Our first instinct was to parse commands and predict their targets. This
dies immediately: pipes, subshells, `$VARS`, `xargs`, scripts calling
scripts. You cannot statically know what a shell command will touch.

So we stopped trying to predict and started measuring:

1. **Before** the command runs (Claude Code's `PreToolUse` hook), walk the
   project tree and record a manifest: every file's path → content hash.
2. **After** it completes (`PostToolUse`), walk again and diff.
3. The diff — files modified, created, deleted — is attached to the
   journal entry as the command's *effect set*.
4. **Undo** restores modified and deleted files from their snapshots and
   removes created ones. Byte-identical, path-contained to the project root.

## "Isn't that insanely expensive?"

It would be, done naively. Two tricks make it milliseconds:

**Content-addressed storage.** Every file snapshot is stored under its
sha256. Identical content is stored exactly once, ever. A tree that doesn't
change between commands costs zero new storage.

**An mtime+size cache.** The walk from the previous command remembers each
file's `(mtimeMs, size, hash)`. If both match, we reuse the hash without
reading the file. After the first walk, only files that actually changed get
re-read and re-hashed.

Plus guardrails: `node_modules`-style directories are excluded, files over
5MB are skipped, and a tree over 20k files skips capture entirely — each
skip is recorded in the journal, because a snapshot you *think* you have is
worse than one you know you don't.

## The crash case is where it gets interesting

What if the command runs but the post-hook never fires (crash, kill,
user denial)? We have a pre-command manifest but no diff. The tempting move
is to restore everything that differs from the manifest.

We refuse. Files that changed *after* the command — by the user, by another
process — are indistinguishable from the command's effects. Restoring
blindly could destroy newer work. So undo for that entry reports:

> "A pre-command tree snapshot exists but the command's completion was never
> observed, so its exact file effects are unknown. Not restoring blindly."

## What stays honestly impossible

Processes started. Network calls made. Writes outside the project root.
A `curl -X POST` has no inverse, and pretending otherwise is how you get
operators who trust an undo button right up until it betrays them. Every
undo result carries its scope: *"restored 3 files, removed 1 created file
(file effects only — processes/network are not reversible)."*

The design rule across the whole product: **the report never rounds up.**
`Fully restored` is only ever printed when it is literally true.

## Try it

```bash
npx -y agent-rewind          # MCP proxy mode
# or, for native Claude Code sessions:
agent-rewind hooks install && agent-rewind ui
```

Source (BUSL, free for individuals/small teams, Apache-2.0 in 4 years):
https://github.com/moholo-founder/agent-rewind
