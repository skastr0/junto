/**
 * junto browser comment. Owner: pty-contract. A seat comments on a box of a
 * page, with a shot main takes of the box, on the editing machine only.
 *
 * The net first asserts the text bound, which holds before transport, and the
 * refusal a comment gets where no app hosts browser control. Then it hosts
 * the browser control server as the app composes it (src/main/index.ts): the
 * edge grant admits a seat on its generation credential against this core's
 * seat credential registry (dbd961246), over this core's canvases, pause
 * plane and box-comment writer. The core has no window, so its view adapter
 * refuses to make a page view: a live grant reaches the comment route, and
 * the shot and its read back stay pending on the windowed app. No shot is
 * faked.
 *
 * Every call points JUNTO_BROWSER_HOME into the sandbox, so the CLI never
 * reaches the operator's own app. The hosted home sits right under the
 * sandbox root: its control socket path must fit a unix socket's 104 bytes.
 */
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BROWSER_MAX_COMMENT_TEXT_BYTES } from "../../src/shared/browser-control";
import { makeBrowserCapabilityRegistry } from "../../src/main/junto/browser/capabilities";
import { startBrowserControlServer } from "../../src/main/junto/browser/control";
import { makeEdgeGrantService } from "../../src/main/junto/browser/edge-grant";
import { makePageTargetResolver } from "../../src/main/junto/browser/page-target";
import { makeBrowserProfileService } from "../../src/main/junto/browser/profiles";
import { BrowserSessionService } from "../../src/main/junto/browser/sessions";
import { ModelRecords } from "../../src/main/junto/model/records";
import { ModelService } from "../../src/main/junto/model/service";
import { PausePlane } from "../../src/main/junto/pause-plane";
import { postSeatPageBox } from "../../src/main/junto/work/page-box-comment";
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check, pending } = casesFor("browser");

const ON = "the windowed app: this core has no page view to capture";
const SESSION = "session-acceptance";
const BOX = "40,120,320,80";
/** The host the net's seats are assigned to (work-cli-acceptance.ts). */
const MACHINE = "acceptance";
const PAGE = "browser-page";
const NAVIGATOR = "browser-navigator";

export const browserArea: AcceptanceArea = {
  name: "browser",
  owner: "pty-contract",
  run: async ({ canvas, cli, log, outside, runtime, credentials, addSeat, operator }) => {
    const env = { JUNTO_BROWSER: "1", JUNTO_BROWSER_HOME: join(outside, "browser-home") };
    const comment = (text: string, as?: Parameters<typeof cli>[1], home = env) =>
      cli(["browser", "comment", SESSION, "--box", BOX, "--text", text], as, home);

    const oversized = await comment("a".repeat(BROWSER_MAX_COMMENT_TEXT_BYTES + 1));
    log("browser comment oversized text", oversized.stdout || oversized.stderr);
    const bound = envelopeOf(oversized);

    const posted = await comment("this button overlaps the title");
    log("browser comment with no control socket", posted.stdout || posted.stderr);
    const down = envelopeOf(posted);

    // The browser control server as the app composes it, over this core.
    const run = <A>(effect: Effect.Effect<A, unknown, unknown>) => runtime.runPromise(effect as Effect.Effect<A>);
    const hosted = { JUNTO_BROWSER: "1", JUNTO_BROWSER_HOME: join(dirname(outside), "bh") };
    const sql = await run(SqlClient.SqlClient);
    const sessions = new BrowserSessionService(
      () => {
        throw new Error("the acceptance core has no window to host a page view");
      },
      () => MACHINE,
      makeBrowserProfileService(sql, join(dirname(outside), "browser-profiles")),
    );
    const capabilities = makeBrowserCapabilityRegistry({ onTerminate: (notice) => sessions.destroyOwnerSessions(notice.auditId, "ended") });
    const listCanvasModels = () =>
      run(Effect.flatMap(ModelService, (model) => Effect.gen(function* () {
        const names = yield* model.listCanvases();
        return yield* Effect.forEach(names, (name) => Effect.map(model.canvas(name), (doc) => ({ name, doc })));
      })));
    const resolvePageTarget = (ref: unknown) =>
      run(Effect.flatMap(ModelService, (model) => Effect.promise(() => makePageTargetResolver(model)(ref))));
    const pausePlane = await run(PausePlane);
    const edgeGrant = makeEdgeGrantService({
      capabilities,
      resolvePageTarget,
      listCanvasModels,
      credentials,
      machineName: () => MACHINE,
      editsCanvas: (name) => run(Effect.flatMap(ModelRecords, (records) => records.editsCanvas(name))),
      sessions: { destroyOwnerTargetSessions: (owner, ref, reason) => sessions.destroyOwnerTargetSessions(owner, ref, reason) },
    });
    const server = await startBrowserControlServer({
      sessions,
      capabilities,
      resolvePageTarget,
      version: "acceptance",
      home: hosted.JUNTO_BROWSER_HOME,
      edgeGrant,
      listCanvasModels,
      canvasPlaying: (name) => pausePlane.stateFor(name).playing,
      postPageBoxComment: (input) => run(postSeatPageBox(sessions, input)),
    });

    let ungranted: Awaited<ReturnType<typeof cli>>;
    let granted: Awaited<ReturnType<typeof cli>>;
    try {
      // The seeded seat has no navigates edge to any page.
      ungranted = await comment("no edge to this page", undefined, hosted);
      log("browser comment from a seat with no page edge", ungranted.stdout || ungranted.stderr);

      // A seat with a navigates edge to a page node holds a live grant.
      const navigator = await addSeat(NAVIGATOR, { x: 700, y: 20 });
      await operator({
        _tag: "Add",
        canvas,
        nodes: [{ kind: "page", id: PAGE, x: 700, y: 120, width: 160, height: 90, z: 10, url: "https://example.com/", profile: "default", onRemove: "kill-session" }],
        wires: [{ id: "browser-navigates", from: NAVIGATOR, to: PAGE, verb: "navigates" }],
      });
      granted = await comment("this button overlaps the title", navigator, hosted);
      log("browser comment from a seat with a live grant, on no open session", granted.stdout || granted.stderr);
    } finally {
      await server.close();
      edgeGrant.clear();
      capabilities.close();
    }
    const refused = envelopeOf(ungranted);
    const reached = envelopeOf(granted);

    return [
      // The same call with a text in bounds reaches transport (below), so this refusal came first.
      check(
        "an oversized --text is refused before transport",
        oversized.code === 1 && bound?.ok === false && bound.error?.type === "InputError" &&
          String(bound.error?.message).includes(`text exceeds ${String(BROWSER_MAX_COMMENT_TEXT_BYTES)} UTF-8 bytes`) &&
          bound.error?.details?.next_step === "junto schema show browser.comment",
        oversized,
      ),
      check(
        "a comment where no app hosts browser control is refused RuntimeDown",
        posted.code === 1 && down?.ok === false && down.error?.type === "RuntimeDown" &&
          down.error?.details?.reason === "runtime_down" && down.error?.details?.retryable === true &&
          down.error?.details?.next_step === "start the Junto app on this machine",
        posted,
      ),
      // The reason, not the type: forbidden is moving from AuthError to ScopeError (cli-overseer).
      check(
        "a seat with no live grant is refused forbidden",
        ungranted.code === 1 && refused?.ok === false && refused.error?.details?.reason === "forbidden" &&
          refused.error?.details?.retryable === false,
        ungranted,
      ),
      // Admission runs before the route, so a refusal from the route is a live grant's.
      check(
        "a seat with a live grant reaches the comment route, refused not_found for a session it never opened",
        granted.code === 1 && reached?.ok === false && reached.error?.details?.reason === "not_found" &&
          String(reached.error?.message) === `no session for ${SESSION}`,
        granted,
      ),
      pending("a seat with a live grant posts, and the comment reads back in the page's thread with a PageBoxAnchor", ON),
    ];
  },
};
