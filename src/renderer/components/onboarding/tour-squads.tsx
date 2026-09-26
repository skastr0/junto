import type { AgentProfileBody } from "@shared/agent-profiles";
import type { SquadBody } from "@shared/squads";
import { terminalActivity } from "../../lib/activity";
import { AGENT_NODE_SIZE } from "../../lib/node-geometry";
import { ProfilePortrait } from "../profiles/ProfilePortrait";
import { SquadPortraitRow } from "../squads/SquadPortraitRow";
import "../squads/squads.css";
import { DemoSeat, DemoWire, TourStage, seatPort, useTourBeat } from "./tour-demo";
import type { TourChapter } from "./FirstRunIntro";

// Chapter: profiles and squads. The rows are the pickers' own faces
// (ProfilePortrait, SquadPortraitRow) on tour-only bodies; the stage places
// the squad into a region the way the canvas does, seats and wires at once.

const PROFILES: ReadonlyArray<{ readonly key: string; readonly line: string; readonly body: AgentProfileBody }> = [
  { key: "tour-planner", line: "claude, plans and splits work", body: { name: "planner", harness: "claude", soul: "calm, thorough" } },
  { key: "tour-builder", line: "codex, writes and tests", body: { name: "builder", harness: "codex" } },
  { key: "tour-reviewer", line: "grok, reviews every diff", body: { name: "reviewer", harness: "grok", instructions: "flag risky migrations" } },
];

const seatAt = (key: string, profile: AgentProfileBody, dx: number, dy: number) => ({
  key,
  profile,
  dx,
  dy,
  ...AGENT_NODE_SIZE,
});

// Seat keys are the profile keys and the squad key is "profile", so the
// picker row, the squad row and the placed seat all draw one face per
// profile, as a squad of profiles does on the canvas.
const CREW: SquadBody = {
  seats: [
    seatAt(PROFILES[0]!.key, PROFILES[0]!.body, 0, 60),
    seatAt(PROFILES[1]!.key, PROFILES[1]!.body, 300, 0),
    seatAt(PROFILES[2]!.key, PROFILES[2]!.body, 300, 120),
  ],
  edges: [
    { from: PROFILES[0]!.key, to: PROFILES[1]!.key, verb: "messages" },
    { from: PROFILES[0]!.key, to: PROFILES[2]!.key, verb: "messages" },
  ],
  prompt: "Ship the migration in two steps.",
};

function SquadsDemo() {
  // The squad sits placed in its region for two beats, the region clears
  // for one, and the squad arrives again, seats and wires at once.
  const beat = useTourBeat(2600);
  const placed = beat % 3 !== 2;
  const origin = { x: 40, y: 58 };
  const W = 560;
  const H = 250;
  return (
    <div className="tour-pair">
      <div className="tour-picker" inert aria-hidden>
        <div className="tour-picker__label">Profiles</div>
        {PROFILES.map((profile) => (
          <div key={profile.key} className="tour-picker__row">
            <ProfilePortrait profileKey={profile.key} body={profile.body} px={34} />
            <span className="tour-picker__text">
              <span className="tour-picker__name">{profile.body.name}</span>
              <span className="tour-picker__line">{profile.line}</span>
            </span>
          </div>
        ))}
        <div className="tour-picker__label">Squads</div>
        <div className={`tour-picker__row${placed ? " is-picked" : ""}`}>
          <SquadPortraitRow squadKey="profile" squad={CREW} size={24} />
          <span className="tour-picker__text">
            <span className="tour-picker__name">migration crew</span>
            <span className="tour-picker__line">3 seats, wired, one opening prompt</span>
          </span>
        </div>
      </div>
      <TourStage width={W} height={H} label="A saved squad placed into a region: three seats and their wires arrive together">
        <div className="tour-region junto-group">
          <div className="junto-region-titlebar">
            <span className="junto-group__label">migration</span>
          </div>
        </div>
        {placed
          ? CREW.edges.map((edge) => {
              const from = CREW.seats.find((seat) => seat.key === edge.from)!;
              const to = CREW.seats.find((seat) => seat.key === edge.to)!;
              return (
                <DemoWire
                  key={`${edge.from}-${edge.to}`}
                  from={seatPort(origin.x + from.dx, origin.y + from.dy, "right")}
                  to={seatPort(origin.x + to.dx, origin.y + to.dy, "left")}
                  width={W}
                  height={H}
                />
              );
            })
          : null}
        {placed
          ? CREW.seats.map((seat) => (
              <DemoSeat
                key={seat.key}
                id={`profile:${seat.key}`}
                name={seat.profile.name}
                harness={seat.profile.harness}
                x={origin.x + seat.dx}
                y={origin.y + seat.dy}
                spec={terminalActivity({ managedSeat: true, running: true, starting: true })}
              />
            ))
          : null}
      </TourStage>
    </div>
  );
}

export const squadsChapter: TourChapter = {
  id: "squads",
  title: "Profiles and squads",
  demo: <SquadsDemo />,
  body: (
    <>
      <p>
        A <strong>profile</strong> is an agent you have made your own, saved:
        its character, which agent it runs and how, its soul and its
        instructions. Save any seat as a profile and place it again whenever
        you want that agent back.
      </p>
      <p>
        A <strong>squad</strong> is a team saved together: its seats, the wires
        between them, and an opening prompt. Place it anywhere and the whole
        team arrives at once; place it in a region and it settles inside.
      </p>
    </>
  ),
  tryIt: [
    { keys: ["right-click"], text: <>a seat and choose <strong>save as profile</strong>.</> },
    { keys: ["right-click"], text: <>a selection of seats and choose <strong>save as squad</strong>.</> },
    { keys: ["right-click"], text: <>the canvas: your profiles and squads wait in the add menu.</> },
  ],
  pip: "delighted",
};
