"""
Local, self-contained replacement for Supabase used when Supabase is not
configured.

It provides a small object that mimics the subset of the ``supabase-py`` client
interface this project uses:

* ``client.table(name).select(...).eq(...).in_(...).order(...).range(...).execute()``
* ``client.table(name).insert(data).execute()``
* ``client.table(name).update(data).eq(...).execute()``
* ``client.storage.from_(bucket).upload(...) / get_public_url(...) / download(...)``

Data is stored in an embedded PostgreSQL instance (via the ``pgserver`` package,
which bundles the Postgres binaries, so no Docker or system Postgres is needed).
Every table is modelled generically as ``(pk, id, doc jsonb)`` so the exact
column set never has to be enumerated and stays compatible with the app's
free-form inserts/updates. Uploaded files are written to local disk and served
back over HTTP by the API (see the ``/local-storage`` route).
"""

from __future__ import annotations

import logging
import os
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Tables the application uses. Each is created as (pk, id, doc jsonb).
_TABLES = (
    "generations",
    "orders",
    "user_profiles",
    "anonymous_users",
    "waitlist_emails",
)

# Populated by init_local_supabase().
STORAGE_ROOT: Optional[Path] = None
_server = None  # keep a reference so the embedded server isn't garbage collected


class _Result:
    """Mimics the object returned by supabase's ``.execute()``."""

    def __init__(self, data: List[Dict[str, Any]], count: Optional[int] = None):
        self.data = data
        self.count = count


class _UploadResult:
    """Mimics the object returned by supabase storage ``.upload()``."""

    def __init__(self, path: str):
        self.path = path
        self.error = None
        self.full_path = path


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


class _QueryBuilder:
    """A minimal, chainable query builder backed by a JSONB column."""

    def __init__(self, conn, lock: threading.Lock, table: str):
        if table not in (*_TABLES, "latest_generations"):
            # Unknown tables are still allowed; create lazily would be ideal, but
            # the app only uses the known set. Fail loud to catch typos.
            logger.warning("Local DB: query on unregistered table '%s'", table)
        self._conn = conn
        self._lock = lock
        self._table = table
        self._op: Optional[str] = None
        self._select_cols: str = "*"
        self._count_mode: Optional[str] = None
        self._payload: Optional[Dict[str, Any]] = None
        self._filters: List[Tuple[str, str, Any]] = []
        self._order: List[Tuple[str, bool]] = []
        self._range: Optional[Tuple[int, int]] = None
        self._limit: Optional[int] = None

    # -- operation selectors -------------------------------------------------
    def select(self, columns: str = "*", count: Optional[str] = None) -> "_QueryBuilder":
        self._op = "select"
        self._select_cols = columns
        self._count_mode = count
        return self

    def insert(self, data: Dict[str, Any]) -> "_QueryBuilder":
        self._op = "insert"
        self._payload = dict(data)
        return self

    def update(self, data: Dict[str, Any]) -> "_QueryBuilder":
        self._op = "update"
        self._payload = dict(data)
        return self

    def delete(self) -> "_QueryBuilder":
        self._op = "delete"
        return self

    # -- filters -------------------------------------------------------------
    def eq(self, column: str, value: Any) -> "_QueryBuilder":
        self._filters.append(("eq", column, value))
        return self

    def neq(self, column: str, value: Any) -> "_QueryBuilder":
        self._filters.append(("neq", column, value))
        return self

    def is_(self, column: str, value: Any) -> "_QueryBuilder":
        if value not in (None, "null"):
            raise ValueError("Local is_ filters currently support null only")
        self._filters.append(("is", column, None))
        return self

    def in_(self, column: str, values: List[Any]) -> "_QueryBuilder":
        self._filters.append(("in", column, list(values)))
        return self

    def lt(self, column: str, value: Any) -> "_QueryBuilder":
        self._filters.append(("lt", column, value))
        return self

    def gt(self, column: str, value: Any) -> "_QueryBuilder":
        self._filters.append(("gt", column, value))
        return self

    def order(self, column: str, desc: bool = False) -> "_QueryBuilder":
        self._order.append((column, desc))
        return self

    def range(self, start: int, end: int) -> "_QueryBuilder":
        self._range = (start, end)
        return self

    def limit(self, count: int) -> "_QueryBuilder":
        self._limit = count
        return self

    # -- helpers -------------------------------------------------------------
    def _build_where(self, alias: str = "doc") -> Tuple[str, list]:
        from psycopg.types.json import Json

        clauses: List[str] = []
        params: list = []
        for kind, col, val in self._filters:
            if kind == "eq":
                clauses.append(f"{alias} @> %s::jsonb")
                params.append(Json({col: val}))
            elif kind == "neq":
                clauses.append(f"NOT ({alias} @> %s::jsonb)")
                params.append(Json({col: val}))
            elif kind == "is":
                clauses.append(f"({alias}->>%s) IS NULL")
                params.append(col)
            elif kind == "in":
                clauses.append(f"{alias}->>%s = ANY(%s)")
                params.append(col)
                params.append([str(v) for v in val])
            elif kind in ("gt", "lt"):
                operator = ">" if kind == "gt" else "<"
                clauses.append(f"({alias}->%s) {operator} %s::jsonb")
                params.extend([col, Json(val)])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        return where, params

    def _execute_cursor(self, sql: str, params: list):
        with self._lock:
            cur = self._conn.execute(sql, params)
            try:
                return cur.fetchall()
            except Exception:
                return []

    # -- execution -----------------------------------------------------------
    def execute(self) -> _Result:
        from psycopg.types.json import Json

        table = f'"{self._table}"'

        if self._op == "insert":
            data = dict(self._payload or {})
            data.setdefault("id", str(uuid.uuid4()))
            data.setdefault("created_at", _now_iso())
            data.setdefault("updated_at", data["created_at"])
            rows = self._execute_cursor(
                f"INSERT INTO {table} (id, doc) VALUES (%s, %s) RETURNING doc",
                [str(data["id"]), Json(data)],
            )
            return _Result([r[0] for r in rows])

        if self._op == "update":
            where, params = self._build_where()
            rows = self._execute_cursor(
                f"UPDATE {table} SET doc = doc || %s::jsonb{where} RETURNING doc",
                [Json(self._payload or {})] + params,
            )
            return _Result([r[0] for r in rows])

        if self._op == "delete":
            where, params = self._build_where()
            rows = self._execute_cursor(
                f"DELETE FROM {table}{where} RETURNING doc", params
            )
            return _Result([r[0] for r in rows])

        # default: select (handles embedded join as a special case)
        if "!inner(" in self._select_cols:
            return self._execute_embedded_select()

        where, params = self._build_where()
        sql = f"SELECT doc FROM {table}{where}"
        if self._order:
            expressions = []
            for col, desc in self._order:
                expression = "(doc->>%s)::integer" if col == "version" else "doc->>%s"
                expressions.append(f"{expression} {'DESC' if desc else 'ASC'}")
                params.append(col)
            sql += " ORDER BY " + ", ".join(expressions)
        if self._range is not None:
            start, end = self._range
            sql += f" LIMIT {max(end - start + 1, 0)} OFFSET {max(start, 0)}"
        elif self._limit is not None:
            sql += f" LIMIT {self._limit}"

        rows = self._execute_cursor(sql, params)
        data = [r[0] for r in rows]

        count = None
        if self._count_mode:
            cwhere, cparams = self._build_where()
            crows = self._execute_cursor(
                f"SELECT count(*) FROM {table}{cwhere}", cparams
            )
            count = crows[0][0] if crows else 0

        return _Result(data, count)

    def _execute_embedded_select(self) -> _Result:
        """Handle ``select("*, generations!inner(...)")`` used for orders."""
        from psycopg.types.json import Json

        # Parse the embedded resource: name and requested fields.
        head, rest = self._select_cols.split("!inner(", 1)
        embed_table = head.split(",")[-1].strip()
        embed_fields = [f.strip() for f in rest.split(")", 1)[0].split(",") if f.strip()]

        clauses: List[str] = []
        params: list = []
        for kind, col, val in self._filters:
            target = "g.doc" if col.startswith(f"{embed_table}.") else "o.doc"
            key = col.split(".", 1)[1] if "." in col else col
            if kind == "eq":
                clauses.append(f"{target} @> %s::jsonb")
                params.append(Json({key: val}))
            elif kind == "neq":
                clauses.append(f"NOT ({target} @> %s::jsonb)")
                params.append(Json({key: val}))
            elif kind == "is":
                clauses.append(f"({target}->>%s) IS NULL")
                params.append(key)
            elif kind == "in":
                clauses.append(f"{target}->>%s = ANY(%s)")
                params.append(key)
                params.append([str(v) for v in val])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        sql = (
            f'SELECT o.doc, g.doc FROM "{self._table}" o '
            f'JOIN "{embed_table}" g ON o.doc->>%s = g.doc->>%s'
            f"{where}"
        )
        join_params = ["generation_id", "id"] + params
        if self._order:
            sql += " ORDER BY " + ", ".join(
                f"o.doc->>%s {'DESC' if desc else 'ASC'}" for _col, desc in self._order)
            join_params.extend(col for col, _desc in self._order)

        rows = self._execute_cursor(sql, join_params)
        result: List[Dict[str, Any]] = []
        for odoc, gdoc in rows:
            row = dict(odoc)
            row[embed_table] = {f: (gdoc or {}).get(f) for f in embed_fields}
            result.append(row)
        return _Result(result)


class _StorageBucket:
    def __init__(self, root: Path, bucket: str, public_base: str):
        self._root = root
        self._bucket = bucket
        self._public_base = public_base.rstrip("/")

    def _full_path(self, path: str) -> Path:
        # Prevent path traversal outside the bucket directory.
        safe = os.path.normpath(path).lstrip("/")
        target = (self._root / self._bucket / safe).resolve()
        bucket_root = (self._root / self._bucket).resolve()
        if not str(target).startswith(str(bucket_root)):
            raise ValueError("Invalid storage path")
        return target

    def upload(self, path: str, file: Any, file_options: Optional[dict] = None) -> _UploadResult:
        target = self._full_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        content = file.encode("utf-8") if isinstance(file, str) else file
        with open(target, "wb") as f:
            f.write(content)
        return _UploadResult(path)

    def get_public_url(self, path: str) -> str:
        safe = os.path.normpath(path).lstrip("/")
        return f"{self._public_base}/local-storage/{self._bucket}/{safe}"

    def download(self, path: str) -> bytes:
        return self._full_path(path).read_bytes()

    def remove(self, paths: Any) -> dict:
        if isinstance(paths, str):
            paths = [paths]
        for p in paths:
            try:
                self._full_path(p).unlink(missing_ok=True)
            except Exception:
                pass
        return {"data": [], "error": None}


class _Storage:
    def __init__(self, root: Path, public_base: str):
        self._root = root
        self._public_base = public_base

    def from_(self, bucket: str) -> _StorageBucket:
        return _StorageBucket(self._root, bucket, self._public_base)


class LocalSupabaseClient:
    """Drop-in stand-in for ``supabase.Client`` for the subset used here."""

    def __init__(self, conn, storage_root: Path, public_base: str):
        self._conn = conn
        self._lock = threading.Lock()
        self.storage = _Storage(storage_root, public_base)

    def table(self, name: str) -> _QueryBuilder:
        return _QueryBuilder(self._conn, self._lock, name)


def _create_schema(conn) -> None:
    with conn.cursor() as cur:
        for table in _TABLES:
            cur.execute(
                f'CREATE TABLE IF NOT EXISTS "{table}" ('
                "pk bigserial PRIMARY KEY, "
                "id text, "
                "doc jsonb NOT NULL)"
            )
            cur.execute(
                f'CREATE INDEX IF NOT EXISTS "{table}_id_idx" '
                f'ON "{table}" ((doc->>\'id\'))'
            )
            cur.execute(
                f'CREATE INDEX IF NOT EXISTS "{table}_doc_gin" '
                f'ON "{table}" USING gin (doc jsonb_path_ops)'
            )
    _create_local_generation_versions(conn)


def _backfill_local_generation_versions(conn) -> None:
    """Recover legacy local edit ancestry before installing version allocation."""
    from psycopg.types.json import Json

    rows = [row[0] for row in conn.execute('SELECT doc FROM generations')]
    pending = [row for row in rows if not row.get("generation_id") or not row.get("version")]
    if not pending:
        return
    by_id = {row["id"]: row for row in rows}
    parents = {}
    image_predecessors = {}
    for row in sorted(rows, key=lambda row: (row.get("created_at", ""), row["id"])):
        owner = (row.get("user_id"), row.get("user_type"))
        image_key = (*owner, row.get("processed_image_url"))
        parent = row.get("source_generation_id")
        if not parent and row.get("endpoint") in ("updateModel", "resizeModel", "promptEditModel"):
            match = re.match(r"^(?:Updated model from |Resized model from |Edited from )([0-9a-fA-F-]{36})", row.get("prompt") or "")
            parent = match.group(1) if match else None
            if parent not in by_id and row.get("processed_image_url"):
                parent = image_predecessors.get(image_key)
        source = by_id.get(parent)
        if source and parent != row["id"] and (source.get("user_id"), source.get("user_type")) == owner:
            parents[row["id"]] = parent
        if row.get("processed_image_url"):
            image_predecessors[image_key] = row["id"]

    counters = {}
    for row in rows:
        if row.get("generation_id") and row.get("version"):
            group = row["generation_id"]
            counters[group] = max(counters.get(group, 0), row["version"])
    for row in sorted(pending, key=lambda row: (row.get("created_at", ""), row["id"])):
        ancestor = row["id"]
        seen = {ancestor}
        while ancestor in parents and parents[ancestor] not in seen:
            ancestor = parents[ancestor]
            seen.add(ancestor)
        group = by_id[ancestor].get("generation_id") or ancestor
        counters[group] = counters.get(group, 0) + 1
        payload = {"generation_id": group, "version": counters[group]}
        conn.execute('UPDATE generations SET doc = doc || %s::jsonb WHERE id = %s',
                     (Json(payload), row["id"]))


def _create_local_generation_versions(conn) -> None:
    """Match the Supabase migration for the embedded database's JSONB schema."""
    with conn.transaction():
        conn.execute('LOCK TABLE generations IN SHARE ROW EXCLUSIVE MODE')
        _backfill_local_generation_versions(conn)
        conn.execute("UPDATE generations SET doc = doc - 'source_generation_id' WHERE doc ? 'source_generation_id'")
        conn.execute("""
            CREATE OR REPLACE FUNCTION assign_local_generation_version() RETURNS trigger
            LANGUAGE plpgsql AS $$
            DECLARE model_id text; next_version integer := 1;
            BEGIN
                model_id := coalesce(new.doc->>'generation_id', new.doc->>'id');
                IF model_id <> new.doc->>'id' THEN
                    PERFORM pg_advisory_xact_lock(hashtextextended(model_id, 0));
                    IF NOT EXISTS (
                        SELECT 1 FROM generations WHERE doc->>'generation_id' = model_id
                          AND doc->>'user_id' = new.doc->>'user_id'
                          AND doc->>'user_type' = new.doc->>'user_type'
                    ) THEN RAISE EXCEPTION 'Model not found for this owner'; END IF;
                    SELECT coalesce(max((doc->>'version')::integer), 0) + 1
                    INTO next_version FROM generations WHERE doc->>'generation_id' = model_id;
                END IF;
                new.doc := new.doc - 'source_generation_id';
                new.doc := new.doc || jsonb_build_object('generation_id', model_id, 'version', next_version);
                RETURN new;
            END; $$;
            DROP TRIGGER IF EXISTS generations_assign_local_version ON generations;
            CREATE TRIGGER generations_assign_local_version BEFORE INSERT ON generations
            FOR EACH ROW EXECUTE FUNCTION assign_local_generation_version();
            CREATE UNIQUE INDEX IF NOT EXISTS generations_model_version_idx
              ON generations ((doc->>'generation_id'), ((doc->>'version')::integer));
            CREATE OR REPLACE VIEW latest_generations AS
              SELECT DISTINCT ON (doc->>'user_id', doc->>'user_type', doc->>'generation_id') pk, id, doc
              FROM generations ORDER BY doc->>'user_id', doc->>'user_type', doc->>'generation_id',
                (doc->>'version')::integer DESC;
        """)


def init_local_supabase() -> LocalSupabaseClient:
    """Spin up an embedded Postgres and return a Supabase-compatible client.

    Raises if the embedded server or driver cannot be started so the caller can
    fall back to disabled storage.
    """
    global STORAGE_ROOT, _server

    import pgserver
    import psycopg

    backend_dir = Path(__file__).resolve().parents[2]
    data_dir = backend_dir / ".local_postgres"
    storage_root = backend_dir / ".local_storage"
    data_dir.mkdir(parents=True, exist_ok=True)
    storage_root.mkdir(parents=True, exist_ok=True)

    public_base = (
        os.getenv("LOCAL_STORAGE_PUBLIC_URL")
        or os.getenv("SITE_URL")
        or "http://127.0.0.1:8002"
    )

    logger.info("Starting embedded Postgres for local storage at %s", data_dir)
    _server = pgserver.get_server(str(data_dir))
    conn = psycopg.connect(_server.get_uri(), autocommit=True)
    _create_schema(conn)

    STORAGE_ROOT = storage_root
    logger.info(
        "Local storage ready (embedded Postgres + file store at %s, public base %s)",
        storage_root,
        public_base,
    )
    return LocalSupabaseClient(conn, storage_root, public_base)
