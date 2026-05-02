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
    const messages = db.prepare("SELECT id, sender, content FROM messages WHERE session_id LIKE 'sess-wa-%'").all();
    console.log(`Found ${messages.length} WhatsApp messages to check.`);

    const updateMessage = db.prepare('UPDATE messages SET sender = ?, content = ? WHERE id = ?');

    let updatedCount = 0;

    const transaction = db.transaction(() => {
        for (const msg of messages) {
            // Reconstruct the original line
            let originalLine = msg.content;
            if (msg.sender !== 'unknown') {
                originalLine = msg.sender + ':' + msg.content;
            }

            let newSender = 'unknown';
            let newContent = originalLine;
            
            // Clean LRM characters WhatsApp adds
            const cleanLine = originalLine.replace(/\u200E/g, '');
            
            // Format 1: [DD.MM.YYYY, HH:MM:SS] Sender: Message
            // Format 2: [DD.MM.YYYY, HH:MM] Sender: Message
            const bracketMatch = cleanLine.match(/^\[\d{1,2}\.\d{1,2}\.\d{2,4}[, ]+\d{1,2}:\d{2}(?::\d{2})?\]\s*(.+?):\s*(.+)$/);
            
            if (bracketMatch) {
                newSender = bracketMatch[1];
                newContent = bracketMatch[2];
            } else {
                // Format 3: Sender: Message (no brackets)
                const colonIndex = cleanLine.indexOf(':');
                if (colonIndex !== -1 && colonIndex < 30) {
                    const possibleSender = cleanLine.substring(0, colonIndex).trim();
                    if (!possibleSender.includes('http') && !possibleSender.startsWith('•')) {
                        newSender = possibleSender;
                        newContent = cleanLine.substring(colonIndex + 1).trim();
                    }
                }
            }

            if (newSender !== msg.sender || newContent !== msg.content) {
                updateMessage.run(newSender, newContent, msg.id);
                updatedCount++;
            }
        }
    });

    transaction();
    console.log(`Fixed sender parsing for ${updatedCount} messages.`);
}

main();
