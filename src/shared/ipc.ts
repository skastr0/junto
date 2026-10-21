import type { ResourceIpcApi } from "./resource-ipc";
import type { MachineInventory } from "./harness-domain/inventory";
import type { NativeSettingWrite } from "./harness-domain/native-config";
import type { MachineCacheWindows, MachineProviders, MachineRecord } from "./machine-settings";
import type { WorkAttentionSnapshot } from "./work-attention";
import type { WorkItemQuery, WorkActorQuery, WorkActorPage, WorkAttentionQuery, WorkLaneRow, WorkSinkQuery, WorkSinkPage, WorkSinkChanged } from "./work-sinks";
import type { CanvasesChanged, Changed, Command, Opened } from "./model";
import type { WorkMailQuery, WorkMailPage, WorkMailChanged } from "./work-mail";
import type { MailThreadMessagesPage, MailThreadsPage } from "./wire/mail-threads";
import type { OperatorContentPut, OperatorContentPutResult } from "./operator-attachments";
import type {
  MentionableSeat,
  OperatorThreadSend,
  OperatorThreadSent,
  SeatThreadPageQuery,
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
import type { RemoteHost } from "./remote-hosts";
import type { OperatorRequestEnvelope, OperatorResponseEnvelope } from "./operator-control";
import type { MachineCommandProgress } from "./machine-progress";
import type { WorkMetadata, Task, Part, TaskState, FinishCriteria, CompletionEvidence, TaskAdmission, TaskPathArm, TaskRule } from "./work-model";
import type {
  SeatCollaborationAskResult,
  SeatCollaborationDraft,
} from "./seat-collaboration";
import type { WorkErrorDetails } from "./work-control";
import type { ContentRef } from "./content";
import type {
  DemoEdl,
  DemoStateInfo,
  DemoWriteEdlResult,
} from "./demo";
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
import type {
  GitCommitResult,
  GitLogResult,
  GitReviewResult,
  GitReviewView,
  GitShowResult,
  GitStatusResult,
  GitSummaryResult,
} from "./git";
import type { ActorRef } from "./work-protocol";
import type { WorkSeatRecentOpsFeed } from "./work-recent-ops";
import type {
  StateBackupId,
  StateRecoveryExportResult,
  StateRecoveryListResult,
} from "./state-recovery";
import type { UpdateApi } from "./update";
import type { PreambleEvent } from "./preamble";
import type { WireTrafficEvent } from "./wire-traffic";
import type {
  AutomationApplyRequest,
  AutomationApplyResponse,
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
  AppBriefing,
  AppBriefingWriteResult,
  ReferenceDeleteResult,
  ReferencePlaceInput,
  ReferenceReadInput,
  ReferenceSummary,
  ReferenceWriteInput,
  ReferenceWriteResult,
  ReferencesChangedEvent,
  StoredReference,
} from "./references";
import type { SourceReport, StaleSeat } from "./region-environment";
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
import type { NotifyCue, NotifyReport, NotifyTarget } from "./desktop-notifications";
import type { ShellEnvironmentChange, ShellEnvironmentStatus } from "./shell-environment";
import type { SeatCacheWindow, SeatNextTurn } from "./seat-next-launch";
import type { OverseerLiveApi } from "./overseer-live";
import type {
  ObservabilityLogEntry,
  ObservabilityQuery,
  ObservabilitySnapshot,
} from "./observability";
export type { UpdateApi, UpdateStatus, AvailableRelease, UpdatePhase } from "./update";
export type {
  ObservabilityLogEntry,
  ObservabilityQuery,
  ObservabilitySnapshot,
} from "./observability";

export type AgentSignalOperatorResult =
  | { readonly ok: true; readonly signal: AgentSignal; readonly messageId?: string }
  | { readonly ok: false; readonly message: string };

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
  agentSignalDismiss: "junto:agent-signal-dismiss",
  /** Previews of files an agent names in its text: one guarded read, and reveal. */
  previewRead: "junto:preview-read",
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
  appBriefingRead: "junto:app-briefing-read",
  appBriefingWrite: "junto:app-briefing-write",
  referencesList: "junto:references-list",
  referencesRead: "junto:references-read",
  referencesWrite: "junto:references-write",
  referencesDelete: "junto:references-delete",
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
  /** Desktop notifications: renderer reports open needs, asks for a test banner; main routes a click and a cue back. */
  notificationsReport: "junto:notifications-report",
  notificationsTest: "junto:notifications-test",
  notificationActivate: "junto:notification-activate",
  notificationCue: "junto:notification-cue",
  notificationsDelivery: "junto:notifications-delivery",
  notificationsOpenSystemSettings: "junto:notifications-open-system-settings",
  /** The operator's shell environment: what Junto read, a fresh read, and main's push when it changes. */
  shellEnvironmentStatus: "junto:shell-environment-status",
  shellEnvironmentRefresh: "junto:shell-environment-refresh",
  shellEnvironmentChanged: "junto:shell-environment-changed",
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
  workTaskCreate: "junto:work-task-create",
  workTaskDescribe: "junto:work-task-describe",
  workTaskTransition: "junto:work-task-transition",
  workTaskPromote: "junto:work-task-promote",
  workTaskComment: "junto:work-task-comment",
  workTaskRespond: "junto:work-task-respond",
  workArtifactArchive: "junto:work-artifact-archive",
  workArtifactDelete: "junto:work-artifact-delete",
  workSeatRecentOps: "junto:work-seat-recent-ops",
  workMailPage: "junto:work-mail-page",
  workItem: "junto:work-item",
  workActorPage: "junto:work-actor-page",
  workAttention: "junto:work-attention",
  workTaskPolicy: "junto:work-task-policy",
  workSinkPage: "junto:work-sink-page",
  workSinkChanged: "junto:work-sink-changed",
  // The Automations node (0.10/07): reads, the operator's writes, and a change after each.
  automationList: "junto:automation-list",
  automationFirings: "junto:automation-firings",
  automationApply: "junto:automation-apply",
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
  browserRelease: "junto:browser-release",
  browserGoto: "junto:browser-goto",
  browserTraverse: "junto:browser-traverse",
  browserOpenTab: "junto:browser-open-tab",
  browserCloseTab: "junto:browser-close-tab",
  browserActivateTab: "junto:browser-activate-tab",
  browserFocusPage: "junto:browser-focus-page",
  /** Main → renderer: a page's tabs or driving changed; the payload is its shown tab's session. */
  browserPageChanged: "junto:browser-page-changed",
  // demo/scripting engine (--junto-demo only; inert otherwise)
  demoState: "junto:demo-state",
  demoWriteEdl: "junto:demo-write-edl",
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
  // remote host registry (app-owned SQLite state)
  hostsList: "junto:hosts-list",
  /** Tailscale peers visible on the mesh but not yet enrolled. */
  hostsDiscoverPeers: "junto:hosts-discover-peers",
  hostsUpsert: "junto:hosts-upsert",
  hostsRemove: "junto:hosts-remove",
  hostsTest: "junto:hosts-test",
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
  // Command Center auto-update (Mac; readiness-gated install)
  updateGetState: "junto:update-get-state",
  updateCheck: "junto:update-check",
  updateRestartAndInstall: "junto:update-restart-and-install",
  updateStateChanged: "junto:update-state-changed",
  // main -> renderer pushes
  nodeRefOpened: "junto:node-ref-opened",
  nodeRefOpenedAck: "junto:node-ref-opened-ack",
  canvasFlushRequested: "junto:canvas-flush-requested",
  canvasFlushComplete: "junto:canvas-flush-complete",
  canvasQuiesceAndFlushRequested: "junto:canvas-quiesce-and-flush-requested",
  canvasQuiesceAndFlushStarted: "junto:canvas-quiesce-and-flush-started",
  canvasQuiesceAndFlushComplete: "junto:canvas-quiesce-and-flush-complete",
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
  terminalWrite: "junto:terminal-write",
  /** Operator multi-prompt via durable prompt-mail (deliver now or queue). */
  terminalManagedPrompt: "junto:terminal-managed-prompt",
  terminalResize: "junto:terminal-resize",
  terminalEvent: "junto:terminal-event",
  /** A lease this window held ended without its release: another view took control, or the link ended it. */
  terminalLeaseEnded: "junto:terminal-lease-ended",
  hostDirectoryRead: "junto:host-directory-read",
  gitStatus: "junto:git-status",
  gitLog: "junto:git-log",
  gitShow: "junto:git-show",
  gitSummary: "junto:git-summary",
  gitReview: "junto:git-review",
  gitCommit: "junto:git-commit",
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
  /** Renderer → main: one piece of a file the operator attaches to mail, staged in the content store. */
  operatorContentPut: "junto:operator-content-put",
  browserSessionChanged: "junto:browser-session-changed",
  // Developer observability ring (process-local; UI gated by advanced.logsExplorer)
  observabilityQuery: "junto:observability-query",
  observabilityClear: "junto:observability-clear",
  /** Renderer interest: enable live push while the explorer is open. */
  observabilityWatch: "junto:observability-watch",
  observabilityUnwatch: "junto:observability-unwatch",
  /** Main → renderer: one structured log entry (only while watched). */
  observabilityLog: "junto:observability-log",
  /** Main → renderer: ring was cleared. */
  observabilityCleared: "junto:observability-cleared",
} as const;

/** Operator-authored per-task admission and wait overlay on the create surface. */
export type TaskCreateOptions = {
  readonly admission: TaskAdmission;
  /** Explicit task wait before the first claim, in ms; wins over the board default. */
  readonly waitForMs?: number;
};

export interface ChassisApi {
  readonly doctor: () => Promise<DoctorReport>;
}

export interface CanvasSummary {
  readonly name: string;
  readonly modifiedAt: string;
}

export interface CanvasFlushRequest {
  readonly requestId: string;
}

export interface CanvasFlushResult extends CanvasFlushRequest {
  readonly ok: boolean;
}

export interface CanvasQuiesceAndFlushRequest extends CanvasFlushRequest {}

export interface CanvasQuiesceAndFlushOutcome {
  readonly ok: boolean;
  /** True once renderer mutation admission is monotonically closed. */
  readonly quiesced: boolean;
}

export interface CanvasQuiesceAndFlushResult
  extends CanvasQuiesceAndFlushRequest, CanvasQuiesceAndFlushOutcome {}

export interface DigestResult {
  readonly digest: string;
}

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
export type FactoryPauseSetResult =
  | { readonly ok: true; readonly state: CanvasPauseState }
  | { readonly ok: false; readonly error: string };

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

export type RegionEnvSaveSecretInput = {
  /** The region the source lives in. Context only; not stored. */
  readonly regionId: string;
  /** The variable name. Context only; not a key. */
  readonly name: string;
  /** Crosses IPC once. Never returned by any call. */
  readonly value: string;
  /** Present: replace the value behind this id. Absent: mint a new id. */
  readonly secretId?: string;
};
/** `message` is shown to the operator as is: plain words, no secret material. */
export type RegionEnvSaveSecretResult =
  | { readonly ok: true; readonly secretId: string }
  | { readonly ok: false; readonly message: string };
export type RegionEnvRemoveSecretResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };
/** Names, kinds, origins and status. Never a value. */
export type RegionEnvReportResult =
  | { readonly ok: true; readonly report: ReadonlyArray<SourceReport> }
  | { readonly ok: false; readonly message: string };
export type RegionEnvStaleSeatsResult =
  | { readonly ok: true; readonly seats: ReadonlyArray<StaleSeat> }
  | { readonly ok: false; readonly message: string };

export type MenuYield = "none" | "switcher" | "all";

/** A canvas's actor refs, sent whole whenever they change. */
export type ModelActorRefsChanged = {
  readonly canvas: string;
  readonly refs: ReadonlyArray<ActorRef>;
};

/**
 * The operator's shell environment (src/shared/shell-environment.ts is the
 * wire; decode with its schemas). `status` answers after the first read,
 * which main finishes before the window opens, and at once with `Resolving`
 * while a later read runs. `refresh` reads again and answers when it ends.
 */
export interface ShellEnvironmentApi {
  readonly status: () => Promise<ShellEnvironmentStatus>;
  readonly refresh: () => Promise<ShellEnvironmentStatus>;
  readonly onChange: (listener: (change: ShellEnvironmentChange) => void) => () => void;
}

export interface JuntoApi extends UpdateApi, OverseerLiveApi {
  /**
   * Tasks and artifacts from main's stores, written through main's ruler as
   * the operator (resource-ipc.ts). Each domain is there only with its feature.
   */
  readonly resource: ResourceIpcApi;
  /** Read-only platform marker for renderer geometry and copy. */
  readonly platform: NodeJS.Platform;
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
  readonly modelCommand: (command: Command) => Promise<{ readonly seq: number }>;
  /** The rows that changed on a canvas, after every commit, to every window. */
  readonly onModelChanged: (listener: (event: Changed) => void) => () => void;
  readonly onModelCanvasesChanged: (listener: (event: CanvasesChanged) => void) => () => void;
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
  /** Close an open signal without mail. */
  readonly agentSignalDismiss: (signalId: string) => Promise<AgentSignalOperatorResult>;
  /**
   * Preview a local file that the source's stored text names. Main serves
   * nothing the text does not name: see `src/main/junto/preview/read.ts`.
   */
  readonly previewRead: (request: PreviewRequest) => Promise<PreviewResult>;
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
  /** The app briefing every seat gets at onboard; null when there is none. */
  readonly appBriefingRead: () => Promise<AppBriefing | null>;
  /** Replace the app briefing; an empty body clears it. */
  readonly appBriefingWrite: (body: string) => Promise<AppBriefingWriteResult>;
  /** References by name, never their bodies: app-wide, or one region's. */
  readonly referencesList: (place?: ReferencePlaceInput) => Promise<ReadonlyArray<ReferenceSummary>>;
  /** One reference with its body; null when there is none by that name. */
  readonly referencesRead: (input: ReferenceReadInput) => Promise<StoredReference | null>;
  /** Create or replace a reference. An empty body is refused: delete instead. */
  readonly referencesWrite: (input: ReferenceWriteInput) => Promise<ReferenceWriteResult>;
  readonly referencesDelete: (input: ReferenceReadInput) => Promise<ReferenceDeleteResult>;
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
  readonly workTaskCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
    metadata?: WorkMetadata,
    reason?: string,
    /** First-class task media (raw image parts) authored into the task thread. */
    media?: ReadonlyArray<Part>,
    /** Same-sink hard prerequisites (task ids). */
    dependsOn?: ReadonlyArray<string>,
    finishCriteria?: FinishCriteria,
    /** Board-addressed rules; set at creation, immutable on generic transitions. */
    rules?: ReadonlyArray<TaskRule>,
    /** Per-task admission overlay and optional wait before the first claim. */
    options?: TaskCreateOptions,
  ) => Promise<WorkOpResult<Task>>;
  readonly workTaskDescribe: (
    canvas: string,
    nodeId: string,
    taskId: string,
    brief: string,
  ) => Promise<WorkOpResult<Task>>;
  readonly workTaskTransition: (
    canvas: string,
    nodeId: string,
    taskId: string,
    state: TaskState,
    note?: string,
    completionEvidence?: CompletionEvidence,
    path?: TaskPathArm,
  ) => Promise<WorkOpResult<Task>>;
  /** Operator approval of an approval-admission task for its current epoch. */
  readonly workTaskPromote: (
    canvas: string,
    nodeId: string,
    taskId: string,
    note?: string,
  ) => Promise<WorkOpResult<Task>>;
  /** Append an operator-authored comment through the canonical task message channel. */
  readonly workTaskComment: (
    canvas: string,
    nodeId: string,
    taskId: string,
    text: string,
  ) => Promise<WorkOpResult<Task["history"][number]>>;
  readonly workTaskRespond: (
    canvas: string,
    nodeId: string,
    taskId: string,
    responseText: string,
    disposition: "working" | "rejected",
  ) => Promise<WorkOpResult<Task>>;
  readonly workArtifactArchive: (
    canvas: string,
    nodeId: string,
    artifactId: string,
    archived: boolean,
  ) => Promise<WorkOpResult<import("./work-model").Artifact>>;
  readonly workArtifactDelete: (
    canvas: string,
    nodeId: string,
    artifactId: string,
  ) => Promise<WorkOpResult<{ readonly artifactId: string }>>;
  readonly workItem: (query: WorkItemQuery) => Promise<Task | undefined>;
  readonly workActorPage: (query: WorkActorQuery) => Promise<WorkActorPage>;
  readonly workAttention: (query: WorkAttentionQuery) => Promise<WorkAttentionSnapshot>;
  readonly workTaskPolicy: (query: WorkAttentionQuery) => Promise<ReadonlyArray<WorkLaneRow>>;
  readonly workSinkPage: (query: WorkSinkQuery) => Promise<WorkSinkPage>;
  readonly onWorkSinkChanged: (listener: (event: WorkSinkChanged) => void) => () => void;
  readonly automationList: (canvas: string, request: AutomationListRequest) => Promise<AutomationListResponse>;
  readonly automationFirings: (canvas: string, request: AutomationFiringsRequest) => Promise<AutomationFiringsResponse>;
  readonly automationApply: (canvas: string, request: AutomationApplyRequest) => Promise<AutomationApplyResponse>;
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
  /** Main -> renderer: the briefing or a reference changed, whoever wrote it. Read again. */
  readonly onReferencesChanged?: (listener: (event: ReferencesChangedEvent) => void) => () => void;
  /** Main -> renderer: one seat's offboard moved on (asked, saved, resting, started). */
  readonly onSeatOffboardProgress?: (listener: (event: SeatOffboardProgress) => void) => () => void;
  /** The seats due the auto cache mode's question, the whole list, whenever it changes. */
  readonly onSeatCacheDue?: (listener: (due: ReadonlyArray<SeatCacheDue>) => void) => () => void;
  /** Main -> renderer: one seat onboarded, or started a session that has not. */
  readonly onSeatOnboardingChanged?: (listener: (event: SeatOnboardingEvent) => void) => () => void;
  /** Main -> renderer: every profile, after any change. */
  readonly onProfilesChanged?: (listener: (profiles: ProfilesChanged) => void) => () => void;
  /** The canvas's open needs, for desktop notifications and the Dock badge. */
  readonly notificationsReport?: (
    report: NotifyReport,
  ) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Show a test banner now (where macOS asks for permission). */
  readonly notificationsTest?: () => Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Whether macOS delivers Junto's banners, as last seen. */
  readonly notificationsDelivery?: () => Promise<
    | { readonly state: "unknown" | "allowed" }
    | { readonly state: "blocked"; readonly reason: string }
  >;
  /** Open the system's notification settings for Junto (macOS). */
  readonly notificationsOpenSystemSettings?: () => Promise<{ readonly ok: boolean }>;
  /** Main → renderer: the operator clicked a notification. */
  readonly onNotificationActivate?: (listener: (target: NotifyTarget) => void) => () => void;
  /** Main → renderer: a silent banner went up; play its cue. */
  readonly onNotificationCue?: (listener: (event: { readonly cue: NotifyCue }) => void) => () => void;
  /** What Junto read from the operator's login shell: names, directories and typed causes, never values. */
  readonly shellEnvironment?: ShellEnvironmentApi;
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
  /**
   * Developer observability ring — process-local Effect + console logs.
   * UI gated by `settings.advanced.logsExplorer`.
   */
  readonly observabilityQuery: (
    query?: ObservabilityQuery,
  ) => Promise<ObservabilitySnapshot>;
  readonly observabilityClear: () => Promise<ObservabilitySnapshot>;
  /** Open a live-push interest slot (call while explorer is mounted). */
  readonly observabilityWatch: () => Promise<ObservabilitySnapshot>;
  readonly observabilityUnwatch: () => Promise<{ readonly ok: true }>;
  readonly onObservabilityLog: (
    listener: (entry: ObservabilityLogEntry) => void,
  ) => () => void;
  readonly onObservabilityCleared: (
    listener: (payload: {
      readonly newestId: number;
      readonly total: number;
      readonly dropped: number;
    }) => void,
  ) => () => void;
  /** OS login item — read real state; never assume. */
  readonly loginItemGet: () => Promise<LoginItemOpResult>;
  /** Explicit toggle only; no silent enrollment. */
  readonly loginItemSet: (openAtLogin: boolean) => Promise<LoginItemOpResult>;
}

/** The machines surface. Omitted from preload while the fleetUi flag is off. */
export interface JuntoHostsApi {
  /** The machine list, for the pickers on the canvas. It changes nothing. */
  readonly hostsList: () => Promise<HostsOpResult>;
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

export interface HostsOpResult {
  readonly ok: boolean;
  readonly hosts?: ReadonlyArray<RemoteHost>;
  readonly code?: string;
  readonly message?: string;
}

/** A Tailscale mesh peer not yet enrolled in the host registry. */
export interface DiscoveredPeer {
  readonly name: string;
  readonly addresses: ReadonlyArray<string>;
  readonly online: boolean;
  readonly os?: string;
}

/** hostsDiscoverPeers — degrades to `{ ok: true, peers: [] }`, never throws. */
export interface HostsDiscoverPeersResult {
  readonly ok: boolean;
  readonly peers?: ReadonlyArray<DiscoveredPeer>;
  readonly code?: string;
  readonly message?: string;
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

export interface HostsTestResult {
  readonly ok: boolean;
  readonly detail: string;
  /** Round-trip ms of the probe (present on probe success/failure paths). */
  readonly latencyMs?: number;
  /** Raw SSH link truth — `ok` is the strict all-checks verdict; this is
   * whether the host answered at all (remote probes only). */
  readonly reachability?: "reachable" | "unreachable" | "unknown";
  readonly code?: string;
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

/** A machine-scoped settings answer, from that machine's own core. */
export type MachineSettingsResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
    readonly ok: false;
    readonly error: {
      readonly _tag: "MachineSettingsUnavailableError";
      readonly machine: string;
      readonly reason: "unreachable" | "failed";
      readonly message: string;
      /** The typed failure behind the reason, e.g. LinkUnavailable or SettingsNoSeatHere. */
      readonly failure?: string;
      /** The operation both machines logged this request under. */
      readonly operationId?: string;
    };
  };

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
}

export interface JuntoGitApi {
  readonly gitStatus: (cwd: string) => Promise<GitStatusResult>;
  readonly gitLog: (cwd: string, limit?: number) => Promise<GitLogResult>;
  readonly gitShow: (cwd: string, sha: string) => Promise<GitShowResult>;
  /** A repository at a glance for a folder; one read per repository in main. */
  readonly gitSummary: (cwd: string) => Promise<GitSummaryResult>;
  /** The diff a reviewer reads for a folder: uncommitted work, or the branch against its base. */
  readonly gitReview: (cwd: string, view: GitReviewView) => Promise<GitReviewResult>;
  /** One commit in a folder, for a read only preview. */
  readonly gitCommit: (cwd: string, sha: string) => Promise<GitCommitResult>;
}

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
   * One piece of a file the operator attaches to a thread mail or a signal
   * answer, staged in the Mac content store as the operator; the last piece
   * answers the file's ContentRef, which the mail then names.
   */
  readonly operatorContentPut: (input: OperatorContentPut) => Promise<OperatorContentPutResult>;
}

// --- demo/scripting engine (--junto-demo only) ------------------------------
// Outside demo mode: demoState answers { active: false } and the other two
// answer ok:false — handlers are always registered, behavior is flag-gated.

export interface JuntoDemoApi {
  readonly demoState: () => Promise<DemoStateInfo>;
  readonly demoWriteEdl: (edl: DemoEdl) => Promise<DemoWriteEdlResult>;
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
