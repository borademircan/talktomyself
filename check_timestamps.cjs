const fs = require('fs');
const kg = JSON.parse(fs.readFileSync('src/data/kg.json', 'utf8'));
let countMatched = 0;
let countUnmatched = 0;
let countAlreadyHas = 0;

kg.nodes.forEach(node => {
  if (node.metadata && node.metadata.timestamp) {
    countAlreadyHas++;
    return;
  }
  const match = node.id.match(/(\d{13})/);
  if (match) {
    countMatched++;
  } else {
    countUnmatched++;
    console.log("Unmatched ID:", node.id);
  }
});

console.log(`Matched: ${countMatched}, Unmatched: ${countUnmatched}, Already has: ${countAlreadyHas}`);
