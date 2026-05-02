import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = true;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath, { verbose: null });

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function createEdges() {
    console.log('Loading Local AI Model (Xenova Transformers)...');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

    console.log('Fetching nodes from database...');
    const nodes = db.prepare('SELECT id, text FROM nodes').all();
    console.log(`Found ${nodes.length} nodes. Extracting embeddings...`);

    const embeddedNodes = [];
    for (let i = 0; i < nodes.length; i++) {
        const text = nodes[i].text;
        if (!text || text.length < 10) continue;

        const output = await extractor(text, { pooling: 'mean', normalize: true });
        embeddedNodes.push({
            id: nodes[i].id,
            vector: Array.from(output.data)
        });

        if ((i + 1) % 100 === 0) {
            console.log(`Embedded ${i + 1} / ${nodes.length} nodes...`);
        }
    }

    console.log(`Finished embedding ${embeddedNodes.length} nodes. Calculating similarities and creating edges...`);

    db.prepare('DELETE FROM edges').run();
    console.log('Cleared existing edges.');

    const insertEdge = db.prepare('INSERT INTO edges (id, source_id, target_id, type, weight) VALUES (?, ?, ?, ?, ?)');
    
    let edgeCount = 0;
    const EDGE_THRESHOLD = 0.75; // Adjust as needed. 0.70 might create too many for 1200 nodes.

    const transaction = db.transaction(() => {
        for (let i = 0; i < embeddedNodes.length; i++) {
            for (let j = i + 1; j < embeddedNodes.length; j++) {
                const sim = cosineSimilarity(embeddedNodes[i].vector, embeddedNodes[j].vector);
                if (sim > EDGE_THRESHOLD) {
                    const edgeId = `edge_${Date.now()}_${edgeCount}`;
                    insertEdge.run(edgeId, embeddedNodes[i].id, embeddedNodes[j].id, 'relates_to', sim);
                    edgeCount++;
                }
            }
        }
    });

    transaction();
    console.log(`Generated and inserted ${edgeCount} relational edges.`);
}

createEdges().catch(console.error);
