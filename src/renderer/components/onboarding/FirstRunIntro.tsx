import { useEffect, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import { finishIntro, introVisible } from "../../lib/first-run-intro";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { HarnessMark } from "../HarnessMark";
import { Button, Kbd } from "../ui";
import "./first-run-intro.css";
import { claimFocusOnMount } from "../../lib/focus-ownership";

// First-run introduction. Four slides, shown once on first launch and again
// only on request (help map, Settings). It says what Junto is, how to start
// an agent, that a workspace starts paused until its first play and what play
// changes, and, plainly, that agents run with the operator's permissions so
// macOS may name Junto when one reads a protected folder.

interface IntroSlide {
  readonly id: string;
  readonly title: string;
  readonly art: ReactNode;
  readonly body: ReactNode;
}

function SeatCard({ agent, label, status }: { readonly agent: string; readonly label: string; readonly status: string }) {
  return (
    <div className="intro-seat">
      <HarnessMark agent={agent} size={22} title={false} />
      <span className="intro-seat__text">
        <span className="intro-seat__label">{label}</span>
        <span className="intro-seat__status">{status}</span>
      </span>
    </div>
  );
}

function CanvasArt() {
  return (
    <div className="intro-art intro-art--canvas" aria-hidden>
      <SeatCard agent="claude" label="planner" status="working" />
      <span className="intro-wire"><span className="intro-wire__verb">manages</span></span>
      <SeatCard agent="codex" label="builder" status="ready" />
    </div>
  );
}

const START_STEPS: ReadonlyArray<{ readonly keys: string; readonly text: ReactNode }> = [
  { keys: "right-click", text: <>the canvas, or click <strong>Add item</strong>.</> },
  { keys: "agent", text: <>Choose the harness you already use: Claude Code, Codex, or another agent CLI on this machine.</> },
  { keys: "folder", text: <>Pick the project folder it works in. Each agent keeps its own.</> },
];

function StartArt() {
  return (
    <ol className="intro-steps" aria-label="Start an agent">
      {START_STEPS.map((step) => (
        <li key={step.keys} className="intro-steps__row">
          <Kbd>{step.keys}</Kbd>
          <span>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

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

function PlayPauseArt() {
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

const isMac = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset.juntoPlatform === "darwin";

export const introSlides = (mac: boolean): ReadonlyArray<IntroSlide> => [
  {
    id: "canvas",
    title: "Agents, side by side",
    art: <CanvasArt />,
    body: (
      <>
        <p>
          Junto is a canvas where you run coding agents side by side. Each agent
          gets a seat: a live terminal, a project folder, and a card that shows
          what it is doing at a glance.
        </p>
        <p>
          A wire you draw between two cards is permission. One agent can reach
          another only over a wire, and the wire says exactly what it allows.
        </p>
      </>
    ),
  },
  {
    id: "start",
    title: "Start your first agent",
    art: <StartArt />,
    body: (
      <>
        <p>
          Double-click an agent to open its terminal.
        </p>
      </>
    ),
  },
  {
    id: "play",
    title: "Play and pause",
    art: <PlayPauseArt />,
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
  },
  {
    id: "permissions",
    title: "Your agents act as you",
    art: mac ? <PromptArt /> : null,
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
  },
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
  const slides = introSlides(mac);
  const [step, setStep] = useState(() => Math.min(Math.max(initialStep, 0), slides.length - 1));
  const slide = slides[step]!;
  const last = step === slides.length - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setStep((s) => Math.min(s + 1, slides.length - 1));
      else if (event.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [slides.length]);

  return (
    <FocusSurface
      measure="prose"
      height="fit"
      layer="work"
      label="Welcome to Junto"
      closeOnBackdrop={false}
      onClose={onDone}
      panelClassName="first-run-intro"
    >
      <div className="first-run-intro__head">
        <span className="first-run-intro__brand">Junto</span>
        <Button variant="subtle" size="sm" onClick={onDone} data-testid="first-run-intro-skip">
          skip
        </Button>
      </div>
      <section
        key={slide.id}
        className="first-run-intro__slide"
        data-testid="first-run-intro-slide"
        data-slide={slide.id}
        aria-roledescription="slide"
        aria-label={`${step + 1} of ${slides.length}: ${slide.title}`}
      >
        {slide.art ? <div className="first-run-intro__art">{slide.art}</div> : null}
        <h2 className="first-run-intro__title">{slide.title}</h2>
        <div className="first-run-intro__body">{slide.body}</div>
      </section>
      <div className="first-run-intro__foot">
        <div className="first-run-intro__dots" role="group" aria-label="Introduction progress">
          {slides.map((s, index) => (
            <button
              key={s.id}
              type="button"
              className={`first-run-intro__dot${index === step ? " is-active" : ""}`}
              aria-label={`Go to ${index + 1} of ${slides.length}: ${s.title}`}
              aria-current={index === step ? "step" : undefined}
              onClick={() => setStep(index)}
            />
          ))}
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
    </FocusSurface>
  );
}
