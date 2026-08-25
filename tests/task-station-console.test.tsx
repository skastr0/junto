import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DefectTargetPicker,
  explicitDefectTarget,
} from "../src/renderer/components/work/TaskStationConsole";

describe("TaskStationConsole defect targets", () => {
  it("keeps the previous-station fast path implicit and names a deep target", () => {
    expect(explicitDefectTarget("review", "review")).toBeUndefined();
    expect(explicitDefectTarget("review", "briefing")).toBe("briefing");
  });

  it("renders the visited line, disabled reason, and exact redo consequence", () => {
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
    expect(html).toContain("Visited line");
    expect(html).toContain("No longer a task station");
    expect(html).toContain("Work already accepted before Review stays accepted; everything from Review onward is redone.");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="build"/);
  });
});
