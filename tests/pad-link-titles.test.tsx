// @vitest-environment jsdom
/**
 * A pad's artifact links read their words where the artifact is now
 * (pad-link-titles.tsx): the title now, and a link written before its
 * artifact moved found by id where its last move took it (0.11.1, 10).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactLink } from "../src/shared/artifact-link";
import { asCanvasName, asNodeId } from "../src/shared/model";
import type { Pad } from "../src/shared/pad";
import type { PadLinkTitleOf } from "../src/shared/pad-project";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import { ItemId } from "../src/shared/work-ids";
import { usePadLinkTitles } from "../src/renderer/components/pad/pad-link-titles";
import { artifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { artifacts } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "factory";
const HOME = asNodeId("artifacts-home");
const RELEASE = asNodeId("artifacts-release");
const PLAN = ItemId.make("01M5ZC0000000000000000000B");
const link = artifactLink({ kind: "artifact", nodeId: HOME, artifactId: PLAN }, "Launch plan", CANVAS);
const pad = { shapes: [{ id: "s1", type: "rect", text: `see ${link}` }], edges: [] } as unknown as Pad;
const target = { nodeId: HOME, item: PLAN };
const head = (title: string) => ({ artifact: { artifactId: PLAN, title, type: "document", archived: false } }) as unknown as ArtifactHead;

describe("a pad's artifact links", () => {
  let host: HTMLDivElement;
  let root: Root;
  let titleOf: PadLinkTitleOf | undefined;
  const original = artifactsSource();
  const Probe = () => {
    titleOf = usePadLinkTitles(CANVAS, pad);
    return null;
  };
  const seed = (...ids: ReadonlyArray<string>) =>
    act(() => modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: ids.map((id) => artifacts(id)) }));
  const source = (held: Record<string, ReadonlyArray<ArtifactHead>>, to?: string) =>
    setArtifactsSource({
      ...original,
      list: async (_canvas: string, nodeId: string) => held[nodeId] ?? [],
      moves: async () => (to === undefined ? [] : [{ from: HOME, to, by: { kind: "operator" }, at: 1 }]),
      onChanged: () => () => undefined,
    } as unknown as ArtifactsSource);
  const draw = async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };

  beforeEach(() => {
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    setArtifactsSource(original);
  });

  it("say the title now where the link's node holds it", async () => {
    seed(HOME);
    source({ [HOME]: [head("Launch plan, final")] });
    await draw();
    expect(titleOf!(target, "[[Launch plan]]")).toBe("Launch plan, final");
  });

  it("find an artifact that moved, by id, where it is now", async () => {
    seed(HOME, RELEASE);
    source({ [RELEASE]: [head("Launch plan, moved")] }, RELEASE);
    await draw();
    expect(titleOf!(target, "[[Launch plan]]")).toBe("Launch plan, moved");
  });

  it("follow a move once the link's node is gone, and are missing when it never moved", async () => {
    seed(RELEASE);
    source({ [RELEASE]: [head("Launch plan, moved")] }, RELEASE);
    await draw();
    expect(titleOf!(target, "[[Launch plan]]")).toBe("Launch plan, moved");
    seed(HOME);
    source({});
    await draw();
    expect(titleOf!(target, "[[Launch plan]]")).toBe("Missing artifact");
  });
});
