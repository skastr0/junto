/**
 * The code editor as the app imports it: the editor engine stays out of the
 * window's first load (lazySurface). Until it arrives the editor holds its
 * place empty.
 */
import type { ComponentProps } from "react";
import { lazySurface } from "../../lib/lazy-surface";
import type { CodeEditor as LoadedCodeEditor } from "./CodeEditor";
import "./code-editor.css";
import "./code-editor-lines.css";

export const CodeEditor = lazySurface<ComponentProps<typeof LoadedCodeEditor>>(
  () => import("./CodeEditor").then((m) => m.CodeEditor),
  ({ className, readOnly, surfaceLabel = "File" }) => (
    <div
      className={className ? `code-editor ${className}` : "code-editor"}
      data-readonly={readOnly ? "true" : undefined}
      role="group"
      aria-label={surfaceLabel}
      aria-busy="true"
    />
  ),
);
