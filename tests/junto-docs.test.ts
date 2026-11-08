import { describe, expect, it } from "vitest";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildDocsTopicList,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
} from "../src/shared/junto-docs";
import { productNodeKindEnabled, TASKS_ENABLED } from "../src/shared/features";
import { SINCE_TASKS_TEACHING } from "../src/shared/junto-doctrine";
import { SINCE_COMMANDS } from "../src/shared/seat-since";

describe("junto docs catalog", () => {
  it("agent kind doc carries mail and seat credential identity", () => {
    const agent = buildNodeKindDoc("agent")!;
    expect(agent).toContain("msg.list");
    expect(agent).toContain("seat credential");
  });

  it.each([
    ["agent", ["agentKey", "bindingId", "harness"]],
    ["task", ["name", "contract"]],
    ["page", ["url", "profile", "onRemove"]],
  ] as const)("%s documents its native authored fields", (kind, fields) => {
    // A kind this build's profile gates off has no docs page at all.
    if (!productNodeKindEnabled(kind)) {
      expect(buildNodeKindDoc(kind)).toBeUndefined();
      return;
    }
    const doc = buildNodeKindDoc(kind)!;
    for (const field of fields) expect(doc).toContain(`\`${field}\``);
    for (const field of ["items", "topics", "unread"]) expect(doc).not.toContain(`- \`${field}\``);
  });

  it("unknown kinds return undefined", () => {
    expect(buildNodeKindDoc("nope")).toBeUndefined();
  });

  it("catalog lists the agent kind", () => {
    const catalog = buildNodesCatalogDoc();
    expect(catalog).toContain("agent");
  });

  it("doctrine doc includes the injected body plus expansions", () => {
    const doc = buildDoctrineDoc();
    expect(doc).toContain("Junto — full doctrine");
    expect(doc).toContain("### Why reach is where you sit");
    expect(doc).toContain("### Why identity is a seat credential");
    expect(doc).toContain("### Why the CLI is the tool surface");
    expect(doc).toContain("junto onboard");
  });

  it("doctrine says reach for resources and edges for seats", () => {
    const doc = buildDoctrineDoc();
    expect(doc).toContain("**Your region is your reach**");
    expect(doc).toContain("**Edges join seats**");
    expect(doc).not.toContain("edges are your permissions");
    expect(doc).not.toContain("Reach** is edges + ports");
    expect(doc).not.toContain("fix edges, not the code");
    expect(doc).toContain("`out_of_reach` or `not_in_reach`");
  });

  it("doctrine teaches junto since, automation reads, signal paging and Stale", () => {
    const doc = buildDoctrineDoc();
    expect(doc).toContain("`junto since`");
    expect(doc).toContain("`junto since --all`");
    expect(doc).toContain("`junto automation list`");
    expect(doc).toContain("only the operator and overseers write them");
    expect(doc).toContain("`junto signal list --since <ISO time or signal id>`");
    expect(doc).toContain("- `Stale` — ");
    expect(doc).not.toContain("·");
  });

  it("doctrine teaches since's task sections in the words their lines read, with the command that lists each", () => {
    const sentence = [
      "`your_tasks`",
      '`Your task #N "Title" is <state> [task #N]`',
      "`... is now <state>, changed since your last session`",
      "`... was sent on to <node> since your last session, and is <state> there`",
      `\`${SINCE_COMMANDS.yourTasks}\` lists them. \`reviews_owed\``,
      "`<assignee>'s task #N \"Title\" is in review and waits on your stamp [task #N]`",
      `\`${SINCE_COMMANDS.reviewsOwed}\` lists them.`,
    ];
    const row = "your tasks, the reviews you owe, unread mail";
    // TASKS_ENABLED is compiled in from the run's feature profile, and a
    // single-file run takes the ship profile with tasks off. The sentence is
    // checked on its own so every profile holds it to the lines and commands.
    for (const text of sentence) expect(SINCE_TASKS_TEACHING).toContain(text);
    expect(SINCE_TASKS_TEACHING).not.toContain("·");
    const doc = buildDoctrineDoc();
    for (const text of [...sentence, row]) {
      if (TASKS_ENABLED) expect(doc).toContain(text);
      else expect(doc).not.toContain(text);
    }
  });

  it("the automations kind page says seats read and do not write", () => {
    const doc = buildNodeKindDoc("automations")!;
    expect(doc).toContain("only the operator and overseers write them");
    expect(doc).not.toContain("No native node schema.");
  });

  it.each(["cron", "relay", "watcher", "timer", "gauge", "pad", "sheet"])("the removed %s kind has no docs page", (kind) => {
    expect(buildNodeKindDoc(kind)).toBeUndefined();
    expect(buildNodesCatalogDoc()).not.toContain(`| ${kind} |`);
  });

  it("the port set lists no port of a removed kind, and points schedulers at Automations", () => {
    expect(buildConceptsDoc()).not.toContain("relay.trigger");
    expect(buildNodeKindDoc("automations")).toContain("in place of the old cron, relay, watcher and timer schedulers");
  });

  it("concepts doc covers seats, grants, ladder", () => {
    const c = buildConceptsDoc();
    expect(c).toContain("## Seats");
    expect(c).toContain("## Grants and ports");
    expect(c).toContain("## The intervention ladder");
  });

  it("topics list matches DOC_TOPICS", () => {
    const list = buildDocsTopicList();
    for (const t of DOC_TOPICS) {
      expect(list).toContain(t.id);
    }
  });
});
