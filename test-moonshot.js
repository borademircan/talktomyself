const key = "sk-3bUEv4ADn77iVYzbCh7yKMeJUKSyv06CGVoMNh9SxCKHALME";
fetch('https://api.moonshot.cn/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'moonshot-v1-8k',
    messages: [{role: 'user', content: 'hello'}]
  })
}).then(r => r.json()).then(d => console.log(d)).catch(e => console.error(e));
