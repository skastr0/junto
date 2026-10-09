import { afterEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, asNodeId, type Node, type NodeOf } from "../src/shared/model";
import { editLink, setGitCwd, setPageBinding } from "../src/renderer/lib/mutations";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { page } from "./support/model-nodes";

const name = "page-git-writers";
const loadedPage = () => page("target", { x: 30, y: 50, width: 460, height: 280, z: 8, color: "4", url: "https://before.example", profile: "work", host: "studio", onRemove: "detach" });
const loadedGit = (): NodeOf<"git"> => ({ kind: "git", id: asNodeId("target"), x: 30, y: 50, width: 460, height: 280, z: 8, color: "4", label: "Repository", cwd: "/tmp/before" });
let release: (() => void) | undefined;
const open = (node: Node) => {
  state$.canvasName.set(name);
  state$.error.set("");
  release = modelStore.adopt({ canvas: asCanvasName(name), seq: 21, nodes: [node], wires: [] });
  return node;
};
const held = () => modelStore.canvasOf(name).nodes.values().next().value!;
afterEach(() => { release?.(); vi.restoreAllMocks(); state$.error.set(""); state$.saveState.set("saved"); });

describe("page and git writers change their fields alone", () => {
  it("URL is trimmed and changes URL only, with blank and repeat ignored", () => {
    const before = open(loadedPage());
    const show = vi.spyOn(modelStore, "show");
    editLink("target", "  https://after.example  ");
    expect(held()).toEqual({ ...before, url: "https://after.example" });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "page", url: "https://after.example" } });
    editLink("target", "https://after.example"); editLink("target", "  ");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("binding changes profile and host only, omitting a field already equal", () => {
    const before = open(loadedPage());
    const show = vi.spyOn(modelStore, "show");
    setPageBinding("target", { profile: " personal ", host: " local " });
    expect(held()).toEqual({ ...before, profile: "personal", host: "local" });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "page", profile: "personal", host: "local" } });
    setPageBinding("target", { profile: "second", host: "local" });
    expect(show).toHaveBeenLastCalledWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "page", profile: "second" } });
    expect(held()).toEqual({ ...before, profile: "second", host: "local" });
    setPageBinding("target", { profile: "second", host: "local" });
    setPageBinding("target", { profile: "", host: "local" });
    setPageBinding("target", { profile: "second", host: "../bad" });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("repository changes cwd only, with blank and repeat ignored", () => {
    const before = open(loadedGit());
    const show = vi.spyOn(modelStore, "show");
    setGitCwd("target", " /tmp/after ");
    expect(held()).toEqual({ ...before, cwd: "/tmp/after" });
    expect(show).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas: name, id: before.id, change: { kind: "git", cwd: "/tmp/after" } });
    setGitCwd("target", "/tmp/after"); setGitCwd("target", " ");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("other kinds and missing ids stay untouched, including plain link furniture", () => {
    const before = open({ kind: "link", id: asNodeId("target"), x: 30, y: 50, width: 460, height: 280, z: 8, color: "4", url: "https://before.example" });
    const show = vi.spyOn(modelStore, "show");
    editLink("target", "https://after.example");
    setPageBinding("target", { profile: "personal", host: "local" });
    setGitCwd("target", "/tmp/after");
    editLink("missing", "https://after.example");
    setPageBinding("missing", { profile: "personal", host: "local" });
    setGitCwd("missing", "/tmp/after");
    expect(held()).toEqual(before); expect(show).not.toHaveBeenCalled();
  });
});
