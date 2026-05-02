const fs = require('fs');

const vdb = JSON.parse(fs.readFileSync('src/data/vdb_knowledge.json', 'utf8'));

const nodes = vdb.map(doc => {
  // text is label. description tags
  // Example: "Introduction Interaction. Selim introduced himself by spelling his name... memory conversation"
  const label = doc.metadata.label;
  const textWithoutLabel = doc.text.substring(label.length).trim();
  // Remove starting dot if exists
  let descAndTags = textWithoutLabel.startsWith('.') ? textWithoutLabel.substring(1).trim() : textWithoutLabel;
  
  // Try to extract tags from the end
  let tags = [];
  if (descAndTags.endsWith('memory session')) {
    tags = ['memory', 'session'];
    descAndTags = descAndTags.substring(0, descAndTags.length - 'memory session'.length).trim();
  } else if (descAndTags.endsWith('memory conversation')) {
    tags = ['memory', 'conversation'];
    descAndTags = descAndTags.substring(0, descAndTags.length - 'memory conversation'.length).trim();
  } else if (descAndTags.endsWith('creative visuals')) {
    tags = ['creative', 'visuals'];
    descAndTags = descAndTags.substring(0, descAndTags.length - 'creative visuals'.length).trim();
  } else {
    tags = [];
  }
  
  return {
    id: doc.id,
    type: doc.metadata.type,
    label: label,
    metadata: {
      description: descAndTags,
      tags: tags,
      domain: doc.metadata.domain
    }
  };
});

// Recreate sequential follows edges
const edges = [];
let edgeId = 1;

// Sort nodes by ID timestamp (for conv-... and sess-... nodes)
const timeNodes = nodes.filter(n => n.id.startsWith('conv-'));
timeNodes.sort((a, b) => {
  const ta = parseInt(a.id.split('-')[1]);
  const tb = parseInt(b.id.split('-')[1]);
  return ta - tb;
});

for (let i = 0; i < timeNodes.length - 1; i++) {
  edges.push({
    id: `e${edgeId++}`,
    source: timeNodes[i].id,
    target: timeNodes[i+1].id,
    type: 'follows',
    weight: 1,
    metadata: {}
  });
}

// Add concept-photoshoot related_to edges
const photoshootNodes = nodes.filter(n => n.metadata.description.toLowerCase().includes('shoot') || n.metadata.description.toLowerCase().includes('dress') || n.metadata.description.toLowerCase().includes('club'));
const psNode = nodes.find(n => n.id === 'concept-photoshoot');
if (psNode) {
  for (const n of photoshootNodes) {
    if (n.id !== 'concept-photoshoot') {
      edges.push({
        id: `e${edgeId++}`,
        source: 'concept-photoshoot',
        target: n.id,
        type: 'related_to',
        weight: 0.8,
        metadata: {}
      });
    }
  }
}

const kg = {
  nodes: nodes,
  edges: edges
};

fs.writeFileSync('src/data/kg.json', JSON.stringify(kg, null, 2));
console.log('Restored kg.json with', nodes.length, 'nodes and', edges.length, 'edges');
