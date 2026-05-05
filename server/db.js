import Database from 'better-sqlite3';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec');

const dbPath = path.join(process.cwd(), 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath);

try {
  sqliteVec.load(db);
  const version = db.prepare('SELECT vec_version()').pluck().get();
  console.log(`Loaded sqlite-vec version ${version} in Vite middleware.`);
} catch (e) {
  console.error('Failed to load sqlite-vec in server/db.js:', e);
}

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Initialize Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    category_id TEXT,
    type TEXT,
    timestamp TEXT,
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    FOREIGN KEY(source_id) REFERENCES nodes(id),
    FOREIGN KEY(target_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    timestamp TEXT,
    lastProcessedIndex INTEGER DEFAULT -1
  );

  CREATE TABLE IF NOT EXISTS playground_generations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    html_content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    sender TEXT,
    content TEXT,
    timestamp TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS node_embeddings (
    node_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entity_mappings (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    session_id TEXT,
    message_id TEXT,
    FOREIGN KEY(node_id) REFERENCES nodes(id),
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(message_id) REFERENCES messages(id)
  );

  -- Virtual Table for sqlite-vec
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_node_embeddings USING vec0(
    node_id TEXT PRIMARY KEY,
    embedding float[1536]
  );

  CREATE TABLE IF NOT EXISTS node_embeddings (
    node_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );

  -- Secondary Indexes for Performance
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_entity_mappings_node ON entity_mappings(node_id);
  CREATE INDEX IF NOT EXISTS idx_playground_gens_session ON playground_generations(session_id);
`);

export default db;
