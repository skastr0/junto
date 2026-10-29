/**
 * The phone's artifact and thread walk against `companion-stdio --demo`: no
 * Mac, no app. Writes the transcript (NDJSON) and the step table.
 *
 *   bun scripts/companion-walk-demo.ts <transcript.ndjson>
 */
import { writeFileSync } from "node:fs";
import { Phone, walk } from "../e2e/harness/companion-walk";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: companion-walk-demo.ts <transcript.ndjson>");

const phone = new Phone(["--demo"], process.cwd(), { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("JUNTO_"))) });
const results = await walk(phone, { canvas: "demo", node: "art-notes", seat: "atlas", signalSeat: "sage", hooks: {} });
phone.close();
writeFileSync(out, `${phone.transcript.map((line) => JSON.stringify(line)).join("\n")}\n`);
for (const row of results) console.log(`${row.status.toUpperCase().padEnd(4)} ${row.step}${row.detail === undefined ? "" : `  (${row.detail})`}`);
process.exit(results.some((row) => row.status === "fail") ? 1 : 0);
