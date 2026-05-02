import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

async function backfillEmbeddings() {
  const apiKey = process.env.VITE_OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing VITE_OPENAI_API_KEY in environment variables.");
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS node_embeddings (
      node_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
  `);

  const nodes = db.prepare(`
    SELECT id, text FROM nodes 
    WHERE id NOT IN (SELECT node_id FROM node_embeddings)
  `).all();

  console.log(`Found ${nodes.length} nodes missing embeddings. Starting backfill...`);

  const insertEmbedding = db.prepare('INSERT OR REPLACE INTO node_embeddings (node_id, embedding) VALUES (?, ?)');

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: node.text
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
      }

      const result = await response.json();
      const embedding = result.data[0].embedding;
      
      const buffer = new Float32Array(embedding).buffer;
      insertEmbedding.run(node.id, Buffer.from(buffer));

      if ((i + 1) % 50 === 0) {
        console.log(`Embedded ${i + 1} / ${nodes.length} nodes...`);
      }
    } catch (e) {
      console.error(`Failed to embed node ${node.id}:`, e.message);
    }
  }

  console.log("Backfill complete! All nodes have embeddings.");
}

backfillEmbeddings().catch(console.error);
