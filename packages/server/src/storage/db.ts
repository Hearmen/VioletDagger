import Database from 'better-sqlite3';

export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scheduling_mode TEXT NOT NULL DEFAULT 'sequential',
  status TEXT NOT NULL DEFAULT 'active',
  completion_reason TEXT,
  completion_reference_message_id INTEGER,
  max_sessions INTEGER NOT NULL,
  workdir TEXT NOT NULL DEFAULT '',
  auto_confirm_on_silence INTEGER NOT NULL DEFAULT 0,
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
`;

// 索引与 TABLES_SQL 分开执行：索引引用的列（如 target_agent_id）可能是老库要靠
// migrate() 的 ALTER TABLE 才会补上的——必须先 migrate 再建索引，否则老库在
// 索引创建这一步就会报 "no such column"（CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，
// 不会补列）。
const INDEXES_SQL = `
-- (room_id, id) 是主键，listMessages 游标分页直接走它，不需要单独索引。
CREATE INDEX IF NOT EXISTS idx_messages_room_type ON messages(room_id, type);
CREATE INDEX IF NOT EXISTS idx_messages_room_session ON messages(room_id, session_seq);
CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(room_id, target_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_target_agent ON messages(room_id, target_agent_id);
-- session_events 按 (room_id, session_seq, id) 读取；一次性事件的幂等靠唯一索引
-- (room_id, session_seq, kind, attempt_id)（见 01-storage.md）。
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(room_id, session_seq, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_unique ON session_events(room_id, session_seq, kind, attempt_id);
`;

export const SCHEMA_SQL = TABLES_SQL + INDEXES_SQL;

export function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // SQLite 默认不启用外键；不打开的话 messages/message_references 的复合外键形同虚设。
  db.pragma('foreign_keys = ON');
  db.exec(TABLES_SQL);
  migrate(db);
  db.exec(INDEXES_SQL);
  return db;
}

function hasLegacyMessageSchema(db: Database.Database): boolean {
  const columns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string; pk: number }[];
  if (columns.length === 0) return false;
  const pk = columns.filter((column) => column.pk > 0).map((column) => column.name).sort();
  return pk.length !== 2 || pk[0] !== 'id' || pk[1] !== 'room_id';
}

// 单机工具、无迁移框架：对既有库做幂等的列补齐（CREATE TABLE IF NOT EXISTS 不会改老表）。
// 老库的 room_agents 没有 registry_key——回填为 agent_id（老数据都是单实例、二者相等）。
function migrate(db: Database.Database): void {
  // 消息 id 由"全库自增"改为"room 内自增"不兼容旧库（见 01-storage.md §5.5）：检测到旧的
  // messages schema（单列 id 主键、没有 (room_id, id) 复合主键）就整库重建，不做数据迁移。
  if (hasLegacyMessageSchema(db)) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS message_references;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS session_events;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS room_agents;
      DROP TABLE IF EXISTS rooms;
    `);
    db.exec(SCHEMA_SQL);
    db.pragma('foreign_keys = ON');
    return;
  }

  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  for (const [name, definition] of [
    ['exploring_end_reason', 'TEXT'],
    ['exploring_result_summary', 'TEXT'],
    ['exploring_result_message_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ]) {
    if (!messageColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
    }
  }

  const agentColumns = db.prepare(`PRAGMA table_info(room_agents)`).all() as { name: string }[];
  if (!agentColumns.some((column) => column.name === 'registry_key')) {
    db.exec(`ALTER TABLE room_agents ADD COLUMN registry_key TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE room_agents SET registry_key = agent_id WHERE registry_key = ''`);
  }
  if (!agentColumns.some((column) => column.name === 'dispatch_enabled')) {
    db.exec(`ALTER TABLE room_agents ADD COLUMN dispatch_enabled INTEGER NOT NULL DEFAULT 1`);
  }

  const roomColumns = db.prepare(`PRAGMA table_info(rooms)`).all() as { name: string }[];
  if (!roomColumns.some((column) => column.name === 'workdir')) {
    // 空串表示"按服务端默认目录解析"（见 01-storage.md §5.4）；老数据一律这样兜底。
    db.exec(`ALTER TABLE rooms ADD COLUMN workdir TEXT NOT NULL DEFAULT ''`);
  }
  // 静默收敛自动确认（见 01-storage.md §5.6、03-orchestrator-core.md §1.4）：老库一律按"从未开启过"补齐，
  // 已有 completed 房间历史上都是人工确认，回填 completion_reason='manual' 更准确地反映事实，不留 NULL 造成前端展示空白。
  if (!roomColumns.some((column) => column.name === 'auto_confirm_on_silence')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN auto_confirm_on_silence INTEGER NOT NULL DEFAULT 0`);
  }
  if (!roomColumns.some((column) => column.name === 'completion_reason')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN completion_reason TEXT`);
    db.exec(`ALTER TABLE rooms ADD COLUMN completion_reference_message_id INTEGER`);
    db.exec(`UPDATE rooms SET completion_reason = 'manual' WHERE status = 'completed'`);
  }

  // session 生命周期/退出字段（见 01-storage.md §5.3）：老库补齐为可空列，历史记录不伪造退出事实。
  const sessionColumns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  const missingSessionColumns: [string, string][] = [
    ['exit_code', 'INTEGER'],
    ['exit_signal', 'TEXT'],
    ['stop_intent', 'TEXT'],
    ['cleanup_started_at', 'TEXT'],
    ['exit_cause', 'TEXT'],
  ];
  for (const [name, type] of missingSessionColumns) {
    if (!sessionColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
  }

  // 用量统计（见 01-storage.md 用量统计修订）：老库补列全部为 NULL，不推测回填——
  // 这几列在这个功能上线前从未被采集过，NULL 就是唯一诚实的初值。
  const usageColumns: [string, string][] = [
    ['input_tokens', 'INTEGER'],
    ['output_tokens', 'INTEGER'],
    ['cache_read_tokens', 'INTEGER'],
    ['cache_write_tokens', 'INTEGER'],
    ['cost_usd', 'REAL'],
  ];
  for (const [name, type] of usageColumns) {
    if (!sessionColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
  }

  // @ 定向消息（需求 3.3.2）：老库补列，target_agent_id 为 NULL、dispatch_scope 默认 'broadcast'，
  // 不推测回填历史 session 的定向归属（见 01-storage.md @ 定向消息修订）。
  if (!messageColumns.some((column) => column.name === 'target_agent_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN target_agent_id TEXT`);
  }
  if (!sessionColumns.some((column) => column.name === 'dispatch_scope')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN dispatch_scope TEXT NOT NULL DEFAULT 'broadcast'`);
  }
}

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}
