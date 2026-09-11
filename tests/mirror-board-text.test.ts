import { describe, expect, it } from "vitest";
import {
  boardTitleFromText,
  mirrorArtifactsText,
  mirrorBoardText,
  mirrorTasksText,
} from "../src/shared/task";

describe("boardTitleFromText", () => {
  it("takes the first line, trimmed", () => {
    expect(boardTitleFromText("Fleet announcements\n- topic")).toBe(
      "Fleet announcements",
    );
    expect(boardTitleFromText("  spaced  \n- topic")).toBe("spaced");
  });

  it("falls back to the kind name when empty", () => {
    expect(boardTitleFromText("")).toBe("board");
    expect(boardTitleFromText("  \n  ")).toBe("board");
  });
});

describe("mirrorBoardText", () => {
  it("keeps the authored title as the first line", () => {
    expect(mirrorBoardText("Fleet announcements", [])).toBe(
      "Fleet announcements",
    );
  });

  it("lists up to four recent topic titles beneath the title", () => {
    expect(
      mirrorBoardText("Fleet announcements", [
        { title: "alpha" },
        { title: "beta" },
        { title: "gamma" },
        { title: "delta" },
        { title: "epsilon" },
      ]),
    ).toBe("Fleet announcements\n- alpha\n- beta\n- gamma\n- delta");
  });

  it("an empty titled board keeps its title, not the kind name", () => {
    expect(mirrorBoardText("Fleet announcements", [])).not.toBe("board");
  });

  it("an untitled empty board uses the kind name, never quiet", () => {
    expect(mirrorBoardText("", [])).toBe("board");
    expect(mirrorBoardText("", [])).not.toBe("quiet");
    expect(mirrorBoardText("board", [])).toBe("board");
  });

  it("matches other empty sink mirrors: kind identity, not mood", () => {
    expect(mirrorTasksText([])).toBe("tasks");
    expect(mirrorArtifactsText([])).toBe("artifacts");
    expect(mirrorBoardText("board", [])).toBe("board");
  });

  it("is idempotent across projection passes (title survives)", () => {
    const once = mirrorBoardText("Fleet announcements", [{ title: "alpha" }]);
    const twice = mirrorBoardText(once, [{ title: "alpha" }]);
    expect(twice).toBe(once);
  });
});
