/**
 * One automation's code step, edited in the Automations node's own surface
 * (plan 0.11/05, Code steps). The program is content, not definition text:
 * Save puts it in the content store and saves the automation naming the new
 * ref, so the definition always points at a program that exists.
 *
 * The result block is the step's ruling from the last firing: what it
 * answered, why it stopped, or why it failed, with the stderr tail main
 * already scrubbed.
 */
import { useEffect, useRef } from "react";
import { ChevronLeft } from "lucide-react";
import type { ActionRuling, CodeLanguage } from "@shared/automation";
import { Button, Eyebrow } from "../ui";
import { CodeEditor } from "../ui/lazy-code-editor";
// Type only: erased at build, so the engine still loads outside the first chunk.
import type { CodeEditorHandle } from "../ui/CodeEditor";
import { codeRulingWords } from "../../lib/automation-editor";

/** The step's source as the editor opens it: what to write, and the shape the SDK gives it. */
export const CODE_TEMPLATE = `import { input, cont } from "junto/automation";

const { values } = input();

cont({ at: values["fired.at"] ?? "" });
`;

/** A shell step's source: values on stdin, the exit code decides. */
export const SHELL_TEMPLATE = `# The firing's values arrive as JSON on stdin.
# Exit 0 continues the automation; anything else fails this step.
cat > /dev/null
exit 0
`;

/** A step never written opens on its language's shape. */
export const codeTemplate = (language: CodeLanguage): string => (language === "typescript" ? CODE_TEMPLATE : SHELL_TEMPLATE);

const languageWords = (language: CodeLanguage): string => (language === "typescript" ? "TypeScript" : "Shell");

const secondsWords = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} seconds` : `${(ms / 1000).toFixed(1)} seconds`);

/** A value as it reads: a string as typed, anything else as JSON rather than [object Object]. */
const valueWords = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

function CodeResult({ ruling }: { readonly ruling: ActionRuling | undefined }) {
  const words = ruling === undefined ? undefined : codeRulingWords(ruling);
  if (ruling === undefined || words === undefined) {
    return <p className="automation-editor__note">It has not run yet.</p>;
  }
  const output = ruling.ruling === "continued" ? Object.entries(ruling.output) : [];
  return (
    <section className="automation-code__result" aria-label="Result from the last firing">
      <Eyebrow>Last result</Eyebrow>
      <p className="automation-code__words">{words}</p>
      {output.length > 0 ? (
        <dl className="automation-code__values">
          {output.map(([name, value]) => {
            const words = valueWords(value);
            return (
              <div key={name} className="automation-code__value">
                <dt>{`{{code.${name}}}`}</dt>
                <dd title={words}>{words}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {ruling.ruling === "failed" && ruling.logTail !== undefined ? (
        <pre className="automation-code__tail" aria-label="Error output">
          {ruling.logTail}
        </pre>
      ) : null}
    </section>
  );
}

export function AutomationCodeEditor({
  name,
  language,
  timeoutMs,
  code,
  onCode,
  loading,
  saving,
  dirty,
  unsaved,
  error,
  result,
  onSave,
  onRevert,
  onBack,
}: {
  /** The automation the step belongs to. */
  readonly name: string;
  readonly language: CodeLanguage;
  readonly timeoutMs: number;
  readonly code: string;
  readonly onCode: (code: string) => void;
  readonly loading: boolean;
  readonly saving: boolean;
  /** The text differs from the program it opened on: Revert has somewhere to go. */
  readonly dirty: boolean;
  /** This step has no saved program yet: the template itself is worth saving. */
  readonly unsaved: boolean;
  /** Why the code could not be read or saved, in words. */
  readonly error: string | undefined;
  /** The step's ruling from the last firing. */
  readonly result: ActionRuling | undefined;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly onBack: () => void;
}) {
  // The editor opens on `code`; a revert (or a read that lands later) is put in through its handle,
  // so typing keeps its undo history and a revert moves the text without remounting under the caret.
  const handle = useRef<CodeEditorHandle>(null);
  const shown = useRef(code);
  useEffect(() => {
    if (shown.current === code) return;
    shown.current = code;
    handle.current?.replace(code);
  }, [code]);

  return (
    <div className="automation-code" data-testid="automation-code">
      <header className="automation-code__head">
        <Button size="xs" variant="subtle" onClick={onBack}>
          <ChevronLeft size={12} aria-hidden />
          Back
        </Button>
        <div className="automation-code__title">
          <Eyebrow>Code</Eyebrow>
          <span>{name}</span>
        </div>
        <span className="automation-code__facts">
          {languageWords(language)}, {secondsWords(timeoutMs)} at most
        </span>
      </header>
      {loading ? (
        <p className="automation-editor__note">Opening the code.</p>
      ) : (
        <CodeEditor
          className="automation-code__editor"
          path={language === "typescript" ? "step.ts" : "step.sh"}
          label="Step code"
          surfaceLabel="Automation code"
          value={code}
          onChange={(text) => {
            shown.current = text;
            onCode(text);
          }}
          handle={handle}
        />
      )}
      <p className="automation-editor__note">
        {language === "typescript"
          ? 'import { input, cont, stop, fail } from "junto/automation": input() holds the values, cont() answers them for the steps after.'
          : "The step runs sh with the trigger's values as JSON on stdin."}
      </p>
      <CodeResult ruling={result} />
      <footer className="automation-code__foot">
        {error === undefined ? null : (
          <p className="automation-editor__problem" role="alert">
            {error}
          </p>
        )}
        <Button variant="subtle" size="sm" aria-disabled={!dirty || saving} onClick={onRevert}>
          Revert
        </Button>
        {/* A clean, saved buffer offers no Save: a lit button that does nothing reads as an action that is not there. */}
        <Button
          variant="primary"
          size="sm"
          aria-disabled={(!dirty && !unsaved) || saving || loading}
          onClick={() => {
            // Nothing is saved before the program is here: the text a save would put is not the step's yet.
            if ((dirty || unsaved) && !saving && !loading) onSave();
          }}
        >
          {saving ? "Saving" : "Save"}
        </Button>
      </footer>
    </div>
  );
}
