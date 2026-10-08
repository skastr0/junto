import { afterEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, type Node, type NodeOf } from "../src/shared/model";
import { pinRuling, setRegionContract, setRegionDefaults, setRegionEnvironment } from "../src/renderer/lib/mutations";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { note, region } from "./support/model-nodes";

const name = "region-settings";
const loaded = (): NodeOf<"region"> => region("works", { x: 900, y: 30, width: 500, height: 320 }, {
  z: 7, color: "4", label: "Works", hold: true,
  instruction: "Keep every field.",
  defaults: { page: { url: "https://example.com/works", profile: "work", host: "local" }, paths: { local: "/tmp/works" } },
  contract: { rules: [{ id: "r1", text: "Review first." }], rulings: [{ id: "p1", text: "Use the shared folder.", pinnedAt: "2026-10-07T12:00:00Z" }] },
  environment: { sealed: true, sources: [{ id: "e1", kind: "value", name: "BUILD_MODE", value: "review" }], folders: ["/tmp/shared"] },
  background: "content://backgrounds/works.png", backgroundStyle: "cover",
});
let release: (() => void) | undefined;
const open = (node: Node = loaded()) => {
  state$.canvasName.set(name);
  state$.settings.station.role.set("command-center");
  state$.error.set("");
  release = modelStore.adopt({ canvas: asCanvasName(name), seq: 21, nodes: [node], wires: [] });
  return node;
};
const held = () => modelStore.canvasOf(name).nodes.values().next().value!;
afterEach(() => { release?.(); vi.restoreAllMocks(); state$.error.set(""); state$.saveState.set("saved"); });

describe("region settings change their field alone", () => {
  it("defaults set, repeat, and clear preserve the complete region", () => {
    const before = open();
    const show = vi.spyOn(modelStore, "show");
    const defaults = { paths: { local: "/tmp/next" }, page: { url: "https://next.example" } };
    setRegionDefaults("works", defaults);
    expect(held()).toEqual({ ...before, defaults });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "region", defaults } });
    setRegionDefaults("works", defaults);
    expect(show).toHaveBeenCalledTimes(1);
    setRegionDefaults("works", undefined);
    const { defaults: _gone, ...cleared } = before as NodeOf<"region">;
    expect(held()).toEqual(cleared);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("empty defaults clear only defaults", () => {
    const before = open() as NodeOf<"region">;
    setRegionDefaults("works", { page: { url: "  " }, paths: {} });
    const { defaults: _gone, ...cleared } = before;
    expect(held()).toEqual(cleared);
  });

  it("environment set, repeat, and clear preserve the complete region", () => {
    const before = open() as NodeOf<"region">;
    const show = vi.spyOn(modelStore, "show");
    const environment = { sealed: false, sources: [{ id: "e2", kind: "value" as const, name: "BUILD_MODE", value: "ship" }], folders: ["/tmp/next"] };
    setRegionEnvironment("works", environment);
    expect(held()).toEqual({ ...before, environment });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "region", environment } });
    setRegionEnvironment("works", environment);
    expect(show).toHaveBeenCalledTimes(1);
    setRegionEnvironment("works", undefined);
    const { environment: _gone, ...cleared } = before;
    expect(held()).toEqual(cleared);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("missing nodes and other kinds remain untouched", () => {
    const before = open(note("works"));
    const show = vi.spyOn(modelStore, "show");
    setRegionDefaults("works", { paths: { local: "/tmp/next" } });
    setRegionEnvironment("works", { sealed: true });
    setRegionDefaults("missing", undefined);
    setRegionEnvironment("missing", undefined);
    expect(held()).toEqual(before);
    expect(show).not.toHaveBeenCalled();
  });
  it("contract set and clear preserve the complete region", () => {
    const before = open() as NodeOf<"region">;
    const show = vi.spyOn(modelStore, "show");
    const contract = { rules: [{ id: "r2", text: "Ship after review." }], rulings: before.contract!.rulings };
    setRegionContract("works", contract);
    expect(held()).toEqual({ ...before, contract });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "region", contract } });
    setRegionContract("works", contract);
    expect(show).toHaveBeenCalledTimes(1);
    setRegionContract("works", { rules: [], rulings: [] });
    const { contract: _gone, ...cleared } = before;
    expect(held()).toEqual(cleared);
    setRegionContract("works", undefined);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("pinning appends one ruling, preserving rules, prior rulings and all other fields", () => {
    const before = open() as NodeOf<"region">;
    const show = vi.spyOn(modelStore, "show");
    pinRuling("works", "  Keep the shared folder.  ", "request-1");
    const after = held() as NodeOf<"region">;
    const ruling = after.contract!.rulings!.at(-1)!;
    expect(ruling).toEqual({ id: expect.any(String), pinnedAt: expect.any(String), text: "Keep the shared folder.", sourceRequestId: "request-1" });
    expect(Number.isNaN(Date.parse(ruling.pinnedAt))).toBe(false);
    expect(after).toEqual({ ...before, contract: { ...before.contract, rulings: [...before.contract!.rulings!, ruling] } });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "region", contract: after.contract } });
    pinRuling("works", " "); pinRuling("missing", "Ignored");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("contract and pin refuse other node kinds", () => {
    const before = open(note("works"));
    const show = vi.spyOn(modelStore, "show");
    setRegionContract("works", { rules: [{ id: "r2", text: "Ship." }] });
    pinRuling("works", "Ignored");
    expect(held()).toEqual(before); expect(show).not.toHaveBeenCalled();
  });

});
