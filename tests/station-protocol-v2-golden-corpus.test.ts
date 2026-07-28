import { readFileSync } from "node:fs";
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ReportRequest,
  ReportResponse,
  StatusResponse,
} from "../src/shared/station-api";
import {
  StationControlEnvelope,
  decodeStationControlEnvelope,
  decodeStationControlRequest,
} from "../src/shared/station-api-envelope";
import {
  StationProtocolPreface,
  decideStationProtocolPreface,
  decodeStationProtocolPreface,
} from "../src/shared/station-protocol";
import {
  StationSessionFrame,
  decideStationSessionCorrelation,
  decodeStationSessionFrame,
} from "../src/shared/station-session";
import {
  WorkRecord,
  decodeWorkRecord,
} from "../src/shared/work-protocol";
import {
  encodeOpenSshStationFrame,
} from "../src/main/vellum/station/openssh-peer-exchange";
import {
  bindNegotiatedStationProtocol,
} from "../src/main/vellum/station/peer-session";
import {
  compileStationPortfolioBody,
  decodeStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import {
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  workRecordContentSha256,
} from "../src/main/vellum/work/repository";

interface ValidCorpus {
  readonly preface: {
    readonly offer: unknown;
    readonly accept: unknown;
  };
  readonly projectionBody: string;
  readonly session: {
    readonly requests: ReadonlyArray<unknown>;
    readonly responses: ReadonlyArray<unknown>;
  };
}

type RejectedSurface = "preface" | "session" | "request" | "envelope" | "work";

interface RejectedCase {
  readonly name: string;
  readonly surface: RejectedSurface;
  readonly wire: unknown;
}

const fixture = <A>(name: string): A =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/station-protocol-v2/${name}`, import.meta.url),
      "utf8",
    ),
  ) as A;

const valid = fixture<ValidCorpus>("valid-corpus.json");
const rejected = fixture<ReadonlyArray<RejectedCase>>("rejected-corpus.json");

const right = <A, E>(result: Either.Either<A, E>): A => {
  expect(Either.isRight(result)).toBe(true);
  if (Either.isLeft(result)) {
    throw new Error("golden Station v2 wire failed strict decode");
  }
  return result.right;
};

const semanticHash = (
  record: typeof WorkRecord.Type,
): typeof record.contentSha256 => {
  const {
    contentSha256: _contentSha256,
    originAt: _originAt,
    ...semantic
  } = record;
  return workRecordContentSha256(
    semantic as Parameters<typeof workRecordContentSha256>[0],
  );
};

describe("frozen Station protocol v2 golden wire corpus", () => {
  it("binds the compatibility preface to the one exact v2 codec", () => {
    const offer = right(decodeStationProtocolPreface(valid.preface.offer));
    const accept = right(decodeStationProtocolPreface(valid.preface.accept));

    expect(offer.frame).toBe("offer");
    expect(accept.frame).toBe("accept");
    if (offer.frame !== "offer" || accept.frame !== "accept") {
      throw new Error("golden compatibility exchange has the wrong frame pair");
    }

    expect(decideStationProtocolPreface(offer, accept)).toEqual({
      _tag: "accepted",
      selected: 2,
      warning: false,
      deprecatedForOfferer: false,
      deprecatedForAcceptor: false,
    });
    expect(
      bindNegotiatedStationProtocol({
        negotiatedProtocol: accept.selected,
        local: {
          appVersion: offer.appVersion,
          stateSchemaVersion: offer.stateSchemaVersion,
          support: offer.support,
        },
        peer: {
          appVersion: accept.appVersion,
          stateSchemaVersion: accept.stateSchemaVersion,
          support: accept.support,
        },
      }),
    ).toMatchObject({
      _tag: "negotiated",
      negotiatedProtocol: 2,
      compatibility: "compatible",
    });

    expect(Schema.encodeSync(StationProtocolPreface)(offer)).toEqual(
      valid.preface.offer,
    );
    expect(Schema.encodeSync(StationProtocolPreface)(accept)).toEqual(
      valid.preface.accept,
    );
  });

  it("round-trips correlated strict frames for exactly the five verbs", async () => {
    const requests = valid.session.requests.map((wire) => {
      const frame = right(decodeStationSessionFrame(wire));
      expect(frame.frame).toBe("request");
      if (frame.frame !== "request") {
        throw new Error("golden request corpus contains a response frame");
      }
      expect(Either.isRight(decodeStationControlRequest(frame.request))).toBe(true);
      expect(Schema.encodeSync(StationSessionFrame)(frame)).toEqual(wire);
      return frame;
    });
    const responses = valid.session.responses.map((wire) => {
      const frame = right(decodeStationSessionFrame(wire));
      expect(frame.frame).toBe("response");
      if (frame.frame !== "response") {
        throw new Error("golden response corpus contains a request frame");
      }
      expect(
        Either.isRight(decodeStationControlEnvelope(frame.envelope)),
      ).toBe(true);
      expect(Schema.encodeSync(StationSessionFrame)(frame)).toEqual(wire);
      return frame;
    });

    expect(requests.map(({ request }) => request.op)).toEqual([
      "pair",
      "configure",
      "project",
      "report",
      "status",
    ]);
    expect(
      responses.map(({ envelope }) =>
        envelope.ok ? envelope.response.op : "error"
      ),
    ).toEqual(["pair", "configure", "project", "report", "status"]);

    for (const [index, request] of requests.entries()) {
      const response = responses[index];
      expect(response).toBeDefined();
      if (response === undefined) throw new Error("missing golden response frame");
      expect(decideStationSessionCorrelation(request, response)).toEqual({
        _tag: "correlated",
      });
    }

    for (const [index, frame] of [...requests, ...responses].entries()) {
      const wire = [
        ...valid.session.requests,
        ...valid.session.responses,
      ][index];
      const bytes = await Effect.runPromise(encodeOpenSshStationFrame(frame));
      expect(new TextDecoder().decode(bytes)).toBe(`${JSON.stringify(wire)}\n`);
    }
  });

  it("freezes the canonical projection and status shapes", () => {
    expect(compileStationPortfolioBody(new Map(), new Map())).toBe(
      valid.projectionBody,
    );
    const portfolio = decodeStationPortfolioBody(valid.projectionBody);
    expect(portfolio.documents.size).toBe(0);
    expect(portfolio.actorSeats).toEqual([]);

    const projectFrame = right(
      decodeStationSessionFrame(valid.session.requests[2]),
    );
    expect(projectFrame.frame).toBe("request");
    if (
      projectFrame.frame !== "request" ||
      projectFrame.request.op !== "project"
    ) {
      throw new Error("golden project frame is missing");
    }
    expect(projectFrame.request.projection.body).toBe(valid.projectionBody);
    expect(projectFrame.request.projection.contentSha256).toBe(
      stationProjectionContentSha256(valid.projectionBody),
    );

    const statusFrame = right(
      decodeStationSessionFrame(valid.session.responses[4]),
    );
    expect(statusFrame.frame).toBe("response");
    if (
      statusFrame.frame !== "response" ||
      !statusFrame.envelope.ok ||
      statusFrame.envelope.response.op !== "status"
    ) {
      throw new Error("golden status frame is missing");
    }
    const status = Schema.decodeUnknownSync(StatusResponse, {
      onExcessProperty: "error",
    })(statusFrame.envelope.response);
    expect(status).toMatchObject({
      installationId: "remote-installation-v2",
      state: "ready",
      configuration: {
        role: "remote",
        commandCenterInstallationId: "cc-installation-v2",
      },
      projection: {
        generation: "12",
        contentSha256:
          "12b1109c9d7d83401a2470ee5cd0c8ef90fb6e8dc5ebb8df23c7b900f43cad25",
      },
    });
    expect(Schema.encodeSync(StatusResponse)(status)).toEqual(
      statusFrame.envelope.response,
    );
  });

  it("freezes complete Work, disposition, and ACK route identities", () => {
    const requestFrame = right(
      decodeStationSessionFrame(valid.session.requests[3]),
    );
    const responseFrame = right(
      decodeStationSessionFrame(valid.session.responses[3]),
    );
    if (
      requestFrame.frame !== "request" ||
      requestFrame.request.op !== "report" ||
      responseFrame.frame !== "response" ||
      !responseFrame.envelope.ok ||
      responseFrame.envelope.response.op !== "report"
    ) {
      throw new Error("golden report exchange is missing");
    }
    const request = Schema.decodeUnknownSync(ReportRequest, {
      onExcessProperty: "error",
    })(requestFrame.request);
    const response = Schema.decodeUnknownSync(ReportResponse, {
      onExcessProperty: "error",
    })(responseFrame.envelope.response);
    const records = [...request.batch.records, ...response.batch.records];

    for (const record of records) {
      expect(Either.isRight(decodeWorkRecord(record))).toBe(true);
      expect(record.contentSha256).toBe(semanticHash(record));
      expect(Schema.encodeSync(WorkRecord)(record)).toEqual(record);
    }

    const command = request.batch.records[0];
    const fact = response.batch.records[0];
    const disposition = response.batch.records[1];
    expect(command?.id).toEqual({
      route: {
        eventHome: "cc-installation-v2",
        entityHome: "remote-installation-v2",
      },
      seq: "1",
    });
    expect(fact?.id).toEqual({
      route: {
        eventHome: "remote-installation-v2",
        entityHome: "remote-installation-v2",
      },
      seq: "1",
    });
    expect(disposition?.id).toEqual({
      route: {
        eventHome: "remote-installation-v2",
        entityHome: "remote-installation-v2",
      },
      seq: "2",
    });
    expect(request.batch.acknowledge).toEqual([
      {
        eventHome: "remote-installation-v2",
        entityHome: "remote-installation-v2",
        through: "2",
      },
    ]);
    expect(response.batch.acknowledge).toEqual([
      {
        eventHome: "cc-installation-v2",
        entityHome: "remote-installation-v2",
        through: "1",
      },
    ]);
    expect(disposition?.recordType).toBe("disposition");
    if (disposition?.recordType !== "disposition") {
      throw new Error("golden applied disposition is missing");
    }
    expect(disposition.body).toMatchObject({
      status: "applied",
      command: command?.id,
      commandSha256: command?.contentSha256,
      fact: fact?.id,
      factSha256: fact?.contentSha256,
    });
  });

  it.each(rejected)("$name fails closed on the $surface surface", ({ surface, wire }) => {
    const rejectedByDecoder = (() => {
      switch (surface) {
        case "preface":
          return Either.isLeft(decodeStationProtocolPreface(wire));
        case "session":
          return Either.isLeft(decodeStationSessionFrame(wire));
        case "request":
          return Either.isLeft(decodeStationControlRequest(wire));
        case "envelope":
          return Either.isLeft(decodeStationControlEnvelope(wire));
        case "work":
          return Either.isLeft(decodeWorkRecord(wire));
      }
    })();
    expect(rejectedByDecoder).toBe(true);
  });

  it("keeps the frozen corpus on one Station protocol axis", () => {
    const wire = JSON.stringify(valid);
    expect(wire).not.toContain("/v3");
    expect(wire).not.toContain("projectionVersion");
    expect(wire).not.toContain("workVersion");
    expect(wire).not.toContain("capabilitiesVersion");

    const statusFrame = right(
      decodeStationSessionFrame(valid.session.responses[4]),
    );
    expect(statusFrame.frame).toBe("response");
    if (statusFrame.frame !== "response") {
      throw new Error("golden status response frame is missing");
    }
    const envelope = right(decodeStationControlEnvelope(statusFrame.envelope));
    expect(Schema.encodeSync(StationControlEnvelope)(envelope)).toEqual(
      statusFrame.envelope,
    );
  });
});
