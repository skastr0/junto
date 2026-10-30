/**
 * One rehype pass for threads: a long machine id reads as one mono token, the
 * whole value kept in the text and cut by the stylesheet (seat-threads.css),
 * so selecting it or hearing it still gives the whole id. It rides
 * ArtifactMarkdown's optional rehypePlugins prop, so no other surface sees it.
 */
import { idSegments } from "../../lib/thread-text";

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Array<HastNode>;
};

const idToken = (id: string): HastNode => ({
  type: "element",
  tagName: "span",
  properties: { className: ["seat-threads__id"] },
  children: [{ type: "text", value: id }],
});

/** Ids as tokens through one tree, stopping at code, which stays verbatim. */
const walkIds = (node: HastNode): void => {
  if (!Array.isArray(node.children)) return;
  if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre")) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value !== undefined) {
      const segments = idSegments(child.value);
      if (segments.length === 1 && segments[0]!.id === undefined) return [child];
      return segments.map((segment) => (segment.id === undefined ? { type: "text", value: segment.text } : idToken(segment.id)));
    }
    walkIds(child);
    return [child];
  });
};

/** The rehype pass: each long id is its own token. */
export const rehypeThreadInlineIds = () => (tree: HastNode): void => walkIds(tree);
