import type { MentionIpcApi } from "./mention-ipc";
import type { ArtifactLinksApi } from "./artifact-links-ipc";
import type { ResourceIpcApi } from "./resource-ipc";
import type { MachineInventory } from "./harness-domain/inventory";
import type { AuthorityWindowData } from "./authority";
import type { NativeSettingWrite } from "./harness-domain/native-config";
import type { MachineCacheWindows, MachineProviders, MachineRecord, MachineSettingsNoAnswer } from "./machine-settings";
import type { WorkAttentionSnapshot } from "./work-attention";
import type { WorkItemQuery, WorkAttentionQuery, WorkSinkChanged } from "./work-sinks";
import type { CanvasesChanged, Changed, Command, Opened } from "./model";
import type { WorkMailQuery, WorkMailPage, WorkMailChanged } from "./work-mail";
import type { ViewStateApplyResult, ViewStateEvent, ViewStateSnapshot, ViewStateWrite } from "./view-state";
import type { MailThreadMessagesPage, MailThreadsPage } from "./wire/mail-threads";
import type { SignalReply } from "./signal-reply";
import type { SignalSecretPutRequest, SignalSecretPutResult } from "./vault";
import type { OperatorContentPut, OperatorContentPutResult } from "./operator-attachments";
import type { PageShotPurged, PageShotPurgeRequest } from "./page-shot";
import type {
  MailReadChanged,
  MailReadPoint,
  MentionableSeat,
  OperatorThreadSend,
  OperatorThreadSent,
  SeatThreadMarkRead,
  SeatThreadPageQuery,
  SeatThreadReadsQuery,
  SeatThreadsPageQuery,
  SeatThreadsQuery,
} from "./mail-threads";
import type {
  OffboardRulesPatch,
  SeatOffboardRunInput,
  SeatOffboardRunResult,
  SeatOffboardStatus,
} from "./seat-offboard";
import type { CompanionDeviceRecord, CompanionKeyRestore, CompanionPairStart, CompanionStatus } from "./companion-devices";
import type {
  BrowserProfileWipeInput,
  BrowserProfileWipeReceipt,
  BrowserSessionState,
  BrowserStopReceipt,
  BrowserTraverseStep,
} from "./browser";
import type { BrowserChromeState } from "./browser-chrome";
export type {
  BrowserProfileWipeInput,
  BrowserProfileWipeReceipt,
  BrowserStopReceipt,
} from "./browser";
import type { DoctorReport } from "./contracts";
import type { ExecutionGraphSnapshot } from "./execution-graph";
import type { OperatorRequestEnvelope, OperatorResponseEnvelope } from "./operator-control";
import type { MachineCommandProgress } from "./machine-progress";
import type { Task } from "./work-model";
import type {
  SeatCollaborationAskResult,
  SeatCollaborationDraft,
} from "./seat-collaboration";
import type { WorkErrorDetails } from "./work-control";
import type { ContentRef } from "./content";
import type { NodeRefKey } from "./node-ref";
import type { CanvasPauseState } from "./pause";
import type {
  Settings,
  SettingsOpResult,
  SettingsPatch,
  SettingsSectionKey,
  MachinePreferencesPatch,
  ProvidersPatch,
} from "./settings";
import type { UsageState } from "./usage";
import type { AgentSeatStateEvent } from "./agent-seat-state";
import type { SeatOnboardingEvent, SeatOnboardNudgeResult } from "./seat-onboarding-status";
import type { MailTransportSpec, IsolationSpec } from "./managed-terminal-templates";
import type { HarnessHelpFlag } from "./launch-extra-args";
import type { TerminalSessionSummary } from "./terminal";
import type { HostDirectorySnapshot } from "./host-directory";
import type { ActorRef } from "./work-protocol";
import type { WorkSeatRecentOpsFeed } from "./work-recent-ops";
import type {
  StateBackupId,
  StateRecoveryExportResult,
  StateRecoveryListResult,
} from "./state-recovery";
import type { PreambleEvent } from "./preamble";
import type { WireTrafficEvent } from "./wire-traffic";
import type {
  AutomationApplyRequest,
  AutomationApplyResponse,
  AutomationCodePutRequest,
  AutomationCodePutResponse,
  AutomationCodeReadRequest,
  AutomationCodeReadResponse,
  AutomationFiringsRequest,
  AutomationFiringsResponse,
  AutomationListRequest,
  AutomationListResponse,
  AutomationsChanged,
} from "./automation";
import type { MailWaitingFact } from "./mail-waiting";
import type { AgentSignal } from "./agent-signals";
import type { PreviewRequest, PreviewResult, PreviewPlayResult, PreviewRevealResult, PreviewSource } from "./preview";
import type {
  PortraitOverride,
  PortraitOverrideEvent,
  PortraitOverrides,
  PortraitOverrideSetResult,
} from "./portrait-overrides";
import type { Squad, SquadDeleteResult, SquadResult, SquadSaveInput, SquadsChanged } from "./squads";
import type {
  SeatGuidance,
  SeatGuidanceEvent,
  SeatGuidanceMap,
  SeatGuidanceSetResult,
} from "./seat-guidance";
import type {
  FactoryPauseSetResult as FactoryPauseSetResultSchema,
  RegionEnvRemoveSecretResult as RegionEnvRemoveSecretResultSchema,
  RegionEnvReportResult as RegionEnvReportResultSchema,
  RegionEnvSaveSecretInput as RegionEnvSaveSecretInputSchema,
  RegionEnvSaveSecretResult as RegionEnvSaveSecretResultSchema,
  RegionEnvStaleSeatsResult as RegionEnvStaleSeatsResultSchema,
} from "../contract/core/seats";
import type {
  OffboardMode,
  SeatOffboardAskResult,
  SeatOffboardProgress,
} from "./seat-sessions";
import type { SeatCacheDue, SeatCacheDueAnswerInput, SeatCacheDueAnswerResult } from "./seat-cache-due";
import type {
  AgentProfile,
  ProfileDeleteResult,
  ProfileResult,
  ProfileSaveInput,
  ProfilesChanged,
} from "./agent-profiles";
import type { CanvasSummary as CanvasSummarySchema } from "../contract/core/model";
import type { AgentSignalOperatorResult as AgentSignalOperatorResultSchema } from "../contract/core/signals";
import type { DigestResult as DigestResultSchema } from "../contract/core/status";
import type { SeatCacheWindow, SeatNextTurn } from "./seat-next-launch";
import type { OverseerLiveApi } from "./overseer-live";
export type { UpdateStatus, AvailableRelease, UpdatePhase } from "./update";

export type AgentSignalOperatorResult = typeof AgentSignalOperatorResultSchema.Type;

export type AgentSignalAnswerOptions = {
  /**
   * Record the answer on the signal only: no mail is appended, so the seat
   * is never typed into or started. The agent reads it later via
   * `signal list`.
   */
  readonly silent?: boolean;
  /**
   * Files the operator attached, each uploaded first through
   * `operatorContentPut`. The answer then needs no text.
   */
  readonly attachments?: ReadonlyArray<ContentRef>;
};

/**
 * How the preload words a call main did not answer within its wait: this
 * prefix, then the channel. The window tells a wait that ran out from a
 * failure by it (a secret put that timed out may still have set the value).
 */
export const IPC_NO_ANSWER_PREFIX = "junto: backend did not respond";
export const ipcNoAnswerMessage = (channel: string): string => `${IPC_NO_ANSWER_PREFIX} (${channel}). Try restarting the app.`;

export const IPC_CHANNELS = {
  liveStart: "junto:live-start",
  liveEnd: "junto:live-end",
  liveSnapshot: "junto:live-snapshot",
  liveReady: "junto:live-ready",
  liveProviderEvent: "junto:live-provider-event",
  liveAttention: "junto:live-attention",
  liveCancel: "junto:live-cancel",
  liveSteer: "junto:live-steer",
  liveStopActions: "junto:live-stop-actions",
  liveChanged: "junto:live-changed",
  doctor: "chassis:doctor",
  canvasDigest: "junto:canvas-digest",
  modelOpen: "junto:model-open",
  modelCanvases: "junto:model-canvases",
  modelCommand: "junto:model-command",
  modelChanged: "junto:model-changed",
  modelCanvasesChanged: "junto:model-canvases-changed",
  modelActorRefs: "junto:model-actor-refs",
  modelActorRefsChanged: "junto:model-actor-refs-changed",
  modelStart: "junto:model-start",
  modelSeatLaunchState: "junto:model-seat-launch-state",
  modelStop: "junto:model-stop",
  getUsage: "junto:get-usage",
  refreshUsage: "junto:refresh-usage",
  /** Main → renderer: one ephemeral agent preamble. */
  preamble: "junto:preamble",
  /** Main → renderer: one message typed into a seat (wire pulse, preambles). */
  wireTraffic: "junto:wire-traffic",
  /** Mail waiting on a seat past 30 minutes: the facts that stand, and each change (display only). */
  mailWaitingRead: "junto:mail-waiting-read",
  mailWaiting: "junto:mail-waiting",
  /** Agent signals: list per canvas, operator answer / dismiss, live upsert. */
  agentSignalsList: "junto:agent-signals-list",
  agentSignalRespond: "junto:agent-signal-respond",
  agentSignalReply: "junto:agent-signal-reply",
  signalSecretPut: "junto:signal-secret-put",
  agentSignalDismiss: "junto:agent-signal-dismiss",
  /** Previews of files an agent names in its text: one guarded read, and reveal. */
  previewRead: "junto:preview-read",
  pageShotPurge: "junto:page-shot-purge",
  previewReveal: "junto:preview-reveal",
  previewPlay: "junto:preview-play",
  /** Portrait overrides: list all seats, set or reset one, live upsert. */
  portraitOverridesList: "junto:portrait-overrides-list",
  portraitOverrideSet: "junto:portrait-override-set",
  portraitOverride: "junto:portrait-override",
  agentSignal: "junto:agent-signal",
  /** Squads: list, save (always a new squad), rename, delete, live list push. */
  squadsList: "junto:squads-list",
  squadSave: "junto:squad-save",
  squadRename: "junto:squad-rename",
  squadDelete: "junto:squad-delete",
  squadsChanged: "junto:squads-changed",
  /** Seat guidance (soul, instructions): list all seats, set or clear one, live upsert. */
  seatGuidanceList: "junto:seat-guidance-list",
  seatGuidanceSet: "junto:seat-guidance-set",
  seatGuidance: "junto:seat-guidance",
  referencesChanged: "junto:references-changed",
  /** Region environment: save or remove a value in Junto's own secret store. */
  regionEnvSaveSecret: "junto:region-env-save-secret",
  regionEnvRemoveSecret: "junto:region-env-remove-secret",
  /** Region environment: what a region resolves to, and its out-of-date running seats. */
  regionEnvReport: "junto:region-env-report",
  regionEnvStaleSeats: "junto:region-env-stale-seats",
  /** Offboard from the seat: ask the agent in a mode, and where each seat's offboard stands. */
  seatOffboardAsk: "junto:seat-offboard-ask",
  /** Ask, or offboard now, one seat or many; and what the buttons should say first. */
  seatOffboardRun: "junto:seat-offboard-run",
  seatOffboardStatus: "junto:seat-offboard-status",
  seatOffboardProgressList: "junto:seat-offboard-progress-list",
  seatOffboardProgress: "junto:seat-offboard-progress",
  /** The auto cache mode's question: the seats due it (pushed whole, and read), and the operator's answer. */
  seatCacheDue: "junto:seat-cache-due",
  seatCacheDueList: "junto:seat-cache-due-list",
  seatCacheDueAnswer: "junto:seat-cache-due-answer",
  /** Onboarding: every seat's status, one seat's change, and the operator's nudge. */
  seatOnboardingSnapshot: "junto:seat-onboarding-snapshot",
  seatOnboardingChanged: "junto:seat-onboarding-changed",
  seatOnboardNudge: "junto:seat-onboard-nudge",
  /** Agent profiles: list, save (create or replace), rename, delete, live list push. */
  profilesList: "junto:profiles-list",
  profileSave: "junto:profile-save",
  profileRename: "junto:profile-rename",
  profileDelete: "junto:profile-delete",
  profilesChanged: "junto:profiles-changed",
  /** Files node (0.11): node plus relative path in, never an absolute path out (`src/shared/files.ts`). */
  filesOpen: "junto:files-open",
  filesClose: "junto:files-close",
  filesCount: "junto:files-count",
  filesList: "junto:files-list",
  filesSearch: "junto:files-search",
  filesRead: "junto:files-read",
  filesWrite: "junto:files-write",
  filesCreate: "junto:files-create",
  filesRename: "junto:files-rename",
  filesMove: "junto:files-move",
  filesTrash: "junto:files-trash",
  filesImport: "junto:files-import",
  /** Preload -> main: an OS path a real dropped File carried; import copies only these. */
  filesDropped: "junto:files-dropped",
  filesOpenInDefaultApp: "junto:files-open-in-default-app",
  filesReveal: "junto:files-reveal",
  filesChanged: "junto:files-changed",
  /** View state (0.11, 04): the snapshot at window load, one row's write, and the push to every window. */
  viewStateSnapshot: "junto:view-state-snapshot",
  viewStateApply: "junto:view-state-apply",
  viewStateChanged: "junto:view-state-changed",
  /** A new core took over: what a window read from the last one may be stale. */
  coreRestarted: "junto:core-restarted",
  /** Phone companion: this Mac's readiness, pair a phone (QR), list and remove phones; main pushes the list. */
  companionStatus: "junto:companion-status",
  companionPairStart: "junto:companion-pair-start",
  companionPairCancel: "junto:companion-pair-cancel",
  companionPairCopyLink: "junto:companion-pair-copy-link",
  companionDevices: "junto:companion-devices",
  companionDeviceRemove: "junto:companion-device-remove",
  /** Window only: write back a paired phone's missing line, or every one ("all"). */
  companionDeviceRestore: "junto:companion-device-restore",
  companionDevicesChanged: "junto:companion-devices-changed",
  /** Is sshd listening: the one probe a paired phone's reach depends on. */
  companionRemoteLogin: "junto:companion-remote-login",
  companionOpenRemoteLoginSettings: "junto:companion-open-remote-login-settings",
  getKernelState: "junto:get-kernel-state",
  /** Factory pause plane — canvas-level switch state (born paused). */
  factoryPauseState: "junto:factory-pause-state",
  factoryPauseSet: "junto:factory-pause-set",
  /** Operator Fire now — apply scheduler output-edge effects immediately. */
  /**
   * Put image bytes into the local content store; returns a ContentRef.
   * Canvas notes and image file nodes author through this — never inline Base64
   * in the document.
   */
  contentPutImage: "junto:content-put-image",
  // work plane (serialized canvas mutations)
  workSeatRecentOps: "junto:work-seat-recent-ops",
  workMailPage: "junto:work-mail-page",
  workItem: "junto:work-item",
  workAttention: "junto:work-attention",
  workSinkChanged: "junto:work-sink-changed",
  // The Automations node (0.10/07): reads, the operator's writes, and a change after each.
  automationList: "junto:automation-list",
  automationFirings: "junto:automation-firings",
  automationApply: "junto:automation-apply",
  automationCodePut: "junto:automation-code-put",
  automationCodeRead: "junto:automation-code-read",
  automationsChanged: "junto:automations-changed",
  workMailChanged: "junto:work-mail-changed",
  // browser work surface (partitioned WebContentsView sessions)
  browserProfiles: "junto:browser-profiles",
  browserOpen: "junto:browser-open",
  browserClose: "junto:browser-close",
  browserStop: "junto:browser-stop",
  browserWipeProfile: "junto:browser-wipe-profile",
  browserSessionState: "junto:browser-session-state",
  browserSessionList: "junto:browser-session-list",
  browserSetBounds: "junto:browser-set-bounds",
  browserSurfaceConfig: "junto:browser-surface-config",
  /** Renderer → main: the page chrome's reads and the operator's commands on a page. */
  browserPageState: "junto:browser-page-state",
  browserTakeOver: "junto:browser-take-over",
  browserBoxStart: "junto:browser-box-start",
  browserBoxPost: "junto:browser-box-post",
  browserBoxDiscard: "junto:browser-box-discard",
  browserRelease: "junto:browser-release",
  browserGoto: "junto:browser-goto",
  browserTraverse: "junto:browser-traverse",
  browserOpenTab: "junto:browser-open-tab",
  browserCloseTab: "junto:browser-close-tab",
  browserActivateTab: "junto:browser-activate-tab",
  browserFocusPage: "junto:browser-focus-page",
  /** Main → renderer: a page's tabs or driving changed; the payload is its shown tab's session. */
  browserPageChanged: "junto:browser-page-changed",
  // user settings plane (app-owned SQLite state)
  settingsGet: "junto:settings-get",
  settingsPatch: "junto:settings-patch",
  /** Update this machine's supervision preference. */
  settingsSetMachinePreferences: "junto:settings-set-machine-preferences",
  settingsReset: "junto:settings-reset",
  // Verified state-backup inventory/export. Destination selection stays Main-owned.
  stateBackupsList: "junto:state-backups-list",
  stateBackupExport: "junto:state-backup-export",
  // OS login item (Electron get/setLoginItemSettings)
  loginItemGet: "junto:login-item-get",
  loginItemSet: "junto:login-item-set",
  // The Machines window: one closed owner machine command, and the steps of
  // a send or an update in flight (main -> renderer).
  machineCommand: "junto:machine-command",
  machineProgress: "junto:machine-progress",
  // main -> renderer freshness challenge; renderer -> main bootstrap receipt.
  // The opaque challenge is generation identity, never product authority.
  rendererSurfaceChallenge: "junto:renderer-surface-challenge",
  rendererSurfaceReady: "junto:renderer-surface-ready",
  // renderer -> main: the operator closed the window from the keyboard.
  windowClose: "junto:window-close",
  // renderer -> main: which of its chords the menu bar gives up to the page.
  menuYield: "junto:menu-yield",
  // renderer -> main: this window's page asks for its link (src/contract/window/link.ts).
  windowLinkOpen: "junto:window-link-open",
  /**
   * Main to a window, with a MessagePort moved alongside: the window's link,
   * on which main serves every window group (src/app/window/ipc.ts).
   */
  windowLink: "junto:window-link",
  // main -> renderer pushes
  nodeRefOpened: "junto:node-ref-opened",
  nodeRefOpenedAck: "junto:node-ref-opened-ack",
  canvasFlushRequested: "junto:canvas-flush-requested",
  canvasFlushComplete: "junto:canvas-flush-complete",
  canvasQuiesceAndFlushRequested: "junto:canvas-quiesce-and-flush-requested",
  canvasQuiesceAndFlushStarted: "junto:canvas-quiesce-and-flush-started",
  canvasQuiesceAndFlushComplete: "junto:canvas-quiesce-and-flush-complete",
  filesDraftsSettleRequested: "junto:files-drafts-settle-requested",
  filesDraftsSettleStarted: "junto:files-drafts-settle-started",
  filesDraftsSettleComplete: "junto:files-drafts-settle-complete",
  usageChanged: "junto:usage-changed",
  settingsChanged: "junto:settings-changed",
  kernelChanged: "junto:kernel-changed",
  terminalList: "junto:terminal-list",
  terminalGet: "junto:terminal-get",
  terminalKill: "junto:terminal-kill",
  /** Fence terminal creates and await exact owned teardown before node commit. */
  terminalBeginNodeDelete: "junto:terminal-begin-node-delete",
  /** Release the terminal node-delete fence after commit or abort. */
  terminalFinishNodeDelete: "junto:terminal-finish-node-delete",
  terminalAttach: "junto:terminal-attach",
  terminalRelease: "junto:terminal-release",
  /** A hidden view parks its stream; shown again, it catches up. */
  terminalPark: "junto:terminal-park",
  terminalWrite: "junto:terminal-write",
  /** Operator multi-prompt via durable prompt-mail (deliver now or queue). */
  terminalManagedPrompt: "junto:terminal-managed-prompt",
  terminalResize: "junto:terminal-resize",
  terminalEvent: "junto:terminal-event",
  /** A lease this window held ended without its release: another view took control, or the link ended it. */
  terminalLeaseEnded: "junto:terminal-lease-ended",
  /**
   * Main to a window, with a MessagePort moved alongside: the direct line from
   * a control lease's view to its PTY in the terminal process.
   */
  terminalSurface: "junto:terminal-surface",
  hostDirectoryRead: "junto:host-directory-read",
  /** Fail-soft model list for the managed-terminal harness picker. */
  managedTerminalModels: "junto:managed-terminal-models",
  /** Fail-soft Hermes profile list for the harness picker. */
  managedTerminalProfiles: "junto:managed-terminal-profiles",
  /**
   * Feature-enabled harnesses + local CLI install probe for the palette.
   * Only `installed: true` rows should be offered for authoring.
   */
  managedTerminalHarnesses: "junto:managed-terminal-harnesses",
  /** Options the installed harness lists in its own `--help`. */
  managedTerminalFlags: "junto:managed-terminal-flags",
  /** One machine's harness inventory snapshot (docs/machines.md, Harness inventory). */
  machineInventory: "junto:machine-inventory",
  /** This machine's canvas authorities (0.11/06 F5); null with the authority off. */
  authorityRead: "junto:authority-read",
  /** The authority read changed (a commit, a list edit, alone): read it again. */
  authorityChanged: "junto:authority-changed",
  /** Declared keys of a harness's own config, read on the machine that holds it. */
  nativeSettingsRead: "junto:native-settings-read",
  /** One declared key written by the machine's own Junto, answered as read back. */
  nativeSettingWrite: "junto:native-setting-write",
  /** A machine's providers (names and state only) and its own record, keyed by machine. */
  machineProviders: "junto:machine-providers",
  machineProvidersWrite: "junto:machine-providers-write",
  machineRecord: "junto:machine-record",
  machineRecordWrite: "junto:machine-record-write",
  machineCacheWindows: "junto:machine-cache-windows",
  machineCacheWindowsWrite: "junto:machine-cache-windows-write",
  /** Main → renderer: managed-agent seat state (idle/working/attention/unknown). */
  agentSeatStateSnapshot: "junto:agent-seat-state-snapshot",
  agentSeatViewed: "junto:agent-seat-viewed",
  /** Renderer → main: the operator's holds on seats (surfaces shown, keys typed). */
  seatSurfacesOpen: "junto:seat-surfaces-open",
  seatOperatorTyped: "junto:seat-operator-typed",
  agentSeatStateChanged: "junto:agent-seat-state-changed",
  /** Renderer → main: seat-awareness hydration read (advisory sidecar). */
  seatAwarenessSnapshot: "junto:seat-awareness-snapshot",
  /** Main → renderer: one advisory seat-awareness event (display only). */
  seatAwarenessChanged: "junto:seat-awareness",
  /**
   * Renderer → main: ask one seat for help. Appends a mailbox request the peer
   * answers with ordinary crew mail. Operator-originated, not model-owned.
   */
  seatCollaborationAsk: "junto:seat-collaboration-ask",
  /** Renderer → main: a seat's mail threads, newest activity first. */
  seatThreadsList: "junto:seat-threads-list",
  /** Renderer → main: one of a seat's threads, oldest first. */
  seatThreadMessages: "junto:seat-thread-messages",
  /** Renderer → main: the operator writes in a seat's threads. */
  seatThreadSend: "junto:seat-thread-send",
  /** Renderer → main: the seats a mention may name (wired to the seat). */
  seatThreadMentionables: "junto:seat-thread-mentionables",
  /** Renderer → main: the operator's read points of a seat's threads. */
  seatThreadReads: "junto:seat-thread-reads",
  /** Renderer → main: what the operator has not read in a seat, over every thread of it. */
  seatThreadUnread: "junto:seat-thread-unread",
  /** Renderer → main: the operator read a seat's thread. */
  seatThreadMarkRead: "junto:seat-thread-mark-read",
  /** Main → renderer: a read point moved, on the desktop or the phone. */
  seatThreadReadChanged: "junto:seat-thread-read-changed",
  /** Renderer → main: one piece of a file the operator attaches to mail, staged in the content store. */
  operatorContentPut: "junto:operator-content-put",
  browserSessionChanged: "junto:browser-session-changed",
} as const;

export interface ChassisApi {
  readonly doctor: () => Promise<DoctorReport>;
}

export type CanvasSummary = typeof CanvasSummarySchema.Type;

export interface CanvasFlushRequest {
  readonly requestId: string;
}

export interface CanvasFlushResult extends CanvasFlushRequest {
  readonly ok: boolean;
}

export interface CanvasQuiesceAndFlushRequest extends CanvasFlushRequest {}

/** Main asks the renderer to settle unsaved Files drafts before a quit or a close. */
export interface FilesDraftsSettleRequest {
  readonly requestId: string;
}

/** The renderer is asking the operator; main waits with no deadline from here. */
export interface FilesDraftsSettleStarted extends FilesDraftsSettleRequest {}

/** `proceed: false` is the operator's Cancel: the quit or close stops. */
export interface FilesDraftsSettleResult extends FilesDraftsSettleRequest {
  readonly proceed: boolean;
}

export interface CanvasQuiesceAndFlushOutcome {
  readonly ok: boolean;
  /** True once renderer mutation admission is monotonically closed. */
  readonly quiesced: boolean;
}

export interface CanvasQuiesceAndFlushResult
  extends CanvasQuiesceAndFlushRequest, CanvasQuiesceAndFlushOutcome {}

export type DigestResult = typeof DigestResultSchema.Type;

// --- kernel state types (wire) -----------------------------------------------

/** Blocked seats and why, projected from the kernel cycle. */
export type ExecutionSnapshot = ExecutionGraphSnapshot;

export interface KernelSnapshot {
  readonly canvases: Readonly<
    Record<
      string,
      {
        readonly execution?: ExecutionSnapshot;
      }
    >
  >;
}

// factoryPauseSet is SQLite-first (pause-plane.ts persist): ok carries the
// fresh post-write state so the renderer never re-derives; a refused write
// (state fault, failed persist) changed nothing anywhere and carries the
// reason for the operator to see inline — never swallowed.
export type FactoryPauseSetResult = typeof FactoryPauseSetResultSchema.Type;

export type WorkErrorCode =
  | "canvas_not_found"
  | "node_not_found"
  | "task_not_found"
  | "illegal_kind"
  | "illegal_transition"
  | "claim_contention"
  | "reviewer_is_author"
  | "scope_error"
  | "invalid"
  | "not_ready"
  | "unadmitted"
  | "fork_choice"
  | "wrong_home"
  | "operator_owned";

/** Work commands return their result; scoped events refresh the affected rows. */
export type WorkOpResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly disposition: "applied" | "queued";
      /** Human-readable context for an idempotent or otherwise notable mutation. */
      readonly message?: string;
    }
  | {
      readonly ok: false;
      readonly code: WorkErrorCode;
      readonly message: string;
      /** Structured facts for the control plane; never parsed out of message. */
      readonly details?: WorkErrorDetails;
    };

export interface NodeRefOpenedEvent {
  readonly ref: NodeRefKey;
  readonly canvasName: string;
  readonly nodeId: string;
}

// Internal main -> preload envelope. The delivery id never crosses the
// context bridge; it acknowledges the owner's current in-memory delivery.
export interface NodeRefOpenedDelivery extends NodeRefOpenedEvent {
  readonly deliveryId: string;
}

/** The value crosses IPC once and is never returned by any call. */
export type RegionEnvSaveSecretInput = typeof RegionEnvSaveSecretInputSchema.Type;
/** `message` is shown to the operator as is: plain words, no secret material. */
export type RegionEnvSaveSecretResult = typeof RegionEnvSaveSecretResultSchema.Type;
export type RegionEnvRemoveSecretResult = typeof RegionEnvRemoveSecretResultSchema.Type;
/** Names, kinds, origins and status. Never a value. */
export type RegionEnvReportResult = typeof RegionEnvReportResultSchema.Type;
export type RegionEnvStaleSeatsResult = typeof RegionEnvStaleSeatsResultSchema.Type;

export type MenuYield = "none" | "switcher" | "all";

/** A canvas's actor refs, sent whole whenever they change. */
export type ModelActorRefsChanged = {
  readonly canvas: string;
  readonly refs: ReadonlyArray<ActorRef>;
};

/** One view-state write's receipt; a refusal leaves the mirror as it was. */
export type { ViewStateApplyResult } from "./view-state";

/** How the operator arranged Junto (0.11, 04): read once, written per row, pushed to every window. */
export interface JuntoViewStateApi {
  readonly snapshot: () => Promise<ViewStateSnapshot>;
  readonly apply: (write: ViewStateWrite) => Promise<ViewStateApplyResult>;
  readonly onChanged: (listener: (event: ViewStateEvent) => void) => () => void;
}

export interface JuntoApi extends OverseerLiveApi {
  /**
   * Ask main for this window's link. The port arrives as a page message of
   * type `IPC_CHANNELS.windowLink`, the port moved alongside, so listen first
   * (src/window/rpc/link.ts).
   */
  readonly openWindowLink: () => void;
  /** Machine-local view state: the load snapshot and one row per write (view-state/ipc.ts). */
  readonly viewState: JuntoViewStateApi;
  /**
   * Tasks and artifacts from main's stores, written through main's ruler as
   * the operator (resource-ipc.ts). Each domain is there only with its feature.
   */
  readonly resource: ResourceIpcApi;
  /** Where each seat, task, artifact and page is mentioned, read from main (mention-ipc.ts). */
  readonly mentions: MentionIpcApi;
  /** The artifacts whose body links one, read from main (artifact-links-ipc.ts). */
  readonly artifactLinks: ArtifactLinksApi;
  /** Read-only platform marker for renderer geometry and copy. */
  readonly platform: NodeJS.Platform;
  /** Main's environment names an OTLP collector: the window traces, exporting through main (src/window/rpc/tracing.ts). */
  readonly tracing: boolean;
  /** Internal bootstrap receipt emitted after React commits the product shell. */
  readonly rendererSurfaceReady: () => void;
  /**
   * Close this window the way its close button does: canvas edits are saved
   * first, and on macOS the app and its sessions keep running.
   */
  readonly closeWindow: () => void;
  /**
   * Which of its chords the menu bar gives up to the page in this window.
   * "all": a chord is being recorded in Settings, so every chord is recorded
   * and none is run (Cmd+Q would quit). "switcher": the agent switcher is up
   * with Cmd held, so Cmd+H is the h of h j k l and does not hide the app.
   */
  readonly yieldMenuKeys: (yielding: MenuYield) => void;
  readonly canvasDigest: (name: string) => Promise<DigestResult>;
  /** Everything on one canvas, read once when it is opened. */
  readonly modelOpen: (input: { readonly canvas: string }) => Promise<Opened>;
  /** Canvas headers only, ordered by name for the switcher. */
  readonly modelCanvases: () => Promise<ReadonlyArray<CanvasSummary>>;
  /** Change something on a canvas. Resolves once committed; a refusal rejects. */
  /** `tasksKept`: tasks a restored seat could not take back, since a command ruled on them after its delete. */
  readonly modelCommand: (command: Command) => Promise<{ readonly seq: number; readonly tasksKept?: number }>;
  /** The rows that changed on a canvas, after every commit, to every window. */
  readonly onModelChanged: (listener: (event: Changed) => void) => () => void;
  readonly onModelCanvasesChanged: (listener: (event: CanvasesChanged) => void) => () => void;
  /** A new core took over: read again what the last one answered. */
  readonly onCoreRestarted: (listener: () => void) => () => void;
  /** Which seat acts for which node on a canvas. Read apart from `modelOpen`. */
  readonly modelActorRefs: (input: { readonly canvas: string }) => Promise<ReadonlyArray<ActorRef>>;
  /** The whole list again, whenever it changes. */
  readonly onModelActorRefsChanged: (listener: (event: ModelActorRefsChanged) => void) => () => void;
  /**
   * Start a seat or terminal, named by canvas and id. Main reads the node
   * itself, so the window sends no launch, and the seat's own start decides
   * what it starts on.
   */
  readonly modelStart: (input: {
    readonly canvas: string;
    readonly id: string;
  }) => Promise<TerminalSessionSummary>;
  /** Stop the session of a seat or terminal. The node stays on the canvas. */
  readonly modelStop: (input: { readonly canvas: string; readonly id: string }) => Promise<void>;
  /**
   * `settingsFixed`: the seat picks up where it was, so the mode and startup
   * flags it started with hold until it next starts fresh; decided on the
   * seat's machine. `nextTurn`: whether its next turn, whoever gives it,
   * starts fresh, running or not; absent before Junto is ready
   * (seat-next-launch.ts). `cacheWindow`: the seat against its cache window,
   * the soft warning's fact; told while the seat is still and its next turn
   * picks up where it was.
   */
  readonly modelSeatLaunchState: (input: { readonly canvas: string; readonly id: string }) => Promise<{
    readonly settingsFixed: boolean;
    readonly nextTurn?: SeatNextTurn;
    readonly cacheWindow?: SeatCacheWindow;
  }>;
  // Kernel state and control (headless kernel in main process).
  readonly getKernelState: () => Promise<KernelSnapshot>;
  // Factory pause plane (app-state switch; the factory is born paused and the
  // first play is an explicit operator confirmation — @shared/pause law).
  readonly factoryPauseState: (canvas: string) => Promise<CanvasPauseState>;
  /** Open signals plus recent history for every seat on the canvas. */
  readonly agentSignalsList: (canvas: string) => Promise<ReadonlyArray<AgentSignal>>;
  /** Each seat's mail-waiting fact that stands now, for a window load (`@shared/mail-waiting`). */
  readonly mailWaiting: () => Promise<ReadonlyArray<MailWaitingFact>>;
  /** Answer an open signal: delivered to the seat as operator mail, or only recorded when `options.silent`. */
  readonly agentSignalRespond: (
    signalId: string,
    text: string,
    options?: AgentSignalAnswerOptions,
  ) => Promise<AgentSignalOperatorResult>;
  /**
   * Hand in the work an open signal's form asks for (0.11/07, N1): a document
   * written in the signal, or proof. The form's condition is ruled before
   * anything is written.
   */
  readonly agentSignalReply: (signalId: string, reply: SignalReply) => Promise<AgentSignalOperatorResult>;
  /**
   * Set the value a secret form asks for (0.12, N5), in the vault its region
   * declares, for the machine that reads it. The value goes to the vault and
   * nowhere else: it is never echoed, logged or stored, and the field is
   * cleared after the attempt.
   */
  readonly signalSecretPut: (request: SignalSecretPutRequest) => Promise<SignalSecretPutResult>;
  /** Close an open signal without mail. */
  readonly agentSignalDismiss: (signalId: string) => Promise<AgentSignalOperatorResult>;
  /**
   * Preview a local file that the source's stored text names. Main serves
   * nothing the text does not name: see `src/app/preview/read.ts`.
   */
  readonly previewRead: (request: PreviewRequest) => Promise<PreviewResult>;
  /**
   * The operator removes a page box comment's shot on every machine. The
   * comment and its words stay; its shot reads `removed` (PAGE_SHOT_REMOVED).
   */
  readonly pageShotPurge: (request: PageShotPurgeRequest) => Promise<PageShotPurged>;
  /** Show such a file in the system file manager. */
  readonly previewReveal: (source: PreviewSource, path: string) => Promise<PreviewRevealResult>;
  /**
   * The operator pressed play on a video at a web address the source carries
   * (its attachment at `index`). Main answers with an address of the app's
   * own to play; the real one is fetched by main, and only from then on.
   */
  readonly previewPlay: (source: PreviewSource, index: number) => Promise<PreviewPlayResult>;
  /** Every seat's portrait override (character editor), keyed by node id. */
  readonly portraitOverridesList: () => Promise<PortraitOverrides>;
  /** Replace one seat's portrait override; null resets it to identity. */
  readonly portraitOverrideSet: (
    seatId: string,
    override: PortraitOverride | null,
  ) => Promise<PortraitOverrideSetResult>;
  /** The operator's squads (reusable seat templates), by name. */
  readonly squadsList: () => Promise<ReadonlyArray<Squad>>;
  /** Create a squad; a taken name is refused, never replaced. */
  readonly squadSave: (input: SquadSaveInput) => Promise<SquadResult>;
  readonly squadRename: (squadId: string, name: string) => Promise<SquadResult>;
  readonly squadDelete: (squadId: string) => Promise<SquadDeleteResult>;
  /** Every seat's soul and instructions, keyed by node id. */
  readonly seatGuidanceList: () => Promise<SeatGuidanceMap>;
  /** Replace one seat's soul and instructions; null clears both. */
  readonly seatGuidanceSet: (
    seatId: string,
    guidance: SeatGuidance | null,
  ) => Promise<SeatGuidanceSetResult>;
  /**
   * Save a value in Junto's own secret store on this machine. The value
   * crosses once and is never returned by any call; the answer is the id a
   * `secret` source refers to. With `secretId`, the value behind it is replaced.
   */
  readonly regionEnvSaveSecret?: (
    input: RegionEnvSaveSecretInput,
  ) => Promise<RegionEnvSaveSecretResult>;
  /** Remove a saved secret. Removing an unknown id succeeds. */
  readonly regionEnvRemoveSecret?: (
    secretId: string,
  ) => Promise<RegionEnvRemoveSecretResult>;
  /**
   * What a seat placed directly in this region would be launched with, in
   * application order, read from the canvas as saved at call time.
   */
  readonly regionEnvReport?: (
    canvasName: string,
    regionId: string,
  ) => Promise<RegionEnvReportResult>;
  /**
   * Running seats inside the region (nested regions included) whose launch
   * environment differs from the current resolution.
   */
  readonly regionEnvStaleSeats?: (
    canvasName: string,
    regionId: string,
  ) => Promise<RegionEnvStaleSeatsResult>;
  /**
   * Send a seat's agent the offboard prompt for this mode, on the ordinary
   * mail path. The agent writes the notes; Junto closes the session after.
   */
  readonly seatOffboardAsk?: (canvasName: string, seatId: string, mode: OffboardMode) => Promise<SeatOffboardAskResult>;
  /**
   * Ask the seats' agents to offboard, or end their sessions now (no turn,
   * no notes; only a seat that is idle, offline or resting). One call for
   * the whole selection; one row per seat comes back, in the order given.
   */
  readonly seatOffboardRun?: (input: SeatOffboardRunInput) => Promise<SeatOffboardRunResult>;
  /**
   * Before the click: whether offboard now is allowed for each seat (and why
   * not), how long it has sat still, and which action is preferred.
   */
  readonly seatOffboardStatus?: (
    canvasName: string,
    seatIds: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<SeatOffboardStatus>>;
  /** Where every seat's latest offboard stands. */
  readonly seatOffboardProgressList?: () => Promise<ReadonlyArray<SeatOffboardProgress>>;
  /**
   * The seats due the auto cache mode's question now: past their cache window
   * while open in front of the operator, and never started fresh without an
   * answer. For a window that opens; changes arrive by `onSeatCacheDue`.
   */
  readonly seatCacheDueList?: () => Promise<ReadonlyArray<SeatCacheDue>>;
  /** The operator's answer for one seat: Start fresh (`fresh`), or Keep this session (`keep`). */
  readonly seatCacheDueAnswer?: (input: SeatCacheDueAnswerInput) => Promise<SeatCacheDueAnswerResult>;
  /** Whether each seat's agent ran `junto onboard` in its current harness session. */
  readonly seatOnboardingSnapshot?: () => Promise<ReadonlyArray<SeatOnboardingEvent>>;
  /**
   * Type the onboarding nudge into a seat now. It goes through the same gate
   * as every other typed prompt, so a busy seat or a draft refuses it.
   */
  readonly seatOnboardNudge?: (canvasName: string, seatId: string) => Promise<SeatOnboardNudgeResult>;
  /** The operator's saved agent profiles, by name. */
  readonly profilesList: () => Promise<ReadonlyArray<AgentProfile>>;
  /** Create a profile (no id) or replace one's configuration. */
  readonly profileSave: (input: ProfileSaveInput) => Promise<ProfileResult>;
  readonly profileRename: (profileId: string, name: string) => Promise<ProfileResult>;
  readonly profileDelete: (profileId: string) => Promise<ProfileDeleteResult>;
  /** Canvas play/pause, the only pause scope. */
  readonly factoryPauseSet: (
    canvas: string,
    paused: boolean,
  ) => Promise<FactoryPauseSetResult>;
  /**
   * Ingest image bytes into the content store. Used by canvas image nodes and
   * note embeds. Bytes never land on a canvas; only the returned ContentRef
   * (via content object URL) is authored into the node.
   */
  readonly contentPutImage: (input: {
    readonly bytesBase64: string;
    readonly mediaType: string;
    readonly displayName?: string;
  }) => Promise<
    | { readonly ok: true; readonly ref: ContentRef }
    | { readonly ok: false; readonly error: string }
  >;
  // work plane — repository-native SQLite mutations; canvas reads provide
  // topology and runtime projection only.
  readonly workItem: (query: WorkItemQuery) => Promise<Task | undefined>;
  readonly workAttention: (query: WorkAttentionQuery) => Promise<WorkAttentionSnapshot>;
  readonly onWorkSinkChanged: (listener: (event: WorkSinkChanged) => void) => () => void;
  readonly automationList: (canvas: string, request: AutomationListRequest) => Promise<AutomationListResponse>;
  readonly automationFirings: (canvas: string, request: AutomationFiringsRequest) => Promise<AutomationFiringsResponse>;
  readonly automationApply: (canvas: string, request: AutomationApplyRequest) => Promise<AutomationApplyResponse>;
  readonly automationCodePut: (canvas: string, request: AutomationCodePutRequest) => Promise<AutomationCodePutResponse>;
  readonly automationCodeRead: (canvas: string, request: AutomationCodeReadRequest) => Promise<AutomationCodeReadResponse>;
  readonly onAutomationsChanged: (listener: (event: AutomationsChanged) => void) => () => void;
  readonly workMailPage: (query: WorkMailQuery) => Promise<WorkMailPage>;
  readonly onWorkMailChanged: (listener: (event: WorkMailChanged) => void) => () => void;
  readonly workSeatRecentOps: (
    canvas: string,
    nodeId: string,
    limit?: number,
  ) => Promise<WorkOpResult<WorkSeatRecentOpsFeed>>;
  readonly onNodeRefOpened: (
    listener: (event: NodeRefOpenedEvent) => void | Promise<void>,
  ) => () => void;
  /** Main-process close gate: resolves only after pending canvas writes settle. */
  readonly onCanvasFlushRequested: (listener: () => void | Promise<void>) => () => void;
  /**
   * Quit and close gate for unsaved Files drafts: the listener answers
   * whether leaving goes on (false is Cancel). No listener means go on.
   */
  readonly onFilesDraftsSettle: (listener: () => Promise<boolean>) => () => void;
  /** Signal-only gate: closes renderer authoring, then drains admitted writes. */
  readonly onCanvasQuiesceAndFlushRequested: (
    listener: (
      acknowledgeQuiesced: () => void,
    ) => CanvasQuiesceAndFlushOutcome | Promise<CanvasQuiesceAndFlushOutcome>,
  ) => () => void;
  /** Optional for older renderer bridges; present in the current preload. */
  readonly onPreamble?: (listener: (event: PreambleEvent) => void) => () => void;
  /** One message typed into a seat, as it lands. Optional for older bridges. */
  readonly onWireTraffic?: (listener: (event: WireTrafficEvent) => void) => () => void;
  /** A seat's mail-waiting fact as it starts, changes or clears (count 0). Optional for older bridges. */
  readonly onMailWaiting?: (listener: (fact: MailWaitingFact) => void) => () => void;
  /** Main → renderer: a signal as it now stands (upsert by signalId). */
  readonly onAgentSignal: (listener: (signal: AgentSignal) => void) => () => void;
  /** Main → renderer: one seat's portrait override as it now stands. */
  readonly onPortraitOverride: (listener: (event: PortraitOverrideEvent) => void) => () => void;
  /** Main → renderer: every squad, after any change. Optional for older bridges. */
  readonly onSquadsChanged?: (listener: (event: SquadsChanged) => void) => () => void;
  /** Main -> renderer: one seat's guidance as it now stands. */
  readonly onSeatGuidance?: (listener: (event: SeatGuidanceEvent) => void) => () => void;
  /** Main -> renderer: one seat's offboard moved on (asked, saved, resting, started). */
  readonly onSeatOffboardProgress?: (listener: (event: SeatOffboardProgress) => void) => () => void;
  /** The seats due the auto cache mode's question, the whole list, whenever it changes. */
  readonly onSeatCacheDue?: (listener: (due: ReadonlyArray<SeatCacheDue>) => void) => () => void;
  /** Main -> renderer: one seat onboarded, or started a session that has not. */
  readonly onSeatOnboardingChanged?: (listener: (event: SeatOnboardingEvent) => void) => () => void;
  /** Main -> renderer: every profile, after any change. */
  readonly onProfilesChanged?: (listener: (profiles: ProfilesChanged) => void) => () => void;
  /** Settings, Companion: this Mac's readiness to pair a phone. */
  readonly companionStatus?: () => Promise<CompanionStatus>;
  /** Start pairing a phone; the QR expires after ten minutes. */
  readonly companionPairStart?: () => Promise<CompanionPairStart>;
  /**
   * Copy link: main puts the pending pairing's link on the clipboard (the
   * renderer never holds it) and takes it off again when the pairing ends.
   */
  readonly companionPairCopyLink?: (deviceId: string) => Promise<{ readonly ok: boolean }>;
  /** Abandon a pairing that was never completed. */
  readonly companionPairCancel?: (deviceId: string) => Promise<{ readonly ok: boolean }>;
  readonly companionDevices?: () => Promise<ReadonlyArray<CompanionDeviceRecord>>;
  /** Remove a phone: its key leaves authorized_keys and its record is deleted. */
  readonly companionDeviceRemove?: (deviceId: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Restore a phone whose line is gone from authorized_keys, or every one with "all". */
  readonly companionDeviceRestore?: (target: string) => Promise<CompanionKeyRestore>;
  /** Main → renderer: the phone list after any change. */
  readonly onCompanionDevicesChanged?: (
    listener: (devices: ReadonlyArray<CompanionDeviceRecord>) => void,
  ) => () => void;
  /** Remote Login alone, without the rest of the readiness check: cheap to ask on every focus. */
  readonly companionRemoteLogin?: () => Promise<CompanionStatus["remoteLogin"]>;
  /** Open System Settings at Sharing, Remote Login (macOS). */
  readonly companionOpenRemoteLoginSettings?: () => Promise<{ readonly ok: boolean }>;
  readonly onKernelChanged: (listener: (snapshot: KernelSnapshot) => void) => () => void;
  // User settings document (main owns the SQLite row; renderer holds a live projection).
  readonly settingsGet: () => Promise<SettingsOpResult>;
  readonly settingsPatch: (patch: SettingsPatch) => Promise<SettingsOpResult>;
  /**
   * Update supervision. Machine names change through the owner command.
   */
  readonly settingsSetMachinePreferences: (
    machine: MachinePreferencesPatch,
  ) => Promise<SettingsOpResult>;
  readonly settingsReset: (section?: SettingsSectionKey) => Promise<SettingsOpResult>;
  /** Verified retained backups only; never scans arbitrary paths. */
  readonly stateBackupsList: () => Promise<StateRecoveryListResult>;
  /** Main opens the native save dialog; the renderer supplies no path. */
  readonly stateBackupExport: (
    id: StateBackupId,
  ) => Promise<StateRecoveryExportResult>;
  readonly onSettingsChanged: (listener: (settings: Settings) => void) => () => void;
  /** OS login item — read real state; never assume. */
  readonly loginItemGet: () => Promise<LoginItemOpResult>;
  /** Explicit toggle only; no silent enrollment. */
  readonly loginItemSet: (openAtLogin: boolean) => Promise<LoginItemOpResult>;
}

/** The machines surface. Omitted from preload while the fleetUi flag is off. */
export interface JuntoHostsApi {
  /**
   * One closed owner machine command, the same one `junto machine` sends.
   * Main decodes the request and answers in the owner envelope; the window
   * decodes that answer before it reads it. This is the window's whole reach
   * over machines: it can do nothing an owner command cannot.
   */
  readonly machineCommand: (request: OperatorRequestEnvelope) => Promise<OperatorResponseEnvelope>;
  /** A step of a send or an update in flight, with the id of the command it belongs to. */
  readonly onMachineProgress: (listener: (progress: MachineCommandProgress) => void) => () => void;
}

/** Optional provider-usage product surface. Omitted from preload when disabled. */
export interface JuntoUsageApi {
  readonly getUsage: () => Promise<UsageState>;
  readonly refreshUsage: () => Promise<UsageState>;
  readonly onUsageChanged: (listener: (state: UsageState) => void) => () => void;
}

/** OS login-item state from Electron getLoginItemSettings. */
export interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly openAsHidden: boolean;
  readonly wasOpenedAtLogin: boolean;
  readonly wasOpenedAsHidden: boolean;
}

/** Startup authority is platform-owned; renderer copy never grants it. */
export type StartupProvider = "apple-login-items" | "unsupported";

export interface LoginItemOpResult {
  readonly ok: boolean;
  readonly provider: StartupProvider;
  readonly state?: LoginItemState;
  readonly message?: string;
}

/** Fail-soft model option for the harness picker (main enumeration). */
export interface ManagedTerminalModelOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** The provider serving the model, when the harness names one. */
  readonly provider?: string;
  readonly efforts?: readonly string[];
}

/** A machine's harness snapshot, or why it cannot be read now. */
export type MachineInventoryFailure = {
  readonly _tag: "InventoryUnavailableError";
  readonly machine: string;
  readonly reason: "timeout" | "failed" | "unreachable" | "notInstalled";
  readonly message: string;
  /**
   * The typed failure behind the reason, e.g. LinkUnavailable or
   * InventorySnapshotRefused. NativeSettingUnconfirmed: a write's link closed
   * before its answer and a read-back could not confirm it; it may have taken.
   */
  readonly failure?: string;
  /** The operation both machines logged this request under. */
  readonly operationId?: string;
  /** The last snapshot that machine sent, and when this machine received it. */
  readonly last?: { readonly inventory: MachineInventory; readonly receivedAt: number };
};

export type MachineInventoryResult =
  | { readonly ok: true; readonly inventory: MachineInventory }
  | { readonly ok: false; readonly error: MachineInventoryFailure };

/** Why a native setting could not be read or written on its machine. */
export type NativeSettingFailure =
  | MachineInventoryFailure
  | {
    readonly _tag: "NativeSettingRefusedError";
    readonly harness: string;
    readonly key: string;
    readonly reason: "undeclared" | "version" | "value";
    readonly message: string;
  }
  | {
    readonly _tag: "NativeConfigWriteError";
    readonly machine: string;
    readonly harness: string;
    readonly key: string;
    readonly reason: "conflict" | "unsupported" | "io";
    readonly message: string;
  };

export type NativeSettingsReadResult =
  | {
    readonly ok: true;
    readonly values: Readonly<Record<string, boolean | string | number>>;
    /** Keys whose file value is outside the declared setting; shown as unset, never as text. */
    readonly unfit?: readonly string[];
  }
  | { readonly ok: false; readonly error: NativeSettingFailure };

export type NativeSettingWriteResult =
  | { readonly ok: true; readonly value: boolean | string | number }
  | { readonly ok: false; readonly error: NativeSettingFailure };

/** A machine-scoped settings answer, from that machine's own core (`machineSettingsResult`, shared/machine-settings.ts). */
export type MachineSettingsResult<A> = { readonly ok: true; readonly value: A } | MachineSettingsNoAnswer;

export interface ManagedTerminalModelsResult {
  readonly models: readonly ManagedTerminalModelOption[];
  readonly source: "cache" | "aliases" | "command" | "empty";
  readonly error?: string;
  /** Template efforts when model list carries none. */
  readonly efforts: readonly string[];
}

/** Launch options one installed harness reports about itself. */
export interface ManagedTerminalFlagsResult {
  readonly installed: boolean;
  readonly flags: readonly HarnessHelpFlag[];
  /** Built-in and publicly enumerated plugin modes, when the harness has them. */
  readonly modes?: readonly string[];
}

export interface ManagedTerminalProfileOption {
  readonly name: string;
  readonly model: string;
  readonly gateway?: string;
}

export interface ManagedTerminalProfilesResult {
  readonly profiles: readonly ManagedTerminalProfileOption[];
  readonly source: "cache" | "aliases" | "command" | "empty";
  readonly error?: string;
}

/** One feature-enabled harness with local install status for the palette. */
export interface ManagedTerminalHarnessOption {
  readonly harness: string;
  readonly displayName: string;
  readonly binary: string;
  readonly installed: boolean;
  readonly mailTransport: MailTransportSpec;
  readonly isolation: IsolationSpec;
}

export interface ManagedTerminalHarnessesResult {
  readonly harnesses: readonly ManagedTerminalHarnessOption[];
}

export type TerminalNodeDeleteResource = {
  readonly bindingId: string;
  readonly hostId?: string;
};

export type TerminalBeginNodeDeleteResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly closeResults: ReadonlyArray<{
        readonly bindingId: string;
        readonly hostId: string;
        readonly clean: true;
      }>;
    }
  | { readonly ok: false; readonly error: string };

export type TerminalFinishNodeDeleteOutcome = "committed" | "aborted";

export type TerminalFinishNodeDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface TerminalAttachInput {
  readonly bindingId: string;
  readonly mode: "control" | "observe";
  readonly takeover?: boolean;
  /** Route to remote station when not local. */
  readonly hostId?: string;
  /**
   * A control view that can take a surface port: when its PTY runs in the
   * terminal process, its keys and echo go over the port, not IPC
   * (`terminalSurface`).
   */
  readonly surface?: boolean;
}

/**
 * A park answer. `missed` says main held back output while the view was
 * parked; the view then repaints from `screen` (the main grid's serialized
 * state, scrollback included) or, for a generation that already exited and
 * has no grid, from its final `journal`.
 */
export type TerminalParkResult =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly missed: boolean;
      readonly screen?: {
        readonly epoch: string;
        readonly cols: number;
        readonly rows: number;
        readonly seq: bigint;
        readonly serialized: string;
      };
      readonly journal?: readonly { readonly type: string; readonly data?: string; readonly seq?: bigint }[];
    };

/** submitted = typed into the seat; queued = waiting for the seat to start. */
export type TerminalManagedPromptDisposition =
  | "submitted"
  | "queued"
  | "failed";

export type TerminalManagedPromptResult = {
  readonly ok: boolean;
  readonly disposition: TerminalManagedPromptDisposition;
  readonly messageId?: string;
  readonly reason?: string;
  readonly error?: string;
};

export interface JuntoTerminalApi {
  readonly terminalList: (hostId?: string) => Promise<readonly TerminalSessionSummary[]>;
  readonly terminalGet: (bindingId: string, hostId?: string) => Promise<TerminalSessionSummary | undefined>;
  readonly terminalKill: (bindingId: string, hostId?: string) => Promise<boolean>;
  readonly terminalBeginNodeDelete: (
    resources: ReadonlyArray<TerminalNodeDeleteResource>,
  ) => Promise<TerminalBeginNodeDeleteResult>;
  readonly terminalFinishNodeDelete: (
    leaseId: string,
    outcome: TerminalFinishNodeDeleteOutcome,
  ) => Promise<TerminalFinishNodeDeleteResult>;
  /** Read one bounded directory page on the selected local or Remote host. */
  readonly hostDirectoryRead: (
    hostId: string,
    path?: string,
  ) => Promise<HostDirectorySnapshot>;
  readonly terminalAttach: (input: TerminalAttachInput) => Promise<unknown>;
  readonly terminalRelease: (leaseId: string) => Promise<boolean>;
  /**
   * Park (true) or unpark (false) this window's lease. A parked lease keeps
   * its control and its scrollback, and main sends it no output until it is
   * unparked; the unpark answer carries the catch-up.
   */
  readonly terminalPark?: (leaseId: string, parked: boolean) => Promise<TerminalParkResult>;
  readonly terminalWrite: (leaseId: string, data: string, encoding?: "utf8" | "base64") => Promise<boolean>;
  /**
   * Submit one operator multi-prompt via durable prompt-mail. Immediate
   * delivery when the seat's terminal is ready; otherwise the row stays
   * pending, the seat is started if its canvas is playing, and the verdict
   * is `queued`. `wake: false` never starts a down seat. Does not require a
   * renderer control lease.
   */
  readonly terminalManagedPrompt: (input: {
    readonly bindingId: string;
    readonly text: string;
    readonly canvasName?: string;
    readonly nodeId?: string;
    /** False keeps a down seat down; the prompt waits in its mailbox. */
    readonly wake?: boolean;
  }) => Promise<TerminalManagedPromptResult>;
  readonly terminalResize: (leaseId: string, cols: number, rows: number) => Promise<boolean>;
  readonly onTerminalEvent: (listener: (event: unknown) => void) => () => void;
  /** This window's lease ended without its release; `{ leaseId, reason }`, reason a closed word. */
  readonly onTerminalLeaseEnded?: (listener: (event: unknown) => void) => () => void;
  /** Fail-soft model enumeration for one harness (empty list = use defaults). */
  readonly managedTerminalModels: (
    harness: string,
  ) => Promise<ManagedTerminalModelsResult>;
  /** Fail-soft Hermes profile enumeration. */
  readonly managedTerminalProfiles: () => Promise<ManagedTerminalProfilesResult>;
  /**
   * Feature-enabled harnesses with local CLI install status.
   * Palette filters to `installed` before offering a seat.
   */
  readonly managedTerminalHarnesses: () => Promise<ManagedTerminalHarnessesResult>;
  /** One machine's harness inventory, answered at once from that machine's cache. */
  readonly machineInventory: (machine: string) => Promise<MachineInventoryResult>;
  /** This machine's canvas authorities for every canvas it holds; null with the authority off. */
  readonly authorityRead: () => Promise<AuthorityWindowData | null>;
  /** The authority read changed; read it again. Returns its own unsubscribe. */
  readonly onAuthorityChanged: (listener: () => void) => () => void;
  /** Declared keys of a harness's own config on a machine, read by that machine. */
  readonly nativeSettingsRead: (input: {
    readonly machine: string;
    readonly harness: string;
    readonly keys: readonly string[];
  }) => Promise<NativeSettingsReadResult>;
  /** One declared key, written by the machine's own Junto. */
  readonly nativeSettingWrite: (write: NativeSettingWrite) => Promise<NativeSettingWriteResult>;
  /** A machine's providers: credential names and whether each is set, never a value. */
  readonly machineProviders: (machine: string) => Promise<MachineSettingsResult<MachineProviders>>;
  readonly machineProvidersWrite: (input: {
    readonly machine: string;
    readonly patch: ProvidersPatch;
  }) => Promise<MachineSettingsResult<MachineProviders>>;
  /** A machine's own record: its name and how it is kept running. */
  readonly machineRecord: (machine: string) => Promise<MachineSettingsResult<MachineRecord>>;
  readonly machineRecordWrite: (input: {
    readonly machine: string;
    readonly patch: MachinePreferencesPatch;
  }) => Promise<MachineSettingsResult<MachineRecord>>;
  /** A machine's cache windows: its own, and each harness's that differs. */
  readonly machineCacheWindows: (machine: string) => Promise<MachineSettingsResult<MachineCacheWindows>>;
  readonly machineCacheWindowsWrite: (input: {
    readonly machine: string;
    readonly patch: OffboardRulesPatch;
  }) => Promise<MachineSettingsResult<MachineCacheWindows>>;
  /**
   * Fail-soft: the options the installed harness prints in `--help`, for the
   * launch-parameter editor, plus Amp plugin modes in the chosen folder.
   * Empty when the harness is absent or silent.
   */
  readonly managedTerminalFlags: (
    harness: string,
    cwd?: string,
  ) => Promise<ManagedTerminalFlagsResult>;
  /** Current managed-seat projection for renderer restart hydration. */
  readonly agentSeatStateSnapshot: () => Promise<ReadonlyArray<AgentSeatStateEvent>>;
  /**
   * The operator viewed a seat: its finished turn is no longer unseen. Names
   * the binding, not the window, so a view from any window counts.
   */
  readonly agentSeatViewed: (bindingId: string) => Promise<void>;
  /**
   * Every binding this window shows a terminal for, as a whole list each time
   * it changes. Main holds those seats' sessions while any window shows them.
   */
  readonly seatSurfacesOpen: (bindingIds: ReadonlyArray<string>) => Promise<void>;
  /** The operator typed into a binding's terminal in this window. */
  readonly seatOperatorTyped: (bindingId: string) => Promise<void>;
  /** Main → renderer: managed-agent seat state (idle/working/attention/unknown). */
  readonly onAgentSeatStateChanged: (
    listener: (event: AgentSeatStateEvent) => void,
  ) => () => void;
  /**
   * Current advisory seat-awareness projection for renderer restart hydration.
   * Decoded strictly by the renderer contract; main owns the producer shape.
   */
  readonly seatAwarenessSnapshot: () => Promise<ReadonlyArray<unknown>>;
  /** Main → renderer: one advisory seat-awareness event (display only). */
  readonly onSeatAwarenessChanged: (
    listener: (event: unknown) => void,
  ) => () => void;
  /**
   * Ask one seat for help: append a collaboration request to its mailbox. The
   * peer answers with ordinary crew mail, which is what the return path reads.
   */
  readonly seatCollaborationAsk: (
    input: SeatCollaborationDraft,
  ) => Promise<SeatCollaborationAskResult>;
  /**
   * Mail threads, for a seat's Threads popup, a page at a time: the list from
   * the newest or after a cursor, a thread's messages the newest or before a
   * cursor. Main never ships a whole list. Read again on `onWorkMailChanged`
   * for the canvas: any mailbox can change a seat's threads.
   */
  readonly seatThreadsList: (query: SeatThreadsPageQuery) => Promise<MailThreadsPage>;
  readonly seatThreadMessages: (query: SeatThreadPageQuery) => Promise<MailThreadMessagesPage>;
  /** No threadId and no inReplyTo starts a thread; a mention is a link in the text to a wired seat. */
  readonly seatThreadSend: (input: OperatorThreadSend) => Promise<OperatorThreadSent>;
  readonly seatThreadMentionables: (query: SeatThreadsQuery) => Promise<ReadonlyArray<MentionableSeat>>;
  /**
   * The operator's read point in each of a seat's threads, by thread id; a
   * thread never read is absent. One point per thread, shared with the phone:
   * a thread between two seats read under one is read under both.
   */
  readonly seatThreadReads: (query: SeatThreadReadsQuery) => Promise<Readonly<Record<string, MailReadPoint>>>;
  /**
   * What the operator has not read in a seat, counted over every thread of it
   * rather than the page a list holds. Undefined when it cannot be read, so a
   * surface keeps the count it had rather than claim zero.
   */
  readonly seatThreadUnread: (query: SeatThreadReadsQuery) => Promise<number | undefined>;
  /**
   * Read a thread through a mail, or through its newest. Forward only; a mark
   * that moves nothing writes nothing and tells no one, so it is safe on every
   * render. Undefined on a refusal; it never rejects.
   */
  readonly seatThreadMarkRead: (input: SeatThreadMarkRead) => Promise<MailReadPoint | undefined>;
  /** Main → renderer: a read point moved, from any surface, naming every seat of the thread. */
  readonly onSeatThreadReadChanged: (listener: (change: MailReadChanged) => void) => () => void;
  /**
   * One piece of a file the operator attaches to a thread mail or a signal
   * answer, staged in the Mac content store as the operator; the last piece
   * answers the file's ContentRef, which the mail then names.
   */
  readonly operatorContentPut: (input: OperatorContentPut) => Promise<OperatorContentPutResult>;
}

// --- browser work surface (partitioned WebContentsView; not a corpus join) ---

export interface BrowserProfileInfo {
  readonly id: string;
  readonly label?: string;
  readonly default?: boolean;
}

export interface BrowserOpResult<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly code?: string;
  readonly message?: string;
}

/** What box drawing gave: a box with the shot main staged for it, or none. */
export type BrowserBoxStarted =
  | {
      readonly kind: "drawn";
      readonly draft: {
        readonly shotId: string;
        readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
        readonly url: string;
        readonly width: number;
        readonly height: number;
        readonly png: Uint8Array;
      };
    }
  | { readonly kind: "ended" };

export interface BrowserOpenInput {
  readonly ref: NodeRefKey;
}

/** Renderer-measured DOM rect where the native view should sit (CSS px). */
export interface BrowserSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSessionInfo {
  readonly sessionId: string;
  readonly ref: NodeRefKey;
  readonly nodeId: string;
  readonly url: string;
  readonly profile: string;
  readonly state: BrowserSessionState;
  readonly attached: boolean;
  readonly title?: string;
  readonly lastError?: string;
  /**
   * Shown to a seat while the operator holds the page: it is paused, and the
   * page's url, title and error are left out, as the operator is using it.
   */
  readonly operatorHolds?: true;
}

/** Dock/pool limits from BrowserProfileService config — renderer reads, never guesses. */
export interface BrowserSurfaceConfigInfo {
  readonly maxVisibleSurfaces: number;
  readonly maxWarmSessions: number;
}

export interface JuntoBrowserApi {
  readonly browserProfiles: () => Promise<BrowserOpResult<ReadonlyArray<BrowserProfileInfo>>>;
  readonly browserSurfaceConfig: () => Promise<BrowserOpResult<BrowserSurfaceConfigInfo>>;
  readonly browserOpen: (input: BrowserOpenInput) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserClose: (sessionId: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserStop: (sessionId: string) => Promise<BrowserOpResult<BrowserStopReceipt>>;
  readonly browserWipeProfile: (
    input: BrowserProfileWipeInput,
  ) => Promise<BrowserOpResult<BrowserProfileWipeReceipt>>;
  readonly browserSessionState: (sessionId: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserSessionList: () => Promise<BrowserOpResult<ReadonlyArray<BrowserSessionInfo>>>;
  readonly browserSetBounds: (
    sessionId: string,
    bounds: BrowserSurfaceBounds,
  ) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly onBrowserSessionChanged: (
    listener: (session: BrowserSessionInfo) => void,
  ) => () => void;
  /** The page's tabs and who drives it; any tab's session names the page. */
  readonly browserPageState: (sessionId: string) => Promise<BrowserOpResult<BrowserChromeState>>;
  readonly browserTakeOver: (sessionId: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  /**
   * The operator draws a box over the page's view; main takes the shot and
   * stages it under a shot id (plan 06, B7). `ended` when drawing ended with
   * no box. The renderer never sends bytes.
   */
  readonly browserBoxStart: (sessionId: string) => Promise<BrowserOpResult<BrowserBoxStarted>>;
  /**
   * Post the comment with exactly the staged shot. Posted, the shot is spent;
   * refused before it was claimed (the text, a mention), it stays for a retry.
   */
  readonly browserBoxPost: (
    sessionId: string,
    shotId: string,
    text: string,
  ) => Promise<BrowserOpResult<{ readonly messageId: string; readonly threadId: string }>>;
  /** Drop a staged shot that was not posted. */
  readonly browserBoxDiscard: (sessionId: string, shotId: string) => Promise<BrowserOpResult<null>>;
  readonly browserRelease: (sessionId: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  /** Go on the named tab, or the shown one. */
  readonly browserGoto: (
    sessionId: string,
    url: string,
    tab?: string,
  ) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserTraverse: (
    sessionId: string,
    step: BrowserTraverseStep,
  ) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserOpenTab: (sessionId: string, url?: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserCloseTab: (sessionId: string, tab: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserActivateTab: (sessionId: string, tab: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserFocusPage: (sessionId: string) => Promise<BrowserOpResult<boolean>>;
  /** Hears the shown tab's session of a page whose tabs or driving changed. */
  readonly onBrowserPageChanged: (listener: (sessionId: string) => void) => () => void;
}
