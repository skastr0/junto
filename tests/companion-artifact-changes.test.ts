/**
 * The phone's live artifact updates (0.11.3, docs/artifacts-proposal.md
 * section 4): the change clock carries each artifact change, and a session
 * that subscribed to that canvas sends `artifact.changed` for it, and nothing
 * for a canvas it did not subscribe to.
 */
import { describe, expect, it } from "vitest";
import { makeCompanionChanges } from "../src/main/junto/companion/changes";
import { noteArtifactCanvasChanged, type ScannedHead } from "../src/main/junto/companion/artifact-changes";
import { COMPANION_PROTOCOL, decodeCompanionRequestLine } from "../src/shared/wire/companion-protocol";
import type { CompanionArtifactChanged } from "../src/shared/wire/companion-artifacts";
import { runCompanionSession, type CompanionChange } from "../src/shared/companion-session";
import type { CompanionRequestFrame, CompanionResponseFrame } from "../src/shared/wire/companion-protocol";
import { asNodeId } from "../src/shared/model";
import type { ItemId } from "../src/shared/wire/ids";

const ARTIFACT = "01J9DEM0ART000000000000001" as ItemId;

const change = (canvasName: string): CompanionArtifactChanged => ({
  canvasName,
  artifact: {
    artifactId: ARTIFACT,
    nodeId: asNodeId("art-inbox"),
    type: "document",
    title: "Pricing notes",
    version: 2 as CompanionArtifactChanged["artifact"]["version"],
    updatedAt: 1_790_000_000_000,
    archived: false,
    labels: [],
  },
  author: { kind: "operator" },
  at: 1_790_000_000_000,
  edit: { kind: "replace", baseVersion: 1, body: { type: "document", markdown: "# Pricing notes\n" } } as CompanionArtifactChanged["edit"],
  bodyRef: { sha256: "a".repeat(64), byteLength: 12, mediaType: "text/markdown" } as CompanionArtifactChanged["bodyRef"],
});

describe("the companion change clock", () => {
  it("keeps artifact changes for a poll, and hands each over once", async () => {
    const changes = makeCompanionChanges();
    const first = await changes.wait(undefined, 0);
    changes.noteArtifact(change("demo"));
    const second = await changes.wait(first.cursor, 0);
    expect(second.changed).toBe(true);
    expect(second.artifacts).toHaveLength(1);
    expect(second.artifacts?.[0]?.artifact.artifactId).toBe(ARTIFACT);
    const third = await changes.wait(second.cursor, 0);
    expect(third.artifacts).toEqual([]);
  });

  it("reads as a change for a signal and for an artifact alike", async () => {
    const changes = makeCompanionChanges();
    const first = await changes.wait(undefined, 0);
    changes.noteArtifact(change("demo"));
    const poll = await changes.wait(first.cursor, 0);
    expect(poll.cursor).not.toBe(first.cursor);
  });
});

describe("the wire", () => {
  it("decodes artifacts.subscribe closed, and refuses an unknown key", () => {
    const good = decodeCompanionRequestLine(
      JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id: "r1", op: "artifacts.subscribe", args: { canvasName: "demo" } }),
    );
    expect(good._tag).toBe("Success");
    const bad = decodeCompanionRequestLine(
      JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id: "r2", op: "artifacts.subscribe", args: { canvasName: "demo", node: "x" } }),
    );
    expect(bad._tag).toBe("Failure");
  });
});

/** Drives a session with lines fed by hand and frames collected. */
const harness = () => {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        return { done: true, value: undefined };
      },
      return: async () => ({ done: true, value: undefined }),
    }),
  };
  const frames: CompanionResponseFrame[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const push = (line: string): void => {
    queue.push(line);
    wake?.();
    wake = undefined;
  };
  return { lines, frames, events, push, end: () => { ended = true; wake?.(); wake = undefined; } };
};

describe("a subscribed connection", () => {
  it("sends artifact.changed for its canvas only", async () => {
    const io = harness();
    // The host hands over one poll at a time: the session waits until the test has news.
    let release: (() => void) | undefined;
    let polled: CompanionChange = { cursor: "c1", changed: false, signals: [], artifacts: [], reset: false };
    const host = {
      hello: async () => ({
        ok: true as const,
        hello: { appVersion: "0.11.3", deviceId: "dev", deviceName: "Test phone", station: "Test Mac", protocol: COMPANION_PROTOCOL, serverTime: 0, features: ["artifacts/1"] },
      }),
      call: async (frame: CompanionRequestFrame): Promise<CompanionResponseFrame> =>
        ({ v: COMPANION_PROTOCOL, type: "response", id: frame.id, ok: true, result: {} }) as CompanionResponseFrame,
      waitChange: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return polled;
      },
    };
    const running = runCompanionSession({
      lines: io.lines,
      write: (line) => {
        const frame = JSON.parse(line);
        if (frame.type === "event") io.events.push({ event: frame.event, data: frame.data });
      },
      host,
      idleCloseMs: 5_000,
      waitMs: 0,
    });
    io.push(JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id: "s1", op: "artifacts.subscribe", args: { canvasName: "demo" } }));
    const settle = async (times = 5): Promise<void> => {
      for (let at = 0; at < times; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await settle();
    polled = { cursor: "c2", changed: true, signals: [], artifacts: [change("demo"), change("other")], reset: false };
    release?.();
    await settle();
    io.end();
    await running;
    expect(io.events.filter((frame) => frame.event === "artifact.changed")).toHaveLength(1);
    const changed = io.events.find((frame) => frame.event === "artifact.changed");
    expect((changed?.data as CompanionArtifactChanged).canvasName).toBe("demo");
  });
});

describe("a replicated ruling", () => {
  it("names the artifact it moved, with no edit", async () => {
    const changes = makeCompanionChanges();
    const first = await changes.wait(undefined, 0);
    let heads: ScannedHead[] = [{ ...change("demo").artifact, version: 1 as never, artifactId: ARTIFACT } as unknown as ScannedHead];
    const scan = async () => heads;
    // The first look is the baseline: nothing is new yet.
    noteArtifactCanvasChanged(changes, "demo", scan);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await changes.wait(first.cursor, 0)).artifacts).toEqual([]);
    heads = [{ ...heads[0]!, version: 2 as never }];
    noteArtifactCanvasChanged(changes, "demo", scan);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const poll = await changes.wait(first.cursor, 0);
    expect(poll.artifacts).toHaveLength(1);
    expect(poll.artifacts?.[0]?.artifact.version).toBe(2);
    expect(poll.artifacts?.[0]?.edit).toBeUndefined();
  });
});

describe("the demo's writes", () => {
  it("emits artifact.changed for a write made in the demo", async () => {
    const { makeDemoHost, DEMO_CANVAS } = await import("../src/shared/companion-demo");
    const { DEMO_ARTIFACT_PRICING_NOTES } = await import("../src/shared/wire/companion-demo-fixture");
    const host = makeDemoHost({ machineName: "macbook" });
    const io = harness();
    let release: (() => void) | undefined;
    const poll = async (): Promise<CompanionChange> => {
      await new Promise<void>((resolve) => (release = resolve));
      return host.waitChange("demo:0", 0);
    };
    const running = runCompanionSession({
      lines: io.lines,
      write: (line) => {
        const frame = JSON.parse(line);
        if (frame.type === "event") io.events.push({ event: frame.event, data: frame.data });
      },
      host: { hello: host.hello, call: host.call, waitChange: poll },
      idleCloseMs: 5_000,
      waitMs: 0,
    });
    const settle = async (times = 6): Promise<void> => {
      for (let at = 0; at < times; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    io.push(JSON.stringify({ v: COMPANION_PROTOCOL, type: "request", id: "s1", op: "artifacts.subscribe", args: { canvasName: DEMO_CANVAS } }));
    await settle();
    const applied = await host.call({
      v: COMPANION_PROTOCOL,
      type: "request",
      id: "w1",
      op: "artifact.apply",
      args: {
        canvasName: DEMO_CANVAS,
        nodeId: "art-inbox",
        artifactId: DEMO_ARTIFACT_PRICING_NOTES,
        opId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D7",
        op: { op: "retitle", title: "Pricing notes, second look" },
      },
    } as CompanionRequestFrame);
    expect(applied.ok).toBe(true);
    release?.();
    await settle(8);
    io.end();
    await running;
    const changed = io.events.filter((frame) => frame.event === "artifact.changed");
    expect(changed).toHaveLength(1);
    expect((changed[0]?.data as CompanionArtifactChanged).artifact.title).toBe("Pricing notes, second look");
  });
});
