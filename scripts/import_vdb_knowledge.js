import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const vdbKnowledgeFile = path.join(projectRoot, 'src/data/vdb_knowledge.json');

const db = new Database(dbPath, { verbose: null });

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

function main() {
    console.log(`Reading ${vdbKnowledgeFile}...`);
    // This is a large file, read carefully
    let rawData;
    try {
        rawData = fs.readFileSync(vdbKnowledgeFile, 'utf-8');
    } catch (e) {
        console.error("Failed to read vdb_knowledge.json", e.message);
        return;
    }

    const items = JSON.parse(rawData);
    console.log(`Found ${items.length} items to import.`);

    const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');
    const insertMapping = db.prepare('INSERT OR REPLACE INTO entity_mappings (id, node_id, session_id, message_id) VALUES (?, ?, ?, ?)');

    const transaction = db.transaction(() => {
        let importedNodes = 0;
        let mappingsCreated = 0;

        for (const item of items) {
            const id = item.id;
            // Prefer text if available, fallback to label + description
            let text = item.text || '';
            if (!text && item.metadata) {
                text = `${item.metadata.label || ''} ${item.metadata.description || ''}`.trim();
            }
            if (!text) continue;

            const categoryName = assignCategory(text);
            const categoryId = `cat_${categoryName}`;
            
            const type = item.metadata?.type || 'concept';
            const timestamp = item.metadata?.timestamp || new Date().toISOString();

            insertNode.run(id, text, categoryId, type, timestamp);
            importedNodes++;

            // Create mapping if it relates to a session
            const match = id.match(/^(sess-\d+)/);
            if (match) {
                const sessionId = match[1];
                const mappingId = `map_${id}_${sessionId}`;
                insertMapping.run(mappingId, id, sessionId, null);
                mappingsCreated++;
            }
        }
        console.log(`Imported ${importedNodes} nodes.`);
        console.log(`Created ${mappingsCreated} mappings to sessions.`);
    });

    transaction();
    console.log("Database import for vdb_knowledge complete.");
}

main();
