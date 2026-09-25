// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstLineRenameInput } from "../src/renderer/components/nodes/FirstLineRenameInput";
import {
  claimFocusOnMount,
  noteOperatorGesture,
  resetOperatorGesture,
} from "../src/renderer/lib/focus-ownership";
import { shouldCycleAlertOnKey } from "../src/renderer/lib/alert-attention";
import { isEditableEventTarget } from "../src/renderer/lib/multi-select-gesture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const typeInto = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

function RenameCard({ name, activity }: { readonly name: string; readonly activity: number }) {
  // Mirrors EntityCard: live seat activity repaints beside the rename field.
  return (
    <div className="react-flow__node">
      <FirstLineRenameInput initial={name} ariaLabel="Rename agent node" onCommit={() => undefined} onDone={onDoneSpy} />
      <span data-activity={activity} />
    </div>
  );
}
const onDoneSpy = vi.fn();

function LateField() {
  return (
    <div role="dialog">
      <input aria-label="late" ref={claimFocusOnMount} />
    </div>
  );
}

describe("focus law regression classes", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetOperatorGesture();
    onDoneSpy.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("B: live repaints and name echoes do not reset the rename draft or caret", () => {
    act(() => root.render(<RenameCard name="builder" activity={0} />));
    const input = host.querySelector("input")!;
    act(() => typeInto(input, "builder-two"));
    input.setSelectionRange(4, 4);

    for (let tick = 1; tick <= 20; tick++) {
      act(() => root.render(<RenameCard name={tick % 2 ? "builder" : "echo"} activity={tick} />));
    }

    expect(host.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("builder-two");
    expect(input.selectionStart).toBe(4);
    expect(onDoneSpy).not.toHaveBeenCalled();
  });

  it("C: a field that mounts while the operator types elsewhere stays quiet", () => {
    act(() => root.render(<RenameCard name="builder" activity={0} />));
    const input = host.querySelector("input")!;
    noteOperatorGesture({ target: input, kind: "key", chord: false });

    act(() => root.render(<><RenameCard name="builder" activity={1} /><LateField /></>));

    expect(document.activeElement).toBe(input);
    expect(onDoneSpy).not.toHaveBeenCalled();
  });

  it("C: the same mount claims focus when the operator clicked to open it", () => {
    act(() => root.render(<RenameCard name="builder" activity={0} />));
    noteOperatorGesture({ target: document.body, kind: "pointer", chord: false });

    act(() => root.render(<><RenameCard name="builder" activity={1} /><LateField /></>));

    expect(document.activeElement).toBe(host.querySelector('input[aria-label="late"]'));
  });

  it("F: global keys yield to every typing field through one guard", () => {
    const fields = document.createElement("div");
    fields.innerHTML = `
      <textarea id="note"></textarea>
      <select id="pick"><option>a</option></select>
      <div class="xterm"><textarea class="xterm-helper-textarea" id="pty"></textarea></div>
      <button id="chrome">x</button>`;
    document.body.appendChild(fields);
    const space = { repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: " ", code: "Space" };
    const at = (id: string) => fields.querySelector(`#${id}`);

    expect(shouldCycleAlertOnKey({ ...space, target: at("note") })).toBe(false);
    expect(shouldCycleAlertOnKey({ ...space, target: at("pty") })).toBe(false);
    expect(shouldCycleAlertOnKey({ ...space, target: at("chrome") })).toBe(true);
    expect(isEditableEventTarget(at("pick"))).toBe(true);
    expect(isEditableEventTarget(at("pty"))).toBe(true);
    expect(isEditableEventTarget(at("chrome"))).toBe(false);
    fields.remove();
  });
});
