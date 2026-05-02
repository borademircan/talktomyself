import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const knowledgeFile = path.join(projectRoot, 'src/data/vdb_knowledge.json');

const db = new Database(dbPath, { verbose: null });

function main() {
    console.log("Creating node_embeddings table...");
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS node_embeddings (
            node_id TEXT PRIMARY KEY,
            embedding_json TEXT NOT NULL,
            model_name TEXT DEFAULT 'text-embedding-3-small',
            FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
    `);
    
    console.log("Reading vdb_knowledge.json...");
    const rawData = fs.readFileSync(knowledgeFile, 'utf8');
    const nodes = JSON.parse(rawData);
    
    console.log(`Found ${nodes.length} nodes in JSON file. Importing embeddings...`);
    
    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO node_embeddings (node_id, embedding_json, model_name)
        VALUES (?, ?, 'text-embedding-3-small')
    `);
    
    let imported = 0;
    
    const transaction = db.transaction(() => {
        for (const node of nodes) {
            // Only import if it has an ID and a valid embedding array
            if (node.id && node.embedding && Array.isArray(node.embedding)) {
                try {
                    insertStmt.run(node.id, JSON.stringify(node.embedding));
                    imported++;
                } catch (e) {
                    if (e.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                        throw e;
                    }
                }
            }
        }
    });
    
    transaction();
    
    console.log(`Successfully imported ${imported} high-dimensional embeddings into node_embeddings table!`);
}

main();
