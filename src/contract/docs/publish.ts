/**
 * The docs `junto docs` answers, published for the native CLI to embed: one
 * directory per combination of the features the docs depend on (tasks,
 * artifacts, browser, authority), named by the ones on, or `none`. Each holds
 * topics.json, doctrine.md, nodes.md, concepts.md, node/<kind>.md and
 * taught-roots.json. native/cli/build.rs embeds the directory its build's
 * features name.
 *
 * Docs that come to depend on another feature the native CLI gates (vault,
 * code steps, the machine build), or on one it does not, fail the check: the
 * combinations here would no longer say what such a build says.
 *
 *   bun src/contract/docs/publish.ts           rewrites src/contract/docs/published
 *   bun src/contract/docs/publish.ts --check   writes nothing; exits 1 naming each file that is not current
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportedDocs } from "./export";

const root = fileURLToPath(new URL("../../..", import.meta.url));
export const PUBLISHED_DOCS_DIR = fileURLToPath(new URL("./published", import.meta.url));
const PUBLISH_COMMAND = "bun src/contract/docs/publish.ts";

/** The features the docs depend on, in the order a directory names them, by their define. */
const GATES = [
  ["tasks", "__JUNTO_TASKS_ENABLED__"],
  ["artifacts", "__JUNTO_ARTIFACTS_ENABLED__"],
  ["browser", "__JUNTO_BROWSER_ENABLED__"],
  ["authority", "__JUNTO_AUTHORITY_ENABLED__"],
] as const;

/** Features the native CLI gates that the docs must not depend on. */
const INDEPENDENT = ["__JUNTO_VAULT_ENABLED__", "__JUNTO_CODE_STEPS_ENABLED__", "__JUNTO_MACHINE_BUILD__"] as const;

type Defines = ReadonlyMap<string, string>;

const profileDefines = (profile: "ship" | "all-on"): Defines => {
  const run = spawnSync("bun", ["scripts/build-features.ts", "--bun-define-args"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, JUNTO_FEATURE_PROFILE: profile, JUNTO_ALLOW_FEATURE_OVERRIDES: undefined },
  });
  if (run.status !== 0) throw new Error(`build-features ${profile}: ${run.stderr}`);
  return new Map(
    run.stdout.split("\n").flatMap((line) => {
      const match = /^--define=([^=]+)=(.*)$/.exec(line.trim());
      return match === null ? [] : [[match[1]!, match[2]!] as const];
    }),
  );
};

const exportDocs = (defines: Defines): Promise<ExportedDocs> =>
  new Promise((resolve, reject) => {
    const args = [...[...defines].map(([key, value]) => `--define=${key}=${value}`), "src/contract/docs/export.ts"];
    const child = spawn("bun", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as ExportedDocs) : reject(new Error(`docs export: ${err}`))));
  });

const withGates = (base: Defines, on: ReadonlySet<string>): Defines =>
  new Map([...base, ...GATES.map(([name, define]) => [define, String(on.has(name))] as const)]);

/** Every combination of the gates, each as the set of those on. */
const combinations = (): ReadonlyArray<ReadonlySet<string>> =>
  Array.from({ length: 1 << GATES.length }, (_, bits) => new Set(GATES.filter((_, at) => bits & (1 << at)).map(([name]) => name)));

const directoryOf = (on: ReadonlySet<string>): string =>
  GATES.filter(([name]) => on.has(name)).map(([name]) => name).join("-") || "none";

const filesOf = (docs: ExportedDocs): ReadonlyArray<readonly [string, string]> => [
  ["topics.json", `${JSON.stringify(docs.topics, null, 2)}\n`],
  ["doctrine.md", docs.doctrine],
  ["nodes.md", docs.nodes],
  ["concepts.md", docs.concepts],
  ...Object.entries(docs.node).map(([kind, content]) => [`node/${kind}.md`, content] as const),
  ["taught-roots.json", `${JSON.stringify(docs.taughtRoots, null, 2)}\n`],
];

/** Each published file, by its path under the published directory, as the docs generate it now. */
export const publishedDocs = async (): Promise<{ files: ReadonlyMap<string, string>; faults: ReadonlyArray<string> }> => {
  const ship = profileDefines("ship");
  const allOn = profileDefines("all-on");
  const sets = combinations();
  const [variants, shipDocs, allOnDocs, ...independent] = await Promise.all([
    Promise.all(sets.map((on) => exportDocs(withGates(ship, on)))),
    exportDocs(ship),
    exportDocs(allOn),
    ...INDEPENDENT.map((define) => exportDocs(new Map([...ship, [define, String(ship.get(define) !== "true")]]))),
  ]);
  const files = new Map<string, string>();
  sets.forEach((on, at) => {
    for (const [name, text] of filesOf(variants[at]!)) files.set(`${directoryOf(on)}/${name}`, text);
  });
  const same = (a: ExportedDocs, b: ExportedDocs) => JSON.stringify(a) === JSON.stringify(b);
  const variantOf = (defines: Defines) =>
    variants[sets.findIndex((on) => GATES.every(([name, define]) => on.has(name) === (defines.get(define) === "true")))]!;
  const faults: string[] = [];
  INDEPENDENT.forEach((define, at) => {
    if (!same(independent[at]!, shipDocs)) faults.push(`the docs depend on ${define}, which publish.ts does not vary`);
  });
  if (!same(variantOf(ship), shipDocs)) faults.push("the ship profile's docs depend on a feature publish.ts does not vary");
  if (!same(variantOf(allOn), allOnDocs)) faults.push("the all-on profile's docs depend on a feature publish.ts does not vary");
  return { files, faults };
};

const onDisk = (): ReadonlyArray<string> =>
  existsSync(PUBLISHED_DOCS_DIR) ? readdirSync(PUBLISHED_DOCS_DIR, { recursive: true, encoding: "utf8" }).filter((name) => /\.(md|json)$/.test(name)) : [];

if (import.meta.main) {
  const { files, faults } = await publishedDocs();
  if (faults.length > 0) {
    for (const fault of faults) console.error(fault);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    const stale: string[] = [];
    for (const [name, text] of files) {
      const path = join(PUBLISHED_DOCS_DIR, name);
      if (!existsSync(path)) stale.push(`${name}: missing`);
      else if (readFileSync(path, "utf8") !== text) stale.push(`${name}: stale`);
    }
    for (const name of onDisk()) if (!files.has(name)) stale.push(`${name}: the docs no longer have it`);
    if (stale.length > 0) {
      for (const fault of stale.sort()) console.error(`src/contract/docs/published/${fault}`);
      console.error(`the published docs are not what the docs generate: run ${PUBLISH_COMMAND}`);
      process.exit(1);
    }
    console.log("the published docs are current");
  } else {
    for (const name of onDisk()) if (!files.has(name)) rmSync(join(PUBLISHED_DOCS_DIR, name));
    for (const [name, text] of files) {
      mkdirSync(dirname(join(PUBLISHED_DOCS_DIR, name)), { recursive: true });
      writeFileSync(join(PUBLISHED_DOCS_DIR, name), text);
    }
    console.log(`published ${files.size} files to ${PUBLISHED_DOCS_DIR}`);
  }
}
