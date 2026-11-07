/**
 * Every group the core serves on its link to main. The core answers them with
 * one server, so a group here without a handler fails the core's compile, and
 * a client of a group missing here fails main's (`coreClient`).
 */
import { RpcGroup } from "effect/rpc";
import { AutomationRpcs } from "./automation";
import { BrowserRpcs } from "./browser";
import { BrowserStoreRpcs } from "./browser-store";
import { CompanionRpcs } from "./companion";
import { ContentRpcs } from "./content";
import { CoreReadsRpcs } from "./core-reads";
import { FilesRpcs } from "./files";
import { GitRpcs } from "./git";
import { HostsRpcs } from "./hosts-ipc";
import { LibraryRpcs } from "./library";
import { MainIndexRpcs } from "./main-index";
import { MentionRpcs } from "./mention-ipc";
import { ModelRpcs } from "./model";
import { ObservabilityRpcs } from "./observability";
import { OverseerLiveRpcs } from "./overseer-live";
import { OverseerPagesRpcs } from "./overseer-pages";
import { ReferencesRpcs } from "./references";
import { ResourcesRpcs } from "./resources";
import { SeatAwarenessRpcs } from "./seat-awareness";
import { SeatCacheDueRpcs } from "./seat-cache-due";
import { SeatCredentialsRpcs } from "./seat-credentials";
import { SeatHoldsRpcs } from "./seat-holds";
import { SeatsRpcs } from "./seats";
import { SettingsRpcs } from "./settings";
import { ShellEnvironmentRpcs } from "./shell-environment";
import { SignalsRpcs } from "./signals";
import { StatusRpcs } from "./status";
import { TermRpcs } from "./term-ipc";
import { TermTemplatesRpcs } from "./term-templates";
import { ThreadsRpcs } from "./threads";
import { ViewStateRpcs } from "./view-state";
import { WatchRpcs } from "./watch";
import { WorkRpcs } from "./work";

export const CoreRpcs = RpcGroup.make().merge(
  ViewStateRpcs,
  TermRpcs,
  TermTemplatesRpcs,
  SeatHoldsRpcs,
  SeatAwarenessRpcs,
  SeatCredentialsRpcs,
  SeatCacheDueRpcs,
  SettingsRpcs,
  MainIndexRpcs,
  ShellEnvironmentRpcs,
  ObservabilityRpcs,
  CompanionRpcs,
  ModelRpcs,
  WatchRpcs,
  StatusRpcs,
  WorkRpcs,
  MentionRpcs,
  SignalsRpcs,
  BrowserStoreRpcs,
  BrowserRpcs,
  SeatsRpcs,
  OverseerLiveRpcs,
  OverseerPagesRpcs,
  FilesRpcs,
  HostsRpcs,
  ResourcesRpcs,
  ThreadsRpcs,
  CoreReadsRpcs,
  LibraryRpcs,
  ContentRpcs,
  ReferencesRpcs,
  GitRpcs,
  AutomationRpcs,
);
