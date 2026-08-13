# The stop button was inside the agent's head (and the agent forgot it)

*Publish on dev.to ~4 days after the Bash article. Tags: ai, llm, safety, architecture*

---

An AI safety director told her agent: "don't act until I tell you to."
Then she watched it start deleting her entire inbox, and couldn't stop it
from her phone. Her words: "I had to RUN to my Mac mini like I was defusing
a bomb."

The post-mortem on that OpenClaw incident is one sentence: **the instruction
lived in the agent's context window, and context compaction garbage-collected
it.** The long-running task filled the context; the summarizer kept the
operational state and dropped the safety constraint. The agent didn't
disobey — it forgot, structurally, the way a program "forgets" a variable
that went out of scope.

## In-context constraints are best-effort by construction

Everything in a context window competes for survival: against compaction,
against distraction, against thousands of tokens of tool output. A system
prompt is a strong prior, not a mechanism. If your only stop button is a
sentence the model read earlier, you don't have a stop button — you have a
request.

Platform engineers already know this shape: you don't enforce cluster policy
from inside the pod. The enforcement point must live outside the workload it
governs.

## What "outside" means concretely

In [Agent Rewind](https://github.com/moholo-founder/agent-rewind), the kill
switch is a row in SQLite, on disk, owned by the proxy that sits between the
agent and its tools:

- When an operator hits STOP, every subsequent side-effecting tool call is
  refused at the boundary and journaled as `blocked-by-stop`. Reads pass.
- The flag survives agent restarts, context compaction, model swaps, and
  any amount of "creative reasoning" — the agent's cognition simply cannot
  reach it.
- Only an explicit human RESUME clears it. Approving a held action while
  stopped is also refused: resume first, decide second.

The same boundary carries the rest of the safety model: an append-only
journal (intent recorded *before* execution), pre-action snapshots so undo
is real, and blast-radius holds so "delete 200 things" waits for a human
even when "delete 2 things" doesn't.

## The reframe that matters

The boundary also fixes a miscalibration in how we fear agents. A read of
10,000 files *feels* dangerous and is harmless — we pass reads through
untouched, zero friction. One `delete_many` on an inbox feels like a small
tool call and is the catastrophe. Gate on blast radius and reversibility,
not on vibes, and you can afford the agent *more* autonomy, not less —
because most of what it does is now recorded, held when oversized, and
reversible when it isn't.

Repo + 60-second demo: https://github.com/moholo-founder/agent-rewind
