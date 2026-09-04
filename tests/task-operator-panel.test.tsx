import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DefectTargetPicker,
  explicitDefectTarget,
} from "../src/renderer/components/work/TaskOperatorPanel";

describe("TaskOperatorPanel defect targets", () => {
  it("keeps the previous-board fast path implicit and names a deep target", () => {
    expect(explicitDefectTarget("review", "review")).toBeUndefined();
    expect(explicitDefectTarget("review", "briefing")).toBe("briefing");
  });

  it("renders the visited boards, disabled reason, and exact redo consequence", () => {
    const html = renderToStaticMarkup(
      <DefectTargetPicker
        targets={[
          { id: "briefing", label: "Briefing", present: true },
          { id: "build", label: "Build", present: false },
          { id: "review", label: "Review", present: true },
        ]}
        selected="review"
        pending={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("Return to");
    expect(html).toContain("Visited boards");
    expect(html).toContain("No longer a Tasks board");
    expect(html).toContain("Work already accepted before Review stays accepted; everything from Review onward is redone.");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="build"/);
  });

  it("does not promise a consequence for an unavailable selected board", () => {
    const html = renderToStaticMarkup(
      <DefectTargetPicker
        targets={[
          { id: "briefing", label: "Briefing", present: true },
          { id: "build", label: "Build", present: false },
        ]}
        selected="build"
        pending={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain(
      "Build can no longer receive work. Choose another visited board.",
    );
    expect(html).not.toContain("everything from Build onward is redone");
  });
});
