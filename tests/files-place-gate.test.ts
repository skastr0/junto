/**
 * Where a Files node may open a folder (0.12.1, X6, remote-security F1 to
 * F3, A1 to A3). With files over SSH on, the operator may place one on
 * another machine this machine edits the canvas for, when that machine is an
 * active pin and not a Boat machine. Every other source, a voter-ruled canvas,
 * a retired pin, an unknown or unnamed machine, a Boat machine and a relative
 * root refuse; a root alone is checked against the node's host the same way.
 * With it off, nothing changes. The far serves a peer only under a root that
 * is not / and holds no Junto home, and only through its headless service.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { servesPeerRoot } from "../src/core/files/headless-service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ModelRecords } from "../src/core/model/records";
import { ModelService } from "../src/core/model/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { UNNAMED_MACHINE } from "../src/shared/canvas-copy";
import { asCanvasName, Command } from "../src/shared/model";
import { THIS_MACHINE } from "./support/machines";
import { files } from "./support/model-nodes";
import { ModelStoresLive } from "./support/seed-canvas";
import { makeTestLog } from "./support/test-log";

const flags = vi.hoisted(() => ({ remote: true }));
vi.mock("@shared/features", async (original) => {
  const real = await original<typeof import("../src/shared/features")>();
  return {
    ...real,
    get FILES_REMOTE_ENABLED() { return flags.remote; },
    productNodeKindEnabled: (kind: string) => kind === "files" || real.productNodeKindEnabled(kind as never),
  };
});

const testLog = makeTestLog();
const id = Schema.decodeUnknownSync(InstallationId);
const command = Schema.decodeUnknownSync(Command);
const CANVAS = asCanvasName("factory");
const ROOT = "/Users/mini/Projects/specs";

const runtimes: Array<() => Promise<void>> = [];
afterEach(async () => {
  flags.remote = true;
  for (const close of runtimes.splice(0)) await close();
});

const stage = async () => {
  const root = join(tmpdir(), `junto-files-gate-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.provideMerge(ModelStoresLive, Layer.provideMerge(
      Layer.mergeAll(WorkRepositoryLive, makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE, makeInstallationId: () => id("studio-installation") })),
      makeStateEngineLive(join(root, "junto.db")),
    )),
    testLog.log.loggerLayer,
  ));
  runtimes.push(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await runtime.runPromise(Effect.gen(function* () {
    const machines = yield* MachineRepository;
    yield* machines.configureName(THIS_MACHINE);
    yield* machines.pinPeer({ machineName: "mini", installationId: id("mini-installation") });
    yield* machines.pinPeer({ machineName: "old", installationId: id("old-installation") });
    yield* machines.retirePeer("old");
    yield* (yield* ModelService).command({ _tag: "CreateCanvas", canvas: CANVAS }, "operator");
  }));
  /** "ok", or the rule the model refused with. */
  const run = (raw: unknown, source: "operator" | "runtime" | "overseer" = "operator") =>
    runtime.runPromise(Effect.flatMap(ModelService, (model) => model.command(command(raw), source)).pipe(
      Effect.match({ onSuccess: () => "ok", onFailure: (error) => (error as { readonly rule?: string }).rule ?? String(error) }),
    ));
  const add = (host: string, source?: "operator" | "runtime" | "overseer", root = ROOT, node = "folder") =>
    run({ _tag: "Add", canvas: CANVAS, nodes: [files(node, { host: host as never, root })], wires: [] }, source);
  const gate = (place: { host?: string; root?: string }, boat: () => Promise<ReadonlySet<string>> = async () => new Set(), source: "operator" | "runtime" | "overseer" = "operator") =>
    runtime.runPromise(Effect.flatMap(ModelRecords, (records) => records.requireFilesPlace(place, { source, canvas: CANVAS, boat })).pipe(
      Effect.match({ onSuccess: () => "ok", onFailure: (error) => (error as { readonly rule?: string }).rule ?? String(error) }),
    ));
  const sql = <A extends object>(text: string, values: ReadonlyArray<unknown> = []) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(text, values as never)));
  return { run, add, gate, sql };
};

describe("a Files node on another machine", () => {
  it("is placed by the operator on a machine in this machine's list, on a canvas this machine edits", async () => {
    const f = await stage();
    expect(await f.add("mini")).toBe("ok");
  });

  it("is refused to a seat's runtime and to an overseer, by Add and by an Edit of the host or the root alone (F1, A1)", async () => {
    const f = await stage();
    // The model refuses these sources a canvas change before the gate; the gate refuses them on its own too.
    for (const source of ["runtime", "overseer"] as const) {
      expect(await f.add("mini", source, ROOT, `by-${source}`)).not.toBe("ok");
      expect(await f.gate({ host: "mini", root: ROOT }, undefined, source)).toBe("Only the operator can place a Files node on another machine.");
      expect(await f.gate({ host: "mini" }, undefined, source)).toBe("Only the operator can place a Files node on another machine.");
    }
    expect(await f.add(THIS_MACHINE, "operator", "/Users/me/here", "here")).toBe("ok");
    expect(await f.add("mini")).toBe("ok");
    for (const source of ["runtime", "overseer"] as const) {
      expect(await f.run({ _tag: "Edit", canvas: CANVAS, id: "here", change: { kind: "files", host: "mini" } }, source)).not.toBe("ok");
      expect(await f.run({ _tag: "Edit", canvas: CANVAS, id: "folder", change: { kind: "files", root: "/Users/mini/elsewhere" } }, source)).not.toBe("ok");
    }
    expect(await f.run({ _tag: "Edit", canvas: CANVAS, id: "folder", change: { kind: "files", root: "/Users/mini/elsewhere" } })).toBe("ok");
  });

  it("is refused on a canvas another machine edits (A2)", async () => {
    const f = await stage();
    await f.sql("UPDATE canvases SET editor_installation_id = ? WHERE canvas_name = ?", ["voter-installation", CANVAS]);
    const ruled = await f.gate({ host: "mini", root: ROOT }, async () => new Set());
    expect(ruled).toContain("Only the machine that edits this canvas can place a Files node on another machine.");
  });

  it("is refused on a retired pin, an unknown name, the unnamed machine and a Boat machine (F2)", async () => {
    const f = await stage();
    expect(await f.add("old")).toContain(`"old" is not a machine in this machine's list`);
    expect(await f.add("stranger")).toContain(`"stranger" is not a machine in this machine's list`);
    expect(await f.gate({ host: UNNAMED_MACHINE, root: ROOT })).toContain("names no machine");
    expect(await f.gate({ host: "mini", root: ROOT }, async () => new Set(["mini"]))).toContain(`"mini" is a Boat machine`);
    expect(await f.gate({ host: "mini", root: ROOT }, async () => { throw new Error("unreadable"); })).toContain("could not read which machines are Boat machines");
    expect(await f.gate({ host: "mini", root: "relative/path" })).toContain("is an absolute path");
  });

  it("with files over SSH off, is refused as before", async () => {
    flags.remote = false;
    const f = await stage();
    expect(await f.add("mini")).toContain(`A Files node opens a folder on this machine (${THIS_MACHINE}), not on "mini".`);
    expect(await f.add(THIS_MACHINE, "operator", "/Users/me/here", "here")).toBe("ok");
  });
});

describe("the far's own check of a peer's root (F3, A3)", () => {
  const serves = servesPeerRoot(async () => ["/home/mini/.junto"]);
  it("serves an absolute folder that is not / and neither holds nor sits in a Junto home", async () => {
    expect(await serves("/home/mini/Projects", "/home/mini/Projects")).toBe(true);
    expect(await serves("/", "/")).toBe(false);
    expect(await serves("/home/mini", "/home/mini")).toBe(false);
    expect(await serves("/home/mini/.junto/canvases", "/home/mini/.junto/canvases")).toBe(false);
    expect(await serves("/home/mini/.junto", "/home/mini/.junto")).toBe(false);
    expect(await serves("relative", "/home/mini/relative")).toBe(false);
    // A link that resolves into the home is judged by where it resolves.
    expect(await serves("/home/mini/link", "/home/mini/.junto")).toBe(false);
    expect(await serves("/home/mini/.junto-old", "/home/mini/.junto-old")).toBe(true);
  });

  it("binds a peer's files and file-bytes channels only to the headless service, which carries the check", () => {
    const core = readFileSync("src/core/core.ts", "utf8");
    expect(core).toContain("const filesHost = FILES_REMOTE_ENABLED ? makeHeadlessFilesService() : undefined;");
    expect(core.match(/makeFilesLinkChannel\(\{[^}]*\}/gu)?.every((call) => call.includes("filesHost"))).toBe(true);
    expect(core.match(/makeFileBytesLinkChannel\(\{[^}]*\}/gu)?.every((call) => call.includes("filesHost"))).toBe(true);
    expect(readFileSync("src/core/files/headless-service.ts", "utf8")).toContain("servesRoot: servesPeerRoot(deny),");
  });
});
