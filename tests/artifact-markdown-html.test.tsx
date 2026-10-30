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
