import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { DoctorReport } from "../src/shared/contracts";

describe("shared contracts", () => {
  it("decodes a doctor report envelope", () => {
    const decode = Schema.decodeUnknownSync(DoctorReport);

    const report = decode({
      checkedAt: "2026-05-09T00:00:00.000Z",
      station: {
        name: "Junto",
        version: "0.1.0",
        userDataPath: "/tmp/junto",
      },
      services: [
        {
          id: "codex",
          label: "Codex CLI",
          status: "ok",
          detail: "codex 0.0.0",
        },
      ],
      recommendations: [],
    });

    expect(report.services[0]?.status).toBe("ok");
  });
});
