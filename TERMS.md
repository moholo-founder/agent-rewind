# Agent Rewind — Terms of Use

> **Template notice:** these terms are a starting point drafted without legal
> counsel. Have a lawyer review before relying on them commercially.

**Effective date:** August 12, 2026 · **Provider:** Moholo Inc. ("Moholo",
"we", "us")

## 1. What Agent Rewind is

Agent Rewind is software that sits between AI agents and their tools as an
interception proxy: it journals agent actions, captures state snapshots,
gates risky operations, and offers undo/rewind controls. It runs entirely on
your own machine or infrastructure.

## 2. License, ownership

The software is © 2026 Moholo Inc. and licensed under the Business Source
License 1.1 (LICENSE.md). Production use beyond the Additional Use Grant
requires a commercial license (COMMERCIAL-LICENSE.md). Using the software
means you accept these terms and the applicable license.

"Agent Rewind" and associated logos are trademarks of Moholo Inc. The
license grants no trademark rights.

## 3. Your data

Agent Rewind stores everything locally: the action journal, snapshots, and
configuration live on disk under your control (by default `~/.agent-rewind`
or a project directory). The software sends **no telemetry** and makes no
network connections except those your agents' connectors make on your
instruction. You are responsible for securing the machine it runs on and for
the contents of your journal and snapshots, which may include copies of data
your agents touched.

## 4. Safety tool, not a guarantee

Agent Rewind is a harm-reduction layer. Reversibility depends on connector
compensators, capture timing, and the state of external systems; some actions
are honestly reported as not reversible (for example, an email after its
recall window). **Do not rely on Agent Rewind as your only safeguard against
data loss.** Keep independent backups. Where the software cannot restore
something, it is designed to say so rather than pretend — but no software is
free of defects.

## 5. Acceptable use

You may not use Agent Rewind to violate law, to interfere with systems you
are not authorized to access, or to remove or falsify audit records. You may
not misrepresent modified copies as official Moholo releases.

## 6. Warranty disclaimer and liability

THE SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. TO THE
MAXIMUM EXTENT PERMITTED BY LAW, MOHOLO INC. IS NOT LIABLE FOR ANY INDIRECT,
INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES — INCLUDING LOST
DATA, LOST PROFITS, OR ACTIONS TAKEN BY AI AGENTS WHETHER OR NOT PROXIED
THROUGH THE SOFTWARE — ARISING FROM ITS USE. MOHOLO'S TOTAL LIABILITY IS
LIMITED TO THE GREATER OF US $100 OR THE AMOUNTS YOU PAID MOHOLO FOR THE
SOFTWARE IN THE TWELVE MONTHS PRECEDING THE CLAIM.

## 7. Changes

We may update these terms; material changes will be noted in the repository
changelog. Continued use after a change constitutes acceptance.

## 8. Contact

Moholo Inc. · founders@moholo.co
