/**
 * OpenTelemetry tracing (src/shared/tracing.ts) between the window, main and
 * the core, each its own runtime with its own tracing, joined by
 * MessageChannels on the rpc-port protocols they use in the app: off, nothing
 * is built and nothing is sent; on, a window to main to core call reaches an
 * OTLP receiver started here as one trace with each server span under its
 * client span (an rpc span is named by its tag; its kind is its side), its log lines carry their span, a core restart in the middle
 * of a trace leaves later calls exported, a gone collector holds no shutdown,
 * and no payload leaves in any export.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Deferred, Duration, Effect, Layer, ManagedRuntime, Schema, Scope } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc";
import { afterEach, expect, it, vi } from "vitest";
import { clientProtocol, serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { otlpBaseUrl, processTracingLayer, TRACING_SHUTDOWN_TIMEOUT } from "../src/shared/tracing";
import { windowTracing } from "../src/window/rpc/tracing";
import { scrubCoreLog } from "../src/core/core-tracing";
import { registerKnownSecrets, releaseKnownSecrets } from "../src/core/credentials/known-secrets";
import { createLogger } from "../src/node/observability/logger";
import type { ObservabilityAppendInput } from "../src/core/observability/ring";

const SECRET = "sk-tracing-test-4f9a1c";

const CoreProbe = RpcGroup.make(
  Rpc.make("TracingCoreAsk", { payload: { secret: Schema.String }, success: Schema.String }),
  Rpc.make("TracingCoreHold", { payload: { secret: Schema.String }, success: Schema.String }),
);
const WindowProbe = RpcGroup.make(
  Rpc.make("TracingWindowAsk", { payload: { secret: Schema.String, hold: Schema.Boolean }, success: Schema.String, error: Schema.String }),
);

type Export = { readonly path: string; readonly body: Record<string, unknown> };

/** An OTLP/HTTP JSON receiver: it keeps every export it is sent and answers 200. */
const receiver = async () => {
  const exports: Array<Export> = [];
  const server = createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
      exports.push({ path: request.url ?? "", body: JSON.parse(data || "{}") as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, exports };
};

type OtlpValue = { readonly stringValue?: string };
type OtlpSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly status: { readonly code: number };
};
type ResourceSpans = {
  readonly resource: { readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: OtlpValue }> };
  readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<OtlpSpan> }>;
};
type ResourceLogs = {
  readonly scopeLogs: ReadonlyArray<{ readonly logRecords: ReadonlyArray<{ readonly body: OtlpValue; readonly traceId?: string; readonly spanId?: string }> }>;
};

/** OTLP's span kinds: an rpc span is named by its tag, and its side is its kind. */
const SERVER = 2;
const CLIENT = 3;

const serviceOf = (resource: ResourceSpans["resource"]) =>
  `${resource.attributes.find((attribute) => attribute.key === "service.name")?.value.stringValue}@${resource.attributes.find((attribute) => attribute.key === "service.version")?.value.stringValue}`;

/** Every exported span, with the process that sent it. */
const spansOf = (exports: ReadonlyArray<Export>) =>
  exports
    .filter((sent) => sent.path.endsWith("/v1/traces"))
    .flatMap((sent) => (sent.body.resourceSpans as ReadonlyArray<ResourceSpans>).flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => ({ ...span, service: serviceOf(resource.resource) }))),
    ));

const logsOf = (exports: ReadonlyArray<Export>) =>
  exports
    .filter((sent) => sent.path.endsWith("/v1/logs"))
    .flatMap((sent) => (sent.body.resourceLogs as ReadonlyArray<ResourceLogs>).flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords)));

const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

/** Main's link to the core: it outlives a core restart, as the core host's port does, and says `down` when one goes. */
const restartableLink = () => {
  const handlers = new Set<(message: PortMessage) => void>();
  const on = (message: PortMessage) => {
    for (const handler of handlers) handler(message);
  };
  let current: MessagePort | undefined;
  return {
    attach: (port: MessagePort) => {
      current?.off("message", on);
      current = port;
      port.on("message", on);
    },
    down: (reason: string) => on({ kind: "down", reason }),
    link: {
      post: (message) => current?.postMessage(message),
      listen: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } satisfies RpcPort,
  };
};

const servers: Array<Server> = [];
const ports: Array<MessagePort> = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const port of ports.splice(0)) port.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  releaseKnownSecrets("tracing-test");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const channel = () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return { port1, port2 };
};

const runtimeOf = <A>(tracing: Layer.Layer<A>) => {
  const runtime = ManagedRuntime.make(tracing);
  runtimes.push(runtime);
  return runtime;
};

/** A core: its runtime with its tracing, serving the probe group on a port. `held` hears a hold arrive. */
const startCore = async (tracing: Layer.Layer<never>, port: MessagePort, held?: Deferred.Deferred<void>) => {
  const core = runtimeOf(tracing);
  const handlers = CoreProbe.toLayer({
    TracingCoreAsk: ({ secret }) => Effect.log(`asked with ${secret}`).pipe(Effect.andThen(Effect.log("core answered")), Effect.as("answered")),
    TracingCoreHold: () => (held === undefined ? Effect.never : Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))),
  });
  await core.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(CoreProbe).pipe(Layer.provide(handlers), Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(port))))),
      core.scope,
    ),
  );
  return core;
};

/** Main: its runtime, a client of the core on `coreLink`, and the window's server on `windowPort`, forwarding to the core. */
const startMain = async (tracing: Layer.Layer<never>, coreLink: RpcPort, windowPort: MessagePort) => {
  const main = runtimeOf(tracing);
  const core = await main.runPromise(
    RpcClient.make(CoreProbe).pipe(Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(coreLink)), Scope.provide(main.scope)),
  );
  const handlers = WindowProbe.toLayer({
    TracingWindowAsk: ({ secret, hold }) =>
      (hold ? core.TracingCoreHold({ secret }) : core.TracingCoreAsk({ secret })).pipe(Effect.mapError(() => "the core went")),
  });
  await main.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(WindowProbe).pipe(Layer.provide(handlers), Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(windowPort))))),
      main.scope,
    ),
  );
  return main;
};

/** The window: its runtime and its client of main's server. */
const startWindow = async (tracing: Layer.Layer<never>, port: MessagePort) => {
  const window = runtimeOf(tracing);
  const client = await window.runPromise(
    RpcClient.make(WindowProbe).pipe(Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(linkOf(port))), Scope.provide(window.scope)),
  );
  return { window, ask: (hold: boolean) => window.runPromise(Effect.result(client.TracingWindowAsk({ secret: SECRET, hold }))) };
};

/** A process's tracing on the receiver; the core's scrubs its exported lines as the core's own does. */
const on = (url: string, serviceName: "junto-main" | "junto-core", serviceVersion = "test") =>
  processTracingLayer({ serviceName, serviceVersion, baseUrl: url, ...(serviceName === "junto-core" ? { scrub: scrubCoreLog } : {}) });

/** The three processes, wired as the app wires them, each on the tracing given. */
const startApp = async (tracing: { readonly window: Layer.Layer<never>; readonly main: Layer.Layer<never>; readonly core: Layer.Layer<never> }) => {
  const toCore = channel();
  const toWindow = channel();
  const coreLink = restartableLink();
  coreLink.attach(toCore.port1);
  const core = await startCore(tracing.core, toCore.port2);
  const main = await startMain(tracing.main, coreLink.link, toWindow.port2);
  const window = await startWindow(tracing.window, toWindow.port1);
  return { core, main, window, coreLink };
};

/** Every process's export, flushed: window first, so nothing is still in flight to a closed server. */
const flush = async (...order: ReadonlyArray<ManagedRuntime.ManagedRuntime<never, never>>) => {
  for (const runtime of order) await runtime.dispose();
};

it("reads the collector from OTEL_EXPORTER_OTLP_ENDPOINT, else JUNTO_OTLP_URL, else is off", () => {
  expect(otlpBaseUrl({})).toBeUndefined();
  expect(otlpBaseUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " })).toBeUndefined();
  expect(otlpBaseUrl({ JUNTO_OTLP_URL: "http://127.0.0.1:4318/" })).toBe("http://127.0.0.1:4318");
  expect(otlpBaseUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318", JUNTO_OTLP_URL: "http://b:4318" })).toBe("http://a:4318");
});

it("switched off, builds no tracer in any process, keeps Effect's default tracer and sends no request", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  vi.stubEnv("JUNTO_OTLP_URL", "");
  vi.resetModules();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { CoreTracing } = await import("../src/core/core-tracing");
  const { TerminalTracing } = await import("../src/terminal/tracing");
  const main = await import("../src/app/observability/tracing");
  for (const layer of [CoreTracing, TerminalTracing, main.MainTracing, windowTracing(false, "junto-app://app")]) expect(layer).toBe(Layer.empty);
  expect(main.mainOtlpProxy).toBeUndefined();
  const effect = Effect.succeed(1);
  expect(main.tracedInMain(effect)).toBe(effect);

  const app = await startApp({ window: windowTracing(false, "junto-app://app"), main: main.MainTracing, core: CoreTracing });
  expect((await app.window.ask(false))._tag).toBe("Success");
  const defaultTracer = Effect.runSync(Effect.tracer);
  for (const runtime of [app.window.window, app.main, app.core]) expect(runtime.runSync(Effect.tracer)).toBe(defaultTracer);
  await flush(app.window.window, app.main, app.core);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("switched on, a window to main to core call is one trace, each server span under its client span, its logs on their span", async () => {
  const collector = await receiver();
  const app = await startApp({
    window: windowTracing(true, collector.url),
    main: on(collector.url, "junto-main"),
    core: on(collector.url, "junto-core"),
  });
  expect(await app.window.ask(false)).toMatchObject({ _tag: "Success", success: "answered" });
  await flush(app.window.window, app.main, app.core);

  const spans = spansOf(collector.exports);
  const named = (name: string, kind: number) => {
    const found = spans.filter((span) => span.name === name && span.kind === kind);
    expect(found, `${name} ${kind}`).toHaveLength(1);
    return found[0]!;
  };
  const windowClient = named("TracingWindowAsk", CLIENT);
  const mainServer = named("TracingWindowAsk", SERVER);
  const mainClient = named("TracingCoreAsk", CLIENT);
  const coreServer = named("TracingCoreAsk", SERVER);
  expect([windowClient.service, mainServer.service, mainClient.service, coreServer.service]).toEqual([
    `junto-window@${(await import("../package.json")).version}`,
    "junto-main@test",
    "junto-main@test",
    "junto-core@test",
  ]);
  expect(new Set([windowClient, mainServer, mainClient, coreServer].map((span) => span.traceId)).size).toBe(1);
  expect(windowClient.parentSpanId).toBeUndefined();
  expect(mainServer.parentSpanId).toBe(windowClient.spanId);
  expect(mainClient.parentSpanId).toBe(mainServer.spanId);
  expect(coreServer.parentSpanId).toBe(mainClient.spanId);

  const answered = logsOf(collector.exports).filter((record) => record.body.stringValue === "core answered");
  expect(answered).toHaveLength(1);
  expect(answered[0]).toMatchObject({ traceId: coreServer.traceId, spanId: coreServer.spanId });
});

it("a core restart in the middle of a trace fails that call, exports it, and the calls after it export whole", async () => {
  const collector = await receiver();
  const held = Effect.runSync(Deferred.make<void>());
  const toCore = channel();
  const toWindow = channel();
  const coreLink = restartableLink();
  coreLink.attach(toCore.port1);
  const first = await startCore(on(collector.url, "junto-core", "first"), toCore.port2, held);
  const main = await startMain(on(collector.url, "junto-main"), coreLink.link, toWindow.port2);
  const { window, ask } = await startWindow(windowTracing(true, collector.url), toWindow.port1);

  const inFlight = ask(true);
  await Effect.runPromise(Deferred.await(held));
  // The core dies with the call open: main's link leaves its port, the host says it is down, and a new core takes the link.
  const replacement = channel();
  coreLink.attach(replacement.port1);
  coreLink.down("the core restarted");
  expect(await inFlight).toMatchObject({ _tag: "Failure", failure: "the core went" });
  await first.dispose();
  const second = await startCore(on(collector.url, "junto-core", "second"), replacement.port2);
  expect(await ask(false)).toMatchObject({ _tag: "Success", success: "answered" });

  const started = Date.now();
  await flush(window, main, second);
  expect(Date.now() - started).toBeLessThan(Duration.toMillis(TRACING_SHUTDOWN_TIMEOUT));

  const spans = spansOf(collector.exports);
  const hold = spans.find((span) => span.name === "TracingCoreHold" && span.kind === SERVER);
  const failed = spans.find((span) => span.name === "TracingWindowAsk" && span.kind === CLIENT && span.traceId === hold?.traceId);
  expect(hold?.service).toBe("junto-core@first");
  expect(failed?.status.code).toBe(2);
  const after = spans.find((span) => span.name === "TracingCoreAsk" && span.kind === SERVER);
  expect(after?.service).toBe("junto-core@second");
  const trace = spans.filter((span) => span.traceId === after?.traceId);
  expect(trace.map((span) => `${span.name} ${span.kind}`).sort()).toEqual([
    `TracingCoreAsk ${CLIENT}`,
    `TracingCoreAsk ${SERVER}`,
    `TracingWindowAsk ${CLIENT}`,
    `TracingWindowAsk ${SERVER}`,
  ].sort());
  expect(after?.parentSpanId).toBe(trace.find((span) => span.name === "TracingCoreAsk" && span.kind === CLIENT)?.spanId);
}, 20_000);

it("a collector that never answers holds no shutdown past the bounded flush", async () => {
  const silent = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  servers.push(silent);
  const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
  const runtime = ManagedRuntime.make(on(url, "junto-core"));
  await runtime.runPromise(Effect.log("a line").pipe(Effect.withSpan("work")));
  const started = Date.now();
  await runtime.dispose();
  silent.closeAllConnections();
  // The tracer and the log exporter each flush, one after the other, each within the bound.
  expect(Date.now() - started).toBeLessThan(2 * Duration.toMillis(TRACING_SHUTDOWN_TIMEOUT) + 1_000);
}, 20_000);

it("no export carries a call's payload, nor a secret the core knows, though the core logs it", async () => {
  registerKnownSecrets("tracing-test", [SECRET]);
  const collector = await receiver();
  const app = await startApp({
    window: windowTracing(true, collector.url),
    main: on(collector.url, "junto-main"),
    core: on(collector.url, "junto-core"),
  });
  await app.window.ask(false);
  await flush(app.window.window, app.main, app.core);
  expect(spansOf(collector.exports).length).toBeGreaterThan(0);
  expect(logsOf(collector.exports).some((record) => record.body.stringValue?.startsWith("asked with "))).toBe(true);
  for (const sent of collector.exports) expect(JSON.stringify(sent.body)).not.toContain(SECRET);
});

it("main holds one tracer for its runtime and its launches, and its proxy sends the window's export on unchanged, only below its own path", async () => {
  const collector = await receiver();
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  vi.stubEnv("JUNTO_OTLP_URL", collector.url);
  vi.resetModules();
  const { mainOtlpProxy, MainTracing, tracedInMain } = await import("../src/app/observability/tracing");
  expect(mainOtlpProxy).toBeDefined();
  // Main's one tracer: the app runtime's, and the one a launch outside it runs on.
  const app = runtimeOf(MainTracing);
  const tracer = await app.runPromise(Effect.tracer);
  expect(tracer).not.toBe(Effect.runSync(Effect.tracer));
  expect(await Effect.runPromise(tracedInMain(Effect.tracer))).toBe(tracer);
  const body = JSON.stringify({ resourceSpans: [] });
  const proxied = await mainOtlpProxy!(new Request("http://app/otlp/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body }));
  expect(proxied.status).toBe(200);
  expect(collector.exports).toEqual([{ path: "/v1/traces", body: { resourceSpans: [] } }]);
  const elsewhere = await mainOtlpProxy!(new Request("http://app/otlp/v1/metrics", { method: "POST", headers: { "content-type": "application/json" }, body }));
  expect(elsewhere.status).toBe(404);
  expect(collector.exports).toHaveLength(1);
});

it("switched on, a process's runtime holds the OTLP tracer, not Effect's default", async () => {
  const collector = await receiver();
  const runtime = runtimeOf(on(collector.url, "junto-core"));
  expect(await runtime.runPromise(Effect.tracer)).not.toBe(Effect.runSync(Effect.tracer));
});

it("a log line under a product log goes to that log and, with its span, to the collector", async () => {
  const collector = await receiver();
  const rows: Array<ObservabilityAppendInput> = [];
  const log = createLogger({ process: "core", echo: false, sink: (row) => void rows.push(row) });
  // As the core composes it (core-runtime.ts): the tracing beneath the runtime's layer, inside the log's.
  const runtime = runtimeOf(log.withLogger(Layer.provideMerge(Layer.empty, on(collector.url, "junto-core"))));
  await runtime.runPromise(Effect.log("both ways").pipe(Effect.withSpan("work")));
  await runtime.dispose();
  expect(rows.map((row) => row.message)).toContain("both ways");
  const work = spansOf(collector.exports).find((span) => span.name === "work");
  expect(logsOf(collector.exports).find((record) => record.body.stringValue === "both ways")).toMatchObject({ spanId: work?.spanId, traceId: work?.traceId });
});
