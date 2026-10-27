// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@shared/settings";
import { resolveKey, type KeyContext, type KeySituation } from "../src/shared/key-table";
import { registerFileEditorSave, saveFileInFront } from "../src/renderer/lib/file-editor-keys";
import { KEY_ACTIONS } from "../src/renderer/lib/key-actions";
import { dispatchKey } from "../src/renderer/lib/key-dispatcher";
import { registerQuickOpenHost, toggleQuickOpenFor } from "../src/renderer/lib/quick-open-host";
import { state$ } from "../src/renderer/lib/state";

const key = (over: Partial<KeyboardEvent> & { key: string }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const at = (context: KeyContext): KeySituation => ({
  mac: true,
  context,
  typing: context === "field" || context === "terminal",
});

/** A keydown the dispatcher reads: it takes preventDefault when it acts. */
const press = (over: Partial<KeyboardEvent> & { key: string }) => {
  const event = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  };
  return event as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
};

const registered: Array<() => void> = [];

afterEach(() => {
  for (const unregister of registered.splice(0).reverse()) unregister();
});

beforeEach(() => {
  state$.settings.set(defaultSettings());
});

/** A node modal's quick open, as useQuickOpen registers it. */
const quickOpenNode = (nodeId: string, enabled = true) => {
  const open = vi.fn();
  const close = vi.fn();
  let showing = false;
  const unregister = registerQuickOpenHost({
    nodeId,
    enabled,
    open: () => {
      showing = true;
      open();
    },
    close: () => {
      showing = false;
      close();
    },
    isOpen: () => showing,
  });
  registered.push(unregister);
  return { open, close, unregister };
};

const fileEditor = (save: () => void) => {
  registered.push(registerFileEditorSave(save));
  return save;
};

describe("quick open's chord", () => {
  it("is Cmd+P inside a node modal, and nothing on the canvas, a terminal or search", () => {
    for (const context of ["working", "field"] as const) {
      expect(resolveKey(key({ key: "p", metaKey: true }), at(context))).toEqual({ id: "quickOpen.open" });
    }
    for (const context of ["canvas", "terminal", "operator", "dialog"] as const) {
      expect(resolveKey(key({ key: "p", metaKey: true }), at(context))).toBeNull();
    }
  });

  it("has an action wired to the node modal in front", () => {
    expect(KEY_ACTIONS["quickOpen.open"]).toBeDefined();
  });

  it("opens the palette of the node, and the same chord closes it again", () => {
    const node = quickOpenNode("node-1");
    expect(toggleQuickOpenFor("node-1")).toBe(true);
    expect(node.open).toHaveBeenCalledTimes(1);
    expect(toggleQuickOpenFor("node-1")).toBe(true);
    expect(node.close).toHaveBeenCalledTimes(1);
  });

  it("passes when no modal is up, or the node holds nothing to search", () => {
    expect(toggleQuickOpenFor("node-1")).toBe(false);
    expect(toggleQuickOpenFor("")).toBe(false);
    const empty = quickOpenNode("node-2", false);
    expect(toggleQuickOpenFor("node-2")).toBe(false);
    // Not enabled falls through to nothing it can open, even unnamed.
    expect(toggleQuickOpenFor("")).toBe(false);
    expect(empty.open).not.toHaveBeenCalled();
  });

  it("answers for the modal showing when the front node is not a workbench surface", () => {
    // A card's overlay is not a dock surface, so the action names no node:
    // the last modal registered is the one showing, as the page chrome's keys do.
    const first = quickOpenNode("node-1");
    const showing = quickOpenNode("node-2");
    expect(toggleQuickOpenFor("")).toBe(true);
    expect(showing.open).toHaveBeenCalledTimes(1);
    expect(first.open).not.toHaveBeenCalled();
  });

  it("reaches the node asked for, and a remount takes the place of the modal it replaced", () => {
    const first = quickOpenNode("node-1");
    const other = quickOpenNode("node-2");
    const remounted = quickOpenNode("node-1");
    expect(toggleQuickOpenFor("node-2")).toBe(true);
    expect(other.open).toHaveBeenCalledTimes(1);
    // The replaced modal unmounts after the new one registered: its cleanup
    // must leave the remount answering the chord.
    first.unregister();
    expect(toggleQuickOpenFor("node-1")).toBe(true);
    expect(remounted.open).toHaveBeenCalledTimes(1);
    expect(first.open).not.toHaveBeenCalled();
  });
});

describe("saving the file in front", () => {
  it("saves with Cmd+S while the editor has the keyboard, and keeps the key", () => {
    const save = fileEditor(vi.fn());
    const event = press({ key: "s", metaKey: true });
    expect(dispatchKey(event, KEY_ACTIONS, at("field"))).toBe("files.save");
    expect(save).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("saves from the modal chrome too, not only from a field", () => {
    const save = fileEditor(vi.fn());
    expect(dispatchKey(press({ key: "s", metaKey: true }), KEY_ACTIONS, at("working"))).toBe("files.save");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("passes untouched with no file open, so Cmd+S never acts on anything else", () => {
    const event = press({ key: "s", metaKey: true });
    expect(dispatchKey(event, KEY_ACTIONS, at("field"))).toBeNull();
    expect(saveFileInFront()).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("never takes Cmd+S from a terminal, where Control+S is XOFF", () => {
    const save = fileEditor(vi.fn());
    const event = press({ key: "s", metaKey: true });
    expect(dispatchKey(event, KEY_ACTIONS, at("terminal"))).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
