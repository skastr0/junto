// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { taskNodeId, type TaskCommand, type TaskId } from "../src/shared/task-model";
import { TaskBody } from "../src/renderer/components/tasks/TaskBody";
import { settleLazy } from "./support/settle-lazy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const board = taskNodeId(asNodeId("board"));
const taskId = mintItemId() as TaskId;
const REST = 900;

describe("a task body", () => {
  let host: HTMLDivElement;
  let root: Root;
  let sent: TaskCommand[];
  let refuse: string | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    sent = [];
    refuse = undefined;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const draw = async (body: string, readOnly = false) => {
    await act(async () =>
      root.render(
        <TaskBody
          canvasName="factory"
          node={board}
          taskId={taskId}
          title="Ship"
          body={body}
          all={[]}
          readOnly={readOnly}
          apply={async (command) => {
            sent.push(command);
            return refuse;
          }}
        />,
      ),
    );
    await settleLazy();
  };
  const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
  const typeAtEnd = async (text: string) =>
    act(async () => {
      const view = editor();
      const at = view.state.doc.length;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
    });
  const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, REST)));

  it("renders the body's markdown, not its marks", async () => {
    await draw("## Why\n\nThe feed shows **plain text**.");
    // The editor parses after it mounts; the rendering follows the parse.
    await vi.waitFor(() => expect(host.querySelector("[data-testid=task-body]")!.textContent).toContain("The feed shows plain text."));
    expect(host.querySelector(".cm-md-h2")).not.toBeNull();
    expect(host.querySelector(".cm-md-strong")).not.toBeNull();
  });

  it("saves typing when it rests, whole, through the task's edit", async () => {
    await draw("First line.");
    await typeAtEnd(" More.");
    expect(sent).toEqual([]);
    await rest();
    expect(sent).toEqual([{ kind: "edit", body: "First line. More." }]);
  });

  it("takes another writer's body while nothing is unsaved, and keeps typing that is", async () => {
    await draw("Agent wrote this.");
    await draw("Agent wrote this, then more.");
    expect(editor().state.doc.toString()).toBe("Agent wrote this, then more.");
    await typeAtEnd(" Mine.");
    await draw("Agent changed it again.");
    expect(editor().state.doc.toString()).toBe("Agent wrote this, then more. Mine.");
    await rest();
    expect(sent).toEqual([{ kind: "edit", body: "Agent wrote this, then more. Mine." }]);
  });

  it("a refused save is tried again on the next rest", async () => {
    await draw("Base.");
    refuse = "Body is too long";
    await typeAtEnd(" x");
    await rest();
    refuse = undefined;
    await typeAtEnd("y");
    await rest();
    expect(sent.map((command) => (command.kind === "edit" ? command.body : ""))).toEqual(["Base. x", "Base. xy"]);
  });

  it("an archived task with nothing written draws nothing; with a body it reads, no caret", async () => {
    await draw("", true);
    expect(host.querySelector("[data-testid=task-body]")).toBeNull();
    await draw("Done and archived.", true);
    expect(editor().state.readOnly).toBe(true);
  });
});
