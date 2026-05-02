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

function main() {
    console.log(`Reading ${vdbKnowledgeFile}...`);
    let rawData;
    try {
        rawData = fs.readFileSync(vdbKnowledgeFile, 'utf-8');
    } catch (e) {
        console.error("Failed to read vdb_knowledge.json", e.message);
        return;
    }

    const allItems = JSON.parse(rawData);
    const whatsappItems = allItems.filter(item => item.text && item.text.startsWith('WhatsApp Conversation'));
    console.log(`Found ${whatsappItems.length} WhatsApp Conversation items.`);

    const insertSession = db.prepare('INSERT OR IGNORE INTO sessions (id, name, timestamp) VALUES (?, ?, ?)');
    const insertMessage = db.prepare('INSERT OR REPLACE INTO messages (id, session_id, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)');

    const validSenders = ['Ceren', 'Selin', 'Bora', 'Petek Ceren Çiçeğim ❤️❤️❤️'];

    let sessionsCreated = 0;
    let messagesCreated = 0;

    const transaction = db.transaction(() => {
        for (const item of whatsappItems) {
            let sessionId = item.id;
            const match = item.id.match(/^(sess-wa-\d+)/);
            if (match) {
                sessionId = match[1];
            }

            const lines = item.text.split('\n');
            let sessionName = "WhatsApp Conversation";
            let startIndex = 0;
            
            if (lines.length > 0 && lines[0].startsWith("WhatsApp Conversation")) {
                const firstDot = lines[0].indexOf('.');
                if (firstDot !== -1) {
                    sessionName = lines[0].substring(0, firstDot).trim();
                    lines[0] = lines[0].substring(firstDot + 1).trim();
                }
                if (!lines[0]) startIndex = 1;
            }

            // Insert session
            const res = insertSession.run(sessionId, sessionName, item.metadata?.timestamp || new Date().toISOString());
            if (res.changes > 0) {
                sessionsCreated++;
            }

            let msgIndex = 0;
            let currentSender = null;
            let currentContent = [];

            const flushMessage = () => {
                if (currentSender && currentContent.length > 0) {
                    let mappedSender = currentSender;
                    if (mappedSender === 'Bora') mappedSender = 'Selin';
                    if (mappedSender === 'Petek Ceren Çiçeğim ❤️❤️❤️') mappedSender = 'Ceren';

                    const msgId = `${item.id}-msg-${msgIndex}`;
                    insertMessage.run(msgId, sessionId, mappedSender, currentContent.join('\n').trim(), item.metadata?.timestamp || new Date().toISOString());
                    msgIndex++;
                    messagesCreated++;
                }
                currentSender = null;
                currentContent = [];
            };

            for (let i = startIndex; i < lines.length; i++) {
                let line = lines[i].trimEnd();
                if (!line) continue;
                if (line === "memory conversation whatsapp") continue;

                let parsedSender = null;
                let parsedContent = line;

                const cleanLine = line.replace(/\u200E/g, '');
                
                // Try Format 1
                const bracketMatch = cleanLine.match(/^\[\d{1,2}\.\d{1,2}\.\d{2,4}[, ]+\d{1,2}:\d{2}(?::\d{2})?\]\s*(.+?):\s*(.*)$/);
                if (bracketMatch) {
                    if (validSenders.includes(bracketMatch[1].trim())) {
                        parsedSender = bracketMatch[1].trim();
                        parsedContent = bracketMatch[2];
                    }
                } else {
                    // Try Format 2
                    const colonIndex = cleanLine.indexOf(':');
                    if (colonIndex !== -1 && colonIndex < 40) {
                        const potentialSender = cleanLine.substring(0, colonIndex).trim();
                        if (validSenders.includes(potentialSender)) {
                            parsedSender = potentialSender;
                            parsedContent = cleanLine.substring(colonIndex + 1).trim();
                        }
                    }
                }

                if (parsedSender) {
                    flushMessage();
                    currentSender = parsedSender;
                    currentContent.push(parsedContent);
                } else {
                    // Multiline continuation
                    if (!currentSender) {
                        // If no sender yet, we can default to 'unknown' or maybe it's just garbage at the start
                        currentSender = 'unknown';
                    }
                    currentContent.push(line); // push original line to preserve formatting
                }
            }
            
            flushMessage();
        }
    });

    transaction();
    console.log(`Successfully migrated ${sessionsCreated} sessions and ${messagesCreated} messages.`);
}

main();
