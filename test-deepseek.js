const key = "sk-3bUEv4ADn77iVYzbCh7yKMeJUKSyv06CGVoMNh9SxCKHALME";
fetch('https://api.deepseek.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{role: 'user', content: 'hello'}]
  })
}).then(r => r.json()).then(d => console.log(d)).catch(e => console.error(e));
