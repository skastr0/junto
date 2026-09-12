import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArtifactsCard,
  BoardCard,
} from "../src/renderer/components/work/WorkSurfaces";
import type { TextNode } from "../src/shared/canvas";
import { mirrorBoardText } from "../src/shared/task";

const textNode = (over: Partial<TextNode> = {}): TextNode => ({
  id: "n1",
  type: "text",
  text: "- alpha",
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  ether: { entity: { kind: "board" }, board: { topics: [] } },
  ...over,
});

describe("ArtifactsCard", () => {
  it("renders the empty-state line when no artifacts are visible", () => {
    const html = renderToStaticMarkup(
      <ArtifactsCard
        node={textNode({
          ether: {
            entity: { kind: "artifacts" },
            artifacts: { items: [] },
          },
        })}
      />,
    );
    expect(html).toContain('data-testid="artifacts-card"');
    expect(html).toContain('class="factory-glance__empty text-[9px]"');
    expect(html).toContain("quiet");
  });

  it("renders rows instead of the empty state when artifacts exist", () => {
    const html = renderToStaticMarkup(
      <ArtifactsCard
        node={textNode({
          ether: {
            entity: { kind: "artifacts" },
            artifacts: {
              items: [
                {
                  artifactId: "art-1",
                  name: "release receipt",
                  parts: [{ kind: "text", text: "sha256:abc" }],
                },
              ],
            },
          },
        })}
      />,
    );
    expect(html).toContain("release receipt");
    expect(html).not.toContain("factory-glance__empty");
  });

  it("ignores archived artifacts for both rows and the empty state", () => {
    const html = renderToStaticMarkup(
      <ArtifactsCard
        node={textNode({
          ether: {
            entity: { kind: "artifacts" },
            artifacts: {
              items: [
                {
                  artifactId: "art-1",
                  name: "stale",
                  parts: [{ kind: "text", text: "x" }],
                  metadata: { archived: true },
                },
              ],
            },
          },
        })}
      />,
    );
    expect(html).toContain("quiet");
    expect(html).not.toContain("stale");
  });
});

describe("BoardCard", () => {
  it("titles the card by kind, never the mirror's dash lines", () => {
    const html = renderToStaticMarkup(
      <BoardCard
        node={textNode({
          text: mirrorBoardText([
            { title: "alpha" },
            { title: "beta" },
          ]),
          ether: {
            entity: { kind: "board" },
            board: {
              topics: [
                {
                  topicId: "t1",
                  title: "alpha",
                  state: "open",
                  postCount: 2,
                  lastActivityAt: "2026-09-12T00:00:00.000Z",
                },
              ],
            },
          },
        })}
      />,
    );
    // The work-plane mirror ("- alpha\n- beta") must not leak into the title.
    expect(html).toContain(">board</div>");
    expect(html).not.toContain("- alpha");
    // The glance rows still list the topics.
    expect(html).toContain("alpha");
  });

  it("keeps the kind title when the board is empty", () => {
    const html = renderToStaticMarkup(
      <BoardCard node={textNode({ text: "board" })} />,
    );
    expect(html).toContain(">board</div>");
    expect(html).toContain("quiet");
  });
});
