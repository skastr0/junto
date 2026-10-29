// @vitest-environment jsdom
import { act } from "react";
import { CODE_STEPS_ENABLED } from "../src/shared/features";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type Automation, type AutomationDefinition } from "@shared/automation";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import { ContentRef } from "@shared/wire/content-ref";
import { settleLazy } from "./support/settle-lazy";
import { AutomationsPane } from "../src/renderer/components/automations/AutomationsPane";
import { CODE_TEMPLATE } from "../src/renderer/components/automations/AutomationCodeEditor";
import { makeLocalAutomationsSource, setAutomationsSource, type AutomationsSource } from "../src/renderer/lib/automations-source";
import { setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";
import { loadLazySurfaces } from "../src/renderer/lib/lazy-surface";

// The editors and viewers load before any test, so no test waits on an import.
await loadLazySurfaces();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no Range rectangles; CodeMirror's selection layer asks for them.
Range.prototype.getClientRects = function getClientRects(): DOMRectList {
  return { length: 0, item: () => null } as unknown as DOMRectList;
} as typeof Range.prototype.getClientRects;

const canvas = "automations-code";
const node = asNodeId("automations-1");
const automationId = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");

let host: HTMLDivElement;
let root: Root;
let source: ReturnType<typeof makeLocalAutomationsSource>;
let code: AutomationsSource;
/** The content store this machine would hold, keyed by digest. */
const stored = new Map<string, string>();
let minted = 0;

const refOf = (text: string): ContentRef => {
  minted += 1;
  const sha256 = minted.toString(16).padStart(64, "0");
  stored.set(sha256, text);
  return Schema.decodeUnknownSync(ContentRef)({ sha256, byteLength: new TextEncoder().encode(text).byteLength, mediaType: "text/typescript" });
};

/** A read held open, to test what happens while the code is arriving. */
let heldRead: { readonly resolve: () => void } | undefined;
let slow = false;

const withCode = (base: AutomationsSource): AutomationsSource => ({
  ...base,
  codePut: async (_canvas, text) => ({ kind: "put", ref: refOf(text) }),
  codeRead: async (_canvas, ref) => {
    const text = stored.get(ref.sha256);
    const answer =
      text === undefined
        ? ({ kind: "refused", refusal: { reason: "not_available", message: "this machine has no copy" } } as const)
        : ({ kind: "read", text } as const);
    if (!slow) return answer;
    return new Promise((resolve) => {
      heldRead = { resolve: () => resolve(answer) };
    });
  },
});

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  await settleLazy();
};

const render = async (): Promise<void> => {
  await act(async () => root.render(<AutomationsPane canvasName={canvas} nodeId={node} author={{ kind: "operator" }} onClose={() => undefined} />));
  await flush();
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim().replace(/\s+/g, " ") === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

/** The sidebar's row for one automation: its title, then its trigger in a few words. */
const row = async (): Promise<void> => {
  const found = [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim().startsWith("Nightly check"));
  if (!found) throw new Error("no row for Nightly check");
  await act(async () => found.click());
  await flush();
};

const click = async (name: string): Promise<void> => {
  await act(async () => button(name).click());
  await flush();
};

const definition = (then: AutomationDefinition["then"]): AutomationDefinition => ({
  name: "Nightly check",
  trigger: { kind: "schedule", cron: "0 3 * * *", timezone: "UTC" },
  then,
  limits: DEFAULT_AUTOMATION_LIMITS,
});

const saved = async (): Promise<Automation> =>
  (await source.list(canvas, node)).automations.find((automation) => automation.automationId === automationId)!;

/** The editor's view, for typing into it as a person would. */
const editor = (): EditorView => EditorView.findFromDOM(document.body.querySelector<HTMLElement>(".cm-editor")!)!;

const replaceCode = async (text: string): Promise<void> => {
  await act(async () => {
    const view = editor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
  await flush();
};

beforeEach(() => {
  setNodeViewStore(makeMemoryNodeViewStore());
  source = makeLocalAutomationsSource();
  code = withCode(source);
  setAutomationsSource(code);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  stored.clear();
});

const opened = async (then?: AutomationDefinition["then"]): Promise<void> => {
  await source.apply(canvas, node, automationId, {
    kind: "create",
    automationId,
    enabled: true,
    definition: definition(then ?? [{ kind: "code", language: "typescript", source: refOf("const answer = 1;\n") }]),
  });
  await render();
  await row();
};

describe("a code step in the Automations node", () => {
  it("asks before Escape closes the pane with unsaved code, and Cancel keeps it", async () => {
    await opened();
    await click("Edit code");
    await replaceCode("const answer = 6;\n");
    // Inside the pane: the modal stack only hands Escape to the surface it holds.
    await act(async () => {
      document.querySelector(".automations-node")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("Discard this code?");
    await click("Cancel");
    expect(editor().state.doc.toString()).toBe("const answer = 6;\n");
  });

  it("asks before Revert drops typed code, and Discard puts the saved program back", async () => {
    await opened();
    await click("Edit code");
    await replaceCode("const answer = 5;\n");
    await click("Revert");
    expect(document.body.textContent).toContain("Discard this code?");
    await click("Discard");
    expect(editor().state.doc.toString()).toBe("const answer = 1;\n");
  });

  it("offers no Save while the code is still opening", async () => {
    slow = true;
    try {
      await opened();
      await click("Edit code");
      expect(document.body.textContent).toContain("Opening the code.");
      expect(button("Save").getAttribute("aria-disabled")).toBe("true");
      heldRead!.resolve();
      await flush();
      // Opened, the saved program is what the store holds: still nothing to save until it is typed into.
      expect(button("Save").getAttribute("aria-disabled")).toBe("true");
      await replaceCode("const answer = 8;\n");
      expect(button("Save").getAttribute("aria-disabled")).not.toBe("true");
    } finally {
      slow = false;
      heldRead = undefined;
    }
  });

  it("leaves the keyboard where the operator put it when the code arrives late", async () => {
    slow = true;
    try {
      await opened();
      await click("Edit code");
      const field = document.createElement("input");
      field.setAttribute("aria-label", "Somewhere else");
      document.body.append(field);
      act(() => field.focus());
      heldRead!.resolve();
      await flush();
      expect(document.activeElement).toBe(field);
    } finally {
      slow = false;
      heldRead = undefined;
    }
  });

  it("opens the stored program and saves an edit as new content", async () => {
    await opened();
    await click("Edit code");
    // The keyboard follows the view into the code, never to the body.
    expect(document.body.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.closest(".cm-content")).not.toBeNull();
    expect(editor().state.doc.toString()).toBe("const answer = 1;\n");

    await replaceCode("const answer = 2;\n");
    await click("Save");
    await flush();

    const storedNow = await saved();
    const step = storedNow.then[0]!;
    expect(step.kind).toBe("code");
    if (step.kind !== "code") throw new Error("not a code step");
    expect(stored.get(step.source.sha256)).toBe("const answer = 2;\n");
    // The panel stays open on the saved text, now read back from the store.
    expect(editor().state.doc.toString()).toBe("const answer = 2;\n");
  });

  it.runIf(CODE_STEPS_ENABLED)("opens a step never written on the template, and refuses to save it empty", async () => {
    await opened([{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }]);
    // The action's kind becomes Run code, which has no program yet.
    await act(async () => button("Send mail").click());
    await flush();
    const runCode = [...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("Run code"));
    await act(async () => (runCode as HTMLElement).click());
    await flush();
    await click("Write code");
    expect(editor().state.doc.toString()).toBe(CODE_TEMPLATE);
    // The template is worth saving as it stands: this step has no program yet.
    expect(button("Save").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("leaves the code view on Back once the code is saved", async () => {
    await opened();
    await click("Edit code");
    await replaceCode("const answer = 7;\n");
    await click("Save");
    await flush();
    // A clean buffer offers no Save: the button reads as disabled and pressing it does nothing.
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
    await click("Back");
    expect(document.body.querySelector("[data-testid='automation-code']")).toBeNull();
    expect(button("Edit code")).not.toBeNull();
  });

  it("asks before Back drops code that was typed, and keeps the view on cancel", async () => {
    await opened();
    await click("Edit code");
    await replaceCode("const answer = 3;\n");
    await click("Back");
    const dialog = document.body.querySelector("[role='alertdialog']")!;
    expect(dialog.textContent).toContain("Discard this code?");
    await act(async () => [...dialog.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Cancel")!.click());
    await flush();
    expect(editor().state.doc.toString()).toBe("const answer = 3;\n");
  });

  it("stops a code save in words when another step is unfinished", async () => {
    await opened();
    // A second action, a mail with nobody to send to, is unfinished in the definition view.
    await act(async () => button("Action").click());
    await flush();
    await click("Edit code");
    await replaceCode("const answer = 4;\n");
    await click("Save");
    expect(document.body.textContent).toContain("The automation has one thing to fix before it saves. Back shows it.");
    // Nothing was put: the stored program is still the one it opened on.
    const step = (await saved()).then[0]!;
    if (step.kind !== "code") throw new Error("not a code step");
    expect(stored.get(step.source.sha256)).toBe("const answer = 1;\n");
  });

  it.runIf(CODE_STEPS_ENABLED)("opens a shell step on a shell template", async () => {
    await opened([{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }]);
    await act(async () => button("Send mail").click());
    await flush();
    const runCode = [...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("Run code"));
    await act(async () => (runCode as HTMLElement).click());
    await flush();
    // The language reads through the same select the definition shows.
    await act(async () => button("TypeScript").click());
    await flush();
    const shell = [...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("Shell"));
    await act(async () => (shell as HTMLElement).click());
    await flush();
    await click("Write code");
    expect(editor().state.doc.toString()).toContain("cat > /dev/null");
  });

  it("shows the step's last result, with its values and its error tail", async () => {
    await opened();
    const at = 1_700_000_000_000;
    source.record(canvas, {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF1"),
      automationId,
      at,
      cause: { kind: "run" },
      outcome: {
        kind: "fired",
        actions: [{ index: 0, ruling: "continued", output: { total: 3 }, durationMs: 120 }],
      },
    });
    await render();
    await row();
    expect(document.body.textContent).toContain("answered {{code.total}} in 120 ms");
    expect(document.body.textContent).toContain("{{code.total}}");

    source.record(canvas, {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF2"),
      automationId,
      at: at + 60_000,
      cause: { kind: "run" },
      outcome: {
        kind: "fired",
        actions: [{ index: 0, ruling: "failed", message: "timeout", logTail: "slow line\n", durationMs: 60_000 }],
      },
    });
    await render();
    await row();
    await click("Edit code");
    expect(document.body.textContent).toContain("failed: timeout");
    expect(document.body.textContent).toContain("slow line");
  });
});
