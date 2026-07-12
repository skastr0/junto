import type { CanvasDoc } from "./canvas";

// The starter portfolio canvas written on first launch so the station is
// useful the moment it opens. Bindings reference real tower/quasar project
// keys sampled from the live stores (`tower projects --json`,
// `quasar projects --limit 500`) at authoring time — a source only gets a
// binding when the project actually exists there.

export const SEED_CANVAS_NAME = "portfolio";

export const seedCanvasDoc = (): CanvasDoc => ({
  nodes: [
    // -- instruments ---------------------------------------------------
    {
      id: "g-instruments",
      type: "group",
      label: "instruments",
      x: 120,
      y: 100,
      width: 840,
      height: 380,
    },
    {
      id: "n-prism",
      type: "text",
      text: "prism\nAgent workflow orchestration engine — typed task graphs across harnesses.",
      x: 180,
      y: 200,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "prism" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/prism" } },
        ],
        flags: ["blocker"],
      },
    },
    {
      id: "n-pulsar",
      type: "text",
      text: "pulsar\nTypeScript/Rust code quality scorer — diff-scoped violation signals.",
      x: 440,
      y: 200,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "pulsar" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/pulsar" } },
        ],
      },
    },
    {
      id: "n-quartz",
      type: "text",
      text: "quartz\nTypeScript compiler query tool — diagnostics, refactor preview, contracts.",
      x: 700,
      y: 200,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "quartz" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/quartz" } },
        ],
      },
    },
    {
      id: "n-groundwork",
      type: "text",
      text: "groundwork\nPolicy, provenance, and risk foundation — gates destructive actions.",
      x: 180,
      y: 340,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "groundwork" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/groundwork" } },
        ],
      },
    },
    {
      id: "n-flare",
      type: "text",
      text: "flare\nMedia generation workflow runtime — image, video, audio, 3D.",
      x: 440,
      y: 340,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "flare" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/flare" } },
        ],
      },
    },
    {
      id: "n-probe",
      type: "text",
      text: "probe\niOS app QA and automation CLI — screenshots, flows, Instruments traces.",
      x: 700,
      y: 340,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/probe" } },
        ],
      },
    },

    // -- stations ---------------------------------------------------------
    {
      id: "g-stations",
      type: "group",
      label: "stations",
      x: 1220,
      y: 160,
      width: 840,
      height: 240,
    },
    {
      id: "n-observatory",
      type: "text",
      text: "observatory\nMonitoring and telemetry station for the fleet.",
      x: 1280,
      y: 260,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "station" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "observatory" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/observatory" } },
        ],
      },
    },
    {
      id: "n-almanac",
      type: "text",
      text: "almanac\nInfo-product engine — content pipelines and publishing.",
      x: 1540,
      y: 260,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "station" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "almanac" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/almanac" } },
        ],
      },
    },
    {
      id: "n-vellum",
      type: "text",
      text: "vellum\nDesktop station for the portfolio canvas — this app.",
      x: 1800,
      y: 260,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "station" },
        bindings: [{ source: "tower", ref: { type: "project", key: "vellum" } }],
      },
    },

    // -- orbits -------------------------------------------------------------
    {
      id: "g-orbits",
      type: "group",
      label: "orbits",
      x: 120,
      y: 680,
      width: 1360,
      height: 240,
    },
    {
      id: "n-forge",
      type: "text",
      text: "forge\nSoftware development orbit — explore, build, review, evolve.",
      x: 180,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "orbit" } },
    },
    {
      id: "n-beacon",
      type: "text",
      text: "beacon\nMarketing orbit — positioning, funnels, paid and organic growth.",
      x: 440,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "orbit" } },
    },
    {
      id: "n-scribe",
      type: "text",
      text: "scribe\nContent and ghostwriting orbit — voice, platforms, publishing.",
      x: 700,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "orbit" } },
    },
    {
      id: "n-survey",
      type: "text",
      text: "survey\nMarket and competitive research orbit.",
      x: 960,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "orbit" } },
    },
    {
      id: "n-oracle",
      type: "text",
      text: "oracle\nDecision-support orbit — synthesis and forecasting.",
      x: 1220,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "orbit" } },
    },

    // -- business -------------------------------------------------------------
    {
      id: "g-business",
      type: "group",
      label: "business",
      x: 1540,
      y: 680,
      width: 580,
      height: 240,
    },
    {
      id: "n-vouch-agents",
      type: "text",
      text: "vouch agents\nDeployable creator stack — Hermes/OpenClaw agents on isolated boxes.",
      x: 1600,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "project" } },
    },
    {
      id: "n-hermes-fleet",
      type: "text",
      text: "hermes fleet\nFleet of Matrix-connected Hermes agents across rooms.",
      x: 1860,
      y: 780,
      width: 200,
      height: 80,
      ether: { entity: { kind: "agent" } },
    },
  ],
  edges: [
    {
      id: "e-prism-blocks-vellum",
      fromNode: "n-prism",
      toNode: "n-vellum",
      ether: { kind: "blocks" },
    },
    {
      id: "e-prism-blocks-observatory",
      fromNode: "n-prism",
      toNode: "n-observatory",
      ether: { kind: "blocks" },
    },
    {
      id: "e-prism-blocks-almanac",
      fromNode: "n-prism",
      toNode: "n-almanac",
      ether: { kind: "blocks" },
    },
    {
      id: "e-quartz-depends-prism",
      fromNode: "n-quartz",
      toNode: "n-prism",
      ether: { kind: "depends" },
    },
    {
      id: "e-groundwork-depends-prism",
      fromNode: "n-groundwork",
      toNode: "n-prism",
      ether: { kind: "depends" },
    },
    {
      id: "e-flare-relates-pulsar",
      fromNode: "n-flare",
      toNode: "n-pulsar",
      ether: { kind: "relates" },
    },
    {
      id: "e-vouch-relates-groundwork",
      fromNode: "n-vouch-agents",
      toNode: "n-groundwork",
      ether: { kind: "relates" },
    },
  ],
});
