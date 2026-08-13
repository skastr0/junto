#!/usr/bin/env bun
/**
 * Runnable host-ops programs. I run these. They print a JSON receipt.
 * Usage: bun scripts/host-ops.ts inspect <ssh-endpoint>
 *
 * Loads Darwin or Linux HostOps via Layer.unwrap after the platform probe.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { HostOps } from "../src/main/vellum/hosts/host-ops";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import { SshTransportLive } from "../src/main/vellum/ssh/live";

const usage = (): never => {
  process.stderr.write("usage: bun scripts/host-ops.ts inspect <ssh-endpoint>\n");
  process.exit(2);
};

const [verb, endpointText] = process.argv.slice(2);
if (verb !== "inspect" || endpointText === undefined || endpointText.length === 0) {
  usage();
}

const target = await Effect.runPromise(parseSshEndpoint(endpointText));
const runtime = ManagedRuntime.make(
  HostOps.layerForTarget(target).pipe(Layer.provide(SshTransportLive)),
);

const receipt = await runtime.runPromise(
  Effect.gen(function* () {
    const ops = yield* HostOps;
    return yield* ops.inspect();
  }),
);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
await runtime.dispose();