/**
 * The live markdown surfaces as the app imports them: the editor engine
 * stays out of the window's first load (lazySurface). Until it arrives the
 * field holds its place empty.
 */
import type { ComponentProps } from "react";
import { lazySurface } from "../../lib/lazy-surface";
import type { DocumentEditor as LoadedDocumentEditor } from "./DocumentEditor";
import type { LiveMarkdownField as LoadedLiveMarkdownField } from "./LiveMarkdownField";
// The styles stay with the window's, in the order LiveMarkdownField takes them.
import "../embeds/preview-card.css";
import "../ui/code-editor-lines.css";
import "../ui/mention-combobox.css";
import "./mention-picker.css";
import "./live-markdown.css";

const holding = (className: string | undefined, label: string) => (
  <div className={className ? `live-markdown ${className}` : "live-markdown"} role="group" aria-label={label} aria-busy="true" />
);

export const LiveMarkdownField = lazySurface<ComponentProps<typeof LoadedLiveMarkdownField>>(
  () => import("./LiveMarkdownField").then((m) => m.LiveMarkdownField),
  (props) => holding(props.className, props.surfaceLabel),
);

export const DocumentEditor = lazySurface<ComponentProps<typeof LoadedDocumentEditor>>(
  () => import("./DocumentEditor").then((m) => m.DocumentEditor),
  (props) => holding(undefined, props.title ? `${props.title}, document` : "Document"),
);
