/**
 * The core's one server on its link to main: every group in `CoreRpcs`,
 * answered by its handlers. A group without its handler Layer here leaves a
 * requirement no core runtime provides, and the entry fails to compile.
 */
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/rpc";
import { CoreLink } from "../contract/core/link";
import { CoreRpcs } from "../contract/core/rpcs";
import { serverProtocol } from "@shared/rpc-port";
import { AutomationHandlers } from "./ops/ipc-automation";
import { BrowserHandlers } from "./ops/ipc-browser";
import { BrowserStoreHandlers } from "./ops/browser";
import { CompanionHandlers } from "./ops/companion";
import { ContentHandlers } from "./ops/ipc-content";
import { CoreReadsHandlers } from "./ops/core-reads";
import { FilesHandlers } from "./ops/files";
import { GitHandlers } from "./ops/git-ipc";
import { HostsHandlers } from "./ops/hosts-ipc";
import { LibraryHandlers } from "./ops/ipc-library";
import { MainIndexHandlers } from "./ops/main-index";
import { MentionHandlers } from "./ops/mention-ipc";
import { ModelHandlers } from "./ops/ipc-model";
import { ObservabilityHandlers } from "./ops/observability";
import { OverseerLiveHandlers } from "./ops/overseer-live";
import { OverseerPagesHandlers } from "./ops/overseer-pages";
import { ReferencesHandlers } from "./ops/ipc-references";
import { ResourcesHandlers } from "./ops/ipc-resources";
import { SeatAwarenessHandlers } from "./ops/seat-awareness";
import { SeatCacheDueHandlers } from "./ops/seat-cache-due";
import { SeatCredentialsHandlers } from "./ops/seat-credentials";
import { SeatHoldsHandlers } from "./ops/seat-holds";
import { SeatsHandlers } from "./ops/ipc-seats";
import { SettingsHandlers } from "./ops/ipc-settings";
import { ShellEnvironmentHandlers } from "./ops/shell-environment";
import { SignalsHandlers } from "./ops/ipc-signals";
import { StatusHandlers } from "./ops/ipc-status";
import { TermHandlers } from "./ops/term-ipc";
import { TermTemplatesHandlers } from "./ops/term-templates";
import { ThreadsHandlers } from "./ops/ipc-threads";
import { ViewStateHandlers } from "./ops/ipc-view-state";
import { WatchHandlers } from "./ops/ipc-watch";
import { WorkHandlers } from "./ops/ipc-work";

export const CoreServerLive = RpcServer.layer(CoreRpcs).pipe(
  Layer.provide([
    ViewStateHandlers,
    TermHandlers,
    TermTemplatesHandlers,
    SeatHoldsHandlers,
    SeatAwarenessHandlers,
    SeatCredentialsHandlers,
    SeatCacheDueHandlers,
    SettingsHandlers,
    MainIndexHandlers,
    ShellEnvironmentHandlers,
    ObservabilityHandlers,
    CompanionHandlers,
    ModelHandlers,
    WatchHandlers,
    StatusHandlers,
    WorkHandlers,
    MentionHandlers,
    SignalsHandlers,
    BrowserStoreHandlers,
    BrowserHandlers,
    SeatsHandlers,
    OverseerLiveHandlers,
    OverseerPagesHandlers,
    FilesHandlers,
    HostsHandlers,
    ResourcesHandlers,
    ThreadsHandlers,
    CoreReadsHandlers,
    LibraryHandlers,
    ContentHandlers,
    ReferencesHandlers,
    GitHandlers,
    AutomationHandlers,
  ]),
  Layer.provide(Layer.effect(RpcServer.Protocol, Effect.flatMap(CoreLink, serverProtocol))),
);
