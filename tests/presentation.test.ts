import { describe, expect, it } from "vitest";
import { hostOf } from "../src/renderer/lib/presentation";
import { detailOf, searchOf } from "../src/renderer/lib/node-presentation";
import { titleOf } from "../src/shared/model/title";
import { asNodeId, type Node } from "../src/shared/model";
import { note, page, region, seat, taskBoard } from "./support/model-nodes";

const base = { id: asNodeId("node"), x: 0, y: 0, width: 200, height: 80, z: 0 };

describe("node presentation", () => {
  it("keeps authored identity separate from its work", () => {
    const worker = seat("worker", { label: "PRISM", agentKey: "local:prism" });
    expect(titleOf(worker)).toBe("PRISM");
    expect(detailOf(worker)).toBe("local:prism");
    expect(searchOf(worker)).toContain("local:prism");
    const tasks = taskBoard("tasks", { name: "Build", contract: { instructions: "Ship the editor" } });
    expect(titleOf(tasks)).toBe("Build");
    expect(detailOf(tasks)).toBe("Ship the editor");
    expect(searchOf(tasks)).toContain("ship the editor");
  });

  it("uses each node's own kind, name and content", () => {
    const plain = note("note", "# A note\nBody\nMore");
    expect(titleOf(plain)).toBe("A note");
    expect(detailOf(plain)).toBe("Body More");
    expect(searchOf(plain)).toContain("body");
    expect(titleOf(seat("agent", { label: "Vega" }))).toBe("Vega");
    expect(searchOf(page("page", { url: "https://example.com/path" }))).toContain("https://example.com/path");
  });

  it("keeps kind-specific details for files, links, and regions", () => {
    const file: Node = { ...base, kind: "file", path: "docs/untitled.md", subpath: "#install" };
    const link: Node = { ...base, kind: "link", url: "https://example.com/path" };
    const area = region("region", base, { label: "Operations" });
    expect(titleOf(file)).toBe("untitled.md");
    expect(detailOf(file)).toBe("docs/untitled.md #install");
    expect(searchOf(file)).toContain("#install");
    expect(titleOf(link)).toBe("example.com");
    expect(detailOf(link)).toBe("https://example.com/path");
    expect(titleOf(area)).toBe("Operations");
    expect(detailOf(area)).toBe("Spatial region");
  });

  it("shortens a page address to its host, including malformed addresses", () => {
    expect(hostOf("https://example.com/path")).toBe("example.com");
    expect(hostOf("example.com/path")).toBe("example.com");
  });
});
