import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputFile = path.join(__dirname, 'raw-data/whatsapp/ceren.json');
const outputDir = path.join(__dirname, 'raw-data/whatsapp');

// Parse timestamp: "23.04.2024, 23:33:47" -> Date object
function parseDate(dateStr) {
    const parts = dateStr.split(', ');
    const [day, month, year] = parts[0].split('.');
    const [hours, minutes, seconds] = parts[1].split(':');
    return new Date(year, month - 1, day, hours, minutes, seconds);
}

function main() {
    console.log("Loading dataset...");
    const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
    
    const groups = {};

    for (const msg of data) {
        if (!msg.timestamp) continue;
        
        const dateObj = parseDate(msg.timestamp);
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const year = dateObj.getFullYear();
        
        // Calculate week of month (1-5) based on day of month
        // Days 1-7 = w1, 8-14 = w2, 15-21 = w3, 22-28 = w4, 29+ = w5
        const weekOfMonth = Math.ceil(dateObj.getDate() / 7);
        
        const groupKey = `ceren-${year}-${month}-w${weekOfMonth}`;
        
        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(msg);
    }

    const gapThresholdMs = 2 * 60 * 60 * 1000; // 2 hours

    // Save each group
    let count = 0;
    for (const [key, messages] of Object.entries(groups)) {
        // Sort messages by timestamp just in case
        messages.sort((a, b) => parseDate(a.timestamp).getTime() - parseDate(b.timestamp).getTime());

        const conversations = [];
        let currentConversation = [];
        let lastTime = null;

        for (const msg of messages) {
            const time = parseDate(msg.timestamp).getTime();
            if (lastTime !== null && (time - lastTime) > gapThresholdMs) {
                conversations.push(currentConversation);
                currentConversation = [];
            }
            currentConversation.push(msg);
            lastTime = time;
        }
        if (currentConversation.length > 0) {
            conversations.push(currentConversation);
        }

        const structuredConversations = conversations.map((conv, index) => ({
            id: `${key}-c${index + 1}`,
            start_time: conv[0].timestamp,
            end_time: conv[conv.length - 1].timestamp,
            message_count: conv.length,
            messages: conv
        }));

        const filename = path.join(outputDir, `${key}.json`);
        fs.writeFileSync(filename, JSON.stringify(structuredConversations, null, 2), 'utf-8');
        count++;
    }
    
    console.log(`Successfully grouped ${data.length} messages into ${count} weekly files.`);
}

main();
