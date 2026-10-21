import { describe, expect, it } from "vitest";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildDocsTopicList,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
} from "../src/shared/junto-docs";
import { productNodeKindEnabled } from "../src/shared/features";

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
