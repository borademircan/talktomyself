import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const rawDataDir = path.join(projectRoot, 'raw-data/whatsapp');

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

// Setup DB and clear nodes
console.log("Preparing database...");
db.prepare('DELETE FROM edges').run();
db.prepare('DELETE FROM nodes').run();
db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)').run('cat_ceren', 'ceren', 'System category: ceren');

const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');

async function summarizeConversation(conv) {
    const messagesText = conv.messages.map(m => `[${m.timestamp}] ${m.from}: ${m.message}`).join('\n');
    const prompt = `You are an AI tasked with analyzing a WhatsApp conversation between Bora and Ceren (in Turkish).
Your task is to create a DETAILED SUMMARY of this conversation in ENGLISH.
Do NOT miss any key points, context, or facts discussed. Capture the essence, decisions made, emotions shared, or events mentioned.

Return ONLY a valid JSON object in the exact format:
{
  "summary": "Your detailed English summary here"
}

Conversation:
${messagesText}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    response_format: { type: "json_object" },
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.2
                })
            });

            if (!response.ok) throw new Error(`API error: ${response.status}`);
            
            const json = await response.json();
            const content = JSON.parse(json.choices[0].message.content.trim());
            return content.summary;
        } catch (e) {
            retries--;
            if (retries === 0) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

async function main() {
    const files = fs.readdirSync(rawDataDir).filter(f => f.startsWith('ceren-') && f.endsWith('.json'));
    console.log(`Found ${files.length} weekly files.`);

    const allConversations = [];
    for (const file of files) {
        const content = JSON.parse(fs.readFileSync(path.join(rawDataDir, file), 'utf-8'));
        for (const conv of content) {
            // Only summarize conversations with at least 1 message
            if (conv.messages && conv.messages.length > 0) {
                allConversations.push(conv);
            }
        }
    }

    console.log(`Total conversations to summarize: ${allConversations.length}`);
    
    let completed = 0;
    const concurrency = 15; // Concurrent API calls

    // Helper for concurrency
    async function processQueue(queue) {
        while (queue.length > 0) {
            const conv = queue.shift();
            try {
                // If the conversation is huge, we still summarize it
                const summary = await summarizeConversation(conv);
                
                // Convert timestamp to ISO format for DB
                // original format: 22.05.2024, 00:12:03
                const parts = conv.start_time.split(', ');
                const [day, month, year] = parts[0].split('.');
                const [hours, minutes, seconds] = parts[1].split(':');
                const paddedDay = day.padStart(2, '0');
                const paddedMonth = month.padStart(2, '0');
                const isoTimestamp = new Date(`${year}-${paddedMonth}-${paddedDay}T${hours}:${minutes}:${seconds}Z`).toISOString();

                // Save to DB
                insertNode.run(conv.id, summary, 'cat_ceren', 'conversation', isoTimestamp);
                
                completed++;
                if (completed % 50 === 0) {
                    console.log(`Progress: ${completed} / ${allConversations.length} (${((completed/allConversations.length)*100).toFixed(1)}%)`);
                }
            } catch (err) {
                console.error(`Failed to summarize ${conv.id}: ${err.message}`);
            }
        }
    }

    const queue = [...allConversations];
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(processQueue(queue));
    }

    await Promise.all(workers);
    console.log("Database import and summarization complete!");
}

main().catch(console.error);
