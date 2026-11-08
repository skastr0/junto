/**
 * Code blocks and diffs as the app imports them: the diff library and its
 * highlighter stay out of the window's first load (lazySurface). Until they
 * arrive the text shows plain, as it does when the library cannot draw it.
 */
import type { ReactNode } from "react";
import { lazySurface } from "../../lib/lazy-surface";
import type { CodeBlock as LoadedCodeBlock, DiffView as LoadedDiffView } from "./CodeView";
import "./code-view.css";

type DiffProps<A> = Parameters<typeof LoadedDiffView<A>>[0];

const plain = (kind: "code" | "diff", text: string): ReactNode => (
  <div className="code-view" data-kind={kind}>
    <pre className="code-view__plain">{text}</pre>
  </div>
);

export const CodeBlock = lazySurface<Parameters<typeof LoadedCodeBlock>[0]>(
  () => import("./CodeView").then((m) => m.CodeBlock),
  (props) => plain("code", props.text),
);

// The cast keeps DiffView generic over its annotations, which a component value drops.
export const DiffView = lazySurface<DiffProps<unknown>>(
  () => import("./CodeView").then((m) => m.DiffView as (props: DiffProps<unknown>) => ReactNode),
  (props) => plain("diff", "patch" in props ? props.patch : props.after),
) as <A = undefined>(props: DiffProps<A>) => ReactNode;
