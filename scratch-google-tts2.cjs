const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '.env');
const env = fs.readFileSync(envPath, 'utf8');
const googleKeyMatch = env.match(/VITE_GOOGLE_API_KEY=(.+)/);
const googleKey = googleKeyMatch[1].trim();

async function test() {
  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': googleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { text: 'test' },
      voice: { languageCode: 'en-US', name: 'en-US-Journey-F' },
      audioConfig: { audioEncoding: 'MP3' }
    })
  });
  console.log(res.status);
  const text = await res.text();
  console.log(text);
}
test();
