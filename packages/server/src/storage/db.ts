import Database from 'better-sqlite3';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scheduling_mode TEXT NOT NULL DEFAULT 'sequential',
  status TEXT NOT NULL DEFAULT 'active',
  max_sessions INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_agents (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL,
  join_order INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  current_session_seq INTEGER,
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
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  session_seq INTEGER,
  author_id TEXT NOT NULL,
  type TEXT,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_message_id INTEGER REFERENCES messages(id),
  exploring_status TEXT,
  exploring_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_references (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  referenced_message_id INTEGER NOT NULL REFERENCES messages(id),
  PRIMARY KEY (message_id, referenced_message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_room_type ON messages(room_id, type);
CREATE INDEX IF NOT EXISTS idx_messages_room_session ON messages(room_id, session_seq);
CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_message_id);
`;

export function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}
