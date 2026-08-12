/**
 * @backstop/demo — seed data + scripted "rogue agent".
 *
 * M0 stub. M6 makes this boot the full stack and drive the money-shot demo:
 * the agent bulk-deletes a 200-message inbox and a seeded folder; the
 * operator clicks Rewind and watches everything come back.
 */

export const DEMO_PACKAGE = "@backstop/demo";

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  console.log("Backstop demo: scaffold only (M0). Full demo arrives in M6.");
}
