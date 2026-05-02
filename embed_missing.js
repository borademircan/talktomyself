import fs from 'fs';
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;

async function run() {
  const kg = JSON.parse(fs.readFileSync('src/data/kg.json', 'utf8'));
  let vdb = [];
  try {
    vdb = JSON.parse(fs.readFileSync('src/data/vdb_knowledge.json', 'utf8'));
  } catch (e) {}

  const vdbIds = new Set(vdb.map(d => d.id));
  const missing = kg.nodes.filter(n => !vdbIds.has(n.id));

  console.log(`Found ${missing.length} missing nodes to embed.`);
  if (missing.length === 0) return;

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  for (let i = 0; i < missing.length; i++) {
    const node = missing[i];
    const text = `${node.label}. ${node.metadata?.description || ''} ${node.metadata?.tags ? node.metadata.tags.join(' ') : ''}`.trim();
    
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    
    vdb.push({
      id: node.id,
      text: text,
      embedding: Array.from(output.data),
      metadata: { type: node.type, label: node.label, timestamp: node.metadata?.timestamp, domain: 'knowledge' }
    });

    if (i % 100 === 0) console.log(`Embedded ${i}/${missing.length}...`);
  }

  fs.writeFileSync('src/data/vdb_knowledge.json', JSON.stringify(vdb, null, 2));
  console.log('Done! Saved vdb_knowledge.json');
}

run().catch(console.error);
