//! Page-scoped SQLite pools and connection-bound transactions.
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteQueryResult, SqliteRow,
};
use sqlx::{Column, Row, Sqlite, SqlitePool, Transaction, TypeInfo, ValueRef};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use tokio::sync::Mutex;

/// Statements at or above this host-side cost are always recorded.
const SIDECAR_SLOW_SQL_MS: u128 = 25;

/// Commits between explicit checkpoints. SQLite's own autocheckpoint runs *inside* the committing
/// statement and busy-waits for the WAL write lock when a reader holds a snapshot, which shows up
/// as a ~500 ms commit; checking in from the host, outside any transaction, cannot wait.
const SIDECAR_CHECKPOINT_EVERY: u32 = 16;

#[derive(Default)]
pub struct SidecarTransactions {
    next_id: AtomicU64,
    state: Mutex<SidecarState>,
}

#[derive(Default)]
struct SidecarState {
    scopes: HashMap<String, u64>,
    active: HashMap<u64, ScopedTransaction>,
    databases: HashMap<String, HashMap<(String, u64), usize>>,
    database_locks: HashMap<String, Weak<Mutex<()>>>,
    /// Commits since the last explicit WAL checkpoint, per database.
    commit_counters: HashMap<String, u32>,
}

struct ScopedTransaction {
    owner: String,
    scope: u64,
    database: String,
    transaction: Arc<Mutex<Option<Transaction<'static, Sqlite>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn bind_query(
    query: &str,
    values: Vec<Value>,
) -> Result<sqlx::query::Query<'_, Sqlite, sqlx::sqlite::SqliteArguments<'_>>, String> {
    let mut statement = sqlx::query(query);
    for value in values {
        statement = match value {
            Value::Null => statement.bind(None::<String>),
            Value::String(value) => statement.bind(value),
            Value::Bool(value) => statement.bind(value),
            Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    statement.bind(value)
                } else if let Some(value) = value.as_f64() {
                    statement.bind(value)
                } else {
                    return Err("Unsupported SQLite number".into());
                }
            }
            _ => return Err("Sidecar SQL parameters must be scalar values".into()),
        };
    }
    Ok(statement)
}

/// Truthy values only: `NESTOS_SIDECAR_TRACE=0` must not turn tracing on.
fn truthy(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn sidecar_sql_trace_enabled() -> bool {
    static TRACE: OnceLock<bool> = OnceLock::new();
    *TRACE.get_or_init(|| truthy(std::env::var("NESTOS_SIDECAR_TRACE").ok().as_deref()))
}

/// Where one statement spent its host time. Split so a client-side measurement can be attributed:
/// `wait` covers the transaction mutex, `BEGIN IMMEDIATE` and the pool acquire; `decode` covers
/// turning rows into JSON, which is host work that must not look like IPC latency.
#[derive(Default)]
struct SqlTimings {
    wait_ms: u128,
    query_ms: u128,
    decode_ms: u128,
    rows: usize,
}

/// Whether the statement is worth a log line. Failures are always recorded, because the slowest
/// statements are often the ones that end in an error. `idle_before == 0` means the pool had to
/// open a connection (or wait for one), which is what the first statement after sqlx reaped the
/// idle connection looks like; those explain a slow cold page.
fn should_record_sql(
    trace: bool,
    ok: bool,
    timings: &SqlTimings,
    idle_before: Option<usize>,
) -> bool {
    trace
        || !ok
        || timings.wait_ms + timings.query_ms + timings.decode_ms >= SIDECAR_SLOW_SQL_MS
        || idle_before == Some(0)
}

/// Host-side timing for one sidecar statement, on success and failure. A multi-second client-side
/// measurement cannot be attributed to the host or to request delivery without it.
fn record_sql(
    operation: &str,
    database: &str,
    scope: Option<u64>,
    total_ms: u128,
    outcome: &Result<impl Sized, String>,
    timings: &SqlTimings,
    pool: Option<(u32, usize)>,
) {
    if !should_record_sql(
        sidecar_sql_trace_enabled(),
        outcome.is_ok(),
        timings,
        pool.map(|(_, idle)| idle),
    ) {
        return;
    }
    let mut detail = serde_json::json!({"operation": operation, "database": database,
        "totalMs": total_ms, "waitMs": timings.wait_ms, "queryMs": timings.query_ms,
        "decodeMs": timings.decode_ms, "rows": timings.rows, "ok": outcome.is_ok()});
    if let Err(error) = outcome {
        detail["error"] = serde_json::json!(error);
    }
    if let Some(scope) = scope {
        detail["scope"] = serde_json::json!(scope);
    }
    if let Some((size, idle)) = pool {
        detail["poolSize"] = serde_json::json!(size);
        detail["poolIdleBefore"] = serde_json::json!(idle);
    }
    crate::diagnostics::record("sidecar.sql", detail);
}

/// Run one statement on a pooled connection. The connection goes back to the pool before the
/// caller records, so logging never extends how long the pool is held.
async fn execute_on_pool(
    pool: &SqlitePool,
    query: &str,
    values: Vec<Value>,
    timings: &mut SqlTimings,
) -> Result<SqliteQueryResult, String> {
    let acquire_start = Instant::now();
    let acquired = pool.acquire().await.map_err(|error| error.to_string());
    timings.wait_ms = acquire_start.elapsed().as_millis();
    let mut connection = acquired?;
    let query_start = Instant::now();
    let result = match bind_query(query, values) {
        Ok(statement) => statement
            .execute(&mut *connection)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error),
    };
    timings.query_ms = query_start.elapsed().as_millis();
    timings.rows = result
        .as_ref()
        .map(|result| result.rows_affected() as usize)
        .unwrap_or(0);
    drop(connection);
    result
}

/// Run one query on a pooled connection and decode it, timing acquire, query and decode apart.
async fn select_on_pool(
    pool: &SqlitePool,
    query: &str,
    values: Vec<Value>,
    timings: &mut SqlTimings,
) -> Result<Vec<Map<String, Value>>, String> {
    let acquire_start = Instant::now();
    let acquired = pool.acquire().await.map_err(|error| error.to_string());
    timings.wait_ms = acquire_start.elapsed().as_millis();
    let mut connection = acquired?;
    let query_start = Instant::now();
    let raw = match bind_query(query, values) {
        Ok(statement) => statement
            .fetch_all(&mut *connection)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error),
    };
    timings.query_ms = query_start.elapsed().as_millis();
    drop(connection);
    let decode_start = Instant::now();
    let rows = raw.and_then(decode_rows);
    timings.decode_ms = decode_start.elapsed().as_millis();
    timings.rows = rows.as_ref().map(Vec::len).unwrap_or(0);
    rows
}

/// Run one statement inside an already open transaction; timings are filled on failure too.
async fn execute_in(
    slot: &mut Option<Transaction<'static, Sqlite>>,
    query: &str,
    values: Vec<Value>,
    timings: &mut SqlTimings,
) -> Result<SqliteQueryResult, String> {
    let transaction = slot
        .as_mut()
        .ok_or("Sidecar transaction is no longer active")?;
    let query_start = Instant::now();
    let result = bind_query(query, values)?
        .execute(&mut **transaction)
        .await
        .map_err(|error| error.to_string());
    timings.query_ms = query_start.elapsed().as_millis();
    timings.rows = result
        .as_ref()
        .map(|result| result.rows_affected() as usize)
        .unwrap_or(0);
    result
}

/// Run one query inside an already open transaction and decode it, timing both stages.
async fn select_in(
    slot: &mut Option<Transaction<'static, Sqlite>>,
    query: &str,
    values: Vec<Value>,
    timings: &mut SqlTimings,
) -> Result<Vec<Map<String, Value>>, String> {
    let transaction = slot
        .as_mut()
        .ok_or("Sidecar transaction is no longer active")?;
    let query_start = Instant::now();
    let raw = bind_query(query, values)?
        .fetch_all(&mut **transaction)
        .await
        .map_err(|error| error.to_string());
    timings.query_ms = query_start.elapsed().as_millis();
    let decode_start = Instant::now();
    let rows = raw.and_then(decode_rows);
    timings.decode_ms = decode_start.elapsed().as_millis();
    timings.rows = rows.as_ref().map(Vec::len).unwrap_or(0);
    rows
}

fn decode_rows(rows: Vec<SqliteRow>) -> Result<Vec<Map<String, Value>>, String> {    rows.into_iter().map(decode_row).collect()
}

fn decode_row(row: SqliteRow) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index).map_err(|e| e.to_string())?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            decode_value(&row, index, raw.type_info().name())?
        };
        result.insert(column.name().to_owned(), value);
    }
    Ok(result)
}

fn decode_value(row: &SqliteRow, index: usize, kind: &str) -> Result<Value, String> {
    match kind {
        "TEXT" => row
            .try_get::<String, _>(index)
            .map(Value::from)
            .map_err(|e| e.to_string()),
        "INTEGER" | "NUMERIC" => row
            .try_get::<i64, _>(index)
            .map(Value::from)
            .map_err(|e| e.to_string()),
        "REAL" => row
            .try_get::<f64, _>(index)
            .map(Value::from)
            .map_err(|e| e.to_string()),
        "BOOLEAN" => row
            .try_get::<bool, _>(index)
            .map(Value::from)
            .map_err(|e| e.to_string()),
        _ => Err(format!("Unsupported sidecar column type: {kind}")),
    }
}

impl SidecarTransactions {
    async fn open_scope(&self, owner: &str) -> Result<u64, String> {
        let started = std::time::Instant::now();
        let scope = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut state = self.state.lock().await;
        let previous = state.scopes.insert(owner.to_owned(), scope);
        let ids: Vec<_> = state
            .active
            .iter()
            .filter(|(_, tx)| tx.owner == owner && Some(tx.scope) == previous)
            .map(|(id, _)| *id)
            .collect();
        let pending: Vec<_> = ids
            .iter()
            .filter_map(|id| state.active.remove(id))
            .collect();
        for leases in state.databases.values_mut() {
            leases.retain(|(lease_owner, lease_scope), _| {
                lease_owner != owner || Some(*lease_scope) != previous
            });
        }
        state.databases.retain(|_, leases| !leases.is_empty());
        state
            .database_locks
            .retain(|_, lock| lock.strong_count() > 0);
        drop(state);
        let mut errors = Vec::new();
        for tx in pending {
            if let Some(transaction) = tx.transaction.lock().await.take() {
                if let Err(error) = transaction.rollback().await {
                    errors.push(error.to_string());
                }
            }
        }
        let detail = serde_json::json!({"owner": owner, "scope": scope, "rolledBack": ids.len(),
            "durationMs": started.elapsed().as_millis(), "errors": &errors});
        if errors.is_empty() {
            crate::diagnostics::record("sidecar.scope.open", detail);
        } else {
            crate::diagnostics::record_durable("sidecar.scope.open.failed", detail);
        }
        if errors.is_empty() {
            Ok(scope)
        } else {
            Err(format!(
                "Failed to roll back previous page transactions: {}",
                errors.join("; ")
            ))
        }
    }

    async fn register_database(
        &self,
        owner: &str,
        scope: u64,
        database: &str,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.scopes.get(owner) != Some(&scope) {
            return Err("Sidecar page scope is no longer active".into());
        }
        *state
            .databases
            .entry(database.to_owned())
            .or_default()
            .entry((owner.to_owned(), scope))
            .or_default() += 1;
        Ok(())
    }

    async fn database_lock(&self, database: &str) -> Arc<Mutex<()>> {        let mut state = self.state.lock().await;
        if let Some(lock) = state.database_locks.get(database).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        state
            .database_locks
            .insert(database.to_owned(), Arc::downgrade(&lock));
        lock
    }

    async fn assert_database(&self, owner: &str, scope: u64, database: &str) -> Result<(), String> {
        let state = self.state.lock().await;
        let leased = state
            .databases
            .get(database)
            .and_then(|leases| leases.get(&(owner.to_owned(), scope)))
            .is_some_and(|count| *count > 0);
        if leased {
            Ok(())
        } else {
            Err("Sidecar database is not leased by this page".into())
        }
    }

    async fn release_database(&self, owner: &str, scope: u64, database: &str) -> bool {
        let mut state = self.state.lock().await;
        let Some(leases) = state.databases.get_mut(database) else {
            return false;
        };
        let key = (owner.to_owned(), scope);
        let Some(count) = leases.get_mut(&key) else {
            return false;
        };
        if *count > 1 {
            *count -= 1;
        } else {
            leases.remove(&key);
        }
        if !leases.is_empty() {
            return false;
        }
        state.databases.remove(database);
        true
    }

    /// True while any page still has an open transaction on this database.
    async fn has_active_transaction(&self, database: &str) -> bool {
        self.state
            .lock()
            .await
            .active
            .values()
            .any(|entry| entry.database == database)
    }

    /// Reserves a checkpoint slot so steady-state commits do not pay a PRAGMA each time.
    async fn take_checkpoint_slot(&self, database: &str) -> bool {
        let mut state = self.state.lock().await;
        let counter = state.commit_counters.entry(database.to_owned()).or_default();
        *counter += 1;
        if *counter < SIDECAR_CHECKPOINT_EVERY {
            return false;
        }
        *counter = 0;
        true
    }

    async fn is_last_owner_lease(&self, owner: &str, scope: u64, database: &str) -> bool {
        self.state
            .lock()
            .await
            .databases
            .get(database)
            .and_then(|leases| leases.get(&(owner.to_owned(), scope)))
            == Some(&1)
    }

    async fn rollback_database(
        &self,
        owner: &str,
        scope: u64,
        database: &str,
    ) -> Result<(), String> {
        let pending = {
            let mut state = self.state.lock().await;
            let ids: Vec<_> = state
                .active
                .iter()
                .filter(|(_, tx)| tx.owner == owner && tx.scope == scope && tx.database == database)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| state.active.remove(&id))
                .collect::<Vec<_>>()
        };
        let mut errors = Vec::new();
        for tx in pending {
            if let Some(transaction) = tx.transaction.lock().await.take() {
                if let Err(error) = transaction.rollback().await {
                    errors.push(error.to_string());
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    async fn begin(
        &self,
        pool: &SqlitePool,
        owner: &str,
        scope: u64,
        database: &str,
    ) -> Result<u64, String> {
        let started = Instant::now();
        if self.state.lock().await.scopes.get(owner) != Some(&scope) {
            return Err("Sidecar page scope is no longer active".into());
        }
        let (pool_size, pool_idle) = (pool.size(), pool.num_idle());
        let mut timings = SqlTimings::default();
        let wait_start = Instant::now();
        // Do not hold active's mutex while waiting for another SQLite writer.
        let opened = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|e| e.to_string());
        timings.wait_ms = wait_start.elapsed().as_millis();
        let result = match opened {
            Ok(tx) => self.bind_transaction(tx, owner, scope, database).await,
            Err(error) => Err(error),
        };
        record_sql(
            "begin",
            database,
            Some(scope),
            started.elapsed().as_millis(),
            &result,
            &timings,
            Some((pool_size, pool_idle)),
        );
        result
    }

    /// Bind an opened transaction to its page, rolling it back when the page lost scope or lease.
    async fn bind_transaction(
        &self,
        tx: Transaction<'static, Sqlite>,
        owner: &str,
        scope: u64,
        database: &str,
    ) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut state = self.state.lock().await;
        let leased = state
            .databases
            .get(database)
            .and_then(|leases| leases.get(&(owner.to_owned(), scope)))
            .is_some_and(|count| *count > 0);
        if state.scopes.get(owner) == Some(&scope) && leased {
            state.active.insert(
                id,
                ScopedTransaction {
                    owner: owner.to_owned(),
                    scope,
                    database: database.to_owned(),
                    transaction: Arc::new(Mutex::new(Some(tx))),
                },
            );
            return Ok(id);
        }
        drop(state);
        tx.rollback().await.map_err(|error| error.to_string())?;
        Err("Sidecar page scope changed while waiting for a transaction".into())
    }

    async fn transaction_for(
        &self,
        id: u64,
        owner: &str,
        scope: u64,
        database: &str,
    ) -> Result<Arc<Mutex<Option<Transaction<'static, Sqlite>>>>, String> {
        let state = self.state.lock().await;
        let entry = state
            .active
            .get(&id)
            .ok_or("Sidecar transaction is no longer active")?;
        if entry.owner != owner
            || entry.scope != scope
            || entry.database != database
            || state.scopes.get(owner) != Some(&scope)
        {
            return Err("Sidecar transaction does not belong to this page".into());
        }
        Ok(entry.transaction.clone())
    }

    async fn execute(
        &self,
        id: u64,
        owner: &str,
        scope: u64,
        database: &str,
        query: &str,
        values: Vec<Value>,
    ) -> Result<ExecuteResult, String> {
        let started = Instant::now();
        let tx = self.transaction_for(id, owner, scope, database).await?;
        let mut timings = SqlTimings::default();
        let lock_start = Instant::now();
        let mut transaction = tx.lock().await;
        timings.wait_ms = lock_start.elapsed().as_millis();
        let result = execute_in(&mut transaction, query, values, &mut timings).await;
        record_sql(
            "execute",
            database,
            Some(scope),
            started.elapsed().as_millis(),
            &result,
            &timings,
            None,
        );
        result.map(|result| ExecuteResult {
            rows_affected: result.rows_affected(),
            last_insert_id: result.last_insert_rowid(),
        })
    }

    async fn select(
        &self,
        id: u64,
        owner: &str,
        scope: u64,
        database: &str,
        query: &str,
        values: Vec<Value>,
    ) -> Result<Vec<Map<String, Value>>, String> {
        let started = Instant::now();
        let tx = self.transaction_for(id, owner, scope, database).await?;
        let mut timings = SqlTimings::default();
        let lock_start = Instant::now();
        let mut transaction = tx.lock().await;
        timings.wait_ms = lock_start.elapsed().as_millis();
        let rows = select_in(&mut transaction, query, values, &mut timings).await;
        record_sql(
            "select",
            database,
            Some(scope),
            started.elapsed().as_millis(),
            &rows,
            &timings,
            None,
        );
        rows
    }

    async fn finish(
        &self,
        id: u64,
        owner: &str,
        scope: u64,
        database: &str,
        commit: bool,
    ) -> Result<(), String> {
        let started = Instant::now();
        let tx = self.transaction_for(id, owner, scope, database).await?;
        let mut timings = SqlTimings::default();
        let lock_start = Instant::now();
        let mut guard = tx.lock().await;
        timings.wait_ms = lock_start.elapsed().as_millis();
        let transaction = guard.take();
        let query_start = Instant::now();
        let result = match transaction {
            Some(tx) if commit => tx.commit().await.map_err(|e| e.to_string()),
            Some(tx) => tx.rollback().await.map_err(|e| e.to_string()),
            // A failed commit consumes the handle; SQLx rolls back on drop.
            None if !commit => Ok(()),
            None => Err("Sidecar transaction is no longer active".into()),
        };
        timings.query_ms = query_start.elapsed().as_millis();
        record_sql(
            if commit { "commit" } else { "rollback" },
            database,
            Some(scope),
            started.elapsed().as_millis(),
            &result,
            &timings,
            None,
        );
        if result.is_ok() || !commit {
            self.state.lock().await.active.remove(&id);
        }
        result
    }
}

async fn database_pool(databases: &DbInstances, database: &str) -> Result<SqlitePool, String> {
    let instances = databases.0.read().await;
    match instances.get(database) {
        Some(DbPool::Sqlite(pool)) if !pool.is_closed() => Ok(pool.clone()),
        Some(_) => Err("SQLite sidecar database is closed".into()),
        None => Err("SQLite sidecar database is not loaded".into()),
    }
}

async fn connect_database(database: &str) -> Result<SqlitePool, String> {
    if !database.starts_with("sqlite:") {
        return Err("Sidecar database must use SQLite".into());
    }
    let options = SqliteConnectOptions::from_str(database)
        .map_err(|error| error.to_string())?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(30))
        .foreign_keys(true)
        // SQLite's autocheckpoint runs inside the committing statement and busy-waits for the WAL
        // write lock while a reader holds a snapshot (measured: ~520 ms per heartbeat commit).
        // The host checkpoints explicitly instead, outside any transaction, so it cannot wait.
        .pragma("wal_autocheckpoint", "0");
    SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .map_err(|error| error.to_string())
}

/// Run a PASSIVE checkpoint and report `(busy, walFrames, checkpointedFrames)`. PASSIVE never
/// waits for readers, so this cannot reproduce the commit-time stall it replaces.
async fn checkpoint_pool(pool: &SqlitePool) -> Result<(i64, i64, i64), String> {
    let rows = sqlx::query("PRAGMA wal_checkpoint(PASSIVE)")
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    let decoded = decode_rows(rows)?;
    let field = |name: &str| {
        decoded
            .first()
            .and_then(|row| row.get(name))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    Ok((field("busy"), field("log"), field("checkpointed")))
}

/// Check the WAL in from the host, outside any transaction, once the page using the database is
/// quiet. Only checkpoints that did work or met a reader are recorded.
async fn checkpoint_after_commit(
    databases: &DbInstances,
    transactions: &SidecarTransactions,
    database: &str,
) {
    if transactions.has_active_transaction(database).await {
        return;
    }
    let Ok(pool) = database_pool(databases, database).await else {
        return;
    };
    let started = Instant::now();
    let result = checkpoint_pool(&pool).await;
    let duration_ms = started.elapsed().as_millis();
    match &result {
        Ok((busy, frames, checkpointed)) => {
            if *busy != 0 || *checkpointed != 0 || duration_ms >= SIDECAR_SLOW_SQL_MS {
                crate::diagnostics::record("sidecar.checkpoint", serde_json::json!({
                    "database": database, "busy": busy, "walFrames": frames,
                    "checkpointed": checkpointed, "durationMs": duration_ms}));
            }
        }
        Err(error) => crate::diagnostics::record_durable(
            "sidecar.checkpoint.failed",
            serde_json::json!({"database": database, "durationMs": duration_ms, "error": error}),
        ),
    }
}

async fn retire_pool(pool: SqlitePool, database: String) {    if tokio::time::timeout(Duration::from_secs(2), pool.close())
        .await
        .is_err()
    {
        crate::diagnostics::record_durable(
            "sidecar.database.close.timeout",
            serde_json::json!({"database": database}),
        );
    }
}

/// Returns true when an existing SQLite pool was reused.
#[tauri::command]
pub async fn sidecar_open_database(
    database: String,
    scope: u64,
    webview: tauri::WebviewWindow,
    paths: State<'_, crate::AppPaths>,
    databases: State<'_, DbInstances>,
    transactions: State<'_, SidecarTransactions>,
) -> Result<bool, String> {
    let started = std::time::Instant::now();
    let path = database
        .strip_prefix("sqlite:")
        .ok_or("Sidecar database must use SQLite")?;
    if !crate::is_allowed(std::path::Path::new(path), &paths) {
        return Err("Sidecar database path is not allowed".into());
    }
    let result =
        open_database_for_page(&database, webview.label(), scope, &databases, &transactions).await;
    record_database_open(&database, scope, started.elapsed().as_millis(), &result);
    result
}

async fn open_database_for_page(
    database: &str,
    owner: &str,
    scope: u64,
    databases: &DbInstances,
    transactions: &SidecarTransactions,
) -> Result<bool, String> {
    let lock = transactions.database_lock(&database).await;
    let guard = lock.lock().await;
    transactions
        .register_database(owner, scope, &database)
        .await?;
    let existing = database_pool(&databases, &database).await.ok();
    let opened = if existing.is_some() {
        Ok((true, None))
    } else {
        open_new_database(&database, owner, scope, &databases, &transactions)
            .await
            .map(|replaced| (false, replaced))
    };
    let (reused, replaced) = match opened {
        Ok(value) => value,
        Err(error) => {
            transactions.release_database(owner, scope, &database).await;
            return Err(error);
        }
    };
    let valid = transactions.assert_database(owner, scope, &database).await;
    if valid.is_err() {
        transactions.release_database(owner, scope, &database).await;
    }
    drop(guard);
    if let Some(pool) = replaced {
        let database = database.to_owned();
        tauri::async_runtime::spawn(async move { retire_pool(pool, database).await });
    }
    valid?;
    Ok(reused)
}

fn record_database_open(
    database: &str,
    scope: u64,
    duration_ms: u128,
    result: &Result<bool, String>,
) {
    let detail = serde_json::json!({"database": database, "scope": scope,
        "reused": result.as_ref().ok(), "durationMs": duration_ms, "error": result.as_ref().err()});
    if result.is_ok() {
        crate::diagnostics::record("sidecar.database.open", detail);
    } else {
        crate::diagnostics::record_durable("sidecar.database.open.failed", detail);
    }
}

async fn open_new_database(
    database: &str,
    owner: &str,
    scope: u64,
    databases: &DbInstances,
    transactions: &SidecarTransactions,
) -> Result<Option<SqlitePool>, String> {
    let candidate = connect_database(database).await?;
    if let Err(error) = transactions.assert_database(owner, scope, database).await {
        candidate.close().await;
        return Err(error);
    }
    let replaced = databases
        .0
        .write()
        .await
        .insert(database.to_owned(), DbPool::Sqlite(candidate));
    Ok(match replaced {
        Some(DbPool::Sqlite(pool)) => Some(pool),
        _ => None,
    })
}

#[tauri::command]
pub async fn sidecar_database_execute(
    database: String,
    scope: u64,
    query: String,
    values: Vec<Value>,
    webview: tauri::WebviewWindow,
    databases: State<'_, DbInstances>,
    transactions: State<'_, SidecarTransactions>,
) -> Result<ExecuteResult, String> {
    transactions
        .assert_database(webview.label(), scope, &database)
        .await?;
    let pool = database_pool(&databases, &database).await?;
    let (pool_size, pool_idle) = (pool.size(), pool.num_idle());
    let started = Instant::now();
    let mut timings = SqlTimings::default();
    let result = execute_on_pool(&pool, &query, values, &mut timings).await;
    record_sql(
        "database_execute",
        &database,
        Some(scope),
        started.elapsed().as_millis(),
        &result,
        &timings,
        Some((pool_size, pool_idle)),
    );
    result.map(|result| ExecuteResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}

#[tauri::command]
pub async fn sidecar_database_select(
    database: String,
    scope: u64,
    query: String,
    values: Vec<Value>,
    webview: tauri::WebviewWindow,
    databases: State<'_, DbInstances>,
    transactions: State<'_, SidecarTransactions>,
) -> Result<Vec<Map<String, Value>>, String> {
    transactions
        .assert_database(webview.label(), scope, &database)
        .await?;
    let pool = database_pool(&databases, &database).await?;
    let (pool_size, pool_idle) = (pool.size(), pool.num_idle());
    let started = Instant::now();
    let mut timings = SqlTimings::default();
    let rows = select_on_pool(&pool, &query, values, &mut timings).await;
    record_sql(
        "database_select",
        &database,
        Some(scope),
        started.elapsed().as_millis(),
        &rows,
        &timings,
        Some((pool_size, pool_idle)),
    );
    rows
}

#[tauri::command]
pub async fn sidecar_close_database(
    database: String,
    scope: u64,
    webview: tauri::WebviewWindow,
    databases: State<'_, DbInstances>,
    transactions: State<'_, SidecarTransactions>,
) -> Result<bool, String> {
    let lock = transactions.database_lock(&database).await;
    let guard = lock.lock().await;
    let owner_done = transactions
        .is_last_owner_lease(webview.label(), scope, &database)
        .await;
    let final_lease = transactions
        .release_database(webview.label(), scope, &database)
        .await;
    let rollback = if owner_done {
        transactions
            .rollback_database(webview.label(), scope, &database)
            .await
    } else {
        Ok(())
    };
    let removed = if final_lease {
        databases.0.write().await.remove(&database)
    } else {
        None
    };
    drop(guard);
    if let Some(DbPool::Sqlite(pool)) = removed {
        retire_pool(pool, database).await;
    }
    rollback?;
    Ok(final_lease)
}

#[tauri::command]
pub async fn sidecar_open_scope(
    webview: tauri::WebviewWindow,
    transactions: State<'_, SidecarTransactions>,
) -> Result<u64, String> {
    transactions.open_scope(webview.label()).await
}

#[tauri::command]
pub async fn sidecar_begin(
    database: String,
    scope: u64,
    webview: tauri::WebviewWindow,
    databases: State<'_, DbInstances>,
    transactions: State<'_, SidecarTransactions>,
) -> Result<u64, String> {
    transactions
        .assert_database(webview.label(), scope, &database)
        .await?;
    let pool = {
        let databases = databases.0.read().await;
        match databases.get(&database) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            _ => return Err("SQLite sidecar database is not loaded".into()),
        }
    };
    transactions
        .begin(&pool, webview.label(), scope, &database)
        .await
}

#[tauri::command]
pub async fn sidecar_execute(
    transaction_id: u64,
    database: String,
    scope: u64,
    query: String,
    values: Vec<Value>,
    webview: tauri::WebviewWindow,
    transactions: State<'_, SidecarTransactions>,
) -> Result<ExecuteResult, String> {
    transactions
        .execute(
            transaction_id,
            webview.label(),
            scope,
            &database,
            &query,
            values,
        )
        .await
}

#[tauri::command]
pub async fn sidecar_select(
    transaction_id: u64,
    database: String,
    scope: u64,
    query: String,
    values: Vec<Value>,
    webview: tauri::WebviewWindow,
    transactions: State<'_, SidecarTransactions>,
) -> Result<Vec<Map<String, Value>>, String> {
    transactions
        .select(
            transaction_id,
            webview.label(),
            scope,
            &database,
            &query,
            values,
        )
        .await
}

#[tauri::command]
pub async fn sidecar_finish(
    transaction_id: u64,
    database: String,
    scope: u64,
    commit: bool,
    webview: tauri::WebviewWindow,
    databases: State<'_, DbInstances>,
    transactions: State<'_, SidecarTransactions>,
) -> Result<(), String> {
    let result = transactions
        .finish(transaction_id, webview.label(), scope, &database, commit)
        .await;
    if result.is_ok() && commit && transactions.take_checkpoint_slot(&database).await {
        checkpoint_after_commit(&databases, &transactions, &database).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    fn timings(wait_ms: u128, query_ms: u128, decode_ms: u128) -> SqlTimings {
        SqlTimings { wait_ms, query_ms, decode_ms, rows: 0 }
    }

    #[test]
    fn records_failures_slow_stages_and_connection_rebuilds() {
        // Warm and fast: quiet, so a busy session does not pay a log write per statement.
        assert!(!should_record_sql(false, true, &timings(0, 1, 0), Some(3)));
        // The pool had to open a connection: always worth a line (cold page, reaped idle pool).
        assert!(should_record_sql(false, true, &timings(0, 1, 0), Some(0)));
        // Every host-side stage counts towards the threshold.
        assert!(should_record_sql(false, true, &timings(SIDECAR_SLOW_SQL_MS, 0, 0), Some(2)));
        assert!(should_record_sql(false, true, &timings(0, SIDECAR_SLOW_SQL_MS, 0), None));
        assert!(should_record_sql(false, true, &timings(0, 0, SIDECAR_SLOW_SQL_MS), None));
        // A failed statement is always recorded, however fast it failed.
        assert!(should_record_sql(false, false, &timings(0, 0, 0), None));
        // NESTOS_SIDECAR_TRACE records everything, including transaction-scoped statements.
        assert!(should_record_sql(true, true, &timings(0, 0, 0), None));
    }

    #[test]
    fn trace_switch_accepts_explicit_truthy_values_only() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(truthy(Some(value)), "{value}");
        }
        for value in ["0", "false", "off", "no", ""] {
            assert!(!truthy(Some(value)), "{value}");
        }
        assert!(!truthy(None));
    }

    #[test]
    fn times_pool_statements_that_fail_or_decode() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("CREATE TABLE records (path TEXT PRIMARY KEY, value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO records VALUES ('a', '{\"n\":1}')")
                .execute(&pool)
                .await
                .unwrap();

            // Success: rows are counted and both stages belong to the same timing record.
            let mut timings = SqlTimings::default();
            let rows = select_on_pool(&pool, "SELECT path, value FROM records", vec![], &mut timings)
                .await
                .unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(timings.rows, 1);

            // Query failure: the error comes back and the timings are still filled, so the
            // failure is recorded even though it was fast.
            let mut failed = SqlTimings::default();
            let error = select_on_pool(&pool, "SELECT * FROM missing_table", vec![], &mut failed)
                .await
                .unwrap_err();
            assert!(error.contains("missing_table"), "{error}");
            assert!(should_record_sql(false, false, &failed, Some(1)));

            // Decode failure: an unsupported column type is a decode error, not a query error.
            let mut undecodable = SqlTimings::default();
            let error = select_on_pool(&pool, "SELECT zeroblob(1) AS data", vec![], &mut undecodable)
                .await
                .unwrap_err();
            assert!(error.contains("Unsupported sidecar column type"), "{error}");

            // Write failure: same contract for execute_on_pool.
            let mut write = SqlTimings::default();
            let error = execute_on_pool(&pool, "INSERT INTO missing_table VALUES (1)", vec![], &mut write)
                .await
                .unwrap_err();
            assert!(error.contains("missing_table"), "{error}");
            assert!(should_record_sql(false, false, &write, Some(1)));

            pool.close().await;
        });
    }

    #[test]
    fn explicit_checkpoints_do_not_wait_for_a_reader_and_are_slotted() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir().join(format!(
                "sidecar-checkpoint-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let database = format!("sqlite:{}", path.display());
            let pool = connect_database(&database).await.unwrap();
            sqlx::query("CREATE TABLE records (value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO records VALUES ('x')")
                .execute(&pool)
                .await
                .unwrap();
            // Autocheckpoint stays off so the host, not the committing statement, checks in.
            assert_eq!(
                sqlx::query_scalar::<_, i64>("PRAGMA wal_autocheckpoint")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );

            // A reader holding a snapshot is what made SQLite's own checkpoint busy-wait; the
            // explicit PASSIVE checkpoint must return promptly instead.
            let reader = connect_database(&database).await.unwrap();
            let mut snapshot = reader.acquire().await.unwrap();
            sqlx::query("BEGIN").execute(&mut *snapshot).await.unwrap();
            sqlx::query("SELECT count(*) FROM records")
                .fetch_all(&mut *snapshot)
                .await
                .unwrap();
            let started = Instant::now();
            let (busy, frames, _) = checkpoint_pool(&pool).await.unwrap();
            assert!(
                started.elapsed() < Duration::from_millis(500),
                "checkpoint waited for the reader"
            );
            assert!(busy == 0 || busy == 1);
            assert!(frames >= 0);
            sqlx::query("COMMIT").execute(&mut *snapshot).await.unwrap();
            drop(snapshot);
            reader.close().await;

            // Padding the WAL with many frames still checkpoints promptly once the reader is gone.
            for index in 0..64 {
                sqlx::query("INSERT INTO records VALUES (?)")
                    .bind("x".repeat(1024 + index))
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            let (busy, _, checkpointed) = checkpoint_pool(&pool).await.unwrap();
            assert_eq!(busy, 0);
            assert!(checkpointed > 0, "expected frames to be checkpointed");

            // Steady-state commits only reserve a slot every SIDECAR_CHECKPOINT_EVERY commits.
            let transactions = SidecarTransactions::default();
            let scope = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", scope, &database)
                .await
                .unwrap();
            let mut slots = 0;
            for _ in 0..(SIDECAR_CHECKPOINT_EVERY * 3) {
                if transactions.take_checkpoint_slot(&database).await {
                    slots += 1;
                }
            }
            assert_eq!(slots, 3);
            assert!(!transactions.has_active_transaction(&database).await);
            let id = transactions
                .begin(&pool, "main", scope, &database)
                .await
                .unwrap();
            assert!(transactions.has_active_transaction(&database).await);
            transactions
                .finish(id, "main", scope, &database, false)
                .await
                .unwrap();

            pool.close().await;
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn transactions_keep_connection_and_recover_after_failures() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir().join(format!(
                "sidecar-tx-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let pool = SqlitePoolOptions::new()
                .max_connections(3)
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(&path)
                        .create_if_missing(true)
                        .journal_mode(SqliteJournalMode::Wal)
                        .foreign_keys(true),
                )
                .await
                .unwrap();
            sqlx::query("CREATE TABLE records (path TEXT PRIMARY KEY, value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            let transactions = std::sync::Arc::new(SidecarTransactions::default());
            let scope = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", scope, "sqlite:/test")
                .await
                .unwrap();
            let id = transactions
                .begin(&pool, "main", scope, "sqlite:/test")
                .await
                .unwrap();
            transactions
                .execute(
                    id,
                    "main",
                    scope,
                    "sqlite:/test",
                    "INSERT INTO records VALUES (?, ?)",
                    vec![Value::from("one"), Value::from("ready")],
                )
                .await
                .unwrap();
            assert_eq!(
                transactions
                    .select(
                        id,
                        "main",
                        scope,
                        "sqlite:/test",
                        "SELECT value FROM records",
                        vec![]
                    )
                    .await
                    .unwrap()[0]["value"],
                "ready"
            );
            // An unrelated pooled read must not see the uncommitted write.
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM records")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            // A second writer waits without preventing the first from committing.
            let pending = {
                let transactions = transactions.clone();
                let pool = pool.clone();
                tauri::async_runtime::spawn(async move {
                    transactions
                        .begin(&pool, "main", scope, "sqlite:/test")
                        .await
                })
            };
            transactions
                .finish(id, "main", scope, "sqlite:/test", true)
                .await
                .unwrap();
            let next = pending.await.unwrap().unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM records")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            transactions
                .execute(
                    next,
                    "main",
                    scope,
                    "sqlite:/test",
                    "UPDATE records SET value = 'discard'",
                    vec![],
                )
                .await
                .unwrap();
            assert!(transactions
                .execute(
                    next,
                    "main",
                    scope,
                    "sqlite:/test",
                    "INSERT INTO records VALUES ('one', 'duplicate')",
                    vec![]
                )
                .await
                .is_err());
            transactions
                .finish(next, "main", scope, "sqlite:/test", false)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT value FROM records")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "ready"
            );
            assert!(transactions
                .select(next, "main", scope, "sqlite:/test", "SELECT 1", vec![])
                .await
                .is_err());

            // Deferred FK failure exercises failed COMMIT and rollback-on-drop.
            sqlx::query("CREATE TABLE child (parent TEXT REFERENCES records(path) DEFERRABLE INITIALLY DEFERRED)").execute(&pool).await.unwrap();
            let failed = transactions
                .begin(&pool, "main", scope, "sqlite:/test")
                .await
                .unwrap();
            transactions
                .execute(
                    failed,
                    "main",
                    scope,
                    "sqlite:/test",
                    "INSERT INTO child VALUES ('missing')",
                    vec![],
                )
                .await
                .unwrap();
            assert!(transactions
                .finish(failed, "main", scope, "sqlite:/test", true)
                .await
                .is_err());
            transactions
                .finish(failed, "main", scope, "sqlite:/test", false)
                .await
                .unwrap();
            let last = transactions
                .begin(&pool, "main", scope, "sqlite:/test")
                .await
                .unwrap();
            transactions
                .finish(last, "main", scope, "sqlite:/test", true)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM child")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            pool.close().await;
            std::fs::remove_file(path).unwrap();
        });
    }
    #[test]
    fn page_reload_rolls_back_orphans_and_fences_waiting_transactions() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::query("CREATE TABLE records (value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            let transactions = std::sync::Arc::new(SidecarTransactions::default());
            let old_scope = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", old_scope, "sqlite:/test")
                .await
                .unwrap();
            let old = transactions
                .begin(&pool, "main", old_scope, "sqlite:/test")
                .await
                .unwrap();
            transactions
                .execute(
                    old,
                    "main",
                    old_scope,
                    "sqlite:/test",
                    "INSERT INTO records VALUES ('orphan')",
                    vec![],
                )
                .await
                .unwrap();
            let waiting = {
                let transactions = transactions.clone();
                let pool = pool.clone();
                tauri::async_runtime::spawn(async move {
                    transactions
                        .begin(&pool, "main", old_scope, "sqlite:/test")
                        .await
                })
            };
            // The single connection is still owned by the abandoned page.
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(20), pool.acquire())
                    .await
                    .is_err()
            );
            let current = transactions.open_scope("main").await.unwrap();
            assert!(waiting.await.unwrap().is_err());
            assert!(transactions
                .finish(old, "main", old_scope, "sqlite:/test", true)
                .await
                .is_err());
            assert!(transactions
                .begin(&pool, "main", old_scope, "sqlite:/test")
                .await
                .is_err());
            transactions
                .register_database("main", current, "sqlite:/test")
                .await
                .unwrap();
            let fresh = transactions
                .begin(&pool, "main", current, "sqlite:/test")
                .await
                .unwrap();
            assert_eq!(
                transactions
                    .select(
                        fresh,
                        "main",
                        current,
                        "sqlite:/test",
                        "SELECT COUNT(*) AS count FROM records",
                        vec![]
                    )
                    .await
                    .unwrap()[0]["count"],
                0
            );
            // Another window opening a page cannot revoke this page's transaction.
            transactions.open_scope("other-window").await.unwrap();
            transactions
                .execute(
                    fresh,
                    "main",
                    current,
                    "sqlite:/test",
                    "INSERT INTO records VALUES ('kept')",
                    vec![],
                )
                .await
                .unwrap();
            transactions
                .finish(fresh, "main", current, "sqlite:/test", true)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT value FROM records")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "kept"
            );
            pool.close().await;
        });
    }

    #[test]
    fn page_reload_transfers_database_ownership_and_fences_stale_close() {
        tauri::async_runtime::block_on(async {
            let transactions = SidecarTransactions::default();
            let old = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", old, "sqlite:/one")
                .await
                .unwrap();
            let current = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", current, "sqlite:/one")
                .await
                .unwrap();
            assert!(
                !transactions
                    .release_database("main", old, "sqlite:/one")
                    .await
            );
            transactions
                .assert_database("main", current, "sqlite:/one")
                .await
                .unwrap();
            assert!(
                transactions
                    .release_database("main", current, "sqlite:/one")
                    .await
            );
            assert!(transactions
                .assert_database("main", current, "sqlite:/one")
                .await
                .is_err());
        });
    }

    #[test]
    fn transaction_id_cannot_cross_windows_or_databases() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            let transactions = SidecarTransactions::default();
            let first = transactions.open_scope("first").await.unwrap();
            let second = transactions.open_scope("second").await.unwrap();
            transactions
                .register_database("first", first, "sqlite:/one")
                .await
                .unwrap();
            transactions
                .register_database("second", second, "sqlite:/one")
                .await
                .unwrap();
            let id = transactions
                .begin(&pool, "first", first, "sqlite:/one")
                .await
                .unwrap();
            assert!(transactions
                .select(id, "second", second, "sqlite:/one", "SELECT 1", vec![])
                .await
                .is_err());
            assert!(transactions
                .execute(id, "second", second, "sqlite:/one", "SELECT 1", vec![])
                .await
                .is_err());
            assert!(transactions
                .finish(id, "second", second, "sqlite:/one", false)
                .await
                .is_err());
            assert!(transactions
                .finish(id, "first", first, "sqlite:/other", false)
                .await
                .is_err());
            assert_eq!(
                transactions
                    .select(
                        id,
                        "first",
                        first,
                        "sqlite:/one",
                        "SELECT 1 AS value",
                        vec![]
                    )
                    .await
                    .unwrap()[0]["value"],
                1
            );
            transactions
                .finish(id, "first", first, "sqlite:/one", false)
                .await
                .unwrap();
            pool.close().await;
        });
    }

    #[test]
    fn closing_a_database_rolls_back_an_abandoned_transaction() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            let transactions = SidecarTransactions::default();
            let scope = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", scope, "sqlite:/one")
                .await
                .unwrap();
            let id = transactions
                .begin(&pool, "main", scope, "sqlite:/one")
                .await
                .unwrap();
            assert!(
                transactions
                    .is_last_owner_lease("main", scope, "sqlite:/one")
                    .await
            );
            assert!(
                transactions
                    .release_database("main", scope, "sqlite:/one")
                    .await
            );
            transactions
                .rollback_database("main", scope, "sqlite:/one")
                .await
                .unwrap();
            assert!(transactions
                .finish(id, "main", scope, "sqlite:/one", true)
                .await
                .is_err());
            tokio::time::timeout(Duration::from_millis(100), pool.close())
                .await
                .unwrap();
        });
    }

    #[test]
    fn replacing_a_borrowed_pool_does_not_hold_the_database_open_lock() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir().join(format!(
                "sidecar-replace-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let database = format!("sqlite:{}", path.display());
            let old = connect_database(&database).await.unwrap();
            let borrowed = old.acquire().await.unwrap();
            let instances = DbInstances::default();
            instances
                .0
                .write()
                .await
                .insert(database.clone(), DbPool::Sqlite(old));
            let transactions = SidecarTransactions::default();
            let scope = transactions.open_scope("main").await.unwrap();
            transactions
                .register_database("main", scope, &database)
                .await
                .unwrap();
            let lock = transactions.database_lock(&database).await;
            let guard = lock.lock().await;
            let replaced = tokio::time::timeout(
                Duration::from_secs(1),
                open_new_database(&database, "main", scope, &instances, &transactions),
            )
            .await
            .unwrap()
            .unwrap()
            .unwrap();
            drop(guard);
            let _next_open = tokio::time::timeout(Duration::from_millis(100), lock.lock())
                .await
                .unwrap();
            tokio::time::timeout(
                Duration::from_secs(3),
                retire_pool(replaced, database.clone()),
            )
            .await
            .unwrap();
            drop(borrowed);
            let current = database_pool(&instances, &database).await.unwrap();
            current.close().await;
            instances.0.write().await.remove(&database);
            std::fs::remove_file(path).unwrap();
        });
    }

    #[test]
    fn concurrent_opens_of_one_database_share_a_pool() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir().join(format!(
                "sidecar-singleflight-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let database = format!("sqlite:{}", path.display());
            let instances = Arc::new(DbInstances::default());
            let transactions = Arc::new(SidecarTransactions::default());
            let scope = transactions.open_scope("main").await.unwrap();
            let mut tasks = Vec::new();
            for _ in 0..2 {
                let db = database.clone();
                let instances = instances.clone();
                let transactions = transactions.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    open_database_for_page(&db, "main", scope, &instances, &transactions).await
                }));
            }
            let mut reused = Vec::new();
            for task in tasks {
                reused.push(task.await.unwrap().unwrap());
            }
            reused.sort();
            assert_eq!(reused, [false, true]);
            assert_eq!(instances.0.read().await.len(), 1);
            assert!(
                !transactions
                    .release_database("main", scope, &database)
                    .await
            );
            assert!(
                transactions
                    .release_database("main", scope, &database)
                    .await
            );
            let pool = database_pool(&instances, &database).await.unwrap();
            pool.close().await;
            instances.0.write().await.remove(&database);
            std::fs::remove_file(path).unwrap();
        });
    }
}
