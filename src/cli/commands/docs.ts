// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command } from "effect/unstable/cli";
import { Effect } from "effect";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildDocsTopicList,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
  NODE_DOCS,
} from "@shared/junto-docs";
import { OVERSEER_SKILL_MARKDOWN } from "./overseer-skill";
import { overseerOfflineCapabilities } from "./overseer";
import { commandCapabilities } from "../core/discovery";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";

const topicArg = Argument.string("topic").pipe(
  Argument.withDescription("Documentation topic id"),
);

const kindArg = Argument.string("kind").pipe(
  Argument.withDescription(
    `Node kind (${NODE_DOCS.map((doc) => doc.kind).join(", ")})`,
  ),
);

const docsListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "docs list",
    Effect.succeed({
      topics: DOC_TOPICS.map((t) => ({ id: t.id, title: t.title, description: t.description })),
    }),
  ),
).pipe(Command.withDescription("List documentation topics"));

const docsDoctrineCommand = Command.make("doctrine", {}, () =>
  executeJsonCommand(
    "docs doctrine",
    Effect.succeed({ topic: "doctrine", content: buildDoctrineDoc() }),
  ),
).pipe(Command.withDescription("Full doctrine: injected body + expansions"));

const docsNodesCommand = Command.make("nodes", {}, () =>
  executeJsonCommand(
    "docs nodes",
    Effect.succeed({ topic: "nodes", content: buildNodesCatalogDoc() }),
  ),
).pipe(Command.withDescription("Node catalog: role + ports per kind"));

const docsNodeCommand = Command.make(
  "node",
  { kind: kindArg },
  ({ kind }) =>
    executeJsonCommand(
      "docs node",
      Effect.gen(function* () {
        const content = buildNodeKindDoc(kind);
        if (content === undefined) {
          return yield* Effect.fail(
            new InputError({
              message: `unknown node kind ${kind}`,
              path: "kind",
            }),
          );
        }
        return { topic: "node", kind, content };
      }),
    ),
).pipe(Command.withDescription("One node kind in depth: role, ports, data model, events"));

const docsConceptsCommand = Command.make("concepts", {}, () =>
  executeJsonCommand(
    "docs concepts",
    Effect.succeed({ topic: "concepts", content: buildConceptsDoc() }),
  ),
).pipe(Command.withDescription("Concepts: seats, grants, the crew, earned completion, identity"));

const docsOverseerCommand = Command.make("overseer", {}, () =>
  executeJsonCommand(
    "docs overseer",
    Effect.succeed({
      topic: "overseer",
      offline: true,
      daemon_required: false,
      capabilities: overseerOfflineCapabilities(),
      content: OVERSEER_SKILL_MARKDOWN,
    }),
  ),
).pipe(
  Command.withDescription(
    "Overseer authority, workflows, and exact command surface (offline, no daemon)",
  ),
);

const docsContractCommand = Command.make("contract", {}, () =>
  executeJsonCommand(
    "docs contract",
    Effect.succeed({
      topic: "contract",
      content: [
        "# CLI contract — full surface",
        "",
        "| command | category | description |",
        "|---|---|---|",
        ...commandCapabilities.map(
          (c) => `| \`junto ${c.command}\` | ${c.category} | ${c.description} |`,
        ),
      ].join("\n"),
    }),
  ),
).pipe(Command.withDescription("Full command surface"));

const docsShowCommand = Command.make(
  "show",
  { topic: topicArg },
  ({ topic }) =>
    executeJsonCommand(
      "docs show",
      Effect.gen(function* () {
        switch (topic) {
          case "doctrine":
            return { topic, content: buildDoctrineDoc() };
          case "nodes":
            return { topic, content: buildNodesCatalogDoc() };
          case "concepts":
            return { topic, content: buildConceptsDoc() };
          case "overseer":
            return {
              topic,
              offline: true,
              daemon_required: false,
              capabilities: overseerOfflineCapabilities(),
              content: OVERSEER_SKILL_MARKDOWN,
            };
          case "contract":
            return yield* Effect.fail(
              new InputError({
                message: "use `docs contract` for the command surface",
                path: "topic",
              }),
            );
          default:
            return yield* Effect.fail(
              new InputError({
                message: `unknown topic ${topic} — docs list`,
                path: "topic",
              }),
            );
        }
      }),
    ),
).pipe(Command.withDescription("Show one documentation topic"));

export const docsCommand = Command.make("docs").pipe(
  Command.withDescription("Junto documentation — the full doctrine and node catalog"),
  Command.withSubcommands([
    docsListCommand,
    docsDoctrineCommand,
    docsNodesCommand,
    docsNodeCommand,
    docsConceptsCommand,
    docsOverseerCommand,
    docsContractCommand,
    docsShowCommand,
  ]),
);

// Keep buildDocsTopicList referenced for tests/smoke.
void buildDocsTopicList;
