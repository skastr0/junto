import { describe, expect, it } from "vitest";
import { filterCommandBarNodes } from "../src/renderer/lib/command-bar";
import type { CanvasNode } from "../src/shared/canvas";

const text = (
  id: string,
  body: string,
  ether?: CanvasNode["ether"],
): CanvasNode => ({ id, type: "text", x: 0, y: 0, width: 200, height: 80, text: body, ether });

describe("command bar node ranking", () => {
  it("keeps document order when the query is empty", () => {
    const nodes = [text("a", "Alpha"), text("b", "Beta"), text("c", "Gamma")];
    const result = filterCommandBarNodes(nodes, "", []);
    expect(result.map((match) => match.node.id)).toEqual(["a", "b", "c"]);
    expect(result.map((match) => match.score)).toEqual([0, 0, 0]);
  });

  it("ranks title-prefix above title-substring above body matches", () => {
    const nodes = [
      text("body", "Alpha\nmentions cascade deep inside"),
      text("inside", "Cascade", { entity: { kind: "note" } }),
      text("prefix", "Cascade Ridge"),
      text("nomatch", "Unrelated"),
    ];
    const result = filterCommandBarNodes(nodes, "cascade", []);
    expect(result.map((match) => match.node.id)).toEqual([
      "inside", // title equals/substring match
      "prefix", // title starts with (but "Cascade Ridge".toLowerCase() = "cascade ridge")
      "body", // body-only match
    ]);
  });

  it("prefers title-prefix over title-substring", () => {
    const nodes = [
      text("sub", "Deep cascade notes"),
      text("pre", "Cascade overview"),
    ];
    const result = filterCommandBarNodes(nodes, "cascade", []);
    expect(result[0]?.node.id).toBe("pre");
    expect(result[1]?.node.id).toBe("sub");
  });

  it("breaks ties by hotbar recency, then document order", () => {
    const nodes = [text("a", "Alpha task"), text("b", "Beta task"), text("c", "Gamma task")];
    const result = filterCommandBarNodes(nodes, "task", ["c", "b"]);
    expect(result.map((match) => match.node.id)).toEqual(["c", "b", "a"]);
  });

  it("drops non-matching nodes", () => {
    const nodes = [text("a", "Alpha"), text("b", "Beta")];
    const result = filterCommandBarNodes(nodes, "alpha", []);
    expect(result.map((match) => match.node.id)).toEqual(["a"]);
  });

  it("matches flags and entity names through searchText", () => {
    const nodes = [
      text("flagged", "Quiet note", { flags: ["blocker"] }),
      text("named", "Quiet note", { entity: { kind: "agent", name: "worker-9" } }),
      text("plain", "Quiet note"),
    ];
    expect(filterCommandBarNodes(nodes, "blocker", []).map((m) => m.node.id)).toEqual(["flagged"]);
    expect(filterCommandBarNodes(nodes, "worker-9", []).map((m) => m.node.id)).toEqual(["named"]);
  });
});

import { Play, type LucideIcon } from "lucide-react";
import {
  commandBarActionQuery,
  commandBarMode,
  filterCommandBarActions,
  type CommandBarAction,
} from "../src/renderer/lib/command-bar-actions";

const action = (id: string, label: string, detail = ""): CommandBarAction => ({
  id,
  label,
  detail,
  icon: Play as LucideIcon,
  run: () => undefined,
});

describe("command bar actions mode", () => {
  it("treats a > prefix as actions mode and tab as the fallback toggle", () => {
    expect(commandBarMode(">fit", "nodes")).toBe("actions");
    expect(commandBarMode(">", "nodes")).toBe("actions");
    expect(commandBarMode("fit", "nodes")).toBe("nodes");
    expect(commandBarMode("fit", "actions")).toBe("actions");
    expect(commandBarMode("", "nodes")).toBe("nodes");
  });

  it("strips the > prefix for the action search term", () => {
    expect(commandBarActionQuery(">fit")).toBe("fit");
    expect(commandBarActionQuery(">  fit view ")).toBe("fit view");
    expect(commandBarActionQuery("fit")).toBe("fit");
    expect(commandBarActionQuery("")).toBe("");
  });

  it("returns the full catalog for an empty query", () => {
    const catalog = [action("a", "Fit view"), action("b", "Clear selection")];
    expect(filterCommandBarActions(catalog, "")).toEqual(catalog);
    expect(filterCommandBarActions(catalog, ">")).toEqual(catalog);
  });

  it("matches labels and details", () => {
    const catalog = [
      action("a", "Fit view", "Frame all nodes"),
      action("b", "Open settings"),
      action("c", "Edge filter / show blocks"),
    ];
    expect(filterCommandBarActions(catalog, "fit").map((a) => a.id)).toEqual(["a"]);
    expect(filterCommandBarActions(catalog, "frame").map((a) => a.id)).toEqual(["a"]);
    expect(filterCommandBarActions(catalog, ">filter").map((a) => a.id)).toEqual(["c"]);
    expect(filterCommandBarActions(catalog, "nope")).toEqual([]);
  });
});
