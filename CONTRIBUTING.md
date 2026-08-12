# Contributing to Agent Rewind

Thanks for considering a contribution!

## Contributor License Agreement (CLA)

Agent Rewind is owned by Moholo Inc. and dual-licensed (BUSL-1.1 now,
Apache-2.0 after each version's Change Date, plus commercial licenses). For
that model to work, Moholo must be able to license contributions under all of
those terms.

By submitting a pull request or patch you agree that:

1. You wrote the contribution yourself (or have the right to submit it), and
2. You grant Moholo Inc. a perpetual, worldwide, irrevocable, royalty-free
   license to use, modify, sublicense, and relicense your contribution as
   part of the Licensed Work, including under the Business Source License,
   the Change License, and Moholo's commercial licenses.

If you can't agree to that (for example, your employer owns your work),
please sort that out before submitting.

## Practical notes

- Node 22.5+, pnpm 9+. `pnpm install && pnpm -r build && pnpm -r test`.
- Every compensator change needs a do→undo→assert-original round-trip test.
- The journal is append-only and the redaction rule (no secrets in the
  journal) is non-negotiable — see README architecture rules.
- Honest failure beats silent success everywhere in this codebase.
