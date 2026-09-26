import { useEffect, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import type { PortraitExpression } from "@shared/portrait-expression";
import { JUNTO_MASCOT } from "@shared/brand-mascot";
import { terminalActivity } from "../../lib/activity";
import { AGENT_NODE_SIZE } from "../../lib/node-geometry";
import { AgentEditorView } from "../agent-editor/AgentEditor";
import { AGENT_EDITOR_SECTIONS, type AgentEditorSeat } from "../agent-editor/sections";
import { AgentPortrait } from "../AgentPortrait";
import { finishIntro, introVisible } from "../../lib/first-run-intro";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { Button, Kbd } from "../ui";
import { DemoSeat, TourStage, useTourBeat } from "./tour-demo";
import "./first-run-intro.css";
import { claimFocusOnMount, isOperatorTyping } from "../../lib/focus-ownership";

// The tour. Shown once on first launch and again on request (help map,
// Settings, the command bar). Each chapter pairs a few plain sentences with
// a live demo built from the real canvas components on scripted state, and
// a "try it" line naming the real gesture. Chapters only describe what this
// build ships.

export interface TryIt {
  /** The keys or gesture, as the Kbd chip shows them. */
  readonly keys: ReadonlyArray<string>;
  readonly text: ReactNode;
}

export interface TourChapter {
  readonly id: string;
  readonly title: string;
  /** The live demo; absent for a chapter that is only words. */
  readonly demo?: ReactNode;
  readonly body: ReactNode;
  readonly tryIt?: ReadonlyArray<TryIt>;
  /** Pip's face while this chapter is up. */
  readonly pip: PortraitExpression;
}

// --- 1. Seats and characters -------------------------------------------------

/** A seat that exists only in the tour, for the customize editor to show. */
const TOUR_SEAT: AgentEditorSeat = {
  id: "tour-planner",
  name: "planner",
  harness: "claude",
  node: {
    id: "tour-planner",
    type: "text",
    text: "planner",
    x: 0,
    y: 0,
    ...AGENT_NODE_SIZE,
    ether: { entity: { kind: "agent", name: "tour:planner" }, terminal: { bindingId: "tour:planner", harness: "claude" } },
  },
};

function SeatsDemo() {
  // Walk the editor's tabs so each part of a character gets its moment.
  const beat = useTourBeat(2600);
  const sections = AGENT_EDITOR_SECTIONS.map((section) => section.id);
  const section = sections[beat % sections.length];
  return (
    <div className="tour-pair">
      <TourStage width={232} height={260} label="Three agent seats: planner working and selected, builder resting, reviewer done">
        <DemoSeat id="tour-planner" name="planner" harness="claude" x={24} y={24} spec={terminalActivity({ seatState: "working" })} selected />
        <DemoSeat id="tour-builder" name="builder" harness="codex" x={24} y={102} spec={terminalActivity({ seatState: "idle" })} />
        <DemoSeat id="tour-reviewer" name="reviewer" harness="grok" x={24} y={180} spec={terminalActivity({ seatState: "idle", needsLook: true })} />
      </TourStage>
      {/* The real editor on a tour-only seat. Inert: it shows, it never saves. */}
      <div className="tour-editor" inert aria-hidden>
        <AgentEditorView seat={TOUR_SEAT} section={section} />
      </div>
    </div>
  );
}

const seatsChapter: TourChapter = {
  id: "seats",
  title: "Agents sit in seats",
  demo: <SeatsDemo />,
  body: (
    <>
      <p>
        Junto is a canvas for running coding agents side by side. Every agent
        you start takes a seat: a character in a ring, its name, and one line
        saying what it is doing. Behind each seat is a real terminal running
        the agent you already use, in the project folder you pick.
      </p>
      <p>
        Each seat is a character you can make your own: its look and mood,
        its name, a soul that sets its voice, and standing instructions it
        reads every time it starts. That is the editor on the right.
      </p>
    </>
  ),
  tryIt: [
    { keys: ["right-click"], text: <>the canvas and choose an agent, or press <strong>Add item</strong>.</> },
    { keys: ["double-click"], text: <>a seat to open its terminal.</> },
    { keys: ["click"], text: <>a seat&apos;s portrait to customize its character.</> },
  ],
  pip: "happy",
};

// --- Play and pause ------------------------------------------------------------

function PlayPauseDemo() {
  return (
    <div className="intro-art intro-art--play" aria-hidden>
      <span className="intro-switch intro-switch--paused">
        <Pause size={11} fill="currentColor" />
        paused
      </span>
      <ArrowRight size={14} className="intro-switch__arrow" />
      <span className="intro-switch intro-switch--playing">
        <Play size={11} fill="currentColor" />
        playing
      </span>
    </div>
  );
}

const playChapter: TourChapter = {
  id: "play",
  title: "Play and pause",
  demo: <PlayPauseDemo />,
  body: (
    <>
      <p>
        A new workspace starts paused. While paused, agents keep working in
        their own terminals, but they cannot message each other or act
        through Junto. Once you play it, it opens playing every time.
      </p>
      <p>
        To play, press the <strong>paused</strong> button at the top right of
        the window, or choose <strong>Play canvas</strong> from the command
        bar. Messages then flow between agents joined by a wire. Press it
        again to pause, and that flow stops.
      </p>
    </>
  ),
  pip: "eager",
};

// --- Your agents act as you ------------------------------------------------------

function PromptArt() {
  return (
    <div className="intro-art intro-art--prompt" aria-hidden>
      <div className="intro-prompt">
        <p className="intro-prompt__title">“Junto” would like to access files in your Documents folder.</p>
        <div className="intro-prompt__actions">
          <span className="intro-prompt__button">Don’t Allow</span>
          <span className="intro-prompt__button intro-prompt__button--default">Allow</span>
        </div>
      </div>
    </div>
  );
}

const permissionsChapter = (mac: boolean): TourChapter => ({
  id: "permissions",
  title: "Your agents act as you",
  pip: "content",
  ...(mac ? { demo: <PromptArt /> } : {}),
  body: mac ? (
    <>
      <p>
        The agents Junto starts run with your permissions, like a terminal you
        opened yourself. When one reads a protected place, such as Documents,
        Desktop, or a network drive, macOS asks first, and the prompt names
        Junto because Junto started the agent.
      </p>
      <p>
        Allow or deny each one. A denied place stays closed to every agent
        Junto starts until you change it in System Settings, under Privacy
        &amp; Security.
      </p>
    </>
  ) : (
    <>
      <p>
        The agents Junto starts run with your permissions, like a terminal you
        opened yourself. They can read and change what you can in the folder
        you give them, so point each one at a project folder.
      </p>
    </>
  ),
});

const isMac = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset.juntoPlatform === "darwin";

/** The tour, in order. `mac` picks the permissions chapter's wording. */
export const tourChapters = (mac: boolean): ReadonlyArray<TourChapter> => [
  seatsChapter,
  playChapter,
  permissionsChapter(mac),
];

export function FirstRunIntro() {
  const settingsReady = use$(state$.settingsReady);
  const seen = use$(state$.settings.advanced.onboardingSeen);
  const requested = use$(state$.introOpen);
  const dismissed = use$(state$.introDismissed);
  const visible = introVisible({ settingsReady, seen, requested, dismissed });
  if (!visible) return null;
  return <FirstRunIntroSurface onDone={() => void finishIntro()} />;
}

export function FirstRunIntroSurface({
  onDone,
  mac = isMac(),
  initialStep = 0,
}: {
  readonly onDone: () => void;
  readonly mac?: boolean;
  readonly initialStep?: number;
}) {
  const chapters = tourChapters(mac);
  const [step, setStep] = useState(() => Math.min(Math.max(initialStep, 0), chapters.length - 1));
  const chapter = chapters[step]!;
  const last = step === chapters.length - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isOperatorTyping(event.target)) return;
      if (event.key === "ArrowRight") setStep((s) => Math.min(s + 1, chapters.length - 1));
      else if (event.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chapters.length]);

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Welcome to Junto"
      closeOnBackdrop={false}
      onClose={onDone}
      panelClassName="first-run-intro"
    >
      <div className="first-run-intro__frame">
        <nav className="first-run-intro__rail" aria-label="Tour chapters">
          <div className="first-run-intro__brand">
            <AgentPortrait
              identity={JUNTO_MASCOT.seed}
              config={JUNTO_MASCOT.config}
              expression={chapter.pip}
              size={40}
              frame="round"
              badge={false}
              title={JUNTO_MASCOT.name}
            />
            <span>
              <span className="first-run-intro__wordmark">Junto</span>
              <span className="first-run-intro__guide">a tour with {JUNTO_MASCOT.name}</span>
            </span>
          </div>
          <ol className="first-run-intro__chapters">
            {chapters.map((c, index) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`first-run-intro__chapter${index === step ? " is-active" : ""}${index < step ? " is-seen" : ""}`}
                  aria-current={index === step ? "step" : undefined}
                  aria-label={`Go to ${index + 1} of ${chapters.length}: ${c.title}`}
                  onClick={() => setStep(index)}
                >
                  <span className="first-run-intro__chapter-n" aria-hidden>{index + 1}</span>
                  <span className="first-run-intro__chapter-title">{c.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="first-run-intro__main">
          <div className="first-run-intro__head">
            <span className="first-run-intro__count">
              {step + 1} of {chapters.length}
            </span>
            <Button variant="subtle" size="sm" onClick={onDone} data-testid="first-run-intro-skip">
              skip the tour
            </Button>
          </div>
          <section
            key={chapter.id}
            className="first-run-intro__slide"
            data-testid="first-run-intro-slide"
            data-slide={chapter.id}
            aria-roledescription="slide"
            aria-label={`${step + 1} of ${chapters.length}: ${chapter.title}`}
          >
            {chapter.demo ? <div className="first-run-intro__art">{chapter.demo}</div> : null}
            <div className="first-run-intro__words">
              <div>
                <h2 className="first-run-intro__title">{chapter.title}</h2>
                <div className="first-run-intro__body">{chapter.body}</div>
              </div>
              {chapter.tryIt && chapter.tryIt.length > 0 ? (
                <div className="first-run-intro__try" data-testid="first-run-intro-try">
                  <span className="first-run-intro__try-label">Try it</span>
                  <ul>
                    {chapter.tryIt.map((row) => (
                      <li key={row.keys.join("+")}>
                        <span className="first-run-intro__keys">
                          {row.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </span>
                        <span>{row.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>
          <div className="first-run-intro__foot">
            <div className="first-run-intro__progress" aria-hidden>
              <span style={{ width: `${String(((step + 1) / chapters.length) * 100)}%` }} />
            </div>
            <div className="first-run-intro__nav">
              {step > 0 ? (
                <Button variant="chrome" size="md" onClick={() => setStep(step - 1)} aria-label="Back">
                  <ArrowLeft size={13} aria-hidden />
                  Back
                </Button>
              ) : null}
              {last ? (
                <Button variant="primary" size="md" ref={claimFocusOnMount} onClick={onDone} data-testid="first-run-intro-done">
                  Open the canvas
                </Button>
              ) : (
                <Button variant="primary" size="md" ref={claimFocusOnMount} onClick={() => setStep(step + 1)} data-testid="first-run-intro-next">
                  Next
                  <ArrowRight size={13} aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </FocusSurface>
  );
}
