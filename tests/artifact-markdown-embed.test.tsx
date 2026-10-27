import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ArtifactMarkdown } from "../src/renderer/components/work/ArtifactMarkdown";

const href = "junto://canvas/factory?node=agent-01M46TAATD7VE4ZQA4VRKMX3MP";

it("reads a bang mention as its chip where the app draws links, and blocks it where it does not", () => {
  const source = `![@product-lead](${href})`;
  const drawn = renderToStaticMarkup(
    <ArtifactMarkdown source={source} renderLink={(link, label) => <b data-href={link}>{label}</b>} />,
  );
  expect(drawn).toContain(`<b data-href="${href.replaceAll("&", "&amp;")}">@product-lead</b>`);
  expect(renderToStaticMarkup(<ArtifactMarkdown source={source} />)).toContain("[image blocked]");
});
