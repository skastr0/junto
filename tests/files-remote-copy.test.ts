/**
 * A Files node in the copy (0.12.1, X6, remote-security C1 to C4): the machine
 * the folder is on gets the node whole, host and root, so it can serve the
 * folder and check every op against it. Every other machine gets the stub,
 * as before. A folder alone is a smaller reason than a seat: such a copy
 * carries the Files nodes and the header, nothing else of the canvas. No wire
 * goes to a Files node in any copy. With files over SSH off, nothing changes.
 */
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { decodeCanvasCopy, exportCanvasCopy, type CanvasCopySource } from "../src/shared/canvas-copy";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { files, seat as seatNode, wire } from "./support/model-nodes";

const flags = vi.hoisted(() => ({ remote: true }));
vi.mock("@shared/features", async (original) => {
  const real = await original<typeof import("../src/shared/features")>();
  return {
    ...real,
    get FILES_REMOTE_ENABLED() { return flags.remote; },
    productNodeKindEnabled: (kind: string) => kind === "files" || real.productNodeKindEnabled(kind as never),
  };
});
afterEach(() => { flags.remote = true; });

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-installation");
const MINI = id("mini-installation");
const LINUX = id("linux-installation");
const ROOT = "/Users/mini/Projects/secret-folder";

const seat = (name: string, host: string, x: number) =>
  seatNode(name, { host: host as never, agentKey: `${host}:claude`, x, y: 0, width: 100, height: 60 });

const source = (nodes: ReadonlyArray<Node>): CanvasCopySource => ({
  automations: [],
  canvasName: asCanvasName("factory"),
  canvasId: "canvas-factory",
  seq: 7,
  editor: EDITOR,
  editorMachineName: "macbook",
  nodes,
  wires: [wire("lead-to-folder", "lead", "folder", "messages"), wire("folder-to-lead", "folder", "lead", "messages")],
  guidance: { lead: { soul: "The lead's soul." } },
  briefing: "The app briefing.",
  references: [{ name: "style", body: "App-wide style." }],
  playing: true,
  seatIdOf: () => Schema.decodeUnknownSync(ActorSeatId)(`seat_${"1".repeat(64)}`),
});

const folder = files("folder", { host: "mini" as never, root: ROOT, label: "Specs" });
const cutFor = (nodes: ReadonlyArray<Node>, installationId: InstallationId, machineName: string) =>
  exportCanvasCopy(source(nodes), { installationId, machineName }, "cut");

describe("a Files node in the copy", () => {
  it("goes whole to the machine its folder is on, and as a stub with no host or root to every other", () => {
    const nodes = [seat("lead", "macbook", 0), seat("peer", "mini", 200), seat("other", "linux", 400), folder];
    const mini = cutFor(nodes, MINI, "mini");
    if (!mini.ok) throw new Error(mini.refusal.reason);
    expect(mini.copy.resources.find((resource) => resource.id === "folder")).toEqual({
      kind: "files", id: "folder", x: folder.x, y: folder.y, width: folder.width, height: folder.height, z: folder.z, label: "Specs", host: "mini", root: ROOT,
    });
    const linux = cutFor(nodes, LINUX, "linux");
    if (!linux.ok) throw new Error(linux.refusal.reason);
    expect(linux.copy.resources.find((resource) => resource.id === "folder")).toMatchObject({ kind: "stub", of: "files" });
    expect(JSON.stringify(linux.copy)).not.toContain(ROOT);
    expect(JSON.stringify(linux.copy)).not.toContain("\"host\":\"mini\",\"root\"");
  });

  it("decodes on the folder's machine as a Files node", () => {
    const mini = cutFor([seat("lead", "macbook", 0), seat("peer", "mini", 200), folder], MINI, "mini");
    if (!mini.ok) throw new Error(mini.refusal.reason);
    const decoded = decodeCanvasCopy(JSON.parse(JSON.stringify(mini.copy)));
    expect(decoded._tag).toBe("Success");
  });

  it("carries no wire to or from a Files node, whole or stub (C3)", () => {
    const nodes = [seat("lead", "macbook", 0), seat("peer", "mini", 200), folder];
    const mini = cutFor(nodes, MINI, "mini");
    if (!mini.ok) throw new Error(mini.refusal.reason);
    expect(mini.copy.wires.filter((held) => held.from === "folder" || held.to === "folder")).toEqual([]);
  });

  it("with a folder as the machine's only reason, carries the Files nodes on it and the header, and nothing else (C1)", () => {
    const nodes = [seat("lead", "macbook", 0), seat("other", "linux", 400), folder, files("elsewhere", { host: "linux" as never, root: "/home/linux/other" })];
    const mini = cutFor(nodes, MINI, "mini");
    if (!mini.ok) throw new Error(mini.refusal.reason);
    expect(mini.filesOnly).toBe(true);
    const { canvasName, canvasId, seq, editor, target, playing, ...rest } = mini.copy;
    expect({ canvasName, canvasId, seq, editor, target, playing }).toEqual({ canvasName: "factory", canvasId: "canvas-factory", seq: 7, editor: EDITOR, target: MINI, playing: true });
    expect(rest).toEqual({
      seats: [], peers: [], terminals: [], regions: [], wires: [], guidance: [], references: [],
      resources: [{ kind: "files", id: "folder", x: folder.x, y: folder.y, width: folder.width, height: folder.height, z: folder.z, label: "Specs", host: "mini", root: ROOT }],
    });
    const sent = JSON.stringify(mini.copy);
    for (const never of ["The app briefing", "App-wide style", "The lead's soul", "/home/linux/other", "lead", "other"]) expect(sent).not.toContain(never);
  });

  it("gives a machine that loses its node a stub, or no copy when the node was its only reason (F5, C2)", () => {
    const moved = files("folder", { host: "linux" as never, root: ROOT, label: "Specs" });
    const withSeat = cutFor([seat("lead", "macbook", 0), seat("peer", "mini", 200), seat("other", "linux", 400), moved], MINI, "mini");
    if (!withSeat.ok) throw new Error(withSeat.refusal.reason);
    expect(withSeat.copy.resources.find((resource) => resource.id === "folder")).toMatchObject({ kind: "stub", of: "files" });
    expect(JSON.stringify(withSeat.copy)).not.toContain(ROOT);
    expect(cutFor([seat("lead", "macbook", 0), seat("other", "linux", 400), moved], MINI, "mini")).toEqual({
      ok: false, refusal: { reason: "no-seat-or-automation-on-that-machine" },
    });
  });

  it("with files over SSH off, is today's copy byte for byte: a stub to every machine, and no copy for a folder alone", () => {
    const nodes = [seat("lead", "macbook", 0), seat("peer", "mini", 200), folder];
    flags.remote = false;
    const off = cutFor(nodes, MINI, "mini");
    if (!off.ok) throw new Error(off.refusal.reason);
    expect(off.copy.resources.find((resource) => resource.id === "folder")).toEqual({
      kind: "stub", of: "files", id: "folder", x: folder.x, y: folder.y, width: folder.width, height: folder.height, z: folder.z, label: "Specs",
    });
    expect(JSON.stringify(off.copy)).not.toContain(ROOT);
    expect(cutFor([seat("lead", "macbook", 0), folder], MINI, "mini")).toEqual({ ok: false, refusal: { reason: "no-seat-or-automation-on-that-machine" } });
    // The same canvas cut for a machine that is not the folder's is the same with the flag on or off.
    const linuxOff = JSON.stringify(cutFor([...nodes, seat("other", "linux", 400)], LINUX, "linux"));
    flags.remote = true;
    expect(JSON.stringify(cutFor([...nodes, seat("other", "linux", 400)], LINUX, "linux"))).toBe(linuxOff);
  });
});
