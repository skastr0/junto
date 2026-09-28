import { afterEach, describe, expect, it } from "vitest";
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

  it("matches entity names through searchText", () => {
    const nodes = [
      text("named", "Quiet note", { entity: { kind: "agent", name: "worker-9" } }),
      text("plain", "Quiet note"),
    ];
    expect(filterCommandBarNodes(nodes, "worker-9", []).map((m) => m.node.id)).toEqual(["named"]);
  });
});

describe("command bar agent bias", () => {
  const agent = (id: string, body: string): CanvasNode =>
    text(id, body, { entity: { kind: "agent", name: `local:${id}` } });
  const region = (id: string, label: string): CanvasNode => ({ id, type: "group", label, x: 0, y: 0, width: 400, height: 300 });
  const link = (id: string): CanvasNode => ({ id, type: "link", url: `https://example.com/${id}`, x: 0, y: 0, width: 200, height: 80 });

  // Document order deliberately buries the agents under other kinds.
  const nodes = [
    link("l"),
    text("n", "Deploy plan"),
    region("r", "Deploy"),
    agent("resting", "deploy-resting"),
    agent("offline", "deploy-offline"),
    agent("working", "deploy-working"),
    agent("blocked", "deploy-blocked"),
    agent("waiting", "deploy-waiting"),
  ];
  const urgency = new Map([
    ["blocked", 0],
    ["waiting", 1],
    ["working", 3],
    ["resting", 4],
    ["offline", 5],
  ]);
  const ids = (query: string, recent: ReadonlyArray<string> = []) =>
    filterCommandBarNodes(nodes, query, recent, urgency).map((match) => match.node.id);

  it("empty query: agents first by urgency, then regions, notes, and other kinds", () => {
    expect(ids("")).toEqual(["blocked", "waiting", "working", "resting", "offline", "r", "n", "l"]);
  });

  it("urgency outranks hotbar recency among agents; recency breaks equal urgency", () => {
    expect(ids("", ["offline"])[0]).toBe("blocked");
    const tied = [agent("a", "alpha"), agent("b", "beta")];
    const result = filterCommandBarNodes(tied, "", ["b"], new Map([["a", 1], ["b", 1]]));
    expect(result.map((match) => match.node.id)).toEqual(["b", "a"]);
  });

  it("an agent with no reading ranks as resting", () => {
    const partial = new Map([["waiting", 1], ["offline", 5]]);
    const result = filterCommandBarNodes(nodes, "", [], partial).map((match) => match.node.id);
    expect(result.slice(0, 5)).toEqual(["waiting", "resting", "working", "blocked", "offline"]);
  });

  it("with a query, agents rank above other kinds at equal match quality", () => {
    // Every title starts with "deploy": one tier, agents first by urgency.
    expect(ids("deploy")).toEqual(["blocked", "waiting", "working", "resting", "offline", "n", "r"]);
  });

  it("a better match still beats an agent", () => {
    const mixed = [agent("seat", "yak-seat"), region("r", "Yakjev"), text("n", "Notes on the yak")];
    const result = filterCommandBarNodes(mixed, "yakjev", [], new Map([["seat", 0]]));
    expect(result.map((match) => match.node.id)).toEqual(["r"]);
    const prefix = filterCommandBarNodes(mixed, "yak", [], new Map([["seat", 0]]));
    // All three are title prefixes except the note (substring): agent, region, note.
    expect(prefix.map((match) => match.node.id)).toEqual(["seat", "r", "n"]);
    const titled = [region("r", "Research"), agent("seat", "reviewer\nreads research papers")];
    // The region's title matches; the agent only matches in its body.
    expect(filterCommandBarNodes(titled, "research", []).map((match) => match.node.id)).toEqual(["r", "seat"]);
  });
});

import { Play, type LucideIcon } from "lucide-react";
import type { DigestResult } from "../src/shared/ipc";
import {
  commandBarActionQuery,
  commandBarMode,
  filterCommandBarActions,
  openCanvasDigest,
  type CommandBarAction,
} from "../src/renderer/lib/command-bar-actions";
import { state$ } from "../src/renderer/lib/state";

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

type DigestApi = { exportDigest: (name: string) => Promise<DigestResult | undefined> };

const digestWindow = (): { junto?: DigestApi } => {
  const g = globalThis as { window?: { junto?: DigestApi } };
  if (g.window === undefined) g.window = {};
  return g.window;
};

describe("openCanvasDigest", () => {
  const prior = digestWindow().junto;

  afterEach(() => {
    digestWindow().junto = prior;
    state$.canvasName.set("");
    state$.digest.set(null);
    state$.digestOpen.set(false);
    state$.error.set("");
  });

  it("opens the panel when export succeeds", async () => {
    state$.canvasName.set("ops");
    digestWindow().junto = {
      exportDigest: async () => ({ digest: "board", path: "ops.digest.txt" }),
    };
    await openCanvasDigest("ops");
    expect(state$.digestOpen.peek()).toBe(true);
    expect(state$.digest.peek()).toEqual({
      digest: "board",
      path: "ops.digest.txt",
    });
    expect(state$.error.peek()).toBe("");
  });

  it("surfaces export failure on state.error and does not open", async () => {
    state$.canvasName.set("ops");
    digestWindow().junto = {
      exportDigest: async () => {
        throw new Error("digest write failed");
      },
    };
    await openCanvasDigest("ops");
    expect(state$.digestOpen.peek()).toBe(false);
    expect(state$.digest.peek()).toBeNull();
    expect(state$.error.peek()).toBe("digest write failed");
  });

  it("treats a missing result as failure", async () => {
    state$.canvasName.set("ops");
    digestWindow().junto = undefined;
    await openCanvasDigest("ops");
    expect(state$.digestOpen.peek()).toBe(false);
    expect(state$.error.peek()).toBe("Canvas digest is unavailable.");
  });

  it("ignores a late result after the canvas changed", async () => {
    state$.canvasName.set("ops");
    let release: (value: DigestResult) => void = () => undefined;
    const pending = new Promise<DigestResult>((resolve) => {
      release = resolve;
    });
    digestWindow().junto = { exportDigest: async () => pending };
    const done = openCanvasDigest("ops");
    state$.canvasName.set("other");
    release({ digest: "stale", path: "ops.digest.txt" });
    await done;
    expect(state$.digestOpen.peek()).toBe(false);
    expect(state$.digest.peek()).toBeNull();
    expect(state$.error.peek()).toBe("");
  });

  it("ignores a late failure after the canvas changed", async () => {
    state$.canvasName.set("ops");
    let rejectPending: (error: Error) => void = () => undefined;
    const pending = new Promise<DigestResult>((_resolve, reject) => {
      rejectPending = reject;
    });
    digestWindow().junto = { exportDigest: async () => pending };
    const done = openCanvasDigest("ops");
    state$.canvasName.set("other");
    rejectPending(new Error("digest write failed"));
    await done;
    expect(state$.digestOpen.peek()).toBe(false);
    expect(state$.error.peek()).toBe("");
  });
});
