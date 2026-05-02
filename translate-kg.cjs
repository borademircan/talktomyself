const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.VITE_OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Error: VITE_OPENAI_API_KEY is not defined in .env');
  process.exit(1);
}

const KG_PATH = path.join(__dirname, 'src/data/kg.json');
const BACKUP_PATH = path.join(__dirname, 'src/data/kg_backup.json');

// Regex to remove emojis and LRM (\u200E) and other weird characters
const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{23E9}-\u{23EC}\u{23F0}\u{23F3}\u{25FD}\u{25FE}\u{2B05}\u{2B06}\u{2B07}\u{2B1B}\u{2B1C}\u{2194}-\u{2199}\u{21A9}\u{21AA}\u{FE0F}]/gu;
const unicodeArtifactsRegex = /[\u200E\u200F\u202A-\u202E]/g;

function cleanText(text) {
  if (!text) return text;
  let cleaned = text.replace(unicodeArtifactsRegex, '');
  cleaned = cleaned.replace(emojiRegex, '');
  return cleaned.trim();
}

async function translateAndSummarize(text) {
  if (!text || text.trim().length === 0) return text;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: "You are an expert translator and summarizer. You will receive text (often Turkish WhatsApp logs). Your task is to: 1) Detect if the text is in Turkish. If it is, translate it to English. If it is already in English, leave it in English. 2) Summarize the text into a cohesive, context-rich narrative. If it's a raw WhatsApp log, convert it into a smooth narrative summary without losing any important context, dates, or details. Do NOT include any emojis. Output ONLY the resulting English text."
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.3
      })
    });

    if (!response.ok) {
      console.error(`API Error: ${response.statusText}`);
      return text;
    }

    const data = await response.json();
    let result = data.choices[0].message.content.trim();
    // Apply final clean pass just in case LLM added emojis
    return cleanText(result);
  } catch (err) {
    console.error(`Translation Error: ${err.message}`);
    return text;
  }
}

async function run() {
  console.log('Loading knowledge graph...');
  const kgData = JSON.parse(fs.readFileSync(KG_PATH, 'utf8'));
  console.log(`Loaded ${kgData.nodes.length} nodes and ${kgData.edges.length} edges.`);

  const CONCURRENCY = 15;
  let processedNodes = 0;

  // Process nodes in batches
  for (let i = 0; i < kgData.nodes.length; i += CONCURRENCY) {
    const batch = kgData.nodes.slice(i, i + CONCURRENCY);
    
    await Promise.all(batch.map(async (node, index) => {
      if (node.label) {
        node.label = cleanText(node.label);
      }
      
      if (node.metadata && node.metadata.description) {
        const cleanedDesc = cleanText(node.metadata.description);
        console.log(`Processing node ${i + index + 1}/${kgData.nodes.length}`);
        const updatedDesc = await translateAndSummarize(cleanedDesc);
        node.metadata.description = updatedDesc;
      }
    }));
    
    processedNodes += batch.length;
    
    // Save progress every 100 nodes
    if (processedNodes % 100 < CONCURRENCY) {
      fs.writeFileSync(KG_PATH, JSON.stringify(kgData, null, 2), 'utf8');
      console.log(`Saved progress at ${processedNodes} nodes.`);
    }
  }

  // Process edges
  let processedEdges = 0;
  for (let i = 0; i < kgData.edges.length; i += CONCURRENCY) {
    const batch = kgData.edges.slice(i, i + CONCURRENCY);
    
    await Promise.all(batch.map(async (edge, index) => {
      if (edge.metadata && edge.metadata.relationship) {
        edge.metadata.relationship = cleanText(edge.metadata.relationship);
      }
      if (edge.metadata && edge.metadata.description) {
        const cleanedDesc = cleanText(edge.metadata.description);
        console.log(`Processing edge ${i + index + 1}/${kgData.edges.length}`);
        const updatedDesc = await translateAndSummarize(cleanedDesc);
        edge.metadata.description = updatedDesc;
      }
    }));
  }

  // Final save
  fs.writeFileSync(KG_PATH, JSON.stringify(kgData, null, 2), 'utf8');
  console.log('Translation and cleaning complete! Final graph saved.');
}

run().catch(console.error);
