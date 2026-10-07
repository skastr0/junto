import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CANVAS_AUTHORITY_SCHEMA_SQL } from "../src/main/junto/canvas/state-schema";
import { ENTITIES_STATE_SCHEMA_SQL } from "./fixtures/domain-cutover/entities-schema";
import { migrateCanvasKinds } from "../src/main/junto/model/migrate";
import { KIND_TABLES } from "../src/main/junto/model/state-schema";

const at = "2026-10-07T00:00:00.000Z";
const open = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(CANVAS_AUTHORITY_SCHEMA_SQL + ENTITIES_STATE_SCHEMA_SQL);
  database
    .prepare(`INSERT INTO canvas_documents VALUES (?, ?, ?, ?, ?)`)
    .run("canvas-1", "factory", "a".repeat(64), at, at);
  return database;
};
const add = (
  database: DatabaseSync,
  id: string,
  kind: string | null,
  extra: object = {},
  type = "text",
) => {
  database
    .prepare(
      `INSERT INTO canvas_nodes(
    canvas_id,node_id,z_index,type,x,y,width,height,color,text_content,group_label,link_url,ether_json,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "canvas-1",
      id,
      4,
      type,
      17.5,
      -20,
      220,
      90,
      "amber",
      `body-${id}`,
      type === "group" ? `region-${id}` : null,
      type === "link" ? "https://example.com" : null,
      kind === null
        ? null
        : JSON.stringify({ entity: { kind, name: `name-${id}` }, ...extra }),
      at,
    );
};

describe("kind storage copy-forward", () => {
  it("preserves identities, geometry and each closed kind's authorial data", () => {
    const database = open();
    try {
      const launch = {
        kind: "harness",
        cwd: "/project",
        argv: ["codex", "--resume", "known"],
        env: { MODE: "test" },
        extraArgs: [],
      };
      add(database, "seat", "agent", {
        host: "local",
        overseer: false,
        terminal: {
          bindingId: "binding-seat",
          harness: "codex",
          sessionId: "known",
          label: "terminal label",
          launch,
        },
      });
      add(database, "term", "terminal", {
        terminal: { bindingId: "binding-term", launch: { kind: "shell" } },
      });
      add(
        database,
        "region",
        "region",
        {
          region: {
            hold: false,
            instruction: "brief",
            defaults: {
              page: {
                url: "https://example.com",
                profile: "work",
                host: "local",
              },
              paths: { local: "/project" },
            },
            contract: { rules: [], rulings: [] },
            environment: { sealed: true, sources: [], folders: ["/project"] },
          },
        },
        "group",
      );
      add(
        database,
        "page",
        "page",
        { browser: { profile: "work", onDelete: "detach" } },
        "link",
      );
      const contract = {
        instructions: "do it",
        incoming: { admission: "approval", waitMs: 0 },
        outgoing: { handoff: "receipt" },
        rules: [],
      };
      add(database, "task", "task", {
        tasks: { name: "backlog", contract, items: [] },
      });
      add(database, "requests", "requests", {
        requests: { name: "inbox", items: [] },
      });
      const grid = {
        columns: [{ id: "c1", name: "Name" }],
        rows: [{ id: "r1", cells: { c1: "the exact cell\nwith newline" } }],
      };
      add(database, "sheet", "sheet", { sheet: grid });
      add(database, "cron", "timer", {
        timer: { expression: "* * * * *", everyMinutes: 0.5 },
      });
      add(database, "watcher", "watcher", {
        watch: {
          kind: "stat_threshold",
          source: "hermes",
          key: "k",
          stat: "s",
          op: "gt",
          value: 0,
        },
      });
      add(database, "git", "git", { git: { cwd: "/project" } });
      for (const kind of ["artifacts", "board", "pad", "relay", "label"])
        add(database, kind, kind);
      add(database, "note", null);
      add(database, "unknown", "open-kind-retired");
      database
        .prepare(`INSERT INTO canvas_entities VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          "factory",
          "archived",
          "agent",
          "retired",
          "archived",
          at,
          at,
          at,
          null,
        );
      database
        .prepare(
          `INSERT INTO canvas_edges(canvas_id,edge_id,z_index,from_node_id,to_node_id,from_side,to_side,ether_json,updated_at)
        VALUES ('canvas-1','wire',0,'seat','task','right','left',?,?)`,
        )
        .run(JSON.stringify({ verb: "contributes", mask: ["tasks.list"] }), at);

      migrateCanvasKinds(database);
      expect(
        database.prepare("SELECT count(*) AS n FROM canvases").get()!.n,
      ).toBe(1);
      let total = 0;
      for (const table of Object.values(KIND_TABLES)) {
        const rows = database
          .prepare(`SELECT id,x,y,width,height,z_index,color FROM ${table}`)
          .all();
        total += rows.length;
        for (const row of rows)
          expect(row).toMatchObject({
            x: 17.5,
            y: -20,
            width: 220,
            height: 90,
            z_index: 4,
            color: "amber",
          });
      }
      expect(total).toBe(17);
      const seat = database.prepare("SELECT * FROM seats").get()!;
      expect(seat).toMatchObject({
        id: "seat",
        agent_key: "name-seat",
        label: "body-seat",
        harness: "codex",
        binding_id: "binding-seat",
        session_id: "known",
        overseer: 0,
        launch_kind: "harness",
        launch_cwd: "/project",
      });
      expect(JSON.parse(String(seat.launch_argv_json))).toEqual(launch.argv);
      expect(JSON.parse(String(seat.launch_env_json))).toEqual(launch.env);
      expect(JSON.parse(String(seat.launch_extra_args_json))).toEqual([]);
      expect(database.prepare("SELECT name FROM task_boards").get()!.name).toBe(
        "backlog",
      );
      expect(
        JSON.parse(
          String(
            database.prepare("SELECT contract_json FROM task_boards").get()!
              .contract_json,
          ),
        ),
      ).toEqual(contract);
      expect(
        database.prepare("SELECT name FROM request_boards").get()!.name,
      ).toBe("inbox");
      const sheet = database
        .prepare("SELECT columns_json,rows_json FROM sheet_grids")
        .get()!;
      expect({
        columns: JSON.parse(String(sheet.columns_json)),
        rows: JSON.parse(String(sheet.rows_json)),
      }).toEqual(grid);
      expect(database.prepare("SELECT expression FROM crons").get()).toEqual({
        expression: "* * * * *",
      });
      expect(
        database
          .prepare("SELECT hold,instruction,page_profile FROM regions")
          .get(),
      ).toEqual({ hold: 0, instruction: "brief", page_profile: "work" });
      expect(
        database.prepare("SELECT id,text FROM notes ORDER BY id").all(),
      ).toEqual([
        { id: "note", text: "body-note" },
        { id: "unknown", text: "body-unknown" },
      ]);
      expect(
        database
          .prepare("SELECT from_id,to_id,verb,mask_json FROM wires")
          .get(),
      ).toEqual({
        from_id: "seat",
        to_id: "task",
        verb: "contributes",
        mask_json: '["tasks.list"]',
      });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('canvas_nodes','canvas_edges','canvas_documents','canvas_entities')",
          )
          .all(),
      ).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("migrates an empty region configuration without inventing presence fields", () => {
    const database = open();
    try {
      add(database, "empty-region", "region", { region: { defaults: { page: {} }, contract: {} } }, "group");
      migrateCanvasKinds(database);
      expect(database.prepare("SELECT hold,page_url,paths_json,rules_json,rulings_json FROM regions").get()).toEqual({ hold: 0, page_url: null, paths_json: null, rules_json: null, rulings_json: null });
    } finally { database.close(); }
  });

  it("refuses a binding shared by a seat and a terminal before retiring source rows", () => {
    const database = open();
    try {
      add(database, "seat", "agent", { terminal: { bindingId: "shared", harness: "codex" } });
      add(database, "terminal", "terminal", { terminal: { bindingId: "shared" } });
      database.exec("BEGIN IMMEDIATE");
      expect(() => migrateCanvasKinds(database)).toThrow("share one session binding");
      database.exec("ROLLBACK");
      expect(database.prepare("SELECT count(*) AS n FROM canvas_nodes").get()!.n).toBe(2);
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name='seats'").get()).toBeUndefined();
    } finally { database.close(); }
  });

  it("rolls back the entire copy if two stored seats claim the same executable identity", () => {
    const database = open();
    try {
      add(database, "bad", "agent", {
        terminal: { bindingId: "duplicate", harness: "codex" },
      });
      add(database, "duplicate", "agent", {
        terminal: { bindingId: "duplicate", harness: "codex" },
      });
      database.exec("BEGIN IMMEDIATE");
      expect(() => migrateCanvasKinds(database)).toThrow();
      database.exec("ROLLBACK");
      expect(
        database.prepare("SELECT node_id FROM canvas_nodes").get()!.node_id,
      ).toBe("bad");
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'seats'")
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
