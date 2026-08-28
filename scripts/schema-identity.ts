#!/usr/bin/env bun
/**
 * Recompute the head state-schema identity and rewrite the constant in
 * migrations.ts when it drifted.
 *
 * This kills the hand-computed-hash step of a schema change: append the
 * migration, run `bun run schema:identity`, done. The compute needs
 * node:sqlite (absent in bun), so it executes inside the repo's vitest
 * runtime via a transient tool file — no new dependency, same resolution
 * as every test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "src/main/vellum/state/migrations.ts");

const out = mkdtempSync(join(tmpdir(), "vellum-schema-identity-"));
const resultPath = join(out, "identity.json");
const toolTest = join(ROOT, "tests", "schema-identity-writer.tool.test.ts");

writeFileSync(
  toolTest,
  `import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { STATE_SCHEMA_SQL } from "../src/main/vellum/state/schema";
import {
  CURRENT_STATE_SCHEMA_VERSION,
} from "../src/main/vellum/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/vellum/state/schema-identity";
it("computes the head schema identity", () => {
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
    version: CURRENT_STATE_SCHEMA_VERSION,
    sha: expectedStateSchemaIdentity(STATE_SCHEMA_SQL).actualSchemaSha256,
  }));
});
`,
);

let computed: { readonly version: number; readonly sha: string };
try {
  const run = spawnSync("bunx", ["vitest", "run", toolTest], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VELLUM_COMMAND_TEST_FEATURE_PROFILE: "all-on" },
  });
  if (run.status !== 0) {
    console.error(String(run.stdout));
    console.error(String(run.stderr));
    console.error("schema:identity — compute run failed");
    process.exit(1);
  }
  computed = JSON.parse(readFileSync(resultPath, "utf8")) as typeof computed;
} finally {
  rmSync(toolTest, { force: true });
  rmSync(out, { recursive: true, force: true });
}

const source = readFileSync(MIGRATIONS, "utf8");
const headConstName = `STATE_SCHEMA_V${computed.version}_IDENTITY`;
const headConst = new RegExp(
  `(export const ${headConstName} = \\{\\n  actualSchemaSha256:\\n    ")([0-9a-f]{64})(")`,
  "u",
);
const match = source.match(headConst);
if (match === null) {
  console.error(
    `schema:identity — ${headConstName} not found in migrations.ts; ` +
      "declare the head identity constant (any 64-hex placeholder) first",
  );
  process.exit(1);
}
if (match[2] === computed.sha) {
  console.log(
    `schema:identity — clean (v${computed.version} = ${computed.sha})`,
  );
  process.exit(0);
}
writeFileSync(MIGRATIONS, source.replace(headConst, `$1${computed.sha}$3`));
console.log(
  `schema:identity — rewrote ${headConstName}\n  was ${match[2]}\n  now ${computed.sha}`,
);
