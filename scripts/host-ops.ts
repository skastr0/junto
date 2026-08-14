#!/usr/bin/env bun
/**
 * Runnable host-ops programs. I run these. They print a JSON receipt.
 * Usage: bun scripts/host-ops.ts inspect|copy|cleanup|configure|activate|attach <ssh-endpoint> [cc-installation-id app-version]
 *
 * Loads Darwin or Linux HostOps via Layer.unwrap after the platform probe.
 */
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { InstallationId } from "../src/shared/installation-id";
import { HostOps } from "../src/main/vellum/hosts/host-ops";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import { SshTransportLive } from "../src/main/vellum/ssh/live";

const verbs = [
  "inspect",
  "copy",
  "cleanup",
  "configure",
  "activate",
  "attach",
] as const;
type Verb = (typeof verbs)[number];

const usage = (): never => {
  process.stderr.write(
    "usage: bun scripts/host-ops.ts inspect|copy|cleanup|configure|activate|attach <ssh-endpoint> [cc-installation-id app-version]\n",
  );
  process.exit(2);
};

const isVerb = (value: string | undefined): value is Verb =>
  value !== undefined && (verbs as readonly string[]).includes(value);

const [verb, endpointText, ccId, appVersion] = process.argv.slice(2);
if (!isVerb(verb) || endpointText === undefined || endpointText.length === 0) {
  usage();
}
if (verb === "configure" && (ccId === undefined || appVersion === undefined)) {
  usage();
}

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const target = await Effect.runPromise(parseSshEndpoint(endpointText));
const facts = {
  commandCenterInstallationId: decodeInstallationId(ccId ?? "unset"),
  appVersion: appVersion ?? "0.0.0",
};
const runtime = ManagedRuntime.make(
  HostOps.layerForTarget(target, facts).pipe(Layer.provide(SshTransportLive)),
);

const receipt = await runtime.runPromise(
  Effect.gen(function* () {
    const ops = yield* HostOps;
    switch (verb) {
      case "copy":
        return yield* ops.copy();
      case "cleanup":
        return yield* ops.cleanup();
      case "configure":
        return yield* ops.configure();
      case "activate":
        return yield* ops.activate();
      case "attach":
        return yield* ops.attach();
      default:
        return yield* ops.inspect();
    }
  }),
);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
await runtime.dispose();
