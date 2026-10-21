import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { asNodeId, type NodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";
import { ItemId } from "../src/shared/work-ids";
import { AgentSignalAttachment, agentSignalAttachmentKind, isResourceAttachment } from "../src/shared/agent-signals";
import { previewRefsOfAttachments } from "../src/shared/preview";
import { admitResourceAttachment, type SignalResources } from "../src/main/junto/signals/attachments";

const node = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({
  id: asNodeId(id),
  kind,
  x,
  y,
  width,
  height,
});

// Region R holds seat S, board T and shelf A; board TX sits outside it, in a sibling region Q.
const canvas: ReachCanvas = {
  nodes: new Map(
    [
      node("R", "region", 0, 0, 500, 500),
      node("S", "agent", 10, 10),
      node("T", "task", 100, 10),
      node("A", "artifacts", 200, 10),
      node("N", "note", 300, 10),
      node("Q", "region", 1000, 0, 500, 500),
      node("TX", "task", 1100, 10),
    ].map((n) => [n.id, n]),
  ),
};

const T = "01M5ESZPWMZZM3TZ88P6FVVK33";
const A = "01M5ESR42S7P9YNR8FEH0TD2QC";
const held = new Set([`task:T:${T}`, `artifact:A:${A}`, `task:TX:${T}`]);
const resources: SignalResources = {
  canvas,
  holds: (kind, nodeId: NodeId, item) => held.has(`${kind}:${nodeId}:${item}`),
};
const seat = asNodeId("S");
const ref = (nodeId: string, item?: string) => `junto://canvas/factory?node=${nodeId}${item ? `&item=${item}` : ""}`;

describe("task and artifact attachments, as main admits them", () => {
  it("admits a task or an artifact in the seat's reach that is on its node now", () => {
    expect(admitResourceAttachment({ kind: "task", ref: ref("T", T), caption: "  stamp   this " }, seat, resources)).toEqual({
      ok: true,
      attachment: { kind: "task", nodeId: "T", taskId: T, caption: "stamp this" },
    });
    expect(admitResourceAttachment({ kind: "artifact", ref: ref("A", A) }, seat, resources)).toEqual({
      ok: true,
      attachment: { kind: "artifact", nodeId: "A", artifactId: A },
    });
  });

  it("refuses, with the reason, anything else", () => {
    const refused = (kind: "task" | "artifact", href: string) => {
      const admitted = admitResourceAttachment({ kind, ref: href }, seat, resources);
      return admitted.ok ? "admitted" : admitted.reason;
    };
    expect(refused("task", ref("T"))).toMatch(/named by its ref/);
    expect(refused("task", "#42")).toMatch(/named by its ref/);
    expect(refused("task", ref("T", "not-a-ulid"))).toMatch(/named by its ref/);
    expect(refused("task", ref("A", A))).toBe("A holds no tasks on this canvas");
    expect(refused("artifact", ref("N", A))).toBe("N holds no artifacts on this canvas");
    expect(refused("task", ref("gone", T))).toBe("gone holds no tasks on this canvas");
    expect(refused("task", ref("TX", T))).toBe("TX is out of this seat's reach");
    expect(refused("task", ref("T", A))).toBe(`no task ${A} on T`);
  });
});

describe("task and artifact attachments on the wire", () => {
  const taskId = Schema.decodeSync(ItemId)(T);
  const task = { kind: "task", nodeId: asNodeId("T"), taskId } as const;

  it("decode closed and are told apart from what is previewed", () => {
    const decode = Schema.decodeUnknownSync(AgentSignalAttachment);
    expect(decode({ kind: "task", nodeId: "T", taskId: T })).toEqual(task);
    expect(() => decode({ kind: "task", nodeId: "T", taskId: "42" })).toThrow();
    expect(() => decode({ kind: "artifact", nodeId: "A" })).toThrow();
    expect(agentSignalAttachmentKind(task)).toBe("task");
    expect(isResourceAttachment(task)).toBe(true);
    expect(isResourceAttachment({ kind: "link", url: "https://example.com/" })).toBe(false);
  });

  it("are never previewed, and the rest keep their place in the signal's list", () => {
    const refs = previewRefsOfAttachments([task, { kind: "link", url: "https://example.com/a.mp4" }]);
    expect(refs.map((r) => [r.path, r.kind])).toEqual([["attachment:1", "link"]]);
  });
});
