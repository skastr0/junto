import { describe, expect, it } from "vitest";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildDocsTopicList,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
  NODE_DOCS,
  PORT_DESCRIPTIONS,
} from "../src/shared/vellum-docs";
import { ALL_PORTS } from "../src/shared/physics/schema";
import { KindSpecs } from "../src/shared/physics/kinds";

describe("vellum docs catalog", () => {
  it("covers every well-known kind with role + offers", () => {
    const kinds = Object.keys(KindSpecs);
    expect(NODE_DOCS.length).toBe(kinds.length);
    for (const doc of NODE_DOCS) {
      expect(kinds).toContain(doc.kind);
      expect(["actor", "sink", "scheduler", "geography"]).toContain(doc.role);
      expect(doc.offers.every((p) => ALL_PORTS.includes(p as (typeof ALL_PORTS)[number]))).toBe(true);
    }
  });

  it("describes every port exactly once", () => {
    for (const p of ALL_PORTS) {
      expect(PORT_DESCRIPTIONS[p]).toBeTruthy();
      expect(PORT_DESCRIPTIONS[p]).toMatch(/\S/);
    }
  });

  it("node kind docs carry ports, data model, events, and contract", () => {
    const task = buildNodeKindDoc("task")!;
    expect(task).toContain("tasks.list");
    expect(task).toContain("## Data model");
    expect(task).toContain("items");
    expect(task).toContain("## Events");
    expect(task).toContain("### Edge contract — tasks");
    expect(task).toContain("vellum-command tasks list");

    const requests = buildNodeKindDoc("requests")!;
    expect(requests).toContain("request.escalate");
    expect(requests).toContain("vellum-command escalate");

    const agent = buildNodeKindDoc("agent")!;
    expect(agent).toContain("msg.list");
    expect(agent).toContain("process-bind");
  });

  it("unknown kinds return undefined", () => {
    expect(buildNodeKindDoc("nope")).toBeUndefined();
  });

  it("catalog lists all kinds with their offers", () => {
    const catalog = buildNodesCatalogDoc();
    expect(catalog).toContain("task");
    expect(catalog).toContain("requests");
    expect(catalog).toContain("artifacts");
    expect(catalog).toContain("board");
    expect(catalog).toContain("agent");
    expect(catalog).toContain("tasks.list");
  });

  it("doctrine doc includes the injected body plus expansions", () => {
    const doc = buildDoctrineDoc();
    expect(doc).toContain("Vellum Command — full doctrine");
    expect(doc).toContain("### Why edges are permissions");
    expect(doc).toContain("### Why completion is earned");
    expect(doc).toContain("### Why identity is process-bind");
    expect(doc).toContain("### Why the CLI is the tool surface");
    expect(doc).toContain("vellum-command onboard");
  });

  it("concepts doc covers seats, grants, earned completion, ladder", () => {
    const c = buildConceptsDoc();
    expect(c).toContain("## Seats");
    expect(c).toContain("## Grants and ports");
    expect(c).toContain("## Earned completion");
    expect(c).toContain("## The intervention ladder");
  });

  it("topics list matches DOC_TOPICS", () => {
    const list = buildDocsTopicList();
    for (const t of DOC_TOPICS) {
      expect(list).toContain(t.id);
    }
  });
});
