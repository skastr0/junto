import type { AttachResponse } from "@shared/terminal-remote";

export interface RemoteSessionHost {
  readonly hostId: string;
  attach(bindingId: string, mode: "control" | "observe"): Promise<AttachResponse>;
}

/** Empty-by-default registry seam for the future Remote station transport. */
export class RemoteSessionHostRegistry {
  private readonly hosts = new Map<string, RemoteSessionHost>();

  register(host: RemoteSessionHost): () => void {
    this.hosts.set(host.hostId, host);
    return () => {
      if (this.hosts.get(host.hostId) === host) this.hosts.delete(host.hostId);
    };
  }

  get(hostId: string): RemoteSessionHost | undefined {
    return this.hosts.get(hostId);
  }
}

export const remoteSessionHosts = new RemoteSessionHostRegistry();
