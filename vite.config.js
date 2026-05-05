import { defineConfig, loadEnv } from 'vite';
import fs from 'fs';
import path from 'path';

function localPersistencePlugin(env) {
  let dbPromise;
  return {
    name: 'local-persistence',
    configureServer(server) {
      dbPromise = import('./server/db.js').then(m => m.default);
      server.middlewares.use((req, res, next) => {
        const apiPath = req.url.replace(/^\/talktomyself/, '');

        // --- AUTHENTICATION GUARD ---
        if (apiPath.startsWith('/api/')) {
          // Allow external API proxies to bypass internal auth (they use their own auth headers/keys)
          if (apiPath.startsWith('/api/openai') || 
              apiPath.startsWith('/api/anthropic') || 
              apiPath.startsWith('/api/google-tts') || 
              apiPath.startsWith('/api/elevenlabs')) {
             return next();
          }

          const authHeader = req.headers.authorization;
          const appAuthHeader = req.headers['x-app-auth'];
          const expectedAuth = env?.VITE_APP_AUTH || 'Basic YWRtaW46YWRtaW4=';
          const expectedPassword = env?.VITE_APP_PASSWORD || 'admin';

          if (apiPath === '/api/verify_login' && req.method === 'POST') {
             let body = '';
             req.on('data', chunk => { body += chunk.toString(); });
             req.on('end', () => {
               try {
                 const data = JSON.parse(body);
                 const clientAuth = data.token;
                 if (clientAuth === expectedAuth || clientAuth === expectedPassword || clientAuth === `selin:${expectedPassword}`) {
                   res.setHeader('Content-Type', 'application/json');
                   res.end(JSON.stringify({ success: true, token: expectedAuth }));
                 } else {
                   res.statusCode = 401;
                   res.end(JSON.stringify({ success: false, error: 'Invalid password' }));
                 }
               } catch(e) {
                 res.statusCode = 400;
                 res.end(JSON.stringify({ error: 'Bad request' }));
               }
             });
             return;
          }

          if (authHeader !== expectedAuth && appAuthHeader !== expectedAuth) {
             res.statusCode = 401;
             res.setHeader('Content-Type', 'application/json');
             res.end(JSON.stringify({ error: 'Unauthorized' }));
             return;
          }
        }

        if (apiPath === '/api/save' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const db = await dbPromise;
              const data = JSON.parse(body);
              
              if (data.kg) {
                const insertNode = db.prepare(`
                  INSERT INTO nodes (id, text, category_id, type, timestamp) 
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET 
                    text = excluded.text,
                    category_id = excluded.category_id,
                    type = excluded.type,
                    timestamp = excluded.timestamp
                `);
                const insertEdge = db.prepare(`
                  INSERT INTO edges (id, source_id, target_id, type, weight) 
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET 
                    source_id = excluded.source_id,
                    target_id = excluded.target_id,
                    type = excluded.type,
                    weight = excluded.weight
                `);
                const getOrInsertCategory = db.prepare('INSERT OR IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)');
                const getCategoryByName = db.prepare('SELECT id FROM categories WHERE name = ?');
                
                const transaction = db.transaction(() => {
                  for (const n of (data.kg?.nodes || [])) {
                    let catName = n.metadata?.category || n.metadata?.domain || 'general';
                    let catRow = getCategoryByName.get(catName);
                    let catId = catRow ? catRow.id : `cat_${Math.random().toString(36).substr(2, 9)}`;
                    
                    if (!catRow) {
                      getOrInsertCategory.run(catId, catName, 'Auto-created category');
                    }
                    
                    const text = n.text || n.metadata?.description || n.label || '';
                    insertNode.run(n.id, text, catId, n.type || 'concept', n.metadata?.timestamp || new Date().toISOString());
                  }

                  for (const e of (data.kg?.edges || [])) {
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
          (async () => {
            try {
              const db = await dbPromise;
              const rawNodes = db.prepare(`
                SELECT n.*, c.name as category_name 
                FROM nodes n 
                LEFT JOIN categories c ON n.category_id = c.id
              `).all();
              const rawEdges = db.prepare('SELECT * FROM edges').all();

              const nodes = rawNodes.map(n => ({
                id: n.id,
                type: n.type,
                label: n.text.split('.')[0].substring(0, 50) + (n.text.length > 50 ? '...' : ''),
                text: n.text,
                metadata: {
                  description: n.text,
                  category: n.category_name,
                  domain: n.category_name,
                  timestamp: n.timestamp
                }
              }));

              const edges = rawEdges.map(e => ({
                id: e.id,
                source: e.source_id,
                target: e.target_id,
                type: e.type,
                weight: e.weight
              }));

              const data = { kg: { nodes, edges } };

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            } catch (e) {
              console.error('Error in /api/load:', e);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          })();
          return;
        }

        if (apiPath === '/api/categories' && req.method === 'GET') {
          (async () => {
            try {
              const db = await dbPromise;
              const categories = db.prepare('SELECT name, description FROM categories').all();
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(categories));
            } catch (e) {
              console.error('Error in /api/categories:', e);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          })();
          return;
        }

        if (apiPath === '/api/save_sessions' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const db = await dbPromise;
              const sessions = JSON.parse(body);
              const insertSession = db.prepare(`INSERT OR REPLACE INTO sessions (id, name, timestamp, lastProcessedIndex) VALUES (?, ?, ?, ?)`);
              const insertMessage = db.prepare(`INSERT OR REPLACE INTO messages (id, session_id, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)`);
              
              db.transaction(() => {
                for (const session of sessions) {
                  insertSession.run(session.id, session.name, session.timestamp, session.lastProcessedIndex || -1);
                  if (session.messages) {
                    for (const msg of session.messages) {
                      const msgId = msg.id || `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                      let contentToSave = msg.content;
                      if (typeof contentToSave === 'object' && contentToSave !== null) {
                        contentToSave = contentToSave.responseText || JSON.stringify(contentToSave);
                      }
                      insertMessage.run(msgId, session.id, msg.role, contentToSave, msg.timestamp);
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
          req.on('end', async () => {
            try {
              const db = await dbPromise;
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
          (async () => {
            try {
              const db = await dbPromise;
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
          })();
          return;
        }

        if (apiPath === '/api/save_generation' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const db = await dbPromise;
              const data = JSON.parse(body);
              if (data.sessionId && data.htmlCode) {
                const genId = `gen-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                const timestamp = new Date().toISOString();
                db.prepare('INSERT INTO playground_generations (id, session_id, html_content, timestamp) VALUES (?, ?, ?, ?)').run(genId, data.sessionId, data.htmlCode, timestamp);
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

        if (apiPath.startsWith('/api/load_generations') && req.method === 'GET') {
          (async () => {
            try {
              const urlParts = new URL(req.url, `http://${req.headers.host}`);
              const sessionId = urlParts.searchParams.get('sessionId');
              if (!sessionId) throw new Error("Missing sessionId");
              
              const db = await dbPromise;
              const generations = db.prepare('SELECT id, html_content, timestamp FROM playground_generations WHERE session_id = ? ORDER BY timestamp DESC').all(sessionId);
              
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(generations));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          })();
          return;
        }

        if (apiPath === '/api/map_entity' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const db = await dbPromise;
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
              const db = await dbPromise;
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


              const searchVec = new Float32Array(qvec);
              const rows = db.prepare(`
                SELECT 
                  v.node_id as id, 
                  v.distance,
                  n.text,
                  n.category_id as domain,
                  n.timestamp
                FROM vec_node_embeddings v
                JOIN nodes n ON v.node_id = n.id
                WHERE v.embedding MATCH ? AND k = ?
              `).all(searchVec, topK * 5); // fetch extra to account for time/domain filtering
              
              const scored = [];
              for (const row of rows) {
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
                // Convert sqlite-vec MATCH (L2 distance) back to Cosine Similarity
                // For normalized vectors, L2^2 = 2 * (1 - cosine_similarity)
                // Therefore: cosine_similarity = 1 - (L2^2 / 2)
                const cosineSim = 1 - ((row.distance * row.distance) / 2);
                
                // The old threshold was distance <= 0.65 (which meant cosine_sim >= 0.35)
                if (cosineSim < 0.35) continue;
                
                scored.push({ id: row.id, text: row.text, score: Math.round(cosineSim * 1000) / 1000, domain: row.domain, timestamp: row.timestamp });
              }

              scored.sort((a, b) => b.score - a.score);
              let finalResults = scored.slice(0, topK * 2);

              // Context Augmentation with original messages
              for (let res of finalResults) {
                const mapRows = db.prepare('SELECT message_id, session_id FROM entity_mappings WHERE node_id = ? LIMIT 5').all(res.id);
                if (mapRows.length > 0) {
                  const messages = [];
                  let addedSessions = new Set();
                  for (let mapRow of mapRows) {
                    if (mapRow.session_id && !addedSessions.has(mapRow.session_id)) {
                      addedSessions.add(mapRow.session_id);
                      const allMsgs = db.prepare('SELECT id, sender, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(mapRow.session_id);
                      
                      if (allMsgs.length > 0) {
                        let start = 0, end = allMsgs.length;
                        if (mapRow.message_id) {
                          const idx = allMsgs.findIndex(m => m.id === mapRow.message_id);
                          if (idx !== -1) {
                            start = Math.max(0, idx - 2);
                            end = Math.min(allMsgs.length, idx + 3);
                          } else {
                            start = Math.max(0, allMsgs.length - 5);
                          }
                        } else {
                          start = Math.max(0, allMsgs.length - 5);
                        }
                        
                        messages.push('--- Conversation Snippet ---');
                        allMsgs.slice(start, end).forEach(m => {
                          messages.push(`${m.sender.toUpperCase()}: ${m.content}`);
                        });
                      }
                    }
                  }
                  if (messages.length > 0) {
                    res.text = res.text + '\\n\\n[Raw Chat Extract]:\\n' + messages.join('\\n');
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
              const db = await dbPromise;
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

              const insertVecStmt = db.prepare(`
                  INSERT INTO vec_node_embeddings (node_id, embedding)
                  VALUES (?, ?)
              `);
              insertVecStmt.run(id, new Float32Array(embedding));

              const insertLegacyStmt = db.prepare(`
                  INSERT INTO node_embeddings (node_id, embedding)
                  VALUES (?, ?)
              `);
              insertLegacyStmt.run(id, Buffer.from(new Float32Array(embedding).buffer));

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
    plugins: [localPersistencePlugin(env)],
    server: {
      port: 3000,
      open: 'http://selinmodel.com/talktomyself/',
      allowedHosts: ['www.selinmodel.com', 'selinmodel.com'],
      watch: {
        ignored: ['**/src/data-new/**', '**/src/data/**']
      },
      proxy: {
        '/talktomyself/api/openai': {
          target: 'https://api.openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/talktomyself\/api\/openai/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
               proxyReq.removeHeader('referer');
            });
          }
        },
        '/talktomyself/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/talktomyself\/api\/anthropic/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
            });
          }
        },
        '/talktomyself/api/google-tts': {
          target: 'https://texttospeech.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/talktomyself\/api\/google-tts/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
               proxyReq.removeHeader('referer');
               const googleKey = env.VITE_GEMINI_API_KEY || env.VITE_GEMINI_API_KEY;
               if (googleKey) {
                 proxyReq.setHeader('X-Goog-Api-Key', googleKey.trim());
               }
            });
          }
        },
        '/talktomyself/api/elevenlabs': {
          target: 'https://api.elevenlabs.io',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/talktomyself\/api\/elevenlabs/, ''),
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
               proxyReq.removeHeader('origin');
               proxyReq.removeHeader('referer');
               if (env.VITE_ELEVENLABS_API_KEY) {
                 proxyReq.setHeader('xi-api-key', env.VITE_ELEVENLABS_API_KEY.trim());
               }
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
