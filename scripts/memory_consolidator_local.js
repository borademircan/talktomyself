import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = true;

const dbPath = path.join(process.cwd(), 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath, { verbose: null });

const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');
const insertEdge = db.prepare('INSERT OR REPLACE INTO edges (id, source_id, target_id, type, weight) VALUES (?, ?, ?, ?, ?)');
const getOrInsertCategory = db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)');

const CATEGORIES = ["identity", "preferences", "relationships", "ceren", "work", "business", "errands", "mindset", "general"];

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

function assignCategory(text) {
    const t = text.toLowerCase();
    if (t.includes('trans') || t.includes('identity') || t.includes('self')) return 'identity';
    if (t.includes('ceren')) return 'ceren';
    if (t.includes('work') || t.includes('project') || t.includes('code')) return 'work';
    if (t.includes('business') || t.includes('meeting') || t.includes('client')) return 'business';
    if (t.includes('music') || t.includes('fashion') || t.includes('like') || t.includes('love')) return 'preferences';
    if (t.includes('feel') || t.includes('anxiety') || t.includes('mind') || t.includes('confident')) return 'mindset';
    if (t.includes('friend') || t.includes('talked')) return 'relationships';
    return 'general';
}

function extractWhatsAppTimestamp(text) {
    const match = text.match(/\[(\d{2})\.(\d{2})\.(\d{4}), (\d{2}):(\d{2}):(\d{2})\]/);
    if (match) {
        const [, day, month, year, hours, minutes, seconds] = match;
        return new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`).toISOString();
    }
    return null;
}

async function processData(extractor, rawNodes, sourceName) {
    console.log(`Extracting embeddings for ${rawNodes.length} nodes from ${sourceName}...`);
    
    const embeddedNodes = [];
    for (let i = 0; i < rawNodes.length; i++) {
        const text = rawNodes[i].metadata?.description || rawNodes[i].label || rawNodes[i].text || '';
        if (text.length < 10) continue; 
        
        let nodeTimestamp = extractWhatsAppTimestamp(text);
        if (!nodeTimestamp) {
            nodeTimestamp = rawNodes[i].metadata?.timestamp || rawNodes[i].timestamp || new Date().toISOString();
        }
        
        if (typeof nodeTimestamp === 'number') {
            nodeTimestamp = new Date(nodeTimestamp).toISOString();
        }
        
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        embeddedNodes.push({
            id: rawNodes[i].id || `node_${Date.now()}_${i}`,
            text: text,
            timestamp: nodeTimestamp,
            vector: Array.from(output.data)
        });
        if (i % 100 === 0 && i > 0) console.log(`Embedded ${i} nodes...`);
    }

    console.log(`Clustering similar nodes for ${sourceName}...`);
    const clusters = [];
    const SIMILARITY_THRESHOLD = 0.85;

    for (const node of embeddedNodes) {
        let placed = false;
        for (const cluster of clusters) {
            const sim = cosineSimilarity(node.vector, cluster.centroid);
            if (sim > SIMILARITY_THRESHOLD) {
                cluster.nodes.push(node);
                for (let i = 0; i < cluster.centroid.length; i++) {
                    cluster.centroid[i] = (cluster.centroid[i] * (cluster.nodes.length - 1) + node.vector[i]) / cluster.nodes.length;
                }
                placed = true;
                break;
            }
        }
        if (!placed) {
            clusters.push({ centroid: [...node.vector], nodes: [node] });
        }
    }

    console.log(`Reduced ${embeddedNodes.length} nodes to ${clusters.length} consolidated concepts.`);

    const transaction = db.transaction(() => {
        const clusterReps = [];
        clusters.forEach((cluster, idx) => {
            cluster.nodes.sort((a, b) => b.text.length - a.text.length);
            const rep = cluster.nodes[0];
            const cat = assignCategory(rep.text);
            const catId = `cat_${cat}`;
            
            const newId = `concept_${sourceName}_${idx}`;
            insertNode.run(newId, rep.text, catId, 'concept', rep.timestamp);
            clusterReps.push({ id: newId, centroid: cluster.centroid });
        });

        const EDGE_THRESHOLD = 0.70;
        let edgeCount = 0;
        for (let i = 0; i < clusterReps.length; i++) {
            for (let j = i + 1; j < clusterReps.length; j++) {
                const sim = cosineSimilarity(clusterReps[i].centroid, clusterReps[j].centroid);
                if (sim > EDGE_THRESHOLD) {
                    const edgeId = `edge_${sourceName}_${i}_${j}`;
                    insertEdge.run(edgeId, clusterReps[i].id, clusterReps[j].id, 'relates_to', sim);
                    edgeCount++;
                }
            }
        }
        console.log(`Generated ${edgeCount} relational edges for ${sourceName}.`);
    });
    
    transaction();
}

async function runLocalAI() {
    console.log('Loading Local AI Model (Xenova Transformers)...');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    
    CATEGORIES.forEach(cat => {
        getOrInsertCategory.run(`cat_${cat}`, cat, `System category: ${cat}`);
    });

    // 1. Process kg.json
    console.log('--- Processing kg.json ---');
    const kgPath = path.join(process.cwd(), 'src/data/kg.json');
    if (fs.existsSync(kgPath)) {
        const kgData = JSON.parse(fs.readFileSync(kgPath, 'utf-8'));
        await processData(extractor, kgData.nodes || [], 'kg');
    }

    // 2. Process sessions.json
    console.log('--- Processing sessions.json ---');
    const sessPath = path.join(process.cwd(), 'src/data/sessions.json');
    if (fs.existsSync(sessPath)) {
        const sessions = JSON.parse(fs.readFileSync(sessPath, 'utf-8'));
        const sessionNodes = [];
        
        sessions.forEach((s, idx) => {
            if (!s.messages) return;
            const userMessages = s.messages.filter(m => m.role === 'user');
            if (userMessages.length === 0) return;
            
            // Join messages, take up to 300 chars to avoid massive text blobs per node
            const combinedText = userMessages.map(m => m.content).join(' ').substring(0, 300);
            // Try to use the first user message's timestamp if available
            let earliestTimestamp = s.timestamp;
            if (userMessages[0].timestamp) {
                earliestTimestamp = userMessages[0].timestamp;
            } else if (!earliestTimestamp) {
                earliestTimestamp = Date.now();
            }

            if (combinedText.length > 20) {
                sessionNodes.push({
                    text: combinedText,
                    timestamp: earliestTimestamp
                });
            }
        });
        await processData(extractor, sessionNodes, 'sess');
    }
    
    console.log('Local AI consolidation complete and saved to SQLite.');
}

runLocalAI().catch(console.error);
