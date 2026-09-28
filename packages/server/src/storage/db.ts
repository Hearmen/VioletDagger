import Database from 'better-sqlite3';

export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scheduling_mode TEXT NOT NULL DEFAULT 'sequential',
  status TEXT NOT NULL DEFAULT 'active',
  max_sessions INTEGER NOT NULL,
  workdir TEXT NOT NULL DEFAULT '',
  dispatch_pending INTEGER NOT NULL DEFAULT 0,
  pending_author_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_agents (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL,
  registry_key TEXT NOT NULL DEFAULT '',
  join_order INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  current_session_seq INTEGER,
  dispatch_enabled INTEGER NOT NULL DEFAULT 1,
  directed_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  pgid INTEGER,
  raw_log_path TEXT,
  exit_code INTEGER,
  exit_signal TEXT,
  stop_intent TEXT,
  cleanup_started_at TEXT,
  exit_cause TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  dispatch_scope TEXT NOT NULL DEFAULT 'broadcast',
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  session_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempt_id TEXT NOT NULL DEFAULT '',
  detail TEXT,
  created_at TEXT NOT NULL
);

-- 消息 id 是 room 内自增（见 01-storage.md §5.5），主键为 (room_id, id)。
-- target_message_id / referenced_message_id 不用复合外键：SQLite 自引用复合外键在
-- 「被引用 id 恰等于本行 id」时会被本行自身满足，无法可靠强制同 room（见 01 §2）。
-- 同 room 引用由调用方用 room 内查找（getMessageById(roomId, id)）保证。
CREATE TABLE IF NOT EXISTS messages (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  id INTEGER NOT NULL,
  session_seq INTEGER,
  author_id TEXT NOT NULL,
  type TEXT,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_message_id INTEGER,
  target_agent_id TEXT,
  question_status TEXT,
  question_close_reason TEXT,
  question_closed_by INTEGER,
  chain_status TEXT,
  closes_question INTEGER NOT NULL DEFAULT 0,
  chain_resolution TEXT,
  verify_verdict INTEGER,
  exploring_status TEXT,
  exploring_note TEXT,
  exploring_end_reason TEXT,
  exploring_result_summary TEXT,
  exploring_result_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS message_references (
  room_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  referenced_message_id INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id, referenced_message_id)
);

-- Scheduler 对已有消息 type/状态的每次转换（需求 4.5），只追加（见 01-storage.md §1）。
CREATE TABLE IF NOT EXISTS state_transition_log (
  room_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_type TEXT,
  to_type TEXT,
  from_status TEXT,
  to_status TEXT,
  trigger_message_id INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, id)
);
`;

const INDEXES_SQL = `
-- (room_id, id) 是主键，listMessages 游标分页直接走它，不需要单独索引。
CREATE INDEX IF NOT EXISTS idx_messages_room_type ON messages(room_id, type);
CREATE INDEX IF NOT EXISTS idx_messages_room_session ON messages(room_id, session_seq);
CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(room_id, target_message_id);
CREATE INDEX IF NOT EXISTS idx_state_transition_message ON state_transition_log(room_id, message_id);
-- session_events 按 (room_id, session_seq, id) 读取；一次性事件的幂等靠唯一索引
-- (room_id, session_seq, kind, attempt_id)（见 01-storage.md）。
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(room_id, session_seq, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_unique ON session_events(room_id, session_seq, kind, attempt_id);
`;

export const SCHEMA_SQL = TABLES_SQL + INDEXES_SQL;

const ALL_TABLES = [
  'state_transition_log', 'message_references', 'messages', 'session_events', 'sessions', 'room_agents', 'rooms',
];

export function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // SQLite 默认不启用外键；不打开的话 messages 对 rooms 的外键形同虚设。
  db.pragma('foreign_keys = ON');
  // 必须在建表之前检查：CREATE TABLE IF NOT EXISTS 会先把缺失的 state_transition_log 建出来，掩盖旧 schema。
  if (hasIncompatibleSchema(db)) rebuild(db);
  db.exec(SCHEMA_SQL);
  return db;
}

// 不兼容的旧 schema（见 01-storage.md §5.6）：messages 缺 (room_id, id) 复合主键、缺知识状态列，
// rooms/room_agents 缺待分发标记列，或没有 state_transition_log 表。全新空库（没有 messages 表）不算不兼容。
function hasIncompatibleSchema(db: Database.Database): boolean {
  const columns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string; pk: number }[];
  if (columns.length === 0) return false;
  const pk = columns.filter((column) => column.pk > 0).map((column) => column.name).sort();
  if (pk.length !== 2 || pk[0] !== 'id' || pk[1] !== 'room_id') return true;
  const names = new Set(columns.map((column) => column.name));
  if (['question_status', 'chain_status', 'chain_resolution', 'question_closed_by'].some((name) => !names.has(name))) {
    return true;
  }
  const hasColumns = (table: string, required: string[]) => {
    const tableColumns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
    );
    return required.every((name) => tableColumns.has(name));
  };
  if (!hasColumns('rooms', ['dispatch_pending', 'pending_author_id'])) return true;
  if (!hasColumns('room_agents', ['directed_pending'])) return true;
  const transitionTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_transition_log'`)
    .get();
  return !transitionTable;
}

// 整库重建：删除全部表与数据，由调用方按当前 schema 重新建表；旧数据不迁移、不保留。
function rebuild(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  for (const table of ALL_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.pragma('foreign_keys = ON');
}

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}
