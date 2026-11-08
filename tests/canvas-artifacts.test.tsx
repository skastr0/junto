// @vitest-environment jsdom
/**
 * One read of a canvas's artifacts for every caller: Quick capture's list, its
 * Move to column, the capture editor and the mention pickers share it, a
 * change re-reads once, and a kept read draws on the next open but is not
 * trusted until its re-read lands.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import type { ArtifactHead, ResourceChanged } from "../src/shared/resource-ipc";
import { artifactsSource, setArtifactsSource, useNodeArtifactCount, useNodeArtifacts, type ArtifactsSource } from "../src/window/lib/artifacts-source";
import { asNodeId } from "../src/shared/physics/schema";
import { useCanvasArtifactHeads, useCanvasArtifacts } from "../src/window/lib/canvas-artifacts";
import { modelStore } from "../src/window/lib/use-model";
import { artifacts } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "capture-canvas";
const head = (id: string, nodeId: string): ArtifactHead =>
  ({ artifact: { artifactId: id, nodeId, title: id, type: "document", labels: [], archived: false, updatedAt: 1, version: 1 }, body: null, bodyRef: null }) as unknown as ArtifactHead;

/** A source whose reads the test answers: each list call waits for `answer`. */
const fakeSource = (base: ArtifactsSource) => {
  const calls: Array<{ readonly nodeId: string; readonly resolve: (heads: ReadonlyArray<ArtifactHead>) => void }> = [];
  const listeners = new Set<(changed: ResourceChanged) => void>();
  const source: ArtifactsSource = {
    ...base,
    list: (_canvas, nodeId) => new Promise((resolve) => calls.push({ nodeId, resolve })),
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    calls,
    /** Answer every waiting read with one head per node, titled `round`. */
    answer: (round: string) => {
      for (const call of calls.splice(0)) call.resolve([head(`${round}-${call.nodeId}`, call.nodeId)]);
    },
    change: () => {
      for (const listener of listeners) listener({ canvasName: CANVAS });
    },
  };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("canvas artifacts, one read for every caller", () => {
  let host: HTMLDivElement;
  let root: Root;
  let release: () => void;
  let fake: ReturnType<typeof fakeSource>;
  const original = artifactsSource();

  beforeEach(() => {
    release = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      wires: [],
      nodes: [artifacts("shelf-1", { z: 0 }), artifacts("shelf-2", { x: 600, z: 1 })],
    });
    fake = fakeSource(original);
    setArtifactsSource(fake.source);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    release();
    setArtifactsSource(original);
  });

  const seen: Record<string, string> = {};
  const List = ({ name }: { readonly name: string }) => {
    const heads = useCanvasArtifacts(CANVAS);
    seen[name] = heads.map((one) => one.artifact.artifactId).join(",");
    return null;
  };
  const Kept = () => {
    const { heads, confirmed } = useCanvasArtifactHeads(CANVAS);
    seen["kept"] = `${heads.map((one) => one.artifact.artifactId).join(",")}|${String(confirmed)}`;
    return null;
  };

  it("serves four callers from one read of each node, and a change from one more", async () => {
    await act(async () => {
      root.render(
        <>
          <List name="a" />
          <List name="b" />
          <List name="c" />
          <Kept />
        </>,
      );
      await flush();
    });
    expect(fake.calls.map((call) => call.nodeId).sort()).toEqual(["shelf-1", "shelf-2"]);
    expect(seen["a"]).toBe("");
    await act(async () => {
      fake.answer("r1");
      await flush();
    });
    expect(seen["a"]).toBe("r1-shelf-1,r1-shelf-2");
    expect(seen["c"]).toBe("r1-shelf-1,r1-shelf-2");
    expect(seen["kept"]).toBe("r1-shelf-1,r1-shelf-2|true");

    // Three changes while one read is out: one read now, one more after it.
    await act(async () => {
      fake.change();
      await flush();
      fake.change();
      fake.change();
      await flush();
    });
    expect(fake.calls).toHaveLength(2);
    // Callers keep the read they had while the re-read is out.
    expect(seen["b"]).toBe("r1-shelf-1,r1-shelf-2");
    await act(async () => {
      fake.answer("r2");
      await flush();
    });
    expect(fake.calls).toHaveLength(2);
    await act(async () => {
      fake.answer("r3");
      await flush();
    });
    expect(fake.calls).toHaveLength(0);
    expect(seen["a"]).toBe("r3-shelf-1,r3-shelf-2");
  });

  it("draws a kept read on the next open, trusts it only once re-read after a change", async () => {
    await act(async () => {
      root.render(<Kept />);
      await flush();
    });
    await act(async () => {
      fake.answer("r1");
      await flush();
    });
    expect(seen["kept"]).toBe("r1-shelf-1,r1-shelf-2|true");

    // Closed: a change lands with nobody reading, so nothing is read.
    await act(async () => {
      root.render(null);
      await flush();
    });
    await act(async () => {
      fake.change();
      await flush();
    });
    expect(fake.calls).toHaveLength(0);

    // Opened again: the kept rows draw at once, unconfirmed, and are re-read.
    await act(async () => {
      root.render(
        <>
          <Kept />
          <List name="fresh" />
        </>,
      );
      await flush();
    });
    expect(seen["kept"]).toBe("r1-shelf-1,r1-shelf-2|false");
    expect(seen["fresh"]).toBe("");
    expect(fake.calls).toHaveLength(2);
    await act(async () => {
      fake.answer("r2");
      await flush();
    });
    expect(seen["kept"]).toBe("r2-shelf-1,r2-shelf-2|true");
    expect(seen["fresh"]).toBe("r2-shelf-1,r2-shelf-2");
  });

  it("trusts a kept read with no change since, and reads nothing on that open", async () => {
    await act(async () => {
      root.render(<Kept />);
      await flush();
    });
    await act(async () => {
      fake.answer("r1");
      await flush();
    });
    await act(async () => {
      root.render(null);
      await flush();
    });
    await act(async () => {
      root.render(<List name="again" />);
      await flush();
    });
    expect(seen["again"]).toBe("r1-shelf-1,r1-shelf-2");
    expect(fake.calls).toHaveLength(0);
  });

  it("serves an Artifacts card, its count and the canvas list from one read per node; the count repaints only when it changes", async () => {
    let countRenders = 0;
    const Card = () => {
      seen["card"] = useNodeArtifacts(CANVAS, asNodeId("shelf-1")).map((one) => one.artifact.artifactId).join(",");
      return null;
    };
    const Count = () => {
      countRenders += 1;
      seen["count"] = String(useNodeArtifactCount(CANVAS, asNodeId("shelf-1"), true));
      return null;
    };
    await act(async () => {
      root.render(
        <>
          <Card />
          <Count />
          <Kept />
        </>,
      );
      await flush();
    });
    expect(fake.calls.map((call) => call.nodeId).sort()).toEqual(["shelf-1", "shelf-2"]);
    await act(async () => {
      fake.answer("r1");
      await flush();
    });
    expect(seen["card"]).toBe("r1-shelf-1");
    expect(seen["count"]).toBe("1");
    expect(seen["kept"]).toBe("r1-shelf-1,r1-shelf-2|true");
    const rendersAfterFirst = countRenders;
    // A change re-reads each node once for all three; the count is still one, so it does not repaint.
    await act(async () => {
      fake.change();
      await flush();
    });
    expect(fake.calls.map((call) => call.nodeId).sort()).toEqual(["shelf-1", "shelf-2"]);
    await act(async () => {
      fake.answer("r2");
      await flush();
    });
    expect(seen["card"]).toBe("r2-shelf-1");
    expect(countRenders).toBe(rendersAfterFirst);
  });
});
