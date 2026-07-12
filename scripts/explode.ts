#!/usr/bin/env bun
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { explodeProjectInto, explodeSessionsInto, explodeSignalsInto } from "../src/shared/explode";
import { fetchProjectGlyphs, fetchProjectSignals } from "../src/main/vellum/adapters/tower-rest";
import { fetchProjectSessions, resolveQuasarKey } from "../src/main/vellum/adapters/quasar";

// Headless explode: `bun run explode <project> [canvas] [--all-states] [--signals] [--sessions]`
// fetches the project's live glyph board (forge/beacon/scribe/survey/oracle)
// over the tower REST API and lays one group per orbit, one bound text node
// per glyph, onto ~/.vellum/canvases/<canvas|portfolio>.canvas. Existing
// nodes and the user's arrangement are preserved; only newly-seen glyphs are
// appended. Reload the app to see them; state/title hydrate live via
// resolveTowerGlyphHints on refresh.
//
// --signals additionally explodes the project's signal feed alongside the
// glyph board (one group per orbit, one bound text node per signal),
// hydrated live via resolveTowerSignalHints on refresh.
//
// --sessions additionally explodes the project's recent quasar session
// history (one group, one bound text node per session, capped to the 20 most
// recently updated). `project` is a tower project name; quasar keys sessions
// by its own projectKey, so this first resolves that key via
// resolveQuasarKey. A project with no matching quasar project is not an
// error — it just adds no session nodes.

const canvasesDir = () => join(homedir(), ".vellum", "canvases");
const canvasPath = (name: string) => join(canvasesDir(), `${name}.canvas`);

const readExisting = async (name: string): Promise<CanvasDoc> => {
  try {
    const raw = await readFile(canvasPath(name), "utf8");
    const decoded = decodeCanvasDoc(JSON.parse(raw));
    if (Either.isRight(decoded)) return decoded.right;
    console.error(`explode: ${name}.canvas is invalid, starting fresh`);
  } catch {
    // no existing canvas — start empty
  }
  return { nodes: [], edges: [] };
};

const orbitSummaryOf = <T extends { orbit: string }>(items: ReadonlyArray<T>): string => {
  const byOrbit = new Map<string, number>();
  for (const item of items) byOrbit.set(item.orbit, (byOrbit.get(item.orbit) ?? 0) + 1);
  return [...byOrbit.entries()].map(([orbit, count]) => `${orbit}:${count}`).join(" ");
};

const SESSIONS_CAP = 20;

const main = async () => {
  const args = process.argv.slice(2);
  const allStates = args.includes("--all-states");
  const withSignals = args.includes("--signals");
  const withSessions = args.includes("--sessions");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const project = positional[0];
  const canvasName = positional[1] ?? "portfolio";

  if (!project) {
    console.error("usage: bun run explode <project> [canvas] [--all-states] [--signals] [--sessions]");
    process.exit(1);
  }

  const glyphResult = await fetchProjectGlyphs(project, { activeOnly: !allStates });
  if (!glyphResult.ok) {
    console.error(`explode: failed to fetch glyphs for "${project}": ${glyphResult.error ?? "unknown error"}`);
    process.exit(1);
  }

  const signalResult = withSignals ? await fetchProjectSignals(project) : undefined;
  if (withSignals && !signalResult?.ok) {
    console.error(`explode: failed to fetch signals for "${project}": ${signalResult?.error ?? "unknown error"}`);
    process.exit(1);
  }

  // Quasar keys sessions by its own projectKey (e.g.
  // "git:github.com/skastr0/prism"), not the tower project name — resolve it
  // first. No match is not a failure: it just means this project has no
  // session history to explode.
  let quasarKey: string | undefined;
  let sessionResult: Awaited<ReturnType<typeof fetchProjectSessions>> | undefined;
  if (withSessions) {
    quasarKey = await resolveQuasarKey(project);
    if (!quasarKey) {
      console.error(`explode: no quasar project for "${project}"`);
    } else {
      sessionResult = await fetchProjectSessions(quasarKey, SESSIONS_CAP);
      if (!sessionResult.ok) {
        console.error(
          `explode: failed to fetch sessions for "${project}" (${quasarKey}): ${sessionResult.error ?? "unknown error"}`,
        );
        process.exit(1);
      }
    }
  }

  if (
    glyphResult.glyphs.length === 0 &&
    (signalResult?.signals.length ?? 0) === 0 &&
    (sessionResult?.sessions.length ?? 0) === 0
  ) {
    const missing = [
      `${allStates ? "" : "active "}glyphs`,
      withSignals ? "signals" : undefined,
      withSessions ? "sessions" : undefined,
    ].filter((part): part is string => part !== undefined);
    console.error(`explode: project "${project}" has no ${missing.join(" or ")} to add`);
    process.exit(1);
  }

  const existing = await readExisting(canvasName);
  let exploded = explodeProjectInto(existing, project, glyphResult.glyphs);
  if (signalResult) exploded = explodeSignalsInto(exploded, project, signalResult.signals);
  if (sessionResult) {
    exploded = explodeSessionsInto(
      exploded,
      project,
      sessionResult.sessions.map((session) => ({
        sessionId: session.sessionId,
        provider: session.provider,
        title: session.title,
        messageCount: session.messageCount,
      })),
    );
  }
  const added = exploded.nodes.length - existing.nodes.length;

  const validated = decodeCanvasDoc(exploded);
  if (Either.isLeft(validated)) {
    console.error(`explode: generated doc failed validation: ${validated.left.message}`);
    process.exit(1);
  }

  const serialized = serializeCanvas(applyMirrorLaw(validated.right));
  await mkdir(canvasesDir(), { recursive: true });
  const path = canvasPath(canvasName);
  await writeFile(`${path}.tmp`, serialized, "utf8");
  await rename(`${path}.tmp`, path);

  const parts = [
    `${glyphResult.glyphs.length} ${allStates ? "" : "active "}glyph(s) fetched (${orbitSummaryOf(glyphResult.glyphs)})`,
  ];
  if (signalResult) parts.push(`${signalResult.signals.length} signal(s) fetched (${orbitSummaryOf(signalResult.signals)})`);
  if (withSessions) {
    parts.push(
      sessionResult
        ? `${sessionResult.sessions.length} session(s) fetched from ${quasarKey}`
        : `0 sessions (no quasar project for "${project}")`,
    );
  }

  console.error(
    `explode: ${project} → ${parts.join(", ")}, added ${added} new node(s) to ${canvasName}.canvas (${exploded.nodes.length} total). Reload the app.`,
  );
};

void main();
