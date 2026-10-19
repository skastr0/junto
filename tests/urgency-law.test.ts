/**
 * Urgency law: seat urgency has one definition, `src/shared/wire/urgency.ts`.
 *
 * History. By 0.9.1 the order "how urgent is this seat" was written down in a
 * dozen places: the need ladder, the feed's numbers, the seat rail, the
 * palette, the region badge, the rollup, the alerts, the sound mixer, the
 * phone. They drifted: a declared block tied a proven dialog in one, outranked
 * it in another. The operator ordered one module, Effect-only, with this lock.
 *
 * Every src, e2e and tests file is parsed with the TypeScript compiler. Outside
 * urgency.ts and the named allow-list below, this fails on:
 * - an object or array literal holding two or more level or old tier names
 *   (src and e2e only: a test may name levels in a fixture);
 * - a const or function named *URGENCY*, *SEVERITY* or *RANK* that holds a
 *   numeric table;
 * - a minted level, rank or view group: `as UrgencyLevel`, `as UrgencyRank`,
 *   `.make(` on one, or a lookalike brand.
 * Code names a level through `Level.<name>` and ranks through `rankOf`,
 * `compareUrgency` or a view. Tests may import but never declare.
 *
 * Each allow-list entry names its file, its declaration and a reason. An
 * entry with a `step` is temporary: a surface still waiting for that step of
 * the urgency refactor, and the step's commit deletes it. An entry that no
 * longer matches anything fails, so the list only shrinks. Adding an entry, or
 * weakening an assertion, goes through pty-lead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { NEED_CAUSES, type NeedCause } from "../src/shared/harness-domain/need";
import { AGENT_SIGNAL_KINDS } from "../src/shared/wire/agent-signals";
import { FeedItemKind } from "../src/shared/wire/operator-feed";
import { RingForm } from "../src/shared/wire/rings";
import {
  AlertKind,
  compareUrgency,
  compareView,
  CueUrgency,
  Level,
  levelOfFeedItem,
  levelOfRing,
  levelOfSignal,
  MemberSeverity,
  needsOperator,
  Palette,
  rankOf,
  RegionUrgency,
  ringKeepsApart,
  SeatUrgency,
  takesAttentionSlot,
  URGENCY_LADDER,
  UrgencyLevel,
  UrgencyRank,
  type UrgencyView,
  waitsOnOperator,
  wantsLook,
  worstOf,
} from "../src/shared/wire/urgency";

const root = resolve(__dirname, "..");
const MODULE = "src/shared/wire/urgency.ts";

/** The ladder's names and every old tier's: two in one literal is a copy of an order. */
const URGENCY_NAMES = new Set([
  ...["blocked", "stopped", "waiting", "escalated", "review", "done", "degraded", "working", "resting", "offline"],
  ...["attention", "needs-you", "escalate", "feedback", "ready", "idle"],
]);
const RANK_NAME = /urgency|severity|rank/i;
const MINTED_TYPES = new Set(["UrgencyLevel", "UrgencyRank", "ViewGroup"]);
const BRANDS = new Set(["UrgencyLevel", "UrgencyRank", ...[SeatUrgency, RegionUrgency, MemberSeverity, AlertKind, CueUrgency, Palette].map((view) => view.name)]);

type Rule = "names" | "table" | "mint";
type Allowed = {
  readonly file: string;
  /** The enclosing declarations, outermost first, joined with dots; `X.*` covers everything inside X. */
  readonly name: string;
  readonly rule: Rule;
  readonly reason: string;
  /** Temporary: the refactor step whose commit removes it. */
  readonly step?: 2 | 3 | 4 | 5;
};

const PAINT = "a ring-to-paint map: hue or glyph per kind, no order";
const COPY = "copy: words per kind, no order";
const VOCAB = "a kind's own vocabulary, listed once; not an order";
const COUNTS = "a count per tier, keyed; not an order";
const KIND_MAP = "a kind map onto another vocabulary; ranks nothing";
const NOT_URGENCY = "ranks something other than seat urgency";

const ALLOWED: readonly Allowed[] = [

  // Step 5, remote-lead: the feed ranks each kind by levelOfFeedItem; its kinds share two level names.
  { file: "src/shared/need-surfaces.ts", name: "FEED_FROM_NEED", rule: "names", reason: KIND_MAP },

  // Occupancy maps by cause and orders by the ladder.
  { file: "src/shared/need-surfaces.ts", name: "OCCUPANCY_FROM_NEED", rule: "names", reason: `cause to occupancy, which splits levels a view keeps whole; ${KIND_MAP}` },

  // The need table and its maps: cause names, each cause's level from Level.
  { file: "src/shared/harness-domain/need.ts", name: "NEED_CAUSES", rule: "names", reason: "the cause names as keys; each level is a Level.<name>" },
  { file: "src/shared/harness-domain/need.ts", name: "REPORT_CAUSE", rule: "names", reason: KIND_MAP },
  { file: "src/shared/need-surfaces.ts", name: "NOTIFY_FROM_NEED", rule: "names", reason: "cause to notify category; notifications rank by level" },
  { file: "src/renderer/lib/desktop-notify.ts", name: "FEED_NEED", rule: "names", reason: KIND_MAP },
  { file: "src/shared/desktop-notifications.ts", name: "NOTIFY_CATEGORIES", rule: "names", reason: "the notify categories; notifications rank by level" },
  { file: "src/shared/desktop-notifications.ts", name: "SUBTITLE", rule: "names", reason: COPY },
  { file: "src/shared/desktop-notifications.ts", name: "CUE", rule: "names", reason: KIND_MAP },

  // Ring-to-paint maps: exempt.
  { file: "src/shared/wire/seat-activity.ts", name: "SEVERITY_TONE", rule: "names", reason: PAINT },
  { file: "src/shared/wire/rings.ts", name: "SIGNAL_FLAG_TONE", rule: "names", reason: PAINT },
  { file: "src/renderer/lib/seat-rollup.ts", name: "SIGNAL_ROLLUP_TONE", rule: "names", reason: PAINT },
  { file: "src/renderer/lib/activity-atlas.ts", name: "FLAGS", rule: "names", reason: PAINT },
  { file: "src/renderer/lib/agent-signals-view.ts", name: "SIGNAL_KIND_TONE", rule: "names", reason: PAINT },
  { file: "src/renderer/lib/preamble-sources.ts", name: "SIGNAL_TONE", rule: "names", reason: PAINT },
  { file: "src/renderer/lib/signal-mark.ts", name: "MARK", rule: "names", reason: PAINT },
  { file: "src/renderer/components/feed/OperatorFeed.tsx", name: "KIND_ICON", rule: "names", reason: PAINT },
  { file: "src/renderer/lib/occupancy-chrome.ts", name: "SPEC", rule: "names", reason: "chrome paint and copy per occupancy state; no order" },

  // Copy.
  { file: "src/shared/wire/operator-feed.ts", name: "FEED_KIND_LABEL", rule: "names", reason: COPY },
  { file: "src/shared/agent-signals.ts", name: "KIND_WORDS", rule: "names", reason: COPY },
  { file: "src/renderer/lib/preamble-sources.ts", name: "SIGNAL_WORD", rule: "names", reason: COPY },
  { file: "src/renderer/lib/seat-collaboration.ts", name: "STATE_PHRASE", rule: "names", reason: COPY },
  { file: "src/renderer/lib/seat-offboard.ts", name: "REFUSAL_PHRASE", rule: "names", reason: COPY },
  { file: "src/renderer/lib/seat-offboard.ts", name: "ONE_BLOCK", rule: "names", reason: COPY },
  { file: "src/shared/seat-offboard.ts", name: "OFFBOARD_REFUSAL_REASON", rule: "names", reason: COPY },
  { file: "src/renderer/lib/sound/cues.ts", name: "CATEGORY_LABEL", rule: "names", reason: COPY },
  { file: "src/main/junto/work/control.ts", name: "SIGNAL_NEXT_STEP", rule: "names", reason: COPY },

  // Kind maps.
  { file: "src/renderer/lib/sound/cues.ts", name: "CUE_IDS", rule: "names", reason: "the cue catalog's ids, some named like levels" },
  { file: "src/renderer/lib/sound/cues.ts", name: "CUES", rule: "names", reason: "the cue catalog keyed by cue id" },
  { file: "src/renderer/lib/sound/director.ts", name: "SIGNAL_CUE", rule: "names", reason: KIND_MAP },
  { file: "src/renderer/lib/sound/index.ts", name: "NOTIFICATION_CUE", rule: "names", reason: KIND_MAP },
  { file: "src/renderer/lib/sound/index.ts", name: "DEMO_CUE", rule: "names", reason: KIND_MAP },
  { file: "src/renderer/lib/occupancy-feed.ts", name: "TONE_HARNESS", rule: "names", reason: KIND_MAP },
  { file: "src/shared/companion-seats.ts", name: "SIGNAL_STATE", rule: "names", reason: KIND_MAP },

  // Vocabularies.
  { file: "src/shared/wire/agent-signals.ts", name: "AGENT_SIGNAL_KINDS", rule: "names", reason: VOCAB },
  { file: "src/shared/wire/operator-feed.ts", name: "FeedItemKind", rule: "names", reason: VOCAB },
  { file: "src/shared/wire/companion-protocol.ts", name: "COMPANION_SEAT_STATES", rule: "names", reason: VOCAB },
  { file: "src/shared/agent-seat-state.ts", name: "AGENT_SEAT_STATES", rule: "names", reason: VOCAB },
  { file: "src/shared/seat-control.ts", name: "SEAT_STATE_LITERALS", rule: "names", reason: VOCAB },
  { file: "src/shared/seat-control.ts", name: "SeatWaitUntil", rule: "names", reason: VOCAB },
  { file: "src/cli/commands/seat.ts", name: "SEAT_WAIT_UNTIL", rule: "names", reason: VOCAB },
  { file: "src/shared/terminal.ts", name: "TerminalHarnessState", rule: "names", reason: VOCAB },
  { file: "src/shared/harness-domain/signal.ts", name: "ActivityObserved.activity", rule: "names", reason: VOCAB },
  { file: "src/shared/occupancy/derive.ts", name: "OccupancySpectrum", rule: "names", reason: VOCAB },
  { file: "src/shared/occupancy/derive.ts", name: "OccupancyHarnessState", rule: "names", reason: VOCAB },
  { file: "src/main/junto/term/intervention/policy.ts", name: "SeatSignal", rule: "names", reason: VOCAB },
  { file: "src/main/junto/term/seats-link.ts", name: "SeatsStateEvent.state", rule: "names", reason: VOCAB },
  { file: "src/main/junto/term/program-status.ts", name: "PROGRAM_STATES", rule: "names", reason: VOCAB },
  { file: "src/renderer/lib/agent-broadcast.ts", name: "LIVE_SEAT_STATES", rule: "names", reason: "the seat states that count as live; a set, not an order" },
  { file: "src/shared/seat-offboard.ts", name: "OFFBOARD_REFUSAL_CODES", rule: "names", reason: VOCAB },
  { file: "src/shared/seat-sessions.ts", name: "SEAT_OFFBOARD_STAGES", rule: "names", reason: VOCAB },
  { file: "src/shared/settings.ts", name: "SOUND_CATEGORIES", rule: "names", reason: "sound setting categories, not seat urgency" },
  { file: "src/shared/settings.ts", name: "SoundCategoriesSettings", rule: "names", reason: "sound setting categories, not seat urgency" },
  { file: "src/shared/settings.ts", name: "SoundCategoriesPatch", rule: "names", reason: "sound setting categories, not seat urgency" },
  { file: "src/shared/settings.ts", name: "defaultSoundCategories", rule: "names", reason: "sound setting categories, not seat urgency" },
  { file: "src/shared/settings.ts", name: "NotificationSettings", rule: "names", reason: "notification toggles per category, not seat urgency" },
  { file: "src/shared/settings.ts", name: "NotificationPatch", rule: "names", reason: "notification toggles per category, not seat urgency" },
  { file: "src/shared/settings.ts", name: "defaultNotifications", rule: "names", reason: "notification toggles per category, not seat urgency" },
  { file: "src/shared/pad.ts", name: "PadShapeStatus", rule: "names", reason: "a pad task's status, not seat urgency" },
  { file: "src/shared/pad-project.ts", name: "PadFocusedItem.status", rule: "names", reason: "a pad task's status, not seat urgency" },
  { file: "src/shared/update.ts", name: "UpdatePhase", rule: "names", reason: "the app updater's phases, not seat urgency" },

  // Counts.
  { file: "src/shared/region-rollup.ts", name: "RegionRollup.counts", rule: "names", reason: COUNTS },
  { file: "src/shared/region-rollup.ts", name: "countBySeverity.counts", rule: "names", reason: COUNTS },
  { file: "src/main/junto/overseer/live/context.ts", name: "buildLiveContext.context.authoritative.counts", rule: "names", reason: COUNTS },

  // Fixtures.
  { file: "src/shared/wire/companion-demo-fixture.ts", name: "DEMO_SEATS", rule: "names", reason: "demo seats for the phone's showcase; data, not an order" },
  { file: "e2e/harness/nested-canvas-fixture.ts", name: "openSignals.kind", rule: "names", reason: "an e2e fixture's signal kinds; data, not an order" },
  { file: "e2e/scenarios/canvas-seat-states.spec.ts", name: "seats", rule: "names", reason: "an e2e scenario's seats; data, not an order" },
  { file: "e2e/scenarios/canvas-seat-states.spec.ts", name: "signalEvents", rule: "names", reason: "an e2e scenario's events; data, not an order" },

  // Ranks of other things.
  { file: "src/shared/harness-domain/status.ts", name: "RANK", rule: "table", reason: `signal source precedence; ${NOT_URGENCY}` },
  { file: "src/shared/region-rollup.ts", name: "kindRank", rule: "table", reason: `roll call's node kind order; ${NOT_URGENCY}` },
  { file: "src/shared/region-rollup.ts", name: "GRAPH_REASON_RANK", rule: "table", reason: `execution graph reasons; ${NOT_URGENCY}` },
  { file: "src/renderer/lib/command-bar.ts", name: "kindRank", rule: "table", reason: `the palette's node kind groups; ${NOT_URGENCY}` },
  { file: "src/shared/impact/cone.ts", name: "reasonRank", rule: "table", reason: `blocked reasons in a cone; ${NOT_URGENCY}` },
  { file: "src/shared/impact/rank.ts", name: "rankStoppageSeeds", rule: "table", reason: `stoppage seeds by cone size; ${NOT_URGENCY}` },
  { file: "src/renderer/lib/modal-stack.ts", name: "LAYER_RANK", rule: "table", reason: `modal layers; ${NOT_URGENCY}` },
  { file: "src/renderer/lib/wire-pulse.ts", name: "VERB_RANK", rule: "table", reason: `edge verbs; ${NOT_URGENCY}` },
  { file: "src/shared/rules.ts", name: "ADMISSION_RANK", rule: "table", reason: `task admission; ${NOT_URGENCY}` },
  { file: "src/shared/observability.ts", name: "OBSERVABILITY_LEVEL_RANK", rule: "table", reason: `log levels; ${NOT_URGENCY}` },
  { file: "src/shared/cosmetics/draw.ts", name: "DETAIL_RANK", rule: "table", reason: `cosmetic detail levels; ${NOT_URGENCY}` },
  { file: "src/shared/machine-figure/draw.ts", name: "RANK", rule: "table", reason: `machine figure detail levels; ${NOT_URGENCY}` },
  { file: "src/shared/scheduler-effects.ts", name: "mergePageLoadStatus.rank", rule: "table", reason: `page load statuses; ${NOT_URGENCY}` },
  { file: "src/main/junto/adapters/exec.ts", name: "versionDirs.rank", rule: "table", reason: `installed version directories; ${NOT_URGENCY}` },
  { file: "src/main/junto/usage/antigravity-source.ts", name: "windowsFromQuotaSummary.groupRank", rule: "table", reason: `usage quota groups; ${NOT_URGENCY}` },
  { file: "src/main/junto/usage/antigravity-source.ts", name: "windowsFromQuotaSummary.kindRank", rule: "table", reason: `usage quota kinds; ${NOT_URGENCY}` },
  { file: "src/renderer/components/pad/pad-editor-model.ts", name: "layerRank", rule: "table", reason: `pad element layers; ${NOT_URGENCY}` },
  { file: "src/renderer/components/settings/search-index.ts", name: "searchSettings.rank", rule: "table", reason: `settings search matches; ${NOT_URGENCY}` },
  { file: "src/renderer/components/work/task-path.ts", name: "groupOutgoingVisits.rank", rule: "table", reason: `task path visits; ${NOT_URGENCY}` },
  { file: "src/renderer/lib/actor-ledger-work.ts", name: "compareRaisedTaskRows.rank", rule: "table", reason: `raised task rows; ${NOT_URGENCY}` },
  { file: "src/renderer/lib/actor-ledger-work.ts", name: "compareRequestRows.attentionRank", rule: "table", reason: `request rows flagged for attention; ${NOT_URGENCY}` },
  { file: "src/renderer/lib/focus-switcher.ts", name: "recencyOrder.rank", rule: "table", reason: `focus recency; ${NOT_URGENCY}` },
  { file: "tests/pty-e2e/jev/checkpoints.ts", name: "CLASS_RANK", rule: "table", reason: `screen checkpoint classes; ${NOT_URGENCY}` },
];

// ── The scan ──────────────────────────────────────────────────────────────

const sourcesUnder = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules") return [];
    if (statSync(join(root, rel)).isDirectory()) return sourcesUnder(rel);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [rel] : [];
  });

type Finding = { readonly file: string; readonly line: number; readonly name: string; readonly rule: Rule; readonly what: string };

const unwrap = (node: ts.Expression): ts.Expression => {
  let at = node;
  for (;;) {
    if (ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
    else if (ts.isCallExpression(at) && at.expression.getText() === "Object.freeze" && at.arguments[0]) at = at.arguments[0];
    else return at;
  }
};

const isNumber = (node: ts.Expression): boolean => {
  const at = unwrap(node);
  return ts.isNumericLiteral(at) || (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(at.operand));
};

/** A table of numbers: by key, by position, or built from an order's indices. */
const isNumericTable = (node: ts.Expression): boolean => {
  const at = unwrap(node);
  if (ts.isObjectLiteralExpression(at)) {
    return at.properties.length >= 2 && at.properties.every((p) => ts.isPropertyAssignment(p) && isNumber(p.initializer));
  }
  if (ts.isArrayLiteralExpression(at)) {
    if (at.elements.length >= 2 && at.elements.every((e) => isNumber(e))) return true;
    return at.elements.length >= 2 && at.elements.every((e) => ts.isArrayLiteralExpression(unwrap(e)) && isNumber((unwrap(e) as ts.ArrayLiteralExpression).elements[1] ?? e) && (unwrap(e) as ts.ArrayLiteralExpression).elements.length === 2);
  }
  if ((ts.isNewExpression(at) || ts.isCallExpression(at)) && /^(Map|Object\.fromEntries)$/.test(at.expression.getText())) {
    const arg = at.arguments?.[0];
    if (arg === undefined) return false;
    const inner = unwrap(arg);
    if (ts.isArrayLiteralExpression(inner)) return isNumericTable(inner);
    // `order.map((value, index) => [value, index])`: an order turned into ranks.
    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "map") {
      const fn = inner.arguments[0];
      return fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters.length >= 2;
    }
  }
  return false;
};

/** A function that ranks: it holds a numeric table, or returns two or more distinct numbers. */
const isRankingFunction = (fn: ts.SignatureDeclaration & { body?: ts.Node }): boolean => {
  if (fn.body === undefined) return false;
  const numbers = new Set<string>();
  let table = false;
  const returned = (expr: ts.Expression): void => {
    const at = unwrap(expr);
    if (isNumber(at)) numbers.add(at.getText());
    else if (ts.isConditionalExpression(at)) [at.whenTrue, at.whenFalse].forEach(returned);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node)) && isNumericTable(node)) table = true;
    if (ts.isReturnStatement(node) && node.expression) returned(node.expression);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) returned(node.body);
    ts.forEachChild(node, visit);
  };
  if (ts.isBlock(fn.body)) visit(fn.body);
  else visit(fn);
  return table || numbers.size >= 2;
};

const declaredName = (node: ts.Node): string | undefined => {
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)) &&
    node.name !== undefined &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return undefined;
};

const ownerOf = (node: ts.Node): string => {
  const names: string[] = [];
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    const name = declaredName(at);
    if (name !== undefined) names.unshift(name);
  }
  return names.join(".") || "<module>";
};

const urgencyName = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteralLike(node)) return URGENCY_NAMES.has(node.text) ? node.text : undefined;
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "Level") return node.name.text;
  return undefined;
};

const propertyKey = (property: ts.ObjectLiteralElementLike): string | undefined => {
  const name = property.name;
  if (name === undefined || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return undefined;
  return URGENCY_NAMES.has(name.text) ? name.text : undefined;
};

const literalNames = (node: ts.Node): ReadonlySet<string> => {
  const names = new Set<string>();
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      const name = urgencyName(element);
      if (name !== undefined) names.add(name);
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      const key = propertyKey(property);
      if (key !== undefined) names.add(key);
      const value = ts.isPropertyAssignment(property) ? urgencyName(property.initializer) : undefined;
      if (value !== undefined) names.add(value);
    }
  }
  return names;
};

const scan = (rel: string, rules: ReadonlySet<Rule>, fixtures = false): Finding[] => {
  const text = readFileSync(join(root, rel), "utf8");
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const found = (node: ts.Node, rule: Rule, what: string): void => {
    findings.push({ file: rel, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, name: ownerOf(node), rule, what });
  };
  const visit = (node: ts.Node): void => {
    if (rules.has("names") && (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node))) {
      const names = literalNames(node);
      if (names.size >= 2) found(node, "names", [...names].join(" "));
    }
    if (rules.has("table")) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && RANK_NAME.test(node.name.text) && node.initializer) {
        const init = unwrap(node.initializer);
        const ranks = ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? isRankingFunction(init) : isNumericTable(init);
        if (ranks) found(node, "table", node.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name && RANK_NAME.test(node.name.text) && isRankingFunction(node)) found(node, "table", node.name.text);
      // A lone rank number is one row of a table kept somewhere else. A test's
      // fixture may carry one; it declares nothing.
      if (!fixtures && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && RANK_NAME.test(node.name.text) && node.initializer && isNumber(node.initializer)) found(node, "table", `${node.name.text} = ${unwrap(node.initializer).getText(source)}`);
      if (!fixtures && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && RANK_NAME.test(node.name.text) && isNumber(node.initializer)) found(node, "table", `${node.name.text}: ${unwrap(node.initializer).getText(source)}`);
      // `type Urgency = 0 | 1 | 2`: a numeric ladder spelled as a type.
      if (ts.isTypeAliasDeclaration(node) && RANK_NAME.test(node.name.text) && ts.isUnionTypeNode(node.type)) {
        const numbers = node.type.types.filter((member) => ts.isLiteralTypeNode(member) && ts.isNumericLiteral(member.literal));
        if (numbers.length >= 2) found(node, "table", `type ${node.name.text}`);
      }
    }
    if (rules.has("mint")) {
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && mintsType(node.type)) found(node, "mint", `as ${node.type.getText(source)}`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression.getText(source);
        const method = node.expression.name.text;
        if (method === "make" && /^(UrgencyLevel|UrgencyRank)$|\.Group$/.test(receiver)) found(node, "mint", `${receiver}.make`);
        const brand = node.arguments[0];
        if (method === "brand" && brand !== undefined && ts.isStringLiteralLike(brand) && BRANDS.has(brand.text)) found(node, "mint", `brand ${brand.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};

const mintsType = (type: ts.TypeNode): boolean => {
  let mints = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && MINTED_TYPES.has(node.typeName.getText())) mints = true;
    ts.forEachChild(node, visit);
  };
  visit(type);
  return mints;
};

const ALL: ReadonlySet<Rule> = new Set(["names", "table", "mint"]);
const DECLARES: ReadonlySet<Rule> = new Set(["table", "mint"]);
const LAW_FILE = "tests/urgency-law.test.ts";
const findings: readonly Finding[] = [
  ...[...sourcesUnder("src"), ...sourcesUnder("e2e")].filter((rel) => rel !== MODULE).flatMap((rel) => scan(rel, ALL)),
  ...sourcesUnder("tests").filter((rel) => rel !== LAW_FILE).flatMap((rel) => scan(rel, DECLARES, true)),
];

const allows = (entry: Allowed, finding: Finding): boolean =>
  entry.file === finding.file &&
  entry.rule === finding.rule &&
  (entry.name.endsWith(".*") ? finding.name.startsWith(entry.name.slice(0, -1)) : entry.name === finding.name);
const unlisted = (rule: Rule): string[] =>
  findings
    .filter((finding) => finding.rule === rule && !ALLOWED.some((entry) => allows(entry, finding)))
    .map((finding) => `${finding.file}:${finding.line} ${finding.name} (${finding.what})`);

describe("urgency law: one ladder, declared once", () => {
  it("no literal outside urgency.ts lists two or more level or tier names", () => {
    expect(unlisted("names")).toEqual([]);
  });

  it("no const or function named for urgency, severity or rank holds a numeric table", () => {
    expect(unlisted("table")).toEqual([]);
  });

  it("only urgency.ts mints a level, a rank or a view group", () => {
    expect(unlisted("mint")).toEqual([]);
  });

  it("every allow-list entry still matches, names a reason, and no entry is listed twice", () => {
    const stale = ALLOWED.filter((entry) => !findings.some((finding) => allows(entry, finding)));
    expect(stale.map((entry) => `${entry.file} ${entry.name} (${entry.rule})`)).toEqual([]);
    for (const entry of ALLOWED) expect(entry.reason.trim().length, `${entry.file} ${entry.name}`).toBeGreaterThan(10);
    const keys = ALLOWED.map((entry) => `${entry.file} ${entry.name} ${entry.rule}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── The module's own invariants ───────────────────────────────────────────

const VIEWS: readonly UrgencyView<string, string>[] = [SeatUrgency, RegionUrgency, MemberSeverity, AlertKind, CueUrgency, Palette];

describe("urgency law: the ladder and its views", () => {
  it("the ladder is ten levels, ranked 9 blocked down to 0 offline", () => {
    expect(URGENCY_LADDER).toEqual(["blocked", "stopped", "waiting", "escalated", "review", "done", "degraded", "working", "resting", "offline"]);
    expect(URGENCY_LADDER.map(rankOf)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    for (const [name, level] of Object.entries(Level)) expect(level).toBe(name);
  });

  it("a rank decodes only as an integer 0..9, a level only as a ladder name", () => {
    const rank = Schema.decodeUnknownOption(UrgencyRank);
    for (const bad of [-1, 10, 1.5, "3"]) expect(rank(bad)._tag, String(bad)).toBe("None");
    for (const good of [0, 9]) expect(rank(good)._tag).toBe("Some");
    const level = Schema.decodeUnknownOption(UrgencyLevel);
    for (const bad of ["ready", "idle", "attention", "needs-you", 3]) expect(level(bad)._tag, String(bad)).toBe("None");
  });

  it("compareUrgency is urgency only: most urgent first, zero only for the same level", () => {
    for (const a of URGENCY_LADDER) {
      for (const b of URGENCY_LADDER) {
        const ab = compareUrgency(a, b);
        expect(Math.sign(ab) + Math.sign(compareUrgency(b, a)), `${a} ${b}`).toBe(0);
        expect(ab === 0, `${a} ${b}`).toBe(a === b);
        expect(ab < 0, `${a} ${b}`).toBe(URGENCY_LADDER.indexOf(a) < URGENCY_LADDER.indexOf(b));
      }
    }
    expect(worstOf([Level.done, Level.stopped, Level.working])).toBe(Level.stopped);
    expect(worstOf([])).toBeUndefined();
  });

  it("each view splits the ladder into runs of adjacent levels, every level in exactly one", () => {
    for (const view of VIEWS) {
      const covered = view.groups.flatMap((group) => view.levelsOf(group));
      expect([...covered].sort(compareUrgency), view.name).toEqual(URGENCY_LADDER);
      expect(new Set(covered).size, view.name).toBe(URGENCY_LADDER.length);
      for (const group of view.groups) {
        const indices = view.levelsOf(group).map((level) => URGENCY_LADDER.indexOf(level));
        indices.forEach((index, at) => at > 0 && expect(index, `${view.name} ${group}`).toBe(indices[at - 1]! + 1));
        expect(view.topOf(group), `${view.name} ${group}`).toBe(view.levelsOf(group)[0]);
        for (const level of view.levelsOf(group)) expect(view.groupOf(level), `${view.name} ${level}`).toBe(group);
      }
    }
  });

  it("a view hands out groups, never a number", () => {
    for (const view of VIEWS) {
      for (const group of view.groups) expect(typeof group, `${view.name}`).toBe("string");
      for (const level of URGENCY_LADDER) expect(typeof view.groupOf(level), `${view.name} ${level}`).toBe("string");
      expect(Object.values(view.group).every((group) => typeof group === "string"), view.name).toBe(true);
    }
  });

  it("every view but the palette lists its groups in ladder order and sorts by each group's top level", () => {
    for (const view of VIEWS.filter((view) => view !== Palette)) {
      expect(view.order, view.name).toBe("ladder");
      const sorted = [...view.groups].sort(compareView(view));
      expect(sorted, view.name).toEqual(view.groups);
      for (const a of view.groups) {
        for (const b of view.groups) {
          expect(Math.sign(compareView(view)(a, b)), `${view.name} ${a} ${b}`).toBe(Math.sign(compareUrgency(view.topOf(a), view.topOf(b))));
        }
      }
    }
  });

  it("the palette is the one view with its own order: work in flight above review, the rest as the seat rail", () => {
    expect(Palette.order).toBe("own");
    const order = [...Palette.groups].sort(compareView(Palette));
    expect(order).toEqual(["blocked", "waiting", "working", "review", "done", "resting", "offline"]);
    for (const group of Palette.groups) {
      expect(Palette.levelsOf(group), group).toEqual(SeatUrgency.levelsOf(SeatUrgency.groupOf(Palette.topOf(group))));
    }
  });

  it("a sound cue takes the attention slot only for stopped or needs-you", () => {
    expect(CueUrgency.groups.filter(takesAttentionSlot)).toEqual(["stopped", "needs-you"]);
  });

  it("the predicates split the ladder where the module says", () => {
    expect(URGENCY_LADDER.filter(waitsOnOperator)).toEqual(["blocked", "stopped", "waiting", "escalated"]);
    expect(URGENCY_LADDER.filter(wantsLook)).toEqual(["review", "done"]);
    expect(URGENCY_LADDER.filter(needsOperator)).toEqual(["blocked", "stopped", "waiting", "escalated", "review", "done"]);
  });
});

describe("urgency law: every kind is mapped", () => {
  const onLadder = (level: unknown): boolean => (URGENCY_LADDER as readonly unknown[]).includes(level);

  it("every NeedCause has a ladder level", () => {
    for (const cause of Object.keys(NEED_CAUSES) as NeedCause[]) expect(onLadder(NEED_CAUSES[cause].level), cause).toBe(true);
  });

  it("every AgentSignalKind, FeedItemKind and RingForm maps to a ladder level", () => {
    for (const kind of AGENT_SIGNAL_KINDS) expect(onLadder(levelOfSignal(kind)), kind).toBe(true);
    for (const kind of FeedItemKind.literals) expect(onLadder(levelOfFeedItem(kind)), kind).toBe(true);
    for (const form of RingForm.literals) expect(onLadder(levelOfRing(form)), form).toBe(true);
  });

  it("a ring keeps its seat apart exactly when its form waits on the operator", () => {
    expect(RingForm.literals.filter(ringKeepsApart).sort()).toEqual(["call", "halt", "wait"]);
  });

  it("urgency.ts imports only effect and sibling wire modules, and rings.ts never imports it", () => {
    const imports = (rel: string): string[] => {
      const source = ts.createSourceFile(rel, readFileSync(join(root, rel), "utf8"), ts.ScriptTarget.Latest, true);
      return source.statements.filter(ts.isImportDeclaration).map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    };
    for (const spec of imports(MODULE)) expect(spec === "effect" || /^\.\/[\w-]+$/.test(spec), spec).toBe(true);
    expect(imports("src/shared/wire/rings.ts").filter((spec) => /urgency/.test(spec))).toEqual([]);
  });
});
