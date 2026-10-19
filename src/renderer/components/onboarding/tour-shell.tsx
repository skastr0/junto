import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import type { ShellEnvironmentChange } from "@shared/shell-environment";
import { getJuntoApi } from "../../lib/junto-api";
import {
  RESOLVING_ESCAPE,
  changeSummary,
  readShellStep,
  reloadShellStep,
  shellStepView,
  type ShellStepRead,
} from "../../lib/shell-environment-view";
import { Button, StatusDot } from "../ui";
import type { TourChapter } from "./FirstRunIntro";

// Chapter: the shell. Not a demo: what Junto actually read from the
// operator's login shell at startup, live. Never a gate (the read already
// happened before the window opened) and never a value: the shell, the time
// it took, the PATH directories it added, the harnesses that PATH finds.

// A failed read is a warning, not an error: seats still start, on the fallback.
const TONE = { resolved: "green", reading: "dim", failed: "amber", inherited: "steel" } as const;

/** The escape an rc uses to skip heavy work while Junto reads it. */
const ESCAPE_SNIPPET = `if [ -z "$${RESOLVING_ESCAPE}" ]; then\n  # heavy work: version managers, completions\nfi`;

export function ShellEnvironmentPanel() {
  const [read, setRead] = useState<ShellStepRead | undefined>(undefined);
  const [reloading, setReloading] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [change, setChange] = useState<ShellEnvironmentChange | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Opening the step asks main for the status, which waits for the first
  // read (ensure) and is otherwise instant.
  useEffect(() => {
    const api = getJuntoApi();
    if (!api) return;
    let live = true;
    void readShellStep(api)
      .then((next) => live && setRead(next))
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    const off = api.shellEnvironment?.onChange((next) => live && setChange(next));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const reload = async (): Promise<void> => {
    const api = getJuntoApi();
    if (!api || reloading) return;
    setReloading(true);
    setChange(undefined);
    setError(null);
    try {
      setRead(await reloadShellStep(api));
      setReloaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  const view = read ? shellStepView(reloading ? { _tag: "Resolving", since: 0, generation: 0 } : read.status) : undefined;
  return (
    <div className="intro-art intro-art--shell" data-testid="shell-environment-step" data-tone={view?.tone ?? "reading"}>
      <div className="intro-shell__head">
        <StatusDot tone={TONE[view?.tone ?? "reading"]} />
        <span className="intro-shell__headline" role="status">
          {view?.headline ?? "Reading your shell"}
        </span>
      </div>
      {view && view.facts.length > 0 ? (
        <ul className="intro-shell__facts">
          {view.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      ) : null}
      {view?.cause ? (
        <div className="intro-shell__failure">
          <p>{view.cause}</p>
          <p className="intro-shell__faint">{view.fallback}</p>
        </div>
      ) : null}
      {view?.escape ? (
        <div className="intro-shell__escape">
          <p>
            While Junto reads your shell it sets <code>{RESOLVING_ESCAPE}=1</code>. Wrap heavy rc work so it is skipped
            then:
          </p>
          <pre>{ESCAPE_SNIPPET}</pre>
        </div>
      ) : null}
      {view && view.pathAdded.length > 0 ? (
        <div className="intro-shell__group">
          <span className="intro-shell__label">Added to PATH</span>
          <ul className="intro-shell__paths">
            {view.pathAdded.map((dir) => (
              <li key={dir}>{dir}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {read && !reloading && (read.found.length > 0 || read.missing.length > 0) ? (
        <div className="intro-shell__group">
          <span className="intro-shell__label">Agents found</span>
          <p className="intro-shell__harnesses">
            {read.found.length > 0 ? read.found.join(", ") : "None yet"}
            {read.missing.length > 0 ? <span className="intro-shell__faint">. Not found: {read.missing.join(", ")}</span> : null}
          </p>
        </div>
      ) : null}
      {error ? <p className="intro-shell__faint" role="alert">{error}</p> : null}
      <div className="intro-shell__foot">
        {reloaded && !reloading ? <span className="intro-shell__faint">{changeSummary(change)}</span> : <span />}
        <Button
          variant="chrome"
          size="sm"
          disabled={reloading || !read}
          aria-busy={reloading ? true : undefined}
          onClick={() => void reload()}
          data-testid="shell-environment-reload"
        >
          <RotateCw size={12} aria-hidden />
          Reload shell environment
        </Button>
      </div>
    </div>
  );
}

export const shellChapter: TourChapter = {
  id: "shell",
  title: "Your agents get your shell",
  demo: <ShellEnvironmentPanel />,
  body: (
    <>
      <p>
        Agents need the same tools your terminal finds. Junto reads your login
        shell as it starts, rc files and all, and gives every seat it starts the
        PATH and the variables your shell sets up.
      </p>
      <p>
        Changed an rc file? <strong>Reload shell environment</strong> reads it
        again, and the seats you start next get it. Seats already running keep
        the environment they started with.
      </p>
    </>
  ),
  pip: "content",
};
