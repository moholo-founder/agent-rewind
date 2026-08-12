import type { EmailStore } from "./store.js";

/**
 * Seed ~200 synthetic inbox messages so a bulk delete (and its Rewind) is
 * visibly dramatic. Deterministic content — no PII, no external data.
 */

const SENDERS = [
  "ana.souza", "ben.okafor", "chen.wei", "diana.novak", "eli.katz",
  "fatima.aziz", "greg.holt", "hana.sato", "ivan.petrov", "julia.marek",
  "kofi.mensah", "lena.berg", "marco.rossi", "nina.szabo", "omar.haddad",
  "priya.iyer", "quinn.doyle", "rosa.vega", "sam.tran", "tara.nolan",
];

const TOPICS = [
  "Quarterly budget review", "Standup notes", "Design feedback needed",
  "Contract renewal", "Team offsite planning", "Bug triage summary",
  "Customer escalation", "Invoice attached", "Roadmap draft",
  "Interview debrief", "Security training reminder", "Release checklist",
  "Vendor comparison", "Onboarding schedule", "Board deck comments",
  "API deprecation notice", "Support rotation", "OKR check-in",
  "Conference talk proposal", "Holiday coverage",
];

export function seedInbox(store: EmailStore, count = 200): number {
  if (store.count("inbox") > 0) return 0;
  const base = Date.now() - count * 3_600_000; // one message per hour, oldest first
  for (let i = 0; i < count; i++) {
    const sender = SENDERS[i % SENDERS.length]!;
    const topic = TOPICS[i % TOPICS.length]!;
    store.insert({
      folder: "inbox",
      from: `${sender}@example.com`,
      to: "agent@agent-rewind.local",
      subject: `${topic} (#${i + 1})`,
      body: [
        `Hi,`,
        ``,
        `This is message ${i + 1} of the seeded inbox regarding "${topic.toLowerCase()}".`,
        `Please review when you have a moment and reply with your thoughts.`,
        ``,
        `Best,`,
        sender.split(".").map((p) => p[0]!.toUpperCase() + p.slice(1)).join(" "),
      ].join("\n"),
      ts: new Date(base + i * 3_600_000).toISOString(),
      deliverAfter: null,
    });
  }
  return count;
}
