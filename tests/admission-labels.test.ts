import { describe, expect, it } from "vitest";
import {
  ADMISSION_ORDER,
  admissionChoiceLabel,
  admissionLabel,
  admissionLabels,
  admissionOutcome,
} from "../src/renderer/lib/admission-labels";

describe("admissionLabels", () => {
  it("names every TaskAdmission with one short label and one outcome", () => {
    expect(ADMISSION_ORDER.map((value) => admissionLabels(value))).toEqual([
      {
        value: "auto",
        label: "Immediate",
        outcome: "Agents can start it right away",
      },
      {
        value: "approval",
        label: "Approval",
        outcome: "Waits for my approval",
      },
      {
        value: "operator",
        label: "Me",
        outcome: "I work it myself",
      },
    ]);
    expect(admissionLabel("auto")).toBe("Immediate");
    expect(admissionOutcome("approval")).toBe("Waits for my approval");
    expect(admissionChoiceLabel("operator")).toBe(
      "Me — I work it myself",
    );
  });
});
