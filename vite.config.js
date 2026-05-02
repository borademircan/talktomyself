import { defineConfig, loadEnv } from 'vite';
import fs from 'fs';
import path from 'path';

function localPersistencePlugin() {
  return {
    name: 'local-persistence',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const apiPath = req.url.replace(/^\/talktomyself/, '');
        // We use dynamic import so it doesn't break Vite's optimization scanner
        const { default: db } = await import('./server/db.js');

        if (apiPath === '/api/save' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              
              if (data.kg) {
                const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, text, category_id, type, timestamp) VALUES (?, ?, ?, ?, ?)');
                const insertEdge = db.prepare('INSERT OR REPLACE INTO edges (id, source_id, target_id, type, weight) VALUES (?, ?, ?, ?, ?)');
                const getOrInsertCategory = db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)');
                const getCategoryByName = db.prepare('SELECT id FROM categories WHERE name = ?');
                
                const transaction = db.transaction(() => {
                  for (const n of data.kg.nodes) {
                    let catName = n.metadata?.category || n.metadata?.domain || 'general';
                    let catRow = getCategoryByName.get(catName);
                    let catId = catRow ? catRow.id : `cat_${Math.random().toString(36).substr(2, 9)}`;
                    
                    if (!catRow) {
                      getOrInsertCategory.run(catId, catName, 'Auto-created category');
                    }
                    
                    const text = n.text || n.metadata?.description || n.label || '';
                    insertNode.run(n.id, text, catId, n.type || 'concept', n.metadata?.timestamp || new Date().toISOString());
                  }

                  for (const e of data.kg.edges) {
                    insertEdge.run(e.id, e.source, e.target, e.type, e.weight || 1.0);
                  }
                });
                transaction();
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (apiPath === '/api/load' && req.method === 'GET') {
          try {
            const rawNodes = db.prepare(`
              SELECT n.*, c.name as category_name 
              FROM nodes n 
              LEFT JOIN categories c ON n.category_id = c.id
            `).all();
            const rawEdges = db.prepare('SELECT * FROM edges').all();

            // Format nodes back for frontend compatibility
            const nodes = rawNodes.map(n => ({
              id: n.id,
              type: n.type,
              label: n.text.split('.')[0].substring(0, 50) + (n.text.length > 50 ? '...' : ''), // Derive label from text
              text: n.text, // pass down raw text
              metadata: {
                description: n.text,
                category: n.category_name,
                domain: n.category_name, // fallback for legacy code
                timestamp: n.timestamp
              }
            }));

            // Format edges
            const edges = rawEdges.map(e => ({
              id: e.id,
              source: e.source_id,
              target: e.target_id,
              type: e.type,
              weight: e.weight
            }));

            const data = {
              kg: { nodes, edges }
            };

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data));
          } catch (e) {
            console.error('Error in /api/load:', e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        if (apiPath === '/api/categories' && req.method === 'GET') {
          try {
            const categories = db.prepare('SELECT name, description FROM categories').all();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(categories));
          } catch (e) {
            console.error('Error in /api/categories:', e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        // Save sessions to SQLite database
        if (apiPath === '/api/save_sessions' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const sessions = JSON.parse(body);
              const insertSession = db.prepare(`INSERT OR REPLACE INTO sessions (id, name, timestamp, lastProcessedIndex) VALUES (?, ?, ?, ?)`);
              const insertMessage = db.prepare(`INSERT OR REPLACE INTO messages (id, session_id, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)`);
              
              db.transaction(() => {
                for (const session of sessions) {
                  insertSession.run(session.id, session.name, session.timestamp, session.lastProcessedIndex || -1);
                  if (session.messages) {
                    for (const msg of session.messages) {
                      // Some legacy messages might lack an id during migration, but sessionManager ensures it.
                      const msgId = msg.id || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                      insertMessage.run(msgId, session.id, msg.role, msg.content, msg.timestamp);
                    }
                  }
                }
              })();
              
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (apiPath === '/api/delete_session' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.sessionId) {
                db.transaction(() => {
                  db.prepare('DELETE FROM entity_mappings WHERE session_id = ?').run(data.sessionId);
                  db.prepare('DELETE FROM messages WHERE session_id = ?').run(data.sessionId);
                  db.prepare('DELETE FROM sessions WHERE id = ?').run(data.sessionId);
                })();
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (apiPath === '/api/load_sessions' && req.method === 'GET') {
          try {
            // First, migrate from legacy JSON if it exists and DB is empty
            const filePath = path.join(process.cwd(), 'src/data-new/sessions.json');
            const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
            if (row.count === 0 && fs.existsSync(filePath)) {
               const legacyData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
               const insertSession = db.prepare(`INSERT OR REPLACE INTO sessions (id, name, timestamp, lastProcessedIndex) VALUES (?, ?, ?, ?)`);
               const insertMessage = db.prepare(`INSERT OR REPLACE INTO messages (id, session_id, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)`);
               db.transaction(() => {
                 for (const session of legacyData) {
                    insertSession.run(session.id, session.name, session.timestamp, session.lastProcessedIndex || -1);
                    if (session.messages) {
                      for (const msg of session.messages) {
                         const msgId = msg.id || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                         insertMessage.run(msgId, session.id, msg.role, msg.content, msg.timestamp);
                      }
                    }
                 }
               })();
               // Optionally rename sessions.json so it doesn't get imported again
               fs.renameSync(filePath, path.join(process.cwd(), 'src/data-new/sessions.json.bak'));
            }

            const sessions = db.prepare('SELECT * FROM sessions ORDER BY timestamp DESC').all();
            const getMessages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC');
            
            const data = sessions.map(session => {
              const messages = getMessages.all(session.id).map(m => ({
                id: m.id,
                role: m.sender,
                content: m.content,
                timestamp: m.timestamp
              }));
              return {
                 id: session.id,
                 name: session.name,
                 timestamp: session.timestamp,
                 lastProcessedIndex: session.lastProcessedIndex,
                 messages
              };
            });

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        if (apiPath === '/api/map_entity' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              const { nodeId, sessionId, messageIds } = data;
              if (!nodeId || !sessionId || !messageIds || !Array.isArray(messageIds)) {
                throw new Error("Invalid payload for map_entity");
              }
              const insertMap = db.prepare(`INSERT OR REPLACE INTO entity_mappings (id, node_id, session_id, message_id) VALUES (?, ?, ?, ?)`);
              const insertStub = db.prepare(`INSERT OR IGNORE INTO nodes (id, text) VALUES (?, '')`);
              
              db.transaction(() => {
                insertStub.run(nodeId);
                for (const msgId of messageIds) {
                  const mapId = `map-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                  insertMap.run(mapId, nodeId, sessionId, msgId);
                }
              })();
              
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              console.error("[api/map_entity] Error:", e);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (apiPath === '/api/save_persona' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.persona) {
                fs.writeFileSync(path.join(process.cwd(), 'public/persona.md'), data.persona);
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (apiPath === '/api/search' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const { queryText, topK = 5, timeFilter, daysAgo, domains } = JSON.parse(body);
              const envVars = loadEnv('', process.cwd());
              const apiKey = envVars.VITE_OPENAI_API_KEY;
              
              if (!apiKey) throw new Error('VITE_OPENAI_API_KEY not found');

              const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({ input: queryText, model: 'text-embedding-3-small' })
              });

              if (!response.ok) throw new Error(`OpenAI API error ${response.status}`);
              const json = await response.json();
              const qvec = json.data[0].embedding;


              function cosineSim(a, b) {
                let dot = 0, na = 0, nb = 0;
                for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
                return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
              }

              // Fetch all embeddings
              const rows = db.prepare('SELECT ne.node_id, ne.embedding, n.text, n.category_id, n.timestamp FROM node_embeddings ne JOIN nodes n ON ne.node_id = n.id').all();
              
              const scored = [];
              for (const row of rows) {
                if (row.embedding) {
                  if (timeFilter && timeFilter.start && timeFilter.end && row.timestamp) {
                    const ts = new Date(row.timestamp).getTime();
                    const start = new Date(timeFilter.start).getTime();
                    const end = new Date(timeFilter.end).getTime();
                    if (ts < start || ts > end) continue;
                  }
                  if (daysAgo !== undefined && row.timestamp) {
                    const ts = new Date(row.timestamp).getTime();
                    const cutoff = Date.now() - (daysAgo * 24 * 60 * 60 * 1000);
                    if (ts < cutoff) continue;
                  }
                  // Parse the raw Buffer into a Float32Array
                  const docVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
                  const score = cosineSim(qvec, docVec);
                  if (score > 0.3) {
                    scored.push({ id: row.node_id, text: row.text, score: Math.round(score * 1000) / 1000, domain: row.category_id, timestamp: row.timestamp });
                  }
                }
              }

              scored.sort((a, b) => b.score - a.score);
              let finalResults = scored.slice(0, topK * 2);

              // Context Augmentation with original messages
              for (let res of finalResults) {
                const mapRows = db.prepare('SELECT message_id, session_id FROM entity_mappings WHERE node_id = ? LIMIT 5').all(res.id);
                if (mapRows.length > 0) {
                  const messages = [];
                  for (let mapRow of mapRows) {
                    if (mapRow.message_id) {
                      const msg = db.prepare('SELECT sender, content FROM messages WHERE id = ?').get(mapRow.message_id);
                      if (msg) messages.push(`${msg.sender}: ${msg.content}`);
                    }
                  }
                  if (messages.length > 0) {
                    res.text = res.text + '\\n[Raw Chat Extract]:\\n' + messages.join('\\n');
                  }
                }
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ results: finalResults }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (apiPath === '/api/embed_node' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const { id, text, type, category } = JSON.parse(body);
              
              // Check if exists
              const existing = db.prepare('SELECT node_id FROM node_embeddings WHERE node_id = ?').get(id);
              if (existing) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, message: 'Already exists' }));
                return;
              }

              const envVars = loadEnv('', process.cwd());
              const apiKey = envVars.VITE_OPENAI_API_KEY;
              if (!apiKey) throw new Error('VITE_OPENAI_API_KEY not found');

              const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({ input: text, model: 'text-embedding-3-small' })
              });

              if (!response.ok) throw new Error(`OpenAI API error ${response.status}`);
              const json = await response.json();
              const embedding = json.data[0].embedding;

              const insertStub = db.prepare('INSERT OR IGNORE INTO nodes (id, text, type) VALUES (?, ?, ?)');
              insertStub.run(id, text, type || 'concept');

              const insertStmt = db.prepare(`
                  INSERT INTO node_embeddings (node_id, embedding)
                  VALUES (?, ?)
              `);
              const buffer = new Float32Array(embedding).buffer;
              insertStmt.run(id, Buffer.from(buffer));

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        next();
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: '/talktomyself/',
    root: '.',
    publicDir: 'public',
    plugins: [localPersistencePlugin()],
    server: {
      port: 3000,
      open: 'https://www.selinmodel.com/talktomyself/',
      allowedHosts: ['www.selinmodel.com', 'selinmodel.com'],
      watch: {
        ignored: ['**/src/data-new/*.json', '**/src/data/*.json']
      },
      proxy: {
        '/api/openai': {
          target: 'https://api.openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/openai/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
               proxyReq.removeHeader('referer');
            });
          }
        },
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
            });
          }
        },
        '/api/google-tts': {
          target: 'https://texttospeech.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/google-tts/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
               proxyReq.removeHeader('referer');
               const googleKey = env.VITE_GOOGLE_API_KEY || env.VITE_GEMINI_API_KEY;
               if (googleKey) {
                 proxyReq.setHeader('X-Goog-Api-Key', googleKey.trim());
               }
            });
          }
        },
        '/api/elevenlabs': {
          target: 'https://api.elevenlabs.io',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/elevenlabs/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
               proxyReq.removeHeader('referer');
               // Securely inject the API key from the local environment if available
               if (env.VITE_ELEVENLABS_API_KEY) {
                 proxyReq.setHeader('xi-api-key', env.VITE_ELEVENLABS_API_KEY.trim());
               }
               console.log(`[Vite Proxy] Forwarding to ElevenLabs: ${proxyReq.path}`);
               console.log(`[Vite Proxy] xi-api-key header present:`, !!proxyReq.getHeader('xi-api-key'));
            });
          }
        }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: true
    }
  };
});
