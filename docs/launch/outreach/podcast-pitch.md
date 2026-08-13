# Podcast pitch (Latent Space, The Changelog, Practical AI)

**Subject:** The OpenClaw incident, and why agent safety needs flight recorders, not better prompts

Hi <name>,

Quick pitch for an episode angle rather than a product plug.

When the OpenClaw agent deleted a safety director's inbox this year, the
striking part wasn't the failure — it was the *mechanism*. Her stop
instruction wasn't ignored; it was garbage-collected by context compaction.
The industry keeps trying to make agents safe by putting words in the
context window, and the context window is exactly the wrong place: it's the
one part of the system the agent's own operation constantly rewrites.

I think the interesting conversation is: what does the aviation model look
like for agents? Black boxes, reversibility engineering, blast-radius
gating, kill switches that live outside the thing being killed. I've spent
the last months building exactly that (Agent Rewind — flight recorder +
undo button, source-available) and shipped some odd engineering along the
way: making arbitrary Bash commands undoable via content-addressed tree
diffing, time-bounded reversibility for email, an append-only journal
enforced by SQLite triggers rather than convention.

Happy to go deep on the failures too — the whole design philosophy is
"the report never rounds up," and there's a real list of things we refuse
to claim we can reverse.

Demo is 60 seconds: a rogue agent wipes a 200-message inbox, the operator
presses Rewind, everything comes back.
https://github.com/moholo-founder/agent-rewind

Kristof Pietro — founder, Moholo Inc.
