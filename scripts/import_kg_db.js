import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const dbPath = path.join(projectRoot, 'src/data-new/talk_to_myself.db');
const kgFile = path.join(projectRoot, 'src/data/kg.json');

const db = new Database(dbPath, { verbose: null });

function assignCategory(text) {
    const t = text.toLowerCase();
    if (t.includes('trans') || t.includes('identity') || t.includes('self')) return 'identity';
    if (t.includes('ceren')) return 'ceren';
    if (t.includes('work') || t.includes('project') || t.includes('code')) return 'work';
    if (t.includes('business') || t.includes('meeting') || t.includes('client')) return 'business';
    if (t.includes('music') || t.includes('fashion') || t.includes('like') || t.includes('love')) return 'preferences';
    if (t.includes('feel') || t.includes('anxiety') || t.includes('mind') || t.includes('confident')) return 'mindset';
    if (t.includes('friend') || t.includes('talked')) return 'relationships';
    return 'general';
}

const CATEGORIES = ["identity", "preferences", "relationships", "ceren", "work", "business", "errands", "mindset", "general"];
const getOrInsertCategory = db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)');
CATEGORIES.forEach(cat => {
    getOrInsertCategory.run(`cat_${cat}`, cat, `System category: ${cat}`);
});

const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');

function main() {
    console.log(`Reading ${kgFile}...`);
    const kgData = JSON.parse(fs.readFileSync(kgFile, 'utf-8'));
    
    if (!kgData.nodes) {
        console.log("No nodes found in kg.json.");
        return;
    }

    console.log(`Found ${kgData.nodes.length} nodes to import.`);
    
    const transaction = db.transaction(() => {
        let imported = 0;
        for (const node of kgData.nodes) {
            const text = node.metadata?.description || node.label || node.text || '';
            if (!text) continue;

            const categoryName = assignCategory(text);
            const categoryId = `cat_${categoryName}`;
            
            const timestamp = node.metadata?.timestamp || node.timestamp || new Date().toISOString();
            const type = node.type || 'concept';
            
            insertNode.run(node.id, text, categoryId, type, timestamp);
            imported++;
        }
        console.log(`Successfully imported ${imported} nodes.`);
    });
    
    transaction();
}

main();
