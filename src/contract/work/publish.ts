/**
 * The work socket's contract as JSON Schema, one file per op: what its
 * arguments may be (`payload`) and what its answer is (`success`), from the
 * same Rpcs the core serves and the CLI calls. The native CLI reads these
 * files in its tests (native/cli/src/contract.rs), so a change to an op's
 * arguments fails the Rust gate until its Rust half follows, and a change not
 * republished fails `tests/work-contract-published.test.ts`.
 *
 *   bun src/contract/work/publish.ts    rewrites src/contract/work/published
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { Rpc } from "effect/rpc";
import { DiscoveryRpcs } from "./discovery";
import { MsgRpcs } from "./msg";
import { OverseerRpcs } from "./overseer";
import { SeatRpcs } from "./seat";
import { SkillRpcs } from "./skill";
import { TaskRpcs } from "./task";

/** Every group the work socket serves, as `src/core/work-control/families.ts` merges them. */
export const WORK_RPC_GROUPS = [
  MsgRpcs,
  TaskRpcs,
  SeatRpcs,
  SkillRpcs,
  DiscoveryRpcs,
  OverseerRpcs,
] as const;

export const PUBLISHED_DIR = fileURLToPath(new URL("./published", import.meta.url));

/** The command that rewrites the published files, as a refusal names it. */
export const PUBLISH_COMMAND = "bun src/contract/work/publish.ts";

// The core refuses a field the contract does not name, so the schemas do too.
const document = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });

/** Each op's published file, by name (`<op>.json`), as the contract generates it now. */
export const publishedWorkSchemas = (): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  for (const group of WORK_RPC_GROUPS) {
    for (const [op, rpc] of group.requests as ReadonlyMap<string, Rpc.AnyWithProps>) {
      const published = { op, payload: document(rpc.payloadSchema), success: document(rpc.successSchema) };
      files.set(`${op}.json`, `${JSON.stringify(published, null, 2)}\n`);
    }
  }
  return files;
};

if (import.meta.main) {
  const files = publishedWorkSchemas();
  mkdirSync(PUBLISHED_DIR, { recursive: true });
  // An op that left the contract leaves no file behind.
  for (const name of readdirSync(PUBLISHED_DIR)) {
    if (name.endsWith(".json") && !files.has(name)) rmSync(join(PUBLISHED_DIR, name));
  }
  for (const [name, text] of files) writeFileSync(join(PUBLISHED_DIR, name), text);
  console.log(`published ${files.size} ops to ${PUBLISHED_DIR}`);
}
