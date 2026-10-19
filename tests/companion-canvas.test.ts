/**
 * The phone's canvas is a whitelist: only kind, rectangle, paint order, title
 * and colour cross per node, and no title made from a field that never
 * crosses. A region's environment, instruction and contract, and a seat's
 * agent key, host, binding and launch, appear nowhere in what is sent.
 */
import { describe, expect, it } from "vitest";
import { companionCanvasDrawn } from "../src/shared/companion-canvas";
import { CompanionCanvasScene } from "../src/shared/companion-protocol";
import { asCanvasName, asNodeId, asWireId, canvasFromOpened, type Node } from "../src/shared/model";
import { Result, Schema } from "effect";

const SECRETS = [
  "op://vault/item", "/Users/someone/secret", "keychain-svc", "Brief: never tell", "contract-text", "local:planner-key",
  "mini.tailnet", "binding-xyz", "--dangerous-flag", "sk-live-123", "tok_abc123", "pw-in-url",
];

const canvas = canvasFromOpened({
  canvas: asCanvasName("main"),
  seq: 0,
  nodes: [
    {
      id: asNodeId("r1"), kind: "region", label: "Backend", color: "4", x: 0, y: 0, width: 800, height: 600, z: 0, hold: false,
      instruction: "Brief: never tell",
      environment: { variables: { TOKEN: "op://vault/item", HOME_DIR: "/Users/someone/secret" }, keychain: ["keychain-svc"] },
      contract: { instructions: "contract-text" },
    } as unknown as Node,
    {
      id: asNodeId("a1"), kind: "agent", x: 40, y: 100, width: 240, height: 96, z: 1,
      agentKey: "local:planner-key", host: "mini.tailnet", bindingId: "binding-xyz", overseer: false, harness: "claude",
      launch: { args: ["--dangerous-flag"] },
    } as unknown as Node,
    {
      id: asNodeId("a2"), kind: "agent", label: "Atlas", x: 400, y: 100, width: 240, height: 96, z: 2,
      agentKey: "local:planner-key", host: "mini.tailnet", bindingId: "binding-xyz", overseer: false, harness: "claude",
    } as unknown as Node,
    { id: asNodeId("t1"), kind: "task", x: 0, y: 700, width: 200, height: 100, z: 3, contract: { instructions: "Deploy with key sk-live-123. Then report." } } as unknown as Node,
    { id: asNodeId("f1"), kind: "file", path: "/Users/someone/secret-dir/", x: 300, y: 700, width: 200, height: 100, z: 4 } as unknown as Node,
    { id: asNodeId("f2"), kind: "file", path: "/tmp/notes/plan.md", x: 600, y: 700, width: 200, height: 100, z: 5 } as unknown as Node,
    { id: asNodeId("l1"), kind: "link", url: "tok_abc123@example.com/path", x: 900, y: 700, width: 200, height: 100, z: 6 } as unknown as Node,
    { id: asNodeId("l2"), kind: "link", url: "https://user:pw-in-url@example.org/a", x: 1200, y: 700, width: 200, height: 100, z: 7 } as unknown as Node,
    { id: asNodeId("n1"), kind: "note", text: `${"😀".repeat(300)}\nsecond line`, x: 1500, y: 700, width: 200, height: 100, z: 8 } as unknown as Node,
  ],
  wires: [{ id: asWireId("w1"), from: asNodeId("a1"), to: asNodeId("a2"), verb: "messages" }],
});

describe("companion canvas projection", () => {
  it("carries only the whitelisted fields", () => {
    const drawn = companionCanvasDrawn(canvas);
    const text = JSON.stringify(drawn);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    for (const node of drawn.nodes) {
      expect(Object.keys(node).every((key) => ["nodeId", "kind", "frame", "z", "label", "color"].includes(key))).toBe(true);
    }
    expect(drawn.nodes.find((node) => node.nodeId === "a1")).not.toHaveProperty("label");
    expect(drawn.nodes.find((node) => node.nodeId === "a2")?.label).toBe("Atlas");
    expect(drawn.nodes.find((node) => node.nodeId === "r1")).toMatchObject({ label: "Backend", color: "4" });
    const label = (nodeId: string) => drawn.nodes.find((node) => node.nodeId === nodeId)?.label;
    expect(label("t1")).toBeUndefined();
    expect(label("f1")).toBe("secret-dir");
    expect(label("f2")).toBe("plan.md");
    expect(label("l1")).toBeUndefined();
    expect(label("l2")).toBe("example.org");
  });

  it("cuts a long label whole characters at a time", () => {
    const note = companionCanvasDrawn(canvas).nodes.find((node) => node.nodeId === "n1")!;
    expect(note.label!.length).toBeLessThanOrEqual(256);
    expect(note.label!.endsWith("😀…")).toBe(true);
    expect(note.label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("routes each wire to waypoints the protocol accepts", () => {
    const drawn = companionCanvasDrawn(canvas);
    expect(drawn.wires).toHaveLength(1);
    const wire = drawn.wires[0]!;
    expect(wire).toMatchObject({ wireId: "w1", from: "a1", to: "a2", radius: 8 });
    // Seats are drawn at 216x56 whatever their stored 240x96, and wires meet the drawn card.
    expect(drawn.nodes.find((node) => node.nodeId === "a1")?.frame).toEqual({ x: 40, y: 100, width: 216, height: 56 });
    expect(wire.path[0]).toEqual({ x: 256, y: 128 });
    expect(wire.path.at(-1)).toEqual({ x: 400, y: 128 });
    expect(Result.isSuccess(Schema.decodeUnknownResult(CompanionCanvasScene)({ seq: 1, ...drawn }))).toBe(true);
  });

  it("leaves out a wire whose end is not drawn", () => {
    const orphan = { ...canvas, wires: new Map([[asWireId("w2"), { id: asWireId("w2"), from: asNodeId("a1"), to: asNodeId("gone"), verb: "messages" as const }]]) };
    expect(companionCanvasDrawn(orphan).wires).toEqual([]);
  });
});
