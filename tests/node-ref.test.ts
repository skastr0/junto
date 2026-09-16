import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { CanvasSummary } from "../src/shared/ipc";
import {
  formatNodeRef,
  nodeRefKey,
  parseNodeRef,
  type NodeRef,
} from "../src/shared/node-ref";
import {
  resolveNodeRef,
  type CanvasNodeReader,
} from "../src/main/vellum-command/node-ref-resolver";
import { CanvasError } from "../src/main/vellum-command/canvases";

const parsed = (input: string): NodeRef => {
  const result = parseNodeRef(input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const textNode = (id: string, kind?: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ...(kind === undefined ? {} : { ether: { entity: { kind } } }),
});

const reader = (
  docs: Readonly<Record<string, CanvasDoc>>,
  unreadable: ReadonlySet<string> = new Set(),
): CanvasNodeReader => {
  const summaries: ReadonlyArray<CanvasSummary> = Object.keys(docs).map((name) => ({
    name,
    modifiedAt: "2026-07-17T00:00:00.000Z",
  }));
  return {
    list: Effect.succeed(summaries),
    read: (name) => {
      if (unreadable.has(name)) {
        return Effect.fail(new CanvasError({ message: `canvas ${name} is corrupt` }));
      }
      const doc = docs[name];
      return doc === undefined
        ? Effect.fail(new CanvasError({ message: `canvas ${name} does not exist` }))
        : Effect.succeed({
          name,
          doc,
          actorRefs: [],
          revision: `${name}-r1`,
          workRevision: "0",
        });
    },
  };
};

describe("canonical Junto node references", () => {
  it("round-trips simple, Unicode, percent, and dot-only node ids", () => {
    const refs: ReadonlyArray<NodeRef> = [
      { canvasName: "portfolio", nodeId: "page-01K123" },
      { canvasName: "work_2026", nodeId: "résumé 100%" },
      { canvasName: "portfolio", nodeId: "folder/page\\draft" },
      { canvasName: "portfolio", nodeId: "." },
      { canvasName: "portfolio", nodeId: ".." },
    ];

    for (const ref of refs) {
      const uri = formatNodeRef(ref);
      expect(parsed(uri)).toEqual(ref);
      expect(nodeRefKey(ref)).toBe(uri);
    }
    expect(formatNodeRef(refs[1]!)).toContain("r%C3%A9sum%C3%A9%20100%25");
    expect(formatNodeRef(refs[2]!)).toContain("folder%2Fpage%5Cdraft");
    expect(formatNodeRef(refs[3]!)).toBe("vellum-command://canvas/portfolio?node=.");
    expect(formatNodeRef(refs[4]!)).toBe("vellum-command://canvas/portfolio?node=..");
  });

  it.each([
    ["https://canvas/portfolio?node=n1", "scheme"],
    ["VELLUM://canvas/portfolio?node=n1", "scheme"],
    ["vellum-command://evil/portfolio?node=n1", "authority"],
    ["vellum-command://user@canvas/portfolio?node=n1", "authority"],
    ["vellum-command://canvas:443/portfolio?node=n1", "authority"],
    ["vellum-command://canvas/Portfolio?node=n1", "canvas_name"],
    ["vellum-command://canvas/portfolio", "shape"],
    ["vellum-command://canvas/portfolio/?node=n1", "shape"],
    ["vellum-command://canvas/portfolio/node/n1?node=n1", "shape"],
    ["vellum-command://canvas/portfolio?node=n1&open=true", "shape"],
    ["vellum-command://canvas/portfolio?node=n1&node=n2", "shape"],
    ["vellum-command://canvas/portfolio?node=n1#fragment", "shape"],
    ["vellum-command://canvas/portfolio?node=%", "encoding"],
    ["vellum-command://canvas/portfolio?node=a%00b", "node_id"],
    ["vellum-command://canvas/portfolio?node=r%c3%a9sum%c3%a9", "canonical"],
    ["vellum-command://canvas/portfolio?node=%61", "canonical"],
    ["vellum-command://canvas/portfolio?node=a+b", "canonical"],
  ])("rejects noncanonical or unsafe input: %s", (input, code) => {
    const result = parseNodeRef(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("rejects invalid formatter inputs before a URI exists", () => {
    expect(() => formatNodeRef({ canvasName: "../private", nodeId: "n1" })).toThrow();
    expect(() => formatNodeRef({ canvasName: "portfolio", nodeId: "" })).toThrow();
    expect(() => formatNodeRef({ canvasName: "portfolio", nodeId: "\u0000" })).toThrow();
  });
});

describe("Junto node reference resolver", () => {
  it("uses canvas plus node id as identity across collision-prone documents", async () => {
    const canvases = reader({
      alpha: { nodes: [textNode("shared", "page")], edges: [] },
      beta: { nodes: [textNode("shared", "agent")], edges: [] },
    });

    const alpha = await Effect.runPromise(
      resolveNodeRef(canvases, { canvasName: "alpha", nodeId: "shared" }),
    );
    const beta = await Effect.runPromise(
      resolveNodeRef(canvases, { canvasName: "beta", nodeId: "shared" }),
    );
    expect(alpha.key).toBe("vellum-command://canvas/alpha?node=shared");
    expect(beta.key).toBe("vellum-command://canvas/beta?node=shared");
    expect(alpha.key).not.toBe(beta.key);
  });

  it("fails closed for missing, unreadable, duplicate, and kind-mismatched targets", async () => {
    const canvases = reader(
      {
        alpha: { nodes: [textNode("only", "agent")], edges: [] },
        duplicate: { nodes: [textNode("same"), textNode("same")], edges: [] },
        corrupt: { nodes: [], edges: [] },
      },
      new Set(["corrupt"]),
    );

    const cases = [
      resolveNodeRef(canvases, { canvasName: "missing", nodeId: "n1" }),
      resolveNodeRef(canvases, { canvasName: "corrupt", nodeId: "n1" }),
      resolveNodeRef(canvases, { canvasName: "alpha", nodeId: "missing" }),
      resolveNodeRef(canvases, { canvasName: "duplicate", nodeId: "same" }),
      resolveNodeRef(
        canvases,
        { canvasName: "alpha", nodeId: "only" },
        { expectedEntityKind: "page" },
      ),
    ];

    const errors = await Promise.all(cases.map((effect) => Effect.runPromise(Effect.flip(effect))));
    expect(errors.map((error) => error._tag)).toEqual([
      "CanvasNotFound",
      "CanvasReadError",
      "NodeNotFound",
      "DuplicateNodeId",
      "NodeKindMismatch",
    ]);
  });

  it("rejects a programmatically constructed invalid reference", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolveNodeRef(reader({}), { canvasName: "../private", nodeId: "n1" })),
    );
    expect(error._tag).toBe("InvalidNodeRef");
  });
});
