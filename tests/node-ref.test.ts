import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  formatNodeRef,
  nodeRefKey,
  parseNodeRef,
  type NodeRef,
} from "../src/shared/node-ref";
import {
  resolveNodeRef,
  type ModelNodeReader,
} from "../src/main/junto/node-ref-resolver";
import { ModelStorageError } from "../src/main/junto/model/records";
import { asCanvasName, type Node } from "../src/shared/model";
import { canvasOf, page, seat } from "./support/model-nodes";

const parsed = (input: string): NodeRef => {
  const result = parseNodeRef(input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const reader = (
  held: Readonly<Record<string, ReadonlyArray<Node>>>,
  unreadable: ReadonlySet<string> = new Set(),
): ModelNodeReader => {
  return {
    listCanvases: () => Effect.succeed(Object.keys(held).map(asCanvasName)),
    canvas: (name) => unreadable.has(name) || held[name] === undefined
      ? Effect.fail(new ModelStorageError({ cause: `canvas ${name} cannot be read` }))
      : Effect.succeed(canvasOf(held[name], [], name)),
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
    expect(formatNodeRef(refs[3]!)).toBe("junto://canvas/portfolio?node=.");
    expect(formatNodeRef(refs[4]!)).toBe("junto://canvas/portfolio?node=..");
  });

  it.each([
    ["https://canvas/portfolio?node=n1", "scheme"],
    ["JUNTO://canvas/portfolio?node=n1", "scheme"],
    ["junto://evil/portfolio?node=n1", "authority"],
    ["junto://user@canvas/portfolio?node=n1", "authority"],
    ["junto://canvas:443/portfolio?node=n1", "authority"],
    ["junto://canvas/Portfolio?node=n1", "canvas_name"],
    ["junto://canvas/portfolio", "shape"],
    ["junto://canvas/portfolio/?node=n1", "shape"],
    ["junto://canvas/portfolio/node/n1?node=n1", "shape"],
    ["junto://canvas/portfolio?node=n1&open=true", "shape"],
    ["junto://canvas/portfolio?node=n1&node=n2", "shape"],
    ["junto://canvas/portfolio?node=n1#fragment", "shape"],
    ["junto://canvas/portfolio?node=%", "encoding"],
    ["junto://canvas/portfolio?node=a%00b", "node_id"],
    ["junto://canvas/portfolio?node=r%c3%a9sum%c3%a9", "canonical"],
    ["junto://canvas/portfolio?node=%61", "canonical"],
    ["junto://canvas/portfolio?node=a+b", "canonical"],
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
      alpha: [page("shared")],
      beta: [seat("shared")],
    });

    const alpha = await Effect.runPromise(
      resolveNodeRef(canvases, { canvasName: "alpha", nodeId: "shared" }),
    );
    const beta = await Effect.runPromise(
      resolveNodeRef(canvases, { canvasName: "beta", nodeId: "shared" }),
    );
    expect(alpha.key).toBe("junto://canvas/alpha?node=shared");
    expect(beta.key).toBe("junto://canvas/beta?node=shared");
    expect(alpha.key).not.toBe(beta.key);
  });

  it("fails closed for missing, unreadable, and kind-mismatched targets", async () => {
    const canvases = reader(
      {
        alpha: [seat("only")],
        corrupt: [],
      },
      new Set(["corrupt"]),
    );

    const cases = [
      resolveNodeRef(canvases, { canvasName: "missing", nodeId: "n1" }),
      resolveNodeRef(canvases, { canvasName: "corrupt", nodeId: "n1" }),
      resolveNodeRef(canvases, { canvasName: "alpha", nodeId: "missing" }),
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
