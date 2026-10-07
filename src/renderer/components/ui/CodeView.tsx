/**
 * Code, and changes to code, drawn one way everywhere: a diff from unified
 * diff text, a diff from a before and an after text, and a code block.
 *
 * This is the only place the diff library is imported. It knows nothing of
 * git: a caller hands over text, a name or a language to highlight by, and
 * nothing else. Every colour, size and face comes from the house tokens
 * through the library's own variables (code-view.css); the library's theme
 * supplies the syntax colours only. Text the library cannot draw is shown
 * plain rather than taking the surface down.
 */
import { Component, useMemo, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { File, MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import { getFiletypeFromFileName, type DiffLineAnnotation } from "@pierre/diffs";
import { splitPatchFiles } from "@shared/git";
import { themeMode$ } from "../../lib/theme-mode";
import "./code-view.css";

export type { DiffLineAnnotation };
export type DiffSide = "additions" | "deletions";

type PatchProps<A> = Parameters<typeof PatchDiff<A>>[0];
type FileContents = Parameters<typeof File>[0]["file"];

const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

const useThemeType = (): "light" | "dark" => (use$(themeMode$) === "bright" ? "light" : "dark");

// What people call a language, as the file ending the library knows it by.
const LANGUAGE_ENDING: Readonly<Record<string, string>> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  ruby: "rb",
  golang: "go",
  kotlin: "kt",
  csharp: "cs",
  "c#": "cs",
  "c++": "cpp",
  shell: "sh",
  zsh: "sh",
  markdown: "md",
  yaml: "yml",
  dockerfile: "docker",
  plaintext: "txt",
  text: "txt",
};

/**
 * A language an agent named, as one the library can highlight. A name it does
 * not know is no language at all, so the text is shown plain and never lost.
 */
const knownLanguage = (language: string | undefined): NonNullable<FileContents["lang"]> | undefined => {
  const asked = language?.trim().toLowerCase();
  if (!asked) return undefined;
  const known = getFiletypeFromFileName(`x.${LANGUAGE_ENDING[asked] ?? asked}`);
  return known === "text" ? undefined : known;
};

const contents = (name: string | undefined, text: string, language: string | undefined): FileContents => {
  const lang = knownLanguage(language);
  return { name: name?.trim() || "text", contents: text, ...(lang ? { lang } : {}) };
};

/** Text the library could not draw is still shown, plain. */
class PlainOnFailure extends Component<{ readonly text: string; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <pre className="code-view__plain">{this.props.text}</pre>;
  }
}

export type DiffSource =
  /** Unified diff text, one file or several. */
  | { readonly patch: string }
  /** Two texts; the diff is worked out here. */
  | { readonly before: string; readonly after: string };

/**
 * A diff. Rows that sit between lines (comments), a control beside the line
 * under the pointer, and line selection are the caller's to add; without
 * them the diff is read only.
 */
export function DiffView<A = undefined>({
  name,
  language,
  layout = "split",
  header = true,
  lineAnnotations,
  renderAnnotation,
  renderGutterUtility,
  onLineSelected,
  ...source
}: DiffSource & {
  /** A file name: shown in the header, and what the language is read from. */
  readonly name?: string | undefined;
  /** The language to highlight by, when the name does not say. */
  readonly language?: string | undefined;
  readonly layout?: "split" | "unified" | undefined;
  /** The file's name and counts above the diff. */
  readonly header?: boolean | undefined;
  readonly lineAnnotations?: PatchProps<A>["lineAnnotations"];
  readonly renderAnnotation?: PatchProps<A>["renderAnnotation"];
  readonly renderGutterUtility?: PatchProps<A>["renderGutterUtility"];
  readonly onLineSelected?: NonNullable<PatchProps<A>["options"]>["onLineSelected"];
}) {
  const themeType = useThemeType();
  const patch = "patch" in source ? source.patch : undefined;
  const sections = useMemo(() => (patch === undefined ? [] : splitPatchFiles(patch)), [patch]);
  const options = {
    theme: THEME,
    themeType,
    overflow: "scroll" as const,
    diffStyle: layout,
    disableFileHeader: !header,
    ...(renderGutterUtility ? { enableGutterUtility: true } : {}),
    ...(onLineSelected ? { enableLineSelection: true, onLineSelected } : {}),
  };
  if ("patch" in source) {
    return (
      <div className="code-view" data-kind="diff">
        {(sections.length > 0 ? sections : [source.patch]).map((section, index) => (
          <PlainOnFailure key={`${String(index)}:${section.slice(0, 200)}`} text={section}>
            <PatchDiff<A>
              patch={section}
              disableWorkerPool
              options={options}
              {...(lineAnnotations ? { lineAnnotations } : {})}
              {...(renderAnnotation ? { renderAnnotation } : {})}
              {...(renderGutterUtility ? { renderGutterUtility } : {})}
            />
          </PlainOnFailure>
        ))}
      </div>
    );
  }
  return (
    <div className="code-view" data-kind="diff">
      <PlainOnFailure text={source.after}>
        <MultiFileDiff<A>
          oldFile={contents(name, source.before, language)}
          newFile={contents(name, source.after, language)}
          disableWorkerPool
          options={options}
          {...(lineAnnotations ? { lineAnnotations } : {})}
          {...(renderAnnotation ? { renderAnnotation } : {})}
          {...(renderGutterUtility ? { renderGutterUtility } : {})}
        />
      </PlainOnFailure>
    </div>
  );
}

/** A block of code or text, highlighted by its language or its name. */
export function CodeBlock({
  text,
  name,
  language,
  lineNumbers = true,
}: {
  readonly text: string;
  /** A file name: shown above the block, and what the language is read from. */
  readonly name?: string | undefined;
  readonly language?: string | undefined;
  readonly lineNumbers?: boolean | undefined;
}) {
  const themeType = useThemeType();
  return (
    <div className="code-view" data-kind="code">
      <PlainOnFailure text={text}>
        <File
          file={contents(name, text, language)}
          disableWorkerPool
          options={{
            theme: THEME,
            themeType,
            overflow: "scroll",
            disableFileHeader: !name?.trim(),
            disableLineNumbers: !lineNumbers,
          }}
        />
      </PlainOnFailure>
    </div>
  );
}
