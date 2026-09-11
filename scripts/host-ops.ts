#!/usr/bin/env bun
/**
 * Runnable read-only host-ops diagnostics. They print a JSON receipt.
 * Usage: bun scripts/host-ops.ts inspect|attach <ssh-endpoint>
 *
 * Loads Darwin or Linux HostOps via Layer.unwrap after the platform probe.
 * Mutation verbs (copy / cleanup / configure / activate) are deliberately not
 * exposed here: every remote install mutation flows through HostRuntime
 * reconcile so serialization, maintenance leases, and receipts hold.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { HostConfigure, HostOps } from "../src/main/vellum-command/hosts/host-ops";
import { parseSshEndpoint } from "../src/main/vellum-command/ssh/domain";
import { SshTransportLive } from "../src/main/vellum-command/ssh/live";

const verbs = ["inspect", "attach"] as const;
type Verb = (typeof verbs)[number];

const usage = (): never => {
  process.stderr.write(
    "usage: bun scripts/host-ops.ts inspect|attach <ssh-endpoint>\n",
  );
  process.exit(2);
};

const isVerb = (value: string | undefined): value is Verb =>
  value !== undefined && (verbs as readonly string[]).includes(value);

const [verb, endpointText] = process.argv.slice(2);
if (!isVerb(verb) || endpointText === undefined || endpointText.length === 0) {
  usage();
}

const target = await Effect.runPromise(parseSshEndpoint(endpointText));
const runtime = ManagedRuntime.make(
  HostOps.layerForTarget(target).pipe(
    Layer.provide(HostConfigure.layerUnset),
    Layer.provide(SshTransportLive),
  ),
);

const receipt = await runtime.runPromise(
  Effect.gen(function* () {
    const ops = yield* HostOps;
    switch (verb) {
      case "attach":
        return yield* ops.attach();
      default:
        return yield* ops.inspect();
    }
  }),
);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
await runtime.dispose();
