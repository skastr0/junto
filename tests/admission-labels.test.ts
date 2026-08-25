import { describe, expect, it } from "vitest";
import {
  ADMISSION_ORDER,
  admissionChoiceLabel,
  admissionLabel,
  admissionLabels,
  admissionOutcome,
} from "../src/renderer/lib/admission-labels";

describe("admissionLabels", () => {
  it("names every SinkAdmission with one short label and one outcome", () => {
    expect(ADMISSION_ORDER.map((value) => admissionLabels(value))).toEqual([
      {
        value: "auto",
        label: "Immediate",
        outcome: "Goes live immediately",
      },
      {
        value: "operator-gated",
        label: "Approval",
        outcome: "Waits for my approval",
      },
      {
        value: "operator-owned",
        label: "Mine",
        outcome: "I work it myself",
      },
    ]);
    expect(admissionLabel("auto")).toBe("Immediate");
    expect(admissionOutcome("operator-gated")).toBe("Waits for my approval");
    expect(admissionChoiceLabel("operator-owned")).toBe(
      "Mine — I work it myself",
    );
  });
});
