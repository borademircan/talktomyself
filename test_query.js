
const apiKey = "sk-3bUEv4ADn77iVYzbCh7yKMeJUKSyv06CGVoMNh9SxCKHALME";
const query = "what do you remember from yesterday?";

async function run() {
  const now = new Date().toISOString();
  const systemPrompt = `You are a query analysis AI. The current date and time is ${now}.
Your task is to extract core entities, keywords, and concepts from the user's latest query and recent context to optimize a knowledge graph search.
Additionally, if the user mentions any temporal words (like "yesterday", "last week", "last month", "in 2025", etc.), extract the corresponding start and end timestamps.

Return ONLY a JSON object with this exact structure (no markdown formatting, no explanations):
{
  "keywords": "space-separated list of keywords",
  "timeFilter": {
    "start": "ISO 8601 start date or null",
    "end": "ISO 8601 end date or null"
  }
}
If no time context is found, set timeFilter to null.`;

  const payload = {
    model: 'moonshot-v1-8k',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query }
    ],
    temperature: 0.1,
    response_format: { type: "json_object" }
  };

  try {
    const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
        console.error("API Error:", res.status, await res.text());
        return;
    }

    const data = await res.json();
    console.log(data.choices[0].message.content);
  } catch (err) {
    console.error(err);
  }
}

run();
