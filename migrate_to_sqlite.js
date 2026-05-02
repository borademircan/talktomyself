import fs from 'fs';
import path from 'path';
import db from './server/db.js';

const kgPath = path.join(process.cwd(), 'src/data/kg.json');
const kg = JSON.parse(fs.readFileSync(kgPath, 'utf8'));

console.log(`Starting migration of ${kg.nodes.length} nodes and ${kg.edges.length} edges...`);

const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)');
const insertNode = db.prepare('INSERT OR IGNORE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');
const insertEdge = db.prepare('INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight) VALUES (?, ?, ?, ?, ?)');

const getCategoryId = db.prepare('SELECT id FROM categories WHERE name = ?');

const transaction = db.transaction(() => {
  // First pass: extract and insert all unique categories
  const categories = new Set();
  for (const node of kg.nodes) {
    let catName = 'general';
    if (node.metadata?.tags && node.metadata.tags.length > 0) {
      catName = node.metadata.tags[0]; // e.g., 'memory', 'identity'
    } else if (node.metadata?.domain) {
      catName = node.metadata.domain;
    }
    categories.add(catName);
  }

  let catIdCounter = 1;
  for (const catName of categories) {
    insertCategory.run(`cat_${catIdCounter++}`, catName, `Auto-migrated category: ${catName}`);
  }

  // Second pass: insert nodes
  for (const node of kg.nodes) {
    let catName = 'general';
    if (node.metadata?.tags && node.metadata.tags.length > 0) {
      catName = node.metadata.tags[0];
    } else if (node.metadata?.domain) {
      catName = node.metadata.domain;
    }
    
    const catRow = getCategoryId.get(catName);
    const catId = catRow ? catRow.id : null;
    
    const text = `${node.label}. ${node.metadata?.description || ''} ${node.metadata?.tags ? node.metadata.tags.join(' ') : ''}`.trim();

    insertNode.run(
      node.id,
      text,
      catId,
      node.type || 'concept',
      node.metadata?.timestamp || new Date().toISOString()
    );
  }

  // Third pass: insert edges
  let edgeIdCounter = 1;
  for (const edge of kg.edges) {
    const eId = edge.id || `e_${edgeIdCounter++}`;
    insertEdge.run(
      eId,
      edge.source,
      edge.target,
      edge.type || 'related_to',
      edge.weight || 1.0
    );
  }
});

try {
  transaction();
  console.log('Migration successful!');
} catch (err) {
  console.error('Migration failed:', err);
}
