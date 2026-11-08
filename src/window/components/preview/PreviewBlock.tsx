import { previewMarkdownText, previewTextFace, type PreviewRef, type PreviewResult } from "@shared/preview";
import { CommitPreview } from "../git/CommitPreview";
import { CodeBlock, DiffView } from "../ui";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";

/** The seat a card came from: what a commit is read against. */
export type PreviewSeat = { readonly canvasName: string; readonly nodeId: string };

/**
 * Highlighting walks every line: past this much text a file is shown plain,
 * whole, instead of holding the window while it is coloured.
 */
const HIGHLIGHT_MAX_CHARS = 1024 * 1024;

/** Whether a preview is one this component draws: text in any face, a compare, a commit. */
export const isPreviewBlock = (result: PreviewResult | undefined): boolean =>
  result?.ok === true && (result.kind === "text" || result.kind === "compare" || result.kind === "commit");

/**
 * One preview that is read rather than looked at: a diff, a code block,
 * markdown, plain text, a compare of two texts, or a commit. The same faces
 * on a card (`card`: one column, narrow) and on the viewer's stage (`stage`:
 * side by side where there is a before and an after).
 *
 * It only draws what it is handed; the commit is the one face that reads,
 * and it reads the sending seat's own folder.
 */
export function PreviewBlock({
  item,
  result,
  layout,
  seat,
  onReviewCommit,
}: {
  readonly item: PreviewRef;
  readonly result: PreviewResult;
  readonly layout: "card" | "stage";
  readonly seat?: PreviewSeat | undefined;
  /** Open the full review of a commit. Given only where the feed can be left for it. */
  readonly onReviewCommit?: ((sha: string) => void) | undefined;
}) {
  if (!result.ok) return null;
  const diffLayout = layout === "stage" ? "split" : "unified";
  if (result.kind === "compare") {
    return <DiffView before={result.before} after={result.after} name={result.name} layout={diffLayout} />;
  }
  if (result.kind === "commit") {
    return seat ? (
      <CommitPreview
        canvasName={seat.canvasName}
        nodeId={seat.nodeId}
        sha={result.sha}
        layout={diffLayout}
        onReview={onReviewCommit ? () => onReviewCommit(result.sha) : undefined}
      />
    ) : (
      <pre>{result.sha}</pre>
    );
  }
  if (result.kind !== "text") return null;
  const face = result.format === "markdown" ? "markdown" : previewTextFace(item.name);
  if (face === "markdown") {
    // A file's own markdown images never load by themselves either.
    return <ArtifactMarkdown source={previewMarkdownText(result.text)} />;
  }
  if (face === "plain" || result.text.length > HIGHLIGHT_MAX_CHARS) return <pre>{result.text}</pre>;
  if (face === "diff") return <DiffView patch={result.text} layout={diffLayout} />;
  return <CodeBlock text={result.text} name={item.name} />;
}
