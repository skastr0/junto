/**
 * The work socket's contract as JSON Schema, one file per op: what its
 * arguments may be (`payload`) and what its answer is (`success`), from the
 * same Rpcs the core serves and the CLI calls. The `overseer` op carries one
 * of many operations, each with its own `args`: those are published one file
 * per operation under overseer/, from the registry the core dispatches with,
 * and the native CLI embeds them for `junto schema show`. The native CLI reads these
 * files in its tests (native/cli/src/contract.rs), so a change to an op's
 * arguments fails the Rust gate until its Rust half follows, and a change not
 * republished fails `tests/work-contract-published.test.ts`.
 *
 *   bun src/contract/work/publish.ts           rewrites src/contract/work/published
 *   bun src/contract/work/publish.ts --check   writes nothing; exits 1 naming each file that is not what the contract generates
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { ThreadRpcs } from "./thread";
import { OverseerArgsSchemas } from "../../shared/overseer-control";

/** Every group the work socket serves, as `src/core/work-control/families.ts` merges them. */
export const WORK_RPC_GROUPS = [
  MsgRpcs,
  TaskRpcs,
  SeatRpcs,
  SkillRpcs,
  DiscoveryRpcs,
  OverseerRpcs,
  ThreadRpcs,
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
  for (const [operation, schema] of Object.entries(OverseerArgsSchemas)) {
    const published = { operation, args: document(schema) };
    files.set(`overseer/${operation}.json`, `${JSON.stringify(published, null, 2)}\n`);
  }
  return files;
};

/** Every published file on disk, by its name under the published directory. */
export const publishedOnDisk = (): ReadonlyArray<string> =>
  existsSync(PUBLISHED_DIR)
    ? readdirSync(PUBLISHED_DIR, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".json"))
    : [];

/**
 * Each published file that is not what the contract generates now, with why:
 * missing, stale (its text differs), or left over from an op the contract no
 * longer has. Empty when the published files are current. Reads only.
 */
export const stalePublishedWorkSchemas = (): ReadonlyArray<string> => {
  const files = publishedWorkSchemas();
  const onDisk = publishedOnDisk();
  const faults: string[] = [];
  for (const [name, text] of files) {
    const path = join(PUBLISHED_DIR, name);
    if (!existsSync(path)) faults.push(`${name}: missing`);
    else if (readFileSync(path, "utf8") !== text) faults.push(`${name}: stale`);
  }
  for (const name of onDisk) if (!files.has(name)) faults.push(`${name}: no op of the contract has it`);
  return faults.sort();
};

if (import.meta.main && process.argv.includes("--check")) {
  const faults = stalePublishedWorkSchemas();
  if (faults.length > 0) {
    for (const fault of faults) console.error(`src/contract/work/published/${fault}`);
    console.error(`the published work schemas are not what the contract generates: run ${PUBLISH_COMMAND}`);
    process.exit(1);
  }
  console.log("the published work schemas are current");
} else if (import.meta.main) {
  const files = publishedWorkSchemas();
  mkdirSync(join(PUBLISHED_DIR, "overseer"), { recursive: true });
  // An op that left the contract leaves no file behind.
  for (const name of publishedOnDisk()) if (!files.has(name)) rmSync(join(PUBLISHED_DIR, name));
  for (const [name, text] of files) writeFileSync(join(PUBLISHED_DIR, name), text);
  console.log(`published ${files.size} ops to ${PUBLISHED_DIR}`);
}
