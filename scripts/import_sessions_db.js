import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const sessionsFile = path.join(projectRoot, 'src/data-new/sessions.json');

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

const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');

async function summarizeConversation(conv) {
    const messagesText = conv.messages.map(m => `[${new Date(m.timestamp).toISOString()}] ${m.role}: ${m.content}`).join('\n');
    const prompt = `You are an AI tasked with analyzing a conversation between a user and an AI.
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
    console.log(`Reading ${sessionsFile}...`);
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    console.log(`Found ${sessions.length} sessions.`);

    let completed = 0;
    const concurrency = 5; // Concurrent API calls

    async function processQueue(queue) {
        while (queue.length > 0) {
            const sess = queue.shift();
            try {
                if (!sess.messages || sess.messages.length === 0) continue;
                
                const summary = await summarizeConversation(sess);
                
                // Get timestamp of the first message
                const isoTimestamp = new Date(sess.messages[0].timestamp).toISOString();

                // Save to DB (using 'cat_ceren' or 'general' depending on context? We'll use 'general' or 'identity' maybe. Let's stick to a generic category, e.g., 'cat_general', unless we detect ceren. Let's use 'cat_general' but add it if missing)
                db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)').run('cat_general', 'general', 'General conversation category');
                
                insertNode.run(sess.id, summary, 'cat_general', 'conversation', isoTimestamp);
                
                completed++;
                console.log(`Summarized: ${sess.id} (${completed}/${sessions.length})`);
            } catch (err) {
                console.error(`Failed to summarize ${sess.id}: ${err.message}`);
            }
        }
    }

    const queue = [...sessions];
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(processQueue(queue));
    }

    await Promise.all(workers);
    console.log("Session import and summarization complete!");
}

main().catch(console.error);
