import Database from 'better-sqlite3';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../src/data-new/talk_to_myself.db');
const db = new Database(dbPath);

console.log("Loading sqlite-vec extension...");
sqliteVec.load(db);

const version = db.prepare("SELECT vec_version()").pluck().get();
console.log(`sqlite-vec version: ${version}`);

console.log("Creating virtual table if it doesn't exist...");
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_node_embeddings USING vec0(
    node_id TEXT PRIMARY KEY,
    embedding float[1536]
  );
`);

console.log("Fetching legacy embeddings...");
try {
  const legacyRows = db.prepare("SELECT node_id, embedding FROM node_embeddings").all();
  console.log(`Found ${legacyRows.length} embeddings to migrate.`);

  const insertStmt = db.prepare("INSERT OR REPLACE INTO vec_node_embeddings(node_id, embedding) VALUES (?, ?)");

  let count = 0;
  db.transaction(() => {
    for (const row of legacyRows) {
      if (row.embedding) {
        // Convert legacy Buffer to Float32Array
        const floatArray = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
        insertStmt.run(row.node_id, floatArray);
        count++;
      }
    }
  })();

  console.log(`Successfully migrated ${count} embeddings to vec_node_embeddings.`);

  console.log("Migration complete. Legacy table 'node_embeddings' was kept intact per user request.");
} catch (e) {
  if (e.message.includes('no such table: node_embeddings')) {
    console.log("Legacy table 'node_embeddings' already dropped or doesn't exist. Checking virtual table count...");
    const count = db.prepare("SELECT count(*) FROM vec_node_embeddings").pluck().get();
    console.log(`Virtual table contains ${count} embeddings.`);
  } else {
    console.error("Migration failed:", e);
  }
}
