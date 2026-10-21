import { describe, expect, it } from "vitest";
import type { NodeKind } from "../src/shared/model/kinds";
import type { NodeId } from "../src/shared/physics/schema";
import { mentionChipParts } from "../src/renderer/lib/mention-open";

const ITEM = "01M5ESSJRFWT6RVS5HMWMGJXGD";
const KINDS: Record<string, NodeKind> = { s: "agent", t: "task", a: "artifacts", p: "page" };
const kindOf = (id: NodeId): NodeKind | undefined => KINDS[id];
const href = (node: string, item?: string) => `junto://canvas/factory?node=${node}${item === undefined ? "" : `&item=${item}`}`;

describe("mention chips", () => {
  it("cuts a text into plain parts and one chip per link, by what the canvas says each node is", () => {
    const text = `Ask [@cli](${href("s")}) about [#42 fix tabs](${href("t", ITEM)}), [#spec](${href("a", ITEM)}) and [@example.com](${href("p")}).`;
    expect(mentionChipParts(text, kindOf)).toEqual([
      { text: "Ask " },
      { chip: { kind: "seat", label: "cli", ref: { kind: "seat", nodeId: "s" } } },
      { text: " about " },
      { chip: { kind: "task", label: "fix tabs", number: 42, ref: { kind: "task", nodeId: "t", taskId: ITEM } } },
      { text: ", " },
      { chip: { kind: "artifact", label: "spec", ref: { kind: "artifact", nodeId: "a", artifactId: ITEM } } },
      { text: " and " },
      { chip: { kind: "page", label: "example.com", ref: { kind: "page", nodeId: "p" } } },
      { text: "." },
    ]);
  });

  it("a gone node has no ref, its kind read off the link", () => {
    const text = `[@old](${href("x")}) [#7 done](${href("y", ITEM)}) [#doc](${href("z", ITEM)})`;
    const chips = mentionChipParts(text, kindOf).flatMap((part) => ("chip" in part ? [part.chip] : []));
    expect(chips).toEqual([
      { kind: "seat", label: "old" },
      { kind: "task", label: "done", number: 7 },
      { kind: "artifact", label: "doc" },
    ]);
  });
});
