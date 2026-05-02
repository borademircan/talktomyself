import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env file directly
const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
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

const inputFile = path.join(__dirname, 'raw-data/whatsapp/ceren.json');
const outputFile = path.join(__dirname, 'raw-data/whatsapp/ceren-en.json');

async function translateBatch(batchTexts) {
    // We send an array of objects to ensure the LLM returns the exact same number of translations with IDs.
    const promptData = batchTexts.map((text, i) => ({ id: i, text }));
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            response_format: { type: "json_object" },
            messages: [
                {
                    role: 'system',
                    content: 'You are a translation API. You will receive a JSON array of objects with "id" and "text" (in Turkish). You must translate the "text" to English. Return a JSON object with a single key "translations", which is an array of objects with "id" and "translation". Maintain the exact same IDs. Do not translate URLs, keep them as is.'
                },
                {
                    role: 'user',
                    content: JSON.stringify(promptData)
                }
            ],
            temperature: 0.1
        })
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} - ${await response.text()}`);
    }

    const json = await response.json();
    let content = json.choices[0].message.content.trim();
    const parsed = JSON.parse(content);
    
    // Reconstruct the array in original order
    const translations = [];
    for (let i = 0; i < batchTexts.length; i++) {
        const item = parsed.translations.find(t => t.id === i);
        translations.push(item ? item.translation : batchTexts[i]);
    }
    
    return translations;
}

async function main() {
    console.log("Loading dataset...");
    const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
    
    let translated = [];
    if (fs.existsSync(outputFile)) {
        try {
            translated = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
            console.log(`Found existing output file with ${translated.length} messages.`);
        } catch (e) {
            console.log("Existing output file is invalid, starting fresh.");
        }
    }

    const startIndex = translated.length;
    if (startIndex >= data.length) {
        console.log("Translation already completed!");
        return;
    }

    console.log(`Starting translation via OpenAI API from index ${startIndex}/${data.length}...`);

    const batchSize = 25; // Smaller batch size to avoid timeouts
    
    for (let i = startIndex; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        const textsToTranslate = batch.map(m => m.message);
        
        try {
            console.log(`Translating items ${i} to ${i + batch.length - 1}...`);
            const results = await translateBatch(textsToTranslate);
            
            if (results.length !== batch.length) {
                throw new Error(`Length mismatch: got ${results.length}, expected ${batch.length}`);
            }

            for (let j = 0; j < batch.length; j++) {
                translated.push({
                    timestamp: batch[j].timestamp,
                    from: batch[j].from,
                    original: batch[j].message,
                    message: results[j]
                });
            }
            
            // Save progress every batch
            fs.writeFileSync(outputFile, JSON.stringify(translated, null, 2), 'utf-8');
            console.log(`Progress: ${translated.length} / ${data.length} (${((translated.length / data.length) * 100).toFixed(2)}%)`);
        } catch (error) {
            console.error(`Error at batch ${i}:`, error.message);
            // Wait 2 seconds and retry once
            await new Promise(r => setTimeout(r, 2000));
            i -= batchSize; // Retry same batch
        }
    }
    
    console.log("Translation completely finished!");
}

main().catch(console.error);
