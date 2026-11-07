/**
 * Main's clients of the core's groups, built once on the link to the core
 * process (src/contract/core/link.ts). A registrar names the clients it uses
 * in its own type and reads them from the context built here.
 */
import { Layer } from "effect";
import { ViewStateCore } from "../../contract/core/view-state";

export const CoreClientsLive = Layer.mergeAll(ViewStateCore.layer);

export type CoreClients = Layer.Success<typeof CoreClientsLive>;
