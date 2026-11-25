/**
 * The native CLI's built-in corpus (0.11.6 native CLI, N5): the docs `junto`
 * answers with nothing running, exported from the TypeScript that defines
 * them, so the two never drift. native/cli/build.rs runs this at build time
 * with the build's feature defines and embeds the file it writes. Help,
 * completions, schemas and examples are the native CLI's own
 * (native/cli/corpus).
 *
 *   bun $(bun scripts/build-features.ts --bun-define-args) scripts/native-cli-corpus.ts [out.json]
 *
 * Without a path it prints the corpus to stdout. Each answer is kept as the
 * TypeScript command would print it: the `data` of every docs answer.
 */
import { writeFileSync } from "node:fs";
import { CLI_VERSION } from "../src/cli/core/constants";
import { commandCapabilities } from "../src/cli/core/discovery";
import { COMMAND_FAMILIES, compileReach, type CommandFamily } from "../src/shared/seat-onboarding";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
  NODE_DOCS,
} from "../src/shared/junto-docs";

/**
 * Every root command onboard can teach in this build (a family gated off
 * teaches none): the native binary must register each one.
 */
const taughtRoots = (): ReadonlyArray<string> => {
  const roots = new Set<string>();
  for (const family of Object.keys(COMMAND_FAMILIES) as CommandFamily[]) {
    const spec = COMMAND_FAMILIES[family];
    if (spec.reach !== undefined && compileReach([{ id: "<node>", kind: spec.reach }]).length === 0) continue;
    for (const row of spec.rows) {
      for (const [, root] of `${row.command("<node>")} ${row.detail ?? ""}`.matchAll(/junto ([a-z][a-z-]*)/g)) roots.add(root!);
    }
  }
  return [...roots].sort();
};

const corpus = {
  version: CLI_VERSION,
  taught_roots: taughtRoots(),
  docs: {
    list: { topics: DOC_TOPICS.map((t) => ({ id: t.id, title: t.title, description: t.description })) },
    doctrine: { topic: "doctrine", content: buildDoctrineDoc() },
    nodes: { topic: "nodes", content: buildNodesCatalogDoc() },
    concepts: { topic: "concepts", content: buildConceptsDoc() },
    contract: {
      topic: "contract",
      content: [
        "# CLI contract — full surface",
        "",
        "| command | category | description |",
        "|---|---|---|",
        ...commandCapabilities.map((c) => `| \`junto ${c.command}\` | ${c.category} | ${c.description} |`),
      ].join("\n"),
    },
    node: Object.fromEntries(
      NODE_DOCS.flatMap((doc) => {
        const content = buildNodeKindDoc(doc.kind);
        return content === undefined ? [] : [[doc.kind, { topic: "node", kind: doc.kind, content }]];
      }),
    ),
  },
};

const out = process.argv[2];
const text = JSON.stringify(corpus);
if (out === undefined) process.stdout.write(`${text}\n`);
else writeFileSync(out, text);
