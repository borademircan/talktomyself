import db from './db.js';
import fs from 'fs';
import path from 'path';

const envFile = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
const apiKeyLine = envFile.split('\n').find(line => line.startsWith('VITE_OPENAI_API_KEY='));
const apiKey = apiKeyLine ? apiKeyLine.split('=')[1].trim() : null;

async function embedAll() {
  const nodes = db.prepare(`
    SELECT n.id, n.text 
    FROM nodes n
    LEFT JOIN node_embeddings ne ON n.id = ne.node_id
    WHERE ne.node_id IS NULL
  `).all();

  console.log(`Found ${nodes.length} nodes missing embeddings.`);
  if (nodes.length === 0) return;

  const insertStmt = db.prepare('INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)');
  
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (i % 50 === 0) console.log(`Embedding ${i + 1}/${nodes.length}...`);
    
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ input: node.text, model: 'text-embedding-3-small' })
      });

      if (!response.ok) {
        console.error('Error from OpenAI:', await response.text());
        continue;
      }
      
      const json = await response.json();
      const embedding = json.data[0].embedding;
      
      const buffer = new Float32Array(embedding).buffer;
      insertStmt.run(node.id, Buffer.from(buffer));
      
      await new Promise(r => setTimeout(r, 10)); 
    } catch (e) {
      console.error(`Failed to embed ${node.id}:`, e);
    }
  }
  console.log('Done!');
}

embedAll();
