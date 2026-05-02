import fs from 'fs';
const kgData = JSON.parse(fs.readFileSync('src/data/kg.json', 'utf8'));

// Sort memory nodes by timestamp
const memoryNodes = kgData.nodes.filter(n => n.tags?.includes('memory') || n.id.includes('memory') || n.label.includes('Memory') || (n.metadata && n.metadata.tags && n.metadata.tags.includes('memory')));

memoryNodes.sort((a, b) => {
  const ta = new Date(a.metadata?.timestamp || 0).getTime();
  const tb = new Date(b.metadata?.timestamp || 0).getTime();
  return ta - tb;
});

const newEdges = [];
for (let i = 0; i < memoryNodes.length - 1; i++) {
  newEdges.push({
    id: `edge-temporal-${Date.now()}-${i}`,
    source: memoryNodes[i].id,
    target: memoryNodes[i+1].id,
    type: 'next_memory',
    weight: 1,
    metadata: { generated: true }
  });
}

kgData.edges = newEdges;

fs.writeFileSync('src/data/kg.json', JSON.stringify(kgData, null, 2));
console.log(`Healed KG: Added ${newEdges.length} temporal edges.`);
