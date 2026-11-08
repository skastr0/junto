/**
 * Electron main's tracing (src/shared/tracing.ts): `junto-main`, and the
 * proxy the window exports through.
 *
 * Main runs effects outside its runtime too: each window's server is its own
 * launched fiber (window/ipc.ts), and the core calls a window makes run
 * there. So main builds its tracer and log exporter once, for the process,
 * and hands the same pair to every place that runs: `MainTracing` to the app
 * runtime, which closes it, and `tracedInMain` to a launch. Off, neither is
 * built and both add nothing.
 */
import { Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import { OtlpProxy } from "effect/observability";
import productMetadata from "../../../package.json";
import { scrubMessage } from "../../node/credentials/scrub";
import { exportingLoggers, makeProcessTracing, OTLP_PROXY_PATH, otlpBaseUrl, tracingLayerOf, type ProcessTracing } from "@shared/tracing";

const baseUrl = otlpBaseUrl(process.env);

let held: { readonly tracing: ProcessTracing; readonly scope: Scope.Closeable } | undefined;

/** Main's one tracing, built on first use in a scope only the app runtime closes. Building it does not wait. */
const mainTracing = (url: string) =>
  (held ??= Effect.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const tracing = yield* makeProcessTracing({
        serviceName: "junto-main",
        serviceVersion: productMetadata.version,
        baseUrl: url,
        scrub: (text) => scrubMessage(text),
      }).pipe(
        Scope.provide(scope),
      );
      return { tracing, scope };
    }),
  ));

/** For the app runtime (runtime.ts): main's tracer and log exporter, flushed, bounded, when it disposes. */
export const MainTracing: Layer.Layer<never> =
  baseUrl === undefined
    ? Layer.empty
    : Layer.unwrap(
        Effect.gen(function* () {
          const { tracing, scope } = mainTracing(baseUrl);
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          return tracingLayerOf(tracing);
        }),
      );

/** An effect main runs outside its runtime, traced on main's one tracer; off, the effect as it is. */
export const tracedInMain = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  baseUrl === undefined
    ? effect
    : Effect.suspend(() => {
        const { tracing } = mainTracing(baseUrl);
        return effect.pipe(Effect.withTracer(tracing.tracer), Effect.provide(exportingLoggers(tracing.logger)));
      });

const PROXIED: Readonly<Record<string, OtlpProxy.Signal>> = {
  [`${OTLP_PROXY_PATH}/v1/traces`]: "traces",
  [`${OTLP_PROXY_PATH}/v1/logs`]: "logs",
};

/**
 * The window's exports, as the trusted renderer protocol hands them over
 * (trusted-renderer-protocol.ts): a POST below `OTLP_PROXY_PATH` on the
 * window's own origin goes on unchanged to the collector main's environment
 * names, never to a URL or host the page gives, so the page's CSP never names
 * one. Only POSTs to the two OTLP paths below `/v1/` pass; anything else is 404. Off, undefined: the protocol answers those paths as it
 * answers any POST.
 */
export const mainOtlpProxy: ((request: Request) => Promise<Response>) | undefined =
  baseUrl === undefined
    ? undefined
    : (() => {
        const handlers = Effect.runSync(OtlpProxy.make({ baseUrl }).pipe(Effect.provide(FetchHttpClient.layer)));
        return (request: Request): Promise<Response> => {
          const signal = PROXIED[new URL(request.url).pathname];
          if (signal === undefined || request.method !== "POST") return Promise.resolve(new Response(null, { status: 404 }));
          return Effect.runPromise(
            handlers[signal].pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
              Effect.map((response) => HttpServerResponse.toWeb(response)),
            ),
          );
        };
      })();
