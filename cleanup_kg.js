import fs from 'fs';

const data = JSON.parse(fs.readFileSync('src/data/kg.json', 'utf-8'));
const nodeIds = new Set(data.nodes.map(n => n.id));

const validEdges = data.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

console.log(`Original edges: ${data.edges.length}, Valid edges: ${validEdges.length}`);

data.edges = validEdges;
fs.writeFileSync('src/data/kg.json', JSON.stringify(data, null, 2));
