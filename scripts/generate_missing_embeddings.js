import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');

// Read .env
const envFile = fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8');
let apiKey = '';
for (const line of envFile.split('\n')) {
    if (line.startsWith('VITE_OPENAI_API_KEY=')) {
        apiKey = line.split('=')[1].trim();
        break;
    }
}

if (!apiKey) {
    console.error("VITE_OPENAI_API_KEY not found in .env");
    process.exit(1);
}

const db = new Database(dbPath, { verbose: null });

async function getEmbeddings(texts) {
    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    input: texts,
                    model: 'text-embedding-3-small'
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API error ${response.status}: ${errText}`);
            }

            const json = await response.json();
            // The response.data array contains objects with 'embedding' and 'index'
            // They are guaranteed to be in the same order as the input texts
            return json.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
        } catch (e) {
            retries--;
            if (retries === 0) throw e;
            console.log(`API error, retrying... (${retries} retries left)`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function main() {
    console.log("Finding nodes missing embeddings...");
    const missingNodes = db.prepare(`
        SELECT n.id, n.text 
        FROM nodes n 
        LEFT JOIN node_embeddings e ON n.id = e.node_id 
        WHERE e.node_id IS NULL
    `).all();

    console.log(`Found ${missingNodes.length} nodes missing embeddings.`);
    if (missingNodes.length === 0) return;

    const insertStmt = db.prepare(`
        INSERT INTO node_embeddings (node_id, embedding_json, model_name)
        VALUES (?, ?, 'text-embedding-3-small')
    `);

    // Process in batches of 100
    const BATCH_SIZE = 100;
    let processedCount = 0;

    for (let i = 0; i < missingNodes.length; i += BATCH_SIZE) {
        const batch = missingNodes.slice(i, i + BATCH_SIZE);
        const texts = batch.map(n => n.text);
        
        console.log(`Processing batch ${i / BATCH_SIZE + 1} / ${Math.ceil(missingNodes.length / BATCH_SIZE)}...`);
        
        try {
            const embeddings = await getEmbeddings(texts);
            
            const transaction = db.transaction(() => {
                for (let j = 0; j < batch.length; j++) {
                    insertStmt.run(batch[j].id, JSON.stringify(embeddings[j]));
                }
            });
            transaction();
            
            processedCount += batch.length;
            console.log(`  -> Saved ${batch.length} embeddings. Progress: ${(processedCount / missingNodes.length * 100).toFixed(1)}%`);
        } catch (err) {
            console.error(`Failed to process batch: ${err.message}`);
            break;
        }
    }

    console.log(`Successfully generated and saved ${processedCount} embeddings.`);
}

main().catch(console.error);
