import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath, { verbose: null });

function main() {
    const nodes = db.prepare("SELECT id, text, timestamp FROM nodes WHERE text LIKE 'WhatsApp Conversation%'").all();
    console.log(`Found ${nodes.length} WhatsApp Conversation nodes.`);

    const insertSession = db.prepare('INSERT OR IGNORE INTO sessions (id, name, timestamp) VALUES (?, ?, ?)');
    const insertMessage = db.prepare('INSERT OR REPLACE INTO messages (id, session_id, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)');
    const deleteEdges = db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?');
    const deleteMappings = db.prepare('DELETE FROM entity_mappings WHERE node_id = ?');
    const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');

    let sessionsCreated = 0;
    let messagesCreated = 0;

    const transaction = db.transaction(() => {
        for (const node of nodes) {
            // Extract session id
            let sessionId = node.id;
            const match = node.id.match(/^(sess-wa-\d+)/);
            if (match) {
                sessionId = match[1];
            }

            // The text format:
            // WhatsApp Conversation (4/23/2024). Ceren: https://...
            // Ceren: ...
            // memory conversation whatsapp
            
            const lines = node.text.split('\n');
            let sessionName = "WhatsApp Conversation";
            if (lines.length > 0 && lines[0].startsWith("WhatsApp Conversation")) {
                const firstDot = lines[0].indexOf('.');
                if (firstDot !== -1) {
                    sessionName = lines[0].substring(0, firstDot).trim();
                    lines[0] = lines[0].substring(firstDot + 1).trim();
                }
            }

            // Insert session
            const res = insertSession.run(sessionId, sessionName, node.timestamp);
            if (res.changes > 0) {
                sessionsCreated++;
            }

            let msgIndex = 0;
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                if (line === "memory conversation whatsapp") continue;
                
                // Parse "Sender: Message"
                const colonIndex = line.indexOf(':');
                let sender = 'unknown';
                let content = line;
                
                if (colonIndex !== -1 && colonIndex < 30) {
                    sender = line.substring(0, colonIndex).trim();
                    content = line.substring(colonIndex + 1).trim();
                }

                const msgId = `${node.id}-msg-${msgIndex}`;
                insertMessage.run(msgId, sessionId, sender, content, node.timestamp);
                msgIndex++;
                messagesCreated++;
            }

            // Cleanup the node
            deleteEdges.run(node.id, node.id);
            deleteMappings.run(node.id);
            deleteNode.run(node.id);
        }
    });

    transaction();
    console.log(`Migrated into ${sessionsCreated} new sessions and ${messagesCreated} messages.`);
    console.log(`Deleted ${nodes.length} WhatsApp Conversation nodes and their edges.`);
}

main();
