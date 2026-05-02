const key = "sk-3bUEv4ADn77iVYzbCh7yKMeJUKSyv06CGVoMNh9SxCKHALME";
fetch('https://api.openai.com/v1/models', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json'
  }
}).then(r => r.json()).then(d => console.log(d)).catch(e => console.error(e));
