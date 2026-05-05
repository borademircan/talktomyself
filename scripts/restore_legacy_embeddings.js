import Database from 'better-sqlite3';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../src/data-new/talk_to_myself.db');
const db = new Database(dbPath);
sqliteVec.load(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS node_embeddings (
    node_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
`);

const rows = db.prepare("SELECT node_id, embedding FROM vec_node_embeddings").all();
const insertStmt = db.prepare("INSERT OR REPLACE INTO node_embeddings (node_id, embedding) VALUES (?, ?)");

db.transaction(() => {
  for (const row of rows) {
    // Convert Float32Array back to raw Buffer for the legacy table
    const buffer = Buffer.from(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength);
    insertStmt.run(row.node_id, buffer);
  }
})();

console.log(`Restored ${rows.length} embeddings to the legacy node_embeddings table.`);
