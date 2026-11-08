/**
 * Main's clients of the core's groups, built once on the link to the core
 * process (src/contract/core/link.ts). A registrar names the clients it uses
 * in its own type and reads them from the context built here.
 */
import { Layer } from "effect";
import type { CorePushesMain } from "./main-side/core-pushes";
import { AutomationCore } from "../../contract/core/automation";
import { BrowserCore } from "../../contract/core/browser";
import { BrowserStoreCore } from "../../contract/core/browser-store";
import { CompanionCore } from "../../contract/core/companion";
import { ContentCore } from "../../contract/core/content";
import { CoreReadsCore } from "../../contract/core/core-reads";
import { FilesCore } from "../../contract/core/files";
import { GitCore } from "../../contract/core/git";
import { HostsCore } from "../../contract/core/hosts-ipc";
import { LibraryCore } from "../../contract/core/library";
import { MainIndexCore } from "../../contract/core/main-index";
import { MentionCore } from "../../contract/core/mention-ipc";
import { ModelCore } from "../../contract/core/model";
import { ObservabilityCore } from "../../contract/core/observability";
import { OverseerLiveCore } from "../../contract/core/overseer-live";
import { ReferencesCore } from "../../contract/core/references";
import { ResourcesCore } from "../../contract/core/resources";
import { SeatAwarenessCore } from "../../contract/core/seat-awareness";
import { SeatCacheDueCore } from "../../contract/core/seat-cache-due";
import { SeatCredentialsCore } from "../../contract/core/seat-credentials";
import { SeatHoldsCore } from "../../contract/core/seat-holds";
import { SeatsCore } from "../../contract/core/seats";
import { SettingsCore } from "../../contract/core/settings";
import { ShellEnvironmentCore } from "../../contract/core/shell-environment";
import { SignalsCore } from "../../contract/core/signals";
import { StatusCore } from "../../contract/core/status";
import { TermCore } from "../../contract/core/term-ipc";
import { TermTemplatesCore } from "../../contract/core/term-templates";
import { ThreadsCore } from "../../contract/core/threads";
import { ViewStateCore } from "../../contract/core/view-state";
import { WatchCore } from "../../contract/core/watch";
import { WorkCore } from "../../contract/core/work";

export const CoreClientsLive = Layer.mergeAll(
  ViewStateCore.layer,
  TermCore.layer,
  TermTemplatesCore.layer,
  SeatHoldsCore.layer,
  SeatAwarenessCore.layer,
  SeatCredentialsCore.layer,
  SeatCacheDueCore.layer,
  SettingsCore.layer,
  MainIndexCore.layer,
  ShellEnvironmentCore.layer,
  ObservabilityCore.layer,
  CompanionCore.layer,
  ModelCore.layer,
  WatchCore.layer,
  StatusCore.layer,
  WorkCore.layer,
  MentionCore.layer,
  SignalsCore.layer,
  BrowserStoreCore.layer,
  BrowserCore.layer,
  SeatsCore.layer,
  OverseerLiveCore.layer,
  FilesCore.layer,
  HostsCore.layer,
  ResourcesCore.layer,
  ThreadsCore.layer,
  CoreReadsCore.layer,
  LibraryCore.layer,
  ContentCore.layer,
  ReferencesCore.layer,
  GitCore.layer,
  AutomationCore.layer,
);

/** Main's clients of the core's groups. */
export type CoreGroupClients = Layer.Success<typeof CoreClientsLive>;

/** What a registrar reads of the core: its groups' clients, and the bus its pushes reach main on (main-boot.ts). */
export type CoreClients = CoreGroupClients | CorePushesMain;
