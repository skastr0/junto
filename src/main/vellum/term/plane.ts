import { LocalSessionHost } from "./local-host";
import { TerminalRouter } from "./router";
import {
  startTermControlServer,
  type TermControlServer,
} from "./control-server";

/**
 * App-scoped terminal plane:
 * - LocalSessionHost owns local PTYs
 * - Term control UDS exposes that host to remote CCs via SSH forward
 * - TerminalRouter routes IPC by hostId
 */
export class TermPlane {
  readonly host: LocalSessionHost;
  readonly router: TerminalRouter;
  private control: TermControlServer | undefined;
  private starting: Promise<void> | undefined;

  constructor(host = new LocalSessionHost()) {
    this.host = host;
    this.router = new TerminalRouter(host);
  }

  /** Start local control socket (idempotent). */
  start = async (): Promise<void> => {
    if (this.control) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.control = await startTermControlServer(this.host);
      console.info(`[term] control socket ${this.control.socketPath}`);
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  };

  stop = async (): Promise<void> => {
    await this.router.closeRemotes();
    // Local sessions: caller decides kill (quit) vs leave (not used).
    if (this.control) {
      await this.control.close();
      this.control = undefined;
    }
  };

  runningCount(): number {
    return this.router.runningCount();
  }
}

export const termPlane = new TermPlane();
