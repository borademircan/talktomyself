import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = true;

const dbPath = path.join(process.cwd(), 'src/data-new/talk_to_myself.db');
const db = new Database(dbPath);

const getNodes = db.prepare('SELECT id, text FROM nodes');
const updateNode = db.prepare('UPDATE nodes SET text = ? WHERE id = ?');

function stripUnicode(text) {
    if (!text) return text;
    return text.replace(/[^\x00-\x7F]/g, "").trim();
}

async function run() {
    console.log('Loading local Translation Model (Xenova/opus-mt-tr-en)...');
    // Using xenova local model for translating Turkish to English natively
    const translator = await pipeline('translation', 'Xenova/opus-mt-tr-en');
    
    const nodes = getNodes.all();
    const turkishRegex = /[şŞıİğĞçÇöÖüÜ]/; 
    
    const needsTranslation = [];
    const justStrip = [];
    
    for (const node of nodes) {
        if (turkishRegex.test(node.text)) {
            needsTranslation.push(node);
        } else {
            justStrip.push(node);
        }
    }

    if (justStrip.length > 0) {
        db.transaction(() => {
            for (const node of justStrip) {
                const cleanText = stripUnicode(node.text);
                if (cleanText !== node.text) {
                    updateNode.run(cleanText, node.id);
                }
            }
        })();
        console.log(`Stripped ${justStrip.length} non-Turkish nodes.`);
    }

    const BATCH_SIZE = 50;
    let processedTranslation = 0;

    for (let i = 0; i < needsTranslation.length; i += BATCH_SIZE) {
        const batch = needsTranslation.slice(i, i + BATCH_SIZE);
        const textsToTranslate = batch.map(n => n.text);
        
        try {
            const results = await translator(textsToTranslate);
            db.transaction(() => {
                for (let j = 0; j < batch.length; j++) {
                    const translatedText = results[j].translation_text;
                    const cleanText = stripUnicode(translatedText);
                    updateNode.run(cleanText, batch[j].id);
                }
            })();
            processedTranslation += batch.length;
            console.log(`Translated & Stripped ${processedTranslation} / ${needsTranslation.length} nodes...`);
        } catch (err) {
            console.error('Batch translation failed', err);
        }
    }

    console.log('Database local translation and sanitization complete.');
}

run().catch(console.error);
