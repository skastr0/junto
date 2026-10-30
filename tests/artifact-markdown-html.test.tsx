import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ArtifactMarkdown } from "../src/renderer/components/work/ArtifactMarkdown";

it("shows a tag as the literal text the writer typed, never dropped and never drawn as HTML", () => {
  const drawn = renderToStaticMarkup(<ArtifactMarkdown source={"From <author>: a <b> c"} />);
  expect(drawn).toContain("<p>From &lt;author&gt;: a &lt;b&gt; c</p>");
  expect(drawn).not.toContain("<b>");
  expect(drawn).not.toContain("<author>");
});

it("keeps a block of HTML as inert text", () => {
  const drawn = renderToStaticMarkup(<ArtifactMarkdown source={"<script>alert(1)</script>"} />);
  expect(drawn).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(drawn).not.toContain("<script");
});

it("draws a line that is only a tag, or a tag block, as a paragraph that keeps its line breaks", () => {
  const drawn = renderToStaticMarkup(<ArtifactMarkdown source={"one\n\n<paths>\n\n<div>\na\nb\n</div>\n\n> <q>"} />);
  expect(drawn).toContain("<p>&lt;paths&gt;</p>");
  expect(drawn).toContain("<p>&lt;div&gt;\na\nb\n&lt;/div&gt;</p>");
  expect(drawn).toContain("<blockquote>\n<p>&lt;q&gt;</p>\n</blockquote>");
});
