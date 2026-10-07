import { describe, expect, it } from "vitest";
import { bodySha256Of } from "../src/main/junto/work/body-sha256";
import { intentSha256Of } from "./helpers/authorial-material";

describe("retained projection identity", () => {
  it("hashes exact bytes without parsing or normalizing the body", () => {
    expect(bodySha256Of("{}")).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(bodySha256Of("{ } ")).not.toBe(bodySha256Of("{}"));
    expect(bodySha256Of("é")).not.toBe(bodySha256Of("e\u0301"));
  });

  it("keeps the frozen station fixture's historical portfolio ordering", () => {
    const revisions = new Map([
      ["alpha-", { revisionSha256: "0".repeat(64) }],
      ["alpha_", { revisionSha256: "1".repeat(64) }],
      ["alpha", { revisionSha256: "2".repeat(64) }],
    ]);
    expect(intentSha256Of(revisions)).toBe("c6f7c2d0959b933cd6c4b8cc816f7495d5919c9cd427b22a3d862876a822dc7b");
  });
});
