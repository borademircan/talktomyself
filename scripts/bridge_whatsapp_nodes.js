import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath, { verbose: null });

function main() {
    console.log("Bridging AI-summarized WhatsApp nodes to raw sessions...");
    
    const nodes = db.prepare("SELECT id, timestamp FROM nodes WHERE id LIKE 'ceren-%'").all();
    const sessions = db.prepare("SELECT id, timestamp FROM sessions WHERE id LIKE 'sess-wa-%'").all();
    
    console.log(`Found ${nodes.length} AI nodes and ${sessions.length} raw sessions.`);
    
    // Convert to Unix ms
    const nodeData = nodes.map(n => ({ id: n.id, ts: new Date(n.timestamp).getTime() }));
    
    const insertMapping = db.prepare('INSERT OR REPLACE INTO entity_mappings (id, node_id, session_id, message_id) VALUES (?, ?, ?, ?)');
    
    let mappingsCreated = 0;
    
    const transaction = db.transaction(() => {
        for (const session of sessions) {
            const sessTs = new Date(session.timestamp).getTime();
            
            let closestNode = null;
            let minDiff = Infinity;
            
            for (const node of nodeData) {
                const diff = Math.abs(node.ts - sessTs);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestNode = node;
                }
            }
            
            // Map if within 48 hours to account for timezone and chat fragmentation
            if (closestNode && minDiff < 48 * 60 * 60 * 1000) {
                const mappingId = `map_${closestNode.id}_${session.id}`;
                insertMapping.run(mappingId, closestNode.id, session.id, null);
                mappingsCreated++;
            }
        }
    });
    
    transaction();
    console.log(`Successfully created ${mappingsCreated} mappings!`);
}

main();
