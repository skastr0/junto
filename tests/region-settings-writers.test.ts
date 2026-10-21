import { afterEach, describe, expect, it, vi } from "vitest";
import { TASKS_ENABLED } from "../src/shared/features";
import { asCanvasName, type Node, type NodeOf } from "../src/shared/model";
import { setRegionContract, setRegionDefaults, setRegionEnvironment } from "../src/renderer/lib/mutations";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { note, region } from "./support/model-nodes";

const name = "region-settings";
const loaded = (): NodeOf<"region"> => region("works", { x: 900, y: 30, width: 500, height: 320 }, {
  z: 7, color: "4", label: "Works", hold: true,
  instruction: "Keep every field.",
  defaults: { page: { url: "https://example.com/works", profile: "work" }, paths: { local: "/tmp/works" } },
  contract: { rules: [{ id: "r1", text: "Review first." }], rulings: [{ id: "p1", text: "Use the shared folder.", pinnedAt: "2026-10-07T12:00:00Z" }] },
  environment: { sealed: true, sources: [{ id: "e1", kind: "value", name: "BUILD_MODE", value: "review" }], folders: ["/tmp/shared"] },
  background: "content://backgrounds/works.png", backgroundStyle: "cover",
});
let release: (() => void) | undefined;
const open = (node: Node = loaded()) => {
  state$.canvasName.set(name);
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
    // A build that gates tasks off writes no contract: the region stays as loaded.
    if (!TASKS_ENABLED) {
      setRegionContract("works", undefined);
      expect(held()).toEqual(before);
      expect(show).not.toHaveBeenCalled();
      return;
    }
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

  it("a contract refuses other node kinds", () => {
    const before = open(note("works"));
    const show = vi.spyOn(modelStore, "show");
    setRegionContract("works", { rules: [{ id: "r2", text: "Ship." }] });
    expect(held()).toEqual(before); expect(show).not.toHaveBeenCalled();
  });

});
