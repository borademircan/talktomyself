const key = "sk-3bUEv4ADn77iVYzbCh7yKMeJUKSyv06CGVoMNh9SxCKHALME";
fetch('https://api.moonshot.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'kimi-k2.6',
    messages: [{role: 'user', content: 'hello'}]
  })
}).then(async r => console.log(r.status, await r.text())).catch(e => console.error(e));
