"""Explicit versioning and archival legacy migration; never silently trust old done."""
import sqlite3
import uuid
from pathlib import Path
from .evidence import StateConflict

VERSION = 3
DDL = (
    "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, goal TEXT NOT NULL, baseline_json TEXT NOT NULL,
      revision INTEGER NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL,
      owner TEXT, active_attempt TEXT, acceptance_json TEXT NOT NULL,
      write_scope_json TEXT NOT NULL, resources_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL, capability_refs_json TEXT NOT NULL,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      kind TEXT NOT NULL, wheel_review_id TEXT)""",
    """CREATE TABLE attempts (
      attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      owner TEXT NOT NULL, epoch INTEGER NOT NULL, baseline_revision INTEGER NOT NULL,
      status TEXT NOT NULL, workspace TEXT NOT NULL, baseline_json TEXT NOT NULL,
      result_revision INTEGER NOT NULL DEFAULT 0, result_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
    """CREATE UNIQUE INDEX one_active_attempt ON attempts(task_id)
      WHERE status IN ('running','review','revise','rejected','appeal','accepted','integrating')""",
    """CREATE TABLE reservations (
      attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), kind TEXT NOT NULL,
      resource TEXT NOT NULL, PRIMARY KEY(attempt_id,kind,resource))""",
    """CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)""",
    """CREATE TABLE checks (
      check_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
      epoch INTEGER NOT NULL, revision INTEGER NOT NULL, result_revision INTEGER NOT NULL,
      phase TEXT NOT NULL, operation_id TEXT, subject_commit TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL)""",
    """CREATE TABLE reviews (
      review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      result_revision INTEGER NOT NULL, subject_digest TEXT NOT NULL,
      reviewer TEXT NOT NULL, alignment TEXT NOT NULL, technical TEXT NOT NULL,
      decision TEXT NOT NULL, rationale TEXT NOT NULL, created_at INTEGER NOT NULL)""",
    """CREATE TABLE appeals (
      review_id TEXT PRIMARY KEY REFERENCES reviews(review_id), reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL, decision TEXT, adjudicator TEXT, rationale TEXT)""",
    """CREATE TABLE integrations (
      operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      epoch INTEGER NOT NULL, revision INTEGER NOT NULL, result_revision INTEGER NOT NULL,
      subject_digest TEXT NOT NULL, target_root TEXT NOT NULL, target_ref TEXT NOT NULL,
      expected_head TEXT NOT NULL, candidate TEXT NOT NULL, status TEXT NOT NULL,
      observation_json TEXT, checks_json TEXT, created_at INTEGER NOT NULL)""",
    """CREATE UNIQUE INDEX one_pending_integration ON integrations((1))
      WHERE status NOT IN ('completed','cancelled','needs_revision')""",
    """CREATE TABLE capabilities (
      capability_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      name TEXT NOT NULL, aliases_json TEXT NOT NULL, entries_json TEXT NOT NULL,
      implementation_ref TEXT NOT NULL, evidence_json TEXT NOT NULL,
      valid_revision INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
      created_at INTEGER NOT NULL)""",
    """CREATE TABLE wheel_reviews (
      review_id TEXT PRIMARY KEY, record_json TEXT NOT NULL,
      record_digest TEXT NOT NULL, binding_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL)""",
)


def initialize(db):
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version == VERSION:
        return
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    if version or tables:
        raise StateConflict(f"schema {version} requires explicit migration; supported schema is {VERSION}")
    db.execute("BEGIN IMMEDIATE")
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != VERSION:
            for statement in DDL:
                db.execute(statement)
            db.execute(f"PRAGMA user_version={VERSION}")
        db.execute("COMMIT")
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def migrate_legacy(path):
    """Backup under writer exclusion, archive tables, import quarantined tasks."""
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(str(path), isolation_level=None, timeout=5)
    backup = path.with_name(path.name + ".legacy-" + uuid.uuid4().hex + ".bak")
    try:
        db.execute("BEGIN IMMEDIATE")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        expected = {"tasks", "attempts", "events", "reviews", "capabilities"}
        columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
        if version != 0 or names != expected or columns != {
            "task_id", "goal", "baseline_json", "revision", "status", "owner", "active_attempt",
            "acceptance_json", "write_scope_json", "last_error", "created_at", "updated_at"}:
            raise StateConflict("unknown legacy schema; database left untouched")
        source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        target = sqlite3.connect(str(backup))
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        for table in sorted(expected):
            db.execute(f"ALTER TABLE {table} RENAME TO legacy_{table}")
        db.execute("DROP INDEX IF EXISTS one_active_attempt")
        for statement in DDL:
            db.execute(statement)
        db.execute("""INSERT INTO tasks SELECT task_id,goal,baseline_json,revision,0,'legacy_blocked',
          NULL,NULL,acceptance_json,write_scope_json,'[]','[]','[]',
          'legacy evidence unverified; explicit adoption required',created_at,updated_at,
          'legacy_unclassified',NULL FROM legacy_tasks""")
        db.execute("INSERT INTO metadata VALUES ('legacy_backup',?)", (str(backup),))
        db.execute(f"PRAGMA user_version={VERSION}")
        db.execute("COMMIT")
        return str(backup)
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def migrate_v2(path):
    """Explicit lossless v2 upgrade; old tasks remain unclassified, never passed."""
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(str(path), isolation_level=None, timeout=5)
    backup = path.with_name(path.name + ".v2-" + uuid.uuid4().hex + ".bak")
    try:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("PRAGMA user_version").fetchone()[0] != 2:
            raise StateConflict("not schema v2; database left untouched")
        columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"task_id", "goal", "baseline_json", "revision", "status", "created_at"} <= columns or not {"metadata", "tasks", "attempts", "events", "reviews", "capabilities", "integrations"} <= tables or "wheel_reviews" in tables:
            raise StateConflict("unknown schema v2 shape; database left untouched")
        # done may legally keep an attempt pointer; obsolete is created without
        # one, so an obsolete row that still carries one is corrupt and must
        # fail closed instead of migrating as terminal.
        active = db.execute("""SELECT task_id,status FROM tasks
          WHERE status NOT IN ('done','obsolete','ready','legacy_blocked')
             OR (status IN ('ready','legacy_blocked','obsolete') AND active_attempt IS NOT NULL)
          LIMIT 1""").fetchone()
        if active:
            raise StateConflict(f"v2 migration refused while task {active[0]} is {active[1]}; finish or safely release it with the v2 runtime before migrating")
        source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        target = sqlite3.connect(str(backup))
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        db.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy_unclassified'")
        db.execute("ALTER TABLE tasks ADD COLUMN wheel_review_id TEXT")
        db.execute("""CREATE TABLE wheel_reviews (
          review_id TEXT PRIMARY KEY, record_json TEXT NOT NULL,
          record_digest TEXT NOT NULL, binding_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL)""")
        db.execute(f"PRAGMA user_version={VERSION}")
        db.execute("COMMIT")
        return str(backup)
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def migrate(path):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    try:
        version = db.execute("PRAGMA user_version").fetchone()[0]
    finally:
        db.close()
    if version == 2:
        return migrate_v2(path)
    if version == 0:
        return migrate_legacy(path)
    raise StateConflict(f"unsupported migration from schema {version}")
