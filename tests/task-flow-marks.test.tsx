import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ArrivalMark,
  ArrivalNoteComposer,
} from "../src/renderer/components/work/TaskFlowMarks";

describe("arrival decision controls", () => {
  it("keeps the direct promote path and offers reject plus contextual review", () => {
    const html = renderToStaticMarkup(
      <ArrivalMark
        glance={{ admission: "operator-gated", promotable: true }}
        gatedStation
        pending={false}
        onPromote={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(html).toContain(">Promote<");
    expect(html).toContain(">Reject<");
    expect(html).toContain("Add context before deciding");
  });

  it("teaches the note purpose and exposes both decisions", () => {
    const html = renderToStaticMarkup(
      <ArrivalNoteComposer
        note="Check the retry boundary"
        pending={false}
        onNoteChange={vi.fn()}
        onCancel={vi.fn()}
        onPromote={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(html).toContain("What should the claimant focus on?");
    expect(html).toContain("Promote with note");
    expect(html).toContain("Reject with note");
  });
});
