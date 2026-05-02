const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '.env');
const env = fs.readFileSync(envPath, 'utf8');
const claudeKeyMatch = env.match(/VITE_CLAUDE_API_KEY=(.+)/);
const claudeKey = claudeKeyMatch[1].trim();

async function test() {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    }
  });
  console.log(res.status);
  const text = await res.text();
  console.log(text);
}
test();
