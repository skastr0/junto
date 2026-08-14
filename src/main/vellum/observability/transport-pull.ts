/**
 * Pull a Remote's transport journal through the product SSH kernel.
 * Not a Station verb. Same SshTransport HostOps uses.
 */
import { join } from "node:path";
import { Effect } from "effect";
import { transportLogPathForHome } from "@shared/transport-trace";
import { inspectSshTarget, type SshTarget } from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import { remoteCat } from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";

export const pullRemoteTransportLog = Effect.fn("transport.pull")(
  function* (target: SshTarget) {
    const ssh = yield* SshTransport;
    const endpoint = inspectSshTarget(target).endpoint;
    yield* Effect.annotateCurrentSpan("endpoint", String(endpoint));
    const homeResult = yield* ssh.run(homeDirectoryLookup(target));
    const home = homeResult.stdout.trim();
    const path = transportLogPathForHome(home);
    const cat = yield* remoteCat(path);
    const result = yield* ssh.run(oneShot(target, cat, { budget: "bulk" }));
    return {
      endpoint: String(endpoint),
      path,
      text: result.stdout,
    };
  },
);

export const remoteTransportLogHint = (osHome: string): string =>
  join(osHome, ".vellum-command", "logs", "transport.jsonl");
