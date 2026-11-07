/**
 * The core's terminals, as one service a program is handed at boot. Its Layer
 * is fed by `TerminalPorts`: every port to a terminal process this core is
 * given, in the order it is given them. The desktop core's ports come from
 * main, a new one each time that process starts again; a windowless core, and
 * a test, hand it one port to a terminal server of their own. Either way the
 * core's PTYs run behind a port, never on this program's own thread.
 *
 * The Layer is built once the first port is here, so a seat the boot resumes
 * has its terminals. A later port replaces the last, and a port that closes
 * fails its terminals: each reports an error and an exit, as a PTY whose
 * process died does.
 */
import { Context, Deferred, Effect, Layer, Stream } from "effect";
import { terminalsOverPorts, type TerminalPortMain } from "./over-ports";
import type { TerminalClient } from "../../node/terminals/client";

/** Every port to a terminal process this core is given; each one replaces the last. */
export class TerminalPorts extends Context.Service<TerminalPorts, Stream.Stream<TerminalPortMain>>()("@junto/core/TerminalPorts") {
  /** One port for the life of the program: the windowless core's and a test's. */
  static readonly one = (port: TerminalPortMain): Layer.Layer<TerminalPorts> => Layer.succeed(TerminalPorts, Stream.make(port));
}

/** The core's terminals: spawn, adopt, and the orderly hangup, over the current port. */
export class Terminals extends Context.Service<Terminals, TerminalClient>()("@junto/core/Terminals") {
  /**
   * The terminals over every port `TerminalPorts` gives. Built once the first
   * port is connected, or once the ports end with none; until a port is here
   * a spawn throws and an adoption fails.
   */
  static readonly overPort: Layer.Layer<Terminals, never, TerminalPorts> = Layer.effect(
    Terminals,
    Effect.gen(function* () {
      const ports = yield* TerminalPorts;
      const terminals = terminalsOverPorts();
      const ready = yield* Deferred.make<void>();
      yield* Stream.runForEach(ports, (port) =>
        Effect.sync(() => terminals.connect(port)).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
      ).pipe(Effect.ensuring(Deferred.succeed(ready, undefined)), Effect.forkScoped);
      yield* Deferred.await(ready);
      const { connect: _connect, ...client } = terminals;
      return client;
    }),
  );

  /** The terminals over one port, for the program's life. */
  static readonly here = (port: TerminalPortMain): Layer.Layer<Terminals> =>
    Terminals.overPort.pipe(Layer.provide(TerminalPorts.one(port)));
}

export type { TerminalPortMain };
