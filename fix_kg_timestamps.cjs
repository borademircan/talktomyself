const fs = require('fs');

const filePaths = ['src/data/kg.json'];

filePaths.forEach(filePath => {
  if (!fs.existsSync(filePath)) return;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let updated = 0;

  data.nodes.forEach(node => {
    if (node.metadata && node.metadata.timestamp) return;
    
    // Fallback logic
    let ts = null;
    const match = node.id.match(/(\d{13})/);
    if (match) {
      ts = parseInt(match[1]);
    } else {
      // For concept-photoshoot or other generic concepts, we might just give it a static old date, or leave it blank.
      // Let's check if there is a session ID we can extract.
      if (node.metadata && node.metadata.sessionId) {
        const sMatch = node.metadata.sessionId.match(/(\d{13})/);
        if (sMatch) ts = parseInt(sMatch[1]);
      }
    }

    if (ts) {
      node.metadata = node.metadata || {};
      node.metadata.timestamp = new Date(ts).toISOString();
      updated++;
    }
  });

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Updated ${updated} nodes in ${filePath}`);
});
