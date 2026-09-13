import { ipcMain } from "electron";
import { Schema } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { LiveAttention, LiveStartInput, type OverseerLiveApi, type LiveSnapshot } from "@shared/overseer-live";
import { trustedRendererIpc, getTrustedMainWebContents } from "../../trusted-main-webcontents";

type LiveIpcService = Omit<OverseerLiveApi, "onLiveChanged"> & {
  readonly subscribe: (listener: (snapshot: LiveSnapshot) => void) => () => void;
};
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const decodeId = Schema.decodeUnknownSync(Id);
const decodeEpoch = Schema.decodeUnknownSync(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)));
const decodeAttention = Schema.decodeUnknownSync(LiveAttention, { onExcessProperty: "error" });
const decodeStart = Schema.decodeUnknownSync(LiveStartInput, { onExcessProperty: "error" });
const decodeText = Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)));

/** Trusted operator controls attach media and steer requests. There is no tool-dispatch IPC. */
export const registerOverseerLiveIpc = (service: LiveIpcService): (() => void) => {
  const target = trustedRendererIpc(ipcMain);
  const channels: string[] = [];
  const handle = (channel: string, run: (...args: unknown[]) => unknown): void => {
    channels.push(channel);
    target.handle(channel, (_event, ...args: unknown[]) => run(...args));
  };
  handle(IPC_CHANNELS.liveStart, (input) => service.liveStart(decodeStart(input)));
  handle(IPC_CHANNELS.liveEnd, (id) => service.liveEnd(decodeId(id)));
  handle(IPC_CHANNELS.liveSnapshot, () => service.liveSnapshot());
  handle(IPC_CHANNELS.liveReady, (id, epoch) => service.liveReady(decodeId(id), decodeEpoch(epoch)));
  handle(IPC_CHANNELS.liveProviderEvent, (id, epoch, event) => {
    if (Buffer.byteLength(JSON.stringify(event) ?? "", "utf8") > 65_536) throw new Error("Live event is too large");
    return service.liveProviderEvent(decodeId(id), decodeEpoch(epoch), event);
  });
  handle(IPC_CHANNELS.liveAttention, (id, attention) => service.liveAttention(decodeId(id), decodeAttention(attention)));
  handle(IPC_CHANNELS.liveCancel, (id, request) => service.liveCancel(decodeId(id), decodeId(request)));
  handle(IPC_CHANNELS.liveSteer, (id, request, text, attention) =>
    service.liveSteer(decodeId(id), decodeId(request), decodeText(text), decodeAttention(attention)));
  handle(IPC_CHANNELS.liveStopActions, (id) => service.liveStopActions(decodeId(id)));
  const unsubscribe = service.subscribe((snapshot) => {
    const contents = getTrustedMainWebContents();
    if (contents !== undefined) contents.send(IPC_CHANNELS.liveChanged, snapshot);
  });
  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};
