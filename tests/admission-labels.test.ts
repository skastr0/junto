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
        outcome: "Agents can start it right away",
      },
      {
        value: "operator-gated",
        label: "Approval",
        outcome: "Waits for my approval",
      },
      {
        value: "operator-owned",
        label: "Me",
        outcome: "I work it myself",
      },
    ]);
    expect(admissionLabel("auto")).toBe("Immediate");
    expect(admissionOutcome("operator-gated")).toBe("Waits for my approval");
    expect(admissionChoiceLabel("operator-owned")).toBe(
      "Me — I work it myself",
    );
  });
});
