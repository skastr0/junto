import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArtifactMarkdown,
  safeArtifactMarkdownUrl,
} from "../src/renderer/components/work/ArtifactMarkdown";

describe("ArtifactMarkdown", () => {
  it("renders CommonMark and GFM structures as React elements", () => {
    const html = renderToStaticMarkup(
      <ArtifactMarkdown
        source={[
          "# Release notes",
          "",
          "- **Fast** renderer",
          "- [x] Markdown support",
          "",
          "| status | value |",
          "| --- | --- |",
          "| ready | yes |",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h1>Release notes</h1>");
    expect(html).toContain("<strong>Fast</strong>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
  });

  it("does not emit raw HTML from agent-authored content", () => {
    const html = renderToStaticMarkup(
      <ArtifactMarkdown source={'<script>alert("nope")</script>\n\nvisible'} />,
    );

    expect(html).not.toContain("<script");
    expect(html).toContain("visible");
  });
});

describe("safeArtifactMarkdownUrl", () => {
  it.each([
    "https://example.com/docs",
    "mailto:operator@example.com",
    "/relative/path",
    "#section",
    "vellum-command-content://object/abc",
  ])("allows %s", (url) => {
    expect(safeArtifactMarkdownUrl(url)).toBe(url);
  });

  it.each(["javascript:alert(1)", "data:text/html,alert(1)", "  "]) (
    "rejects %s",
    (url) => {
      expect(safeArtifactMarkdownUrl(url)).toBeUndefined();
    },
  );
});
