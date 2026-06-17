import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, resetDb } from "../src/db.ts";
import { SCHEMA_VERSION } from "../src/constants.ts";

// Regression: a pre-existing index.db with the OLD schema (first_prompt, no
// title, no last_ts) must migrate without crashing and preserve the worklog.

describe("schema migration", () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    delete process.env.LB_HOME;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("old-schema DB migrates, preserves worklog, gains title column", () => {
    dir = mkdtempSync(join(tmpdir(), "lb-mig-"));
    const dbPath = join(dir, "index.db");
    // Write a v1-shaped DB by hand.
    const old = new Database(dbPath, { create: true });
    old.exec(`
      CREATE TABLE sessions (native_id TEXT PRIMARY KEY, agent TEXT, first_prompt TEXT, path TEXT, last_mtime REAL);
      CREATE TABLE worklog (id TEXT PRIMARY KEY, session_native_id TEXT, project TEXT, text TEXT, tags TEXT,
        from_offset INTEGER, to_offset INTEGER, msg_count INTEGER, created_at INTEGER, content_hash TEXT,
        UNIQUE(session_native_id, content_hash));
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version','1');
      INSERT INTO worklog VALUES ('lg_keep','sess_x','/p','prior log',NULL,0,500,7,1780000000000,'h1');
    `);
    old.close();

    process.env.LB_HOME = dir;
    const db = openDb(); // triggers migration

    const ver = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(ver.value).toBe(String(SCHEMA_VERSION)); // migrates to current, whatever it is

    const wl = db.query("SELECT text FROM worklog WHERE id='lg_keep'").get() as { text: string } | null;
    expect(wl?.text).toBe("prior log"); // user data preserved

    const hasTitle = db.query("SELECT COUNT(*) AS n FROM pragma_table_info('sessions') WHERE name='title'").get() as {
      n: number;
    };
    expect(hasTitle.n).toBe(1);
  });

  test("resetDb (index --rebuild) drops derived tables but PRESERVES worklog", () => {
    dir = mkdtempSync(join(tmpdir(), "lb-reset-"));
    process.env.LB_HOME = dir;
    const db = openDb();
    db.query(
      "INSERT INTO worklog (id, session_native_id, project, text, from_offset, to_offset, msg_count, created_at, content_hash)" +
        " VALUES ('lg_keep','s1','/p','important note',0,100,3,1780000000000,'h1')",
    ).run();
    db.query("INSERT INTO sessions (native_id, agent, path) VALUES ('s1','claude','/x/s1.jsonl')").run();

    resetDb(); // what `index --rebuild` calls

    const wl = db.query("SELECT text FROM worklog WHERE id='lg_keep'").get() as { text: string } | null;
    expect(wl?.text).toBe("important note"); // user data survives a rebuild
    const sessions = db.query("SELECT COUNT(*) n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(0); // derived data was cleared
  });
});
