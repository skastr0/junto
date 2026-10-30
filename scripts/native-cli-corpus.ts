/**
 * The native CLI's built-in corpus (0.11.6 native CLI, N5): everything
 * `junto` answers with nothing running, exported from the TypeScript that
 * defines it, so the two never drift. native/cli/build.rs runs this at build
 * time with the build's feature defines and embeds the file it writes.
 *
 *   bun $(bun scripts/build-features.ts --bun-define-args) scripts/native-cli-corpus.ts [out.json]
 *
 * Without a path it prints the corpus to stdout. Each answer is kept as the
 * TypeScript command would print it: help text as Console.log writes it (plain
 * and colored), completion scripts per shell, and the `data` of every schema,
 * examples and docs answer, keyed by each target a lookup accepts.
 *
 * `examples` is the raw examples catalog (args and input), which the parity
 * guard runs through both CLIs.
 */
import { writeFileSync } from "node:fs";
import { Console, Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import * as BunServices from "@effect/platform-bun/BunServices";
import { loadRootCommand, rootCommandNames } from "../src/cli/command-runner";
import { CLI_VERSION } from "../src/cli/core/constants";
import { allExamples, allSchemas, commandCapabilities, renderSchemaContract } from "../src/cli/core/discovery";
import { COMMAND_FAMILIES, compileReach, type CommandFamily } from "../src/shared/seat-onboarding";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
  NODE_DOCS,
} from "../src/shared/junto-docs";
import { OVERSEER_SKILL_MARKDOWN } from "../src/cli/commands/overseer-skill";
import { overseerOfflineCapabilities } from "../src/cli/commands/overseer";

const SHELLS = ["bash", "zsh", "fish", "sh"] as const;

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

const root = await loadRootCommand([]);

/** What the TypeScript CLI writes to stdout for these words, as Console.log writes it. */
const printed = (words: ReadonlyArray<string>, colors: boolean): Promise<string> => {
  const lines: string[] = [];
  const capture: Console.Console = Object.assign(Object.create(console), {
    log: (...parts: ReadonlyArray<unknown>) => void lines.push(`${parts.map(String).join(" ")}\n`),
  });
  return Effect.runPromise(
    Command.runWith(root, { version: CLI_VERSION })(words).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(CliOutput.defaultFormatter({ colors })))),
    ),
  ).then(() => lines.join(""));
};

/** Every command path under the root, the root itself as "". */
const paths = (command: Command.Command.Any, prefix: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => [
  prefix,
  ...command.subcommands.flatMap((group) => group.commands.flatMap((sub) => paths(sub, [...prefix, sub.name]))),
];

const help: Record<string, { readonly plain: string; readonly color: string; readonly subcommands: ReadonlyArray<string> }> = {};
const subcommandsOf = (path: ReadonlyArray<string>): ReadonlyArray<string> => {
  let command: Command.Command.Any = root;
  for (const word of path) {
    command = command.subcommands.flatMap((g) => g.commands).find((c) => c.name === word)!;
  }
  return command.subcommands.flatMap((g) => g.commands.map((c) => c.name));
};
for (const path of paths(root, [])) {
  help[path.join(" ")] = {
    plain: await printed([...path, "--help"], false),
    color: await printed([...path, "--help"], true),
    subcommands: subcommandsOf(path),
  };
}

const completions: Record<string, string> = {};
for (const shell of SHELLS) completions[shell] = await printed(["--completions", shell], false);

/** First entry wins a key, as Array.find takes the first match in order. */
const keysOf = (entry: { readonly command_id: string; readonly command: string; readonly schema_id?: string }) =>
  [entry.command_id, entry.command, ...(entry.schema_id === undefined ? [] : [entry.schema_id])];

/** Each answer once, and each key a lookup accepts pointing at its answer. */
const indexed = () => {
  const answers: string[] = [];
  const keys: Record<string, number> = {};
  return {
    answers: answers as ReadonlyArray<string>,
    keys: keys as Readonly<Record<string, number>>,
    add: (key: string, answer: unknown) => {
      if (key in keys) return;
      const text = JSON.stringify(answer);
      const at = answers.indexOf(text);
      keys[key] = at >= 0 ? at : answers.push(text) - 1;
    },
  };
};

const schemaShow = indexed();
for (const schema of allSchemas) {
  const rendered = renderSchemaContract(schema);
  for (const key of keysOf(schema)) schemaShow.add(key, rendered);
}

const examplesShow = indexed();
for (const key of new Set(allExamples.flatMap(keysOf))) {
  const matched = allExamples.filter((entry) => keysOf(entry).includes(key));
  const first = matched[0]!;
  examplesShow.add(key, {
    command_id: first.command_id,
    command: first.command,
    examples: matched.map((example) => ({
      name: example.name,
      ...(example.description ? { description: example.description } : {}),
      ...(example.args ? { args: example.args } : {}),
      ...(example.input !== undefined ? { input: example.input } : {}),
    })),
  });
}

const overseer = {
  topic: "overseer",
  offline: true,
  daemon_required: false,
  capabilities: overseerOfflineCapabilities(),
  content: OVERSEER_SKILL_MARKDOWN,
};

const corpus = {
  version: CLI_VERSION,
  root_commands: rootCommandNames(),
  taught_roots: taughtRoots(),
  help,
  completions,
  schema: {
    list: {
      schemas: allSchemas.map((schema) => ({
        command_id: schema.command_id,
        command: schema.command,
        schema_id: schema.schema_id,
        description: schema.description,
        accepts_batch: schema.accepts_batch ?? false,
      })),
    },
    show: { answers: schemaShow.answers, keys: schemaShow.keys },
  },
  examples_catalog: {
    list: {
      examples: allExamples.map((example) => ({
        command_id: example.command_id,
        command: example.command,
        name: example.name,
        ...(example.description ? { description: example.description } : {}),
      })),
    },
    show: { answers: examplesShow.answers, keys: examplesShow.keys },
  },
  examples: allExamples,
  docs: {
    list: { topics: DOC_TOPICS.map((t) => ({ id: t.id, title: t.title, description: t.description })) },
    doctrine: { topic: "doctrine", content: buildDoctrineDoc() },
    nodes: { topic: "nodes", content: buildNodesCatalogDoc() },
    concepts: { topic: "concepts", content: buildConceptsDoc() },
    overseer,
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
