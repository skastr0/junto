import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalMark,
  ApprovalNoteComposer,
} from "../src/renderer/components/work/TaskPathMarks";

describe("approval decision controls", () => {
  it("offers the promote path plus contextual review", () => {
    const html = renderToStaticMarkup(
      <ApprovalMark
        glance={{ admission: "approval", promotable: true }}
        gatedBoard
        pending={false}
        onPromote={vi.fn()}
      />,
    );

    expect(html).toContain(">Approve<");
    expect(html).toContain("Add context before deciding");
  });

  it("shows approval before a wait that starts after approval", () => {
    const html = renderToStaticMarkup(
      <ApprovalMark
        glance={{ admission: "approval", countdown: "12h 00m", promotable: true }}
        gatedBoard
        pending={false}
        onPromote={vi.fn()}
      />,
    );

    expect(html).toContain("Awaiting approval");
    expect(html).not.toContain("Wait 12h 00m");
  });

  it("teaches the note purpose and exposes the approve decision", () => {
    const html = renderToStaticMarkup(
      <ApprovalNoteComposer
        note="Check the retry boundary"
        pending={false}
        onNoteChange={vi.fn()}
        onCancel={vi.fn()}
        onPromote={vi.fn()}
      />,
    );

    expect(html).toContain("What should the next worker focus on?");
    expect(html).toContain("Approve with note");
  });

  it("is silent for claimable admission on an open board", () => {
    const html = renderToStaticMarkup(
      <ApprovalMark
        glance={{ admission: "claimable", promotable: false }}
        gatedBoard={false}
        pending={false}
      />,
    );
    expect(html).toBe("");
  });
});
