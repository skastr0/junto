import { useEffect, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import type { PortraitExpression } from "@shared/portrait-expression";
import { JUNTO_MASCOT } from "@shared/brand-mascot";
import type { AgentSignalKind } from "@shared/agent-signals";
import { SEAT_AWARENESS_COMPILED } from "@shared/features";
import type { ThreadHealthTone, ThreadHealthValue } from "@shared/thread-health";
import { terminalActivity } from "../../lib/activity";
import type { SeatHealth, SeatSignal } from "../nodes/AgentSeat";
import type { PreambleAction, PreambleProvenance, PreambleTone } from "@shared/preamble";
import type { SeatBubble } from "../../lib/preamble-feed";
import { AGENT_NODE_SIZE } from "../../lib/node-geometry";
import { AgentEditorView } from "../agent-editor/AgentEditor";
import { AGENT_EDITOR_SECTIONS, type AgentEditorSeat } from "../agent-editor/sections";
import { AgentPortrait } from "../AgentPortrait";
import { finishIntro, introVisible } from "../../lib/first-run-intro";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { Button, Kbd } from "../ui";
import { DemoSeat, DemoWire, PULSE_BEAT_MS, TourStage, seatPort, useTourBeat } from "./tour-demo";
import { ChatComposer } from "../chat/ChatComposer";
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

// --- 2. Reading a seat ---------------------------------------------------------

const signalOf = (kind: AgentSignalKind, text: string): SeatSignal => ({
  openCount: 1,
  worst: { signalId: `tour-${kind}`, canvasName: "tour", nodeId: "tour", kind, text, createdAt: 0, state: "open" },
});

const reading = (health: ThreadHealthTone, value: ThreadHealthValue, line: string): SeatHealth => ({
  health,
  value,
  line,
  label: `AI reads: ${line}`,
});

const COL = 200;
const ROW = 104;

function StatesDemo() {
  // One seat finishes, waits to be read, and rests once you "open" it.
  const beat = useTourBeat(3200);
  const read = beat % 2 === 1;
  const idle = terminalActivity({ seatState: "idle" });
  return (
    <div className="tour-column">
      <TourStage width={COL * 4} height={ROW * 2} label="Seats in every state: working, wants your input, waiting on you, blocked, done, resting, ready for review, offline">
        <DemoSeat id="tour-s1" name="planner" harness="claude" x={8} y={8} spec={terminalActivity({ seatState: "working" })} caption="working: the ring laps" />
        <DemoSeat id="tour-s2" name="reviewer" harness="claude" x={8 + COL} y={8} spec={terminalActivity({ seatState: "attention" })} caption="wants your input: rings go out" />
        <DemoSeat id="tour-s3" name="schema" harness="codex" x={8 + COL * 2} y={8} spec={idle} signal={signalOf("escalate", "two specs disagree")} caption="waiting on you: it circles" />
        <DemoSeat id="tour-s4" name="deploy" harness="codex" x={8 + COL * 3} y={8} spec={idle} signal={signalOf("blocked", "needs the prod password")} caption="blocked: a steady beat" />
        <DemoSeat
          id="tour-s5"
          name="builder"
          harness="codex"
          x={8}
          y={8 + ROW}
          spec={read ? idle : terminalActivity({ seatState: "idle", needsLook: true })}
          caption={read ? "you opened it: resting" : "done: green until you read it"}
        />
        <DemoSeat id="tour-s6" name="notes" harness="claude" x={8 + COL} y={8 + ROW} spec={idle} caption="resting: the one still ring" />
        <DemoSeat id="tour-s7" name="docs" harness="grok" x={8 + COL * 2} y={8 + ROW} spec={idle} signal={signalOf("feedback", "draft ready")} caption="ready for review" />
        <DemoSeat id="tour-s8" name="archive" harness="claude" x={8 + COL * 3} y={8 + ROW} spec={terminalActivity({ managedSeat: true, seatState: "unknown" })} caption="offline" />
      </TourStage>
      {SEAT_AWARENESS_COMPILED ? (
        <div className="tour-aside">
          <span className="tour-aside__tag">Experimental</span>
          <TourStage width={COL * 3} height={ROW - 12} label="An AI reading bends the ring: stuck runs backwards, thrashing waves, going well wears a halo">
            <DemoSeat id="tour-a1" name="migrations" harness="claude" x={8} y={8} spec={terminalActivity({ seatState: "working" })} health={reading("trouble", "stuck", "stuck")} caption="stuck: the lap runs backwards" />
            <DemoSeat id="tour-a2" name="flaky-tests" harness="codex" x={8 + COL} y={8} spec={terminalActivity({ seatState: "working" })} health={reading("trouble", "thrashing", "going in circles")} caption="going in circles: a wave" />
            <DemoSeat id="tour-a3" name="refactor" harness="claude" x={8 + COL * 2} y={8} spec={terminalActivity({ seatState: "working" })} health={reading("good", "going_well", "going well")} caption="going well: a halo" />
          </TourStage>
        </div>
      ) : null}
    </div>
  );
}

const statesChapter: TourChapter = {
  id: "states",
  title: "Reading a seat",
  demo: <StatesDemo />,
  body: (
    <>
      <p>
        Each state moves its ring in its own way, so you can read a whole
        canvas without opening anything. Only a resting seat is still.
      </p>
      <p>
        When an agent finishes, its ring turns green and keeps a faint glint
        until you open the seat and read the answer. Then it rests. When an
        agent needs a decision from you, its ring circles in amber and the
        line under its name says why.
      </p>
      {SEAT_AWARENESS_COMPILED ? (
        <p>
          <strong>Experimental:</strong> an AI can also read how each session is
          going and bend the ring: backwards when stuck, a wave when it goes in
          circles, a halo when it goes well. It is advice, marked AI, and stays
          off until you turn it on in Settings, under Experimental.
        </p>
      ) : null}
    </>
  ),
  tryIt: [{ keys: ["double-click"], text: <>a green seat to read what it finished. It rests.</> }],
  pip: "curious",
};

// --- 3. Agents talk to each other ------------------------------------------------

const note = (
  id: string,
  text: string,
  action: PreambleAction,
  tone: PreambleTone,
  shownAt: number,
  provenance: PreambleProvenance = "agent",
): SeatBubble => ({
  current: { id, nodeId: id, text, provenance, action, tone, shownAt, expiresAt: Number.MAX_SAFE_INTEGER },
});

/** Scripted traffic: a hand-off, its answer, then a prompt to the reviewer. */
const TRAFFIC = [
  { wire: "builder", kind: "notice", reverse: false, to: "builder", text: "mail from planner: split the migration in two", action: "mail-in", tone: "violet" },
  { wire: "builder", kind: "answer", reverse: true, to: "planner", text: "mail from builder: both steps pass", action: "mail-in", tone: "green" },
  { wire: "reviewer", kind: "prompt", reverse: false, to: "reviewer", text: "asked by planner: review the migration", action: "mail-in", tone: "amber" },
] as const;

function TalkDemo() {
  const beat = useTourBeat(PULSE_BEAT_MS);
  const step = TRAFFIC[beat % TRAFFIC.length]!;
  const planner = { x: 24, y: 138 };
  const builder = { x: 400, y: 70 };
  const reviewer = { x: 400, y: 206 };
  const bubbleFor = (seat: string): SeatBubble | undefined =>
    step.to === seat ? note(`tour-${seat}-${String(beat)}`, step.text, step.action, step.tone, beat) : undefined;
  const W = 700;
  const H = 290;
  return (
    <div className="tour-column">
      <TourStage width={W} height={H} label="A planner seat messaging a builder and a reviewer; each message lights the wire it crosses">
        <DemoWire
          from={seatPort(planner.x, planner.y, "right")}
          to={seatPort(builder.x, builder.y, "left")}
          width={W}
          height={H}
          pulse={step.wire === "builder" ? beat + 1 : undefined}
          kind={step.kind}
          reverse={step.reverse}
        />
        <DemoWire
          from={seatPort(planner.x, planner.y, "right")}
          to={seatPort(reviewer.x, reviewer.y, "left")}
          width={W}
          height={H}
          pulse={step.wire === "reviewer" ? beat + 1 : undefined}
          kind={step.kind}
          reverse={step.reverse}
        />
        <DemoSeat id="tour-planner" name="planner" harness="claude" {...planner} spec={terminalActivity({ seatState: "working" })} bubble={bubbleFor("planner")} />
        <DemoSeat id="tour-builder" name="builder" harness="codex" {...builder} spec={terminalActivity({ seatState: "working" })} bubble={bubbleFor("builder")} />
        <DemoSeat id="tour-reviewer" name="reviewer" harness="grok" {...reviewer} spec={terminalActivity({ seatState: step.to === "reviewer" ? "working" : "idle" })} bubble={bubbleFor("reviewer")} />
      </TourStage>
      {/* The real multi-prompt composer, as it opens for a selection of agents. */}
      <div className="tour-composer" inert aria-hidden>
        <ChatComposer
          className="chat-composer--rts"
          onSend={() => false}
          ariaLabel="Message all selected agents"
          placeholder="Message all selected agents…"
          hint="⌘↵ send to all"
          sendLabel="send to all"
          eyebrow="multi-prompt — 3 agents"
        />
      </div>
    </div>
  );
}

const talkChapter: TourChapter = {
  id: "talk",
  title: "Agents talk to each other",
  demo: <TalkDemo />,
  body: (
    <>
      <p>
        Draw a wire between two seats and those agents can message each other:
        hand off work, ask a question, report back. Each message lights the wire
        as it crosses: violet for mail, amber when it lands as a prompt, green
        for an answer. Messages flow while the canvas is playing.
      </p>
      <p>
        Above a seat, a short note says what just arrived or what the agent is
        doing right now. Notes fade on their own. To say one thing to several
        agents, select them all and write a single prompt; each gets it in its
        own terminal.
      </p>
    </>
  ),
  tryIt: [
    { keys: ["drag"], text: <>from the edge of one seat onto another to connect them.</> },
    { keys: ["shift-click", "⌘↵"], text: <>several seats, write once, and send to all.</> },
  ],
  pip: "eager",
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
  statesChapter,
  talkChapter,
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
