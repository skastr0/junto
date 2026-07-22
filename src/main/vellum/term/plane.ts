import { LocalSessionHost } from "./local-host";

/** App-scoped authority for native terminal processes. */
export class TermPlane {
  readonly host: LocalSessionHost;

  constructor(host = new LocalSessionHost()) {
    this.host = host;
  }
}

export const termPlane = new TermPlane();
