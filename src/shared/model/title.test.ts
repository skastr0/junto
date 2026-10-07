import { describe, expect, it } from "vitest";
import { asNodeId, taskBoardTitle, titleOf, type Node } from "./index";

const at = { id: asNodeId("01M46VAYSKXYFKW4QX1NHBXCCP"), x: 0, y: 0, width: 200, height: 100, z: 0 };

describe("what a node is called", () => {
  it("calls a task board by its name, then its instructions, then its id", () => {
    const board = (more: object): Node => ({ kind: "task", ...at, ...more });
    expect(titleOf(board({ name: "Backlog" }))).toBe("Backlog");
    expect(titleOf(board({ name: "tasks", contract: { instructions: "Ship it. Then rest." } }))).toBe(
      "Ship it.",
    );
    expect(titleOf(board({}))).toBe("Tasks 1NHBXCCP");
    expect(taskBoardTitle(undefined, "tasks")).toEqual({ name: "Tasks", source: "id" });
  });

  it("never returns an empty name", () => {
    const nodes: ReadonlyArray<Node> = [
      { kind: "requests", ...at },
      { kind: "requests", ...at, name: "Requests" },
      { kind: "board", ...at },
      { kind: "note", ...at, text: "" },
      { kind: "note", ...at, text: "  first\nsecond" },
      { kind: "region", ...at, hold: false },
      { kind: "file", ...at, path: "/a/b/notes.md" },
      { kind: "git", ...at, cwd: "/Users/me/Projects/junto" },
    ];
    expect(nodes.map(titleOf)).toEqual([
      "requests",
      "requests",
      "board",
      "untitled",
      "first",
      "unnamed region",
      "notes.md",
      "junto",
    ]);
  });

  it("names a link and a page by their site, and a note by its first line without heading marks", () => {
    const nodes: ReadonlyArray<Node> = [
      { kind: "link", ...at, url: "https://example.com/a/long/path?with=query" },
      { kind: "link", ...at, url: "example.com/docs" },
      { kind: "link", ...at, url: "" },
      { kind: "page", ...at, url: "http://localhost:3000/x", host: "local", profile: "p", onRemove: "detach" },
      { kind: "note", ...at, text: "## Plan\nbody" },
      { kind: "label", ...at, text: "" },
    ];
    expect(nodes.map(titleOf)).toEqual([
      "example.com",
      "example.com",
      "link",
      "localhost:3000",
      "Plan",
      "untitled",
    ]);
  });
});
