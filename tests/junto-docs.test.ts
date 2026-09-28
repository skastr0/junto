import { describe, expect, it } from "vitest";
import {
  buildConceptsDoc,
  buildDoctrineDoc,
  buildDocsTopicList,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
  DOC_TOPICS,
} from "../src/shared/junto-docs";

describe("junto docs catalog", () => {
  it("agent kind doc carries mail and process-bind identity", () => {
    const agent = buildNodeKindDoc("agent")!;
    expect(agent).toContain("msg.list");
    expect(agent).toContain("process-bind");
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
    expect(doc).toContain("### Why edges are permissions");
    expect(doc).toContain("### Why identity is process-bind");
    expect(doc).toContain("### Why the CLI is the tool surface");
    expect(doc).toContain("junto onboard");
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
