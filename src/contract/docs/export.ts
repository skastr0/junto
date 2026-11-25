/**
 * The docs `junto docs` answers with nothing running, as this build's
 * feature defines write them, printed as JSON for publish.ts: the topic list,
 * the doctrine, the node catalog, the concepts, each node kind's page, and
 * every root command onboard can teach.
 *
 *   bun <feature defines> src/contract/docs/export.ts
 */
import { COMMAND_FAMILIES, compileConnectionInstructions, compileReach, type CommandFamily } from "../../shared/seat-onboarding";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
  NODE_DOCS,
} from "../../shared/junto-docs";

/**
 * The intents onboard teaches of a family in this build: a resource family's
 * by its kind in reach, an edge family's over an edge holding every port. A
 * port or kind this build left out teaches nothing.
 */
const taughtIntents = (family: CommandFamily): ReadonlySet<string> => {
  const spec = COMMAND_FAMILIES[family];
  const sections =
    spec.reach === undefined
      ? compileConnectionInstructions([{ id: "<node>", ports: [...new Set(spec.rows.flatMap((row) => (row.port === undefined ? [] : [row.port])))] }])
      : compileReach([{ id: "<node>", kind: spec.reach }]);
  return new Set(sections.flatMap((section) => Object.keys(section.commands)));
};

/** Every root command onboard can teach in this build, from the rows it teaches. */
const taughtRoots = (): ReadonlyArray<string> => {
  const roots = new Set<string>();
  for (const family of Object.keys(COMMAND_FAMILIES) as CommandFamily[]) {
    const intents = taughtIntents(family);
    for (const row of COMMAND_FAMILIES[family].rows.filter((candidate) => intents.has(candidate.intent))) {
      for (const [, root] of `${row.command("<node>")} ${row.detail ?? ""}`.matchAll(/junto ([a-z][a-z-]*)/g)) roots.add(root!);
    }
  }
  return [...roots].sort();
};

export interface ExportedDocs {
  readonly topics: ReadonlyArray<{ readonly id: string; readonly title: string; readonly description: string }>;
  readonly doctrine: string;
  readonly nodes: string;
  readonly concepts: string;
  readonly node: Readonly<Record<string, string>>;
  readonly taughtRoots: ReadonlyArray<string>;
}

const exported: ExportedDocs = {
  topics: DOC_TOPICS.map((topic) => ({ id: topic.id, title: topic.title, description: topic.description })),
  doctrine: buildDoctrineDoc(),
  nodes: buildNodesCatalogDoc(),
  concepts: buildConceptsDoc(),
  node: Object.fromEntries(
    NODE_DOCS.flatMap((doc) => {
      const content = buildNodeKindDoc(doc.kind);
      return content === undefined ? [] : [[doc.kind, content]];
    }),
  ),
  taughtRoots: taughtRoots(),
};

process.stdout.write(`${JSON.stringify(exported)}\n`);
