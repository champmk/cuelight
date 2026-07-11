//! The run journal: SQLite, one file per project, append-only events.
//! The journal is the truth — the canvas renders from it on reconnect, rewind
//! replays from it, and "cost per node over the last 30 runs" is one query.

use rusqlite::{params, Connection};
use std::path::Path;

pub struct Journal {
    conn: Connection,
}

impl Journal {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS runs (
                id          TEXT PRIMARY KEY,
                stage_name  TEXT NOT NULL,
                stage_json  TEXT NOT NULL,   -- frozen copy of the spec this run used
                started_at  TEXT NOT NULL,
                finished_at TEXT,
                status      TEXT NOT NULL DEFAULT 'running'
            );

            CREATE TABLE IF NOT EXISTS events (
                run_id     TEXT NOT NULL REFERENCES runs(id),
                node_id    TEXT NOT NULL,
                session_id TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                at         TEXT NOT NULL,
                kind       TEXT NOT NULL,
                payload    TEXT NOT NULL,    -- full RunEvent as JSON
                PRIMARY KEY (run_id, session_id, seq)
            );

            CREATE INDEX IF NOT EXISTS idx_events_run_node ON events(run_id, node_id);

            CREATE TABLE IF NOT EXISTS checkpoints (
                run_id     TEXT NOT NULL REFERENCES runs(id),
                node_id    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                git_ref    TEXT NOT NULL,    -- worktree commit captured at the boundary
                PRIMARY KEY (run_id, node_id, git_ref)
            );

            CREATE TABLE IF NOT EXISTS gate_decisions (
                run_id     TEXT NOT NULL REFERENCES runs(id),
                node_id    TEXT NOT NULL,
                decided_at TEXT NOT NULL,
                decision   TEXT NOT NULL,    -- approved | changes_requested | skipped
                memo       TEXT
            );
            "#,
        )?;
        Ok(Self { conn })
    }

    pub fn start_run(&self, run_id: &str, stage_name: &str, stage_json: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO runs (id, stage_name, stage_json, started_at) VALUES (?1, ?2, ?3, ?4)",
            params![run_id, stage_name, stage_json, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Journal one engine event (type-tagged JSON, same shape the canvas
    /// receives). The journal carries the FULL stream — node states, session
    /// output, gate-pending payloads, escalations, run-finished — so a run can
    /// be replayed pixel-faithful after a restart.
    pub fn append_engine(&self, run_id: &str, node_id: &str, seq: u64, kind: &str, payload: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO events (run_id, node_id, session_id, seq, at, kind, payload)
             VALUES (?1, ?2, '', ?3, ?4, ?5, ?6)",
            params![run_id, node_id, seq, chrono::Utc::now().to_rfc3339(), kind, payload],
        )?;
        Ok(())
    }

    pub fn finish_run(&self, run_id: &str, status: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE runs SET finished_at = ?2, status = ?3 WHERE id = ?1",
            params![run_id, chrono::Utc::now().to_rfc3339(), status],
        )?;
        Ok(())
    }

    pub fn checkpoint(&self, run_id: &str, node_id: &str, git_ref: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO checkpoints (run_id, node_id, created_at, git_ref) VALUES (?1, ?2, ?3, ?4)",
            params![run_id, node_id, chrono::Utc::now().to_rfc3339(), git_ref],
        )?;
        Ok(())
    }

    pub fn record_gate(&self, run_id: &str, node_id: &str, decision: &str, memo: Option<&str>) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO gate_decisions (run_id, node_id, decided_at, decision, memo) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![run_id, node_id, chrono::Utc::now().to_rfc3339(), decision, memo],
        )?;
        Ok(())
    }

    /// Replay a run's events in order — the canvas calls this on reconnect,
    /// rewind uses it to rebuild state up to a checkpoint.
    pub fn events_for_run(&self, run_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT payload FROM events WHERE run_id = ?1 ORDER BY at, seq")?;
        let rows = stmt.query_map(params![run_id], |r| r.get::<_, String>(0))?;
        rows.collect()
    }
}
