import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const sessionsFile = path.join(projectRoot, 'src/data-new/sessions.json');

const db = new Database(dbPath, { verbose: null });

function main() {
    console.log("Setting up tables...");
    
    db.prepare(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT,
            timestamp TEXT
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            sender TEXT,
            content TEXT,
            timestamp TEXT,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS entity_mappings (
            id TEXT PRIMARY KEY,
            node_id TEXT,
            session_id TEXT,
            message_id TEXT,
            FOREIGN KEY(node_id) REFERENCES nodes(id),
            FOREIGN KEY(session_id) REFERENCES sessions(id),
            FOREIGN KEY(message_id) REFERENCES messages(id)
        )
    `).run();

    console.log(`Reading ${sessionsFile}...`);
    const sessionsData = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));

    const insertSession = db.prepare('INSERT OR REPLACE INTO sessions (id, name, timestamp) VALUES (?, ?, ?)');
    const insertMessage = db.prepare('INSERT OR REPLACE INTO messages (id, session_id, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)');
    const insertMapping = db.prepare('INSERT OR REPLACE INTO entity_mappings (id, node_id, session_id, message_id) VALUES (?, ?, ?, ?)');

    const transaction = db.transaction(() => {
        let sessionCount = 0;
        let messageCount = 0;

        for (const sess of sessionsData) {
            // Validate timestamp
            let isoTime;
            try {
                isoTime = new Date(sess.timestamp).toISOString();
            } catch (e) {
                isoTime = new Date().toISOString();
            }

            insertSession.run(sess.id, sess.name || 'Untitled Session', isoTime);
            sessionCount++;

            if (sess.messages) {
                for (let i = 0; i < sess.messages.length; i++) {
                    const m = sess.messages[i];
                    const msgId = `${sess.id}-msg-${i}`;
                    
                    let msgIsoTime;
                    try {
                        msgIsoTime = new Date(m.timestamp).toISOString();
                    } catch (e) {
                        msgIsoTime = isoTime;
                    }

                    insertMessage.run(msgId, sess.id, m.role || 'unknown', m.content || '', msgIsoTime);
                    messageCount++;
                }
            }
        }
        console.log(`Imported ${sessionCount} sessions and ${messageCount} messages.`);

        console.log("Mapping nodes to sessions...");
        const nodes = db.prepare('SELECT id FROM nodes').all();
        let mapCount = 0;
        for (const node of nodes) {
            // Find matches like "sess-1777549658061"
            const match = node.id.match(/^(sess-\d+)/);
            if (match) {
                const sessionId = match[1];
                const mappingId = `map_${node.id}_${sessionId}`;
                insertMapping.run(mappingId, node.id, sessionId, null);
                mapCount++;
            }
        }
        console.log(`Created ${mapCount} mappings between nodes and sessions.`);
    });

    transaction();
    console.log("Database migration complete.");
}

main();
