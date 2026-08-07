import { describe, expect, it } from "vitest";
import {
  mirrorArtifactsText,
  mirrorBoardText,
  mirrorTasksText,
} from "../src/shared/task";

describe("mirrorBoardText", () => {
  it("empty board uses the kind name, never quiet", () => {
    expect(mirrorBoardText([])).toBe("board");
    expect(mirrorBoardText([])).not.toBe("quiet");
  });

  it("lists up to four recent topic titles when present", () => {
    expect(
      mirrorBoardText([
        { title: "alpha" },
        { title: "beta" },
        { title: "gamma" },
        { title: "delta" },
        { title: "epsilon" },
      ]),
    ).toBe("- alpha\n- beta\n- gamma\n- delta");
  });

  it("matches other empty sink mirrors: kind identity, not mood", () => {
    expect(mirrorTasksText([])).toBe("tasks");
    expect(mirrorArtifactsText([])).toBe("artifacts");
    expect(mirrorBoardText([])).toBe("board");
  });
});
