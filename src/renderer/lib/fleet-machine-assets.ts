import agentPrismSrc from "../assets/fleet/agent-prism.glb?url";
import artifactVaultSrc from "../assets/fleet/artifact-vault.glb?url";
import browserLensSrc from "../assets/fleet/browser-lens.glb?url";
import chronoDrumSrc from "../assets/fleet/chrono-drum.glb?url";
import commandCoreSrc from "../assets/fleet/command-core.glb?url";
import computeTowerSrc from "../assets/fleet/compute-tower.glb?url";
import macMiniSrc from "../assets/fleet/mac-mini.glb?url";
import macStudioSrc from "../assets/fleet/mac-studio.glb?url";
import macbookProSrc from "../assets/fleet/macbook-pro.glb?url";
import relayObeliskSrc from "../assets/fleet/relay-obelisk.glb?url";
import remoteAnchorSrc from "../assets/fleet/remote-anchor.glb?url";
import requestGateSrc from "../assets/fleet/request-gate.glb?url";
import taskFoundrySrc from "../assets/fleet/task-foundry.glb?url";
import terminalDockSrc from "../assets/fleet/terminal-dock.glb?url";
import watchBeaconSrc from "../assets/fleet/watch-beacon.glb?url";
import agentPrismAvatar from "../assets/fleet/avatars/agent-prism.png";
import artifactVaultAvatar from "../assets/fleet/avatars/artifact-vault.png";
import browserLensAvatar from "../assets/fleet/avatars/browser-lens.png";
import chronoDrumAvatar from "../assets/fleet/avatars/chrono-drum.png";
import commandCoreAvatar from "../assets/fleet/avatars/command-core.png";
import computeTowerAvatar from "../assets/fleet/avatars/compute-tower.png";
import macMiniAvatar from "../assets/fleet/avatars/mac-mini.png";
import macStudioAvatar from "../assets/fleet/avatars/mac-studio.png";
import macbookProAvatar from "../assets/fleet/avatars/macbook-pro.png";
import relayObeliskAvatar from "../assets/fleet/avatars/relay-obelisk.png";
import remoteAnchorAvatar from "../assets/fleet/avatars/remote-anchor.png";
import requestGateAvatar from "../assets/fleet/avatars/request-gate.png";
import taskFoundryAvatar from "../assets/fleet/avatars/task-foundry.png";
import terminalDockAvatar from "../assets/fleet/avatars/terminal-dock.png";
import watchBeaconAvatar from "../assets/fleet/avatars/watch-beacon.png";
import type { FleetMachineModelId } from "./fleet-machine-model";

export const FLEET_MACHINE_ASSETS: Readonly<Record<FleetMachineModelId, string>> = {
  "agent-prism": agentPrismSrc,
  "artifact-vault": artifactVaultSrc,
  "browser-lens": browserLensSrc,
  "chrono-drum": chronoDrumSrc,
  "command-core": commandCoreSrc,
  "compute-tower": computeTowerSrc,
  "mac-mini": macMiniSrc,
  "mac-studio": macStudioSrc,
  "macbook-pro": macbookProSrc,
  "relay-obelisk": relayObeliskSrc,
  "remote-anchor": remoteAnchorSrc,
  "request-gate": requestGateSrc,
  "task-foundry": taskFoundrySrc,
  "terminal-dock": terminalDockSrc,
  "watch-beacon": watchBeaconSrc,
};

export const FLEET_MACHINE_AVATARS: Readonly<Record<FleetMachineModelId, string>> = {
  "agent-prism": agentPrismAvatar,
  "artifact-vault": artifactVaultAvatar,
  "browser-lens": browserLensAvatar,
  "chrono-drum": chronoDrumAvatar,
  "command-core": commandCoreAvatar,
  "compute-tower": computeTowerAvatar,
  "mac-mini": macMiniAvatar,
  "mac-studio": macStudioAvatar,
  "macbook-pro": macbookProAvatar,
  "relay-obelisk": relayObeliskAvatar,
  "remote-anchor": remoteAnchorAvatar,
  "request-gate": requestGateAvatar,
  "task-foundry": taskFoundryAvatar,
  "terminal-dock": terminalDockAvatar,
  "watch-beacon": watchBeaconAvatar,
};
