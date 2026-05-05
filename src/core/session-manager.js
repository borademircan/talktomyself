import { bus } from './event-bus.js';
import { apiFetch } from './api.js';

export class SessionManager {
  /**
   * @param {import('./knowledge-graph.js').KnowledgeGraph} kg 
   */
  constructor(kg) {
    this.kg = kg;
    this.sessions = [];
    this.activeSessionId = null;
    this.cronInterval = null;
    // 30 mins defaults, but we can configure for testing
    this.cronIntervalMs = 30 * 60 * 1000; 
    this._model = 'kimi-k2.6';
  }

  setModel(modelId) {
    this._model = modelId;
  }

  async loadSessions() {
    try {
      const res = await apiFetch('api/load_sessions');
      if (res.ok) {
        this.sessions = await res.json();
        // Ensure legacy messages have an ID
        this.sessions.forEach(s => {
          if (s.messages) {
            s.messages.forEach(m => {
              if (!m.id) {
                m.id = `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
              }
            });
          }
        });
      }
    } catch (err) {
      console.error('[SessionManager] Failed to load sessions', err);
    }

    if (this.sessions.length === 0) {
      this.createNewSession();
    } else {
      // By default activate the most recent session
      this.sessions.sort((a, b) => {
        const getTs = ts => (typeof ts === 'string' && /^\d+(\.\d+)?$/.test(ts)) ? parseFloat(ts) : new Date(ts).getTime();
        return getTs(b.timestamp) - getTs(a.timestamp);
      });
      this.activeSessionId = this.sessions[0].id;
      bus.emit('session:switched', this.sessions[0]);
    }
  }

  async saveSessions() {
    try {
      // Optimize: Only save the currently active session to avoid massive payloads
      const sessionToSave = this.getCurrentSession();
      if (!sessionToSave) return;
      
      await apiFetch('api/save_sessions', {
        method: 'POST',
        body: JSON.stringify([sessionToSave]) // API expects an array
      });
    } catch (err) {
      console.error('[SessionManager] Failed to save sessions', err);
    }
  }

  createNewSession() {
    const id = `sess-${Date.now()}`;
    const name = `Session ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const newSession = {
      id,
      name,
      timestamp: new Date().toISOString(),
      messages: [],
      lastProcessedIndex: -1 // Track which messages have been synced to the Brain
    };
    this.sessions.unshift(newSession); // add to top
    this.activeSessionId = id;
    this.saveSessions();
    bus.emit('session:created', newSession);
    bus.emit('session:switched', newSession);
    return newSession;
  }

  switchSession(id) {
    const session = this.sessions.find(s => s.id === id);
    if (session) {
      this.activeSessionId = id;
      bus.emit('session:switched', session);
    }
  }

  async deleteSession(id) {
    const sessionIndex = this.sessions.findIndex(s => s.id === id);
    if (sessionIndex > -1) {
      this.sessions.splice(sessionIndex, 1);
      
      // If we deleted the active session, switch to the most recent one
      if (this.activeSessionId === id) {
        if (this.sessions.length > 0) {
          this.activeSessionId = this.sessions[0].id;
          bus.emit('session:switched', this.sessions[0]);
        } else {
          this.createNewSession();
        }
      }
      
      bus.emit('session:deleted', id);
      
      // Remove related nodes from KG
      const memoryNodes = Array.from(this.kg.nodes.values()).filter(n => n.metadata?.sessionId === id);
      for (const node of memoryNodes) {
        this.kg.removeNode(node.id);
      }
      
      // Delete from backend SQLite database
      try {
        await apiFetch('api/delete_session', {
          method: 'POST',
          body: JSON.stringify({ sessionId: id })
        });
      } catch (err) {
        console.error('[SessionManager] Failed to delete session from DB', err);
      }
    }
  }

  getCurrentSession() {
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  addMessage(role, text) {
    const session = this.getCurrentSession();
    if (!session) return;
    
    // Auto-generate name based on first user message if it's currently a generic timestamp name
    if (session.messages.length === 0 && role === 'user') {
      const shortTitle = text.length > 25 ? text.substring(0, 25) + '...' : text;
      session.name = shortTitle;
    }

    const id = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    session.messages.push({ id, role, content: text, timestamp: Date.now() });
    this.saveSessions();
    bus.emit('session:updated', session);
  }

  removeMessagesRelatedTo(targetText) {
    // Basic forget functionality for current session
    const session = this.getCurrentSession();
    if (!session) return 0;
    
    if (!targetText) {
      // just remove last
      if (session.messages.length > 0) {
         // remove last AI and last User if possible
         const lastMsg = session.messages[session.messages.length - 1];
         session.messages.pop();
         if (session.messages.length > 0 && session.messages[session.messages.length - 1].role === 'user' && lastMsg.role === 'ai') {
             session.messages.pop(); // remove pair
         }
         this.saveSessions();
         bus.emit('session:updated', session);
         return 1;
      }
      return 0;
    }
    
    const initialLen = session.messages.length;
    session.messages = session.messages.filter(m => !m.content.toLowerCase().includes(targetText.toLowerCase()));
    const deletedCount = initialLen - session.messages.length;
    
    if (deletedCount > 0) {
      this.saveSessions();
      bus.emit('session:updated', session);
    }
    return deletedCount;
  }

  // --- Background Brain Synchronization ---
  
  startCron(intervalMs = null) {
    if (this.cronInterval) clearInterval(this.cronInterval);
    if (intervalMs) this.cronIntervalMs = intervalMs;
    
    this.cronInterval = setInterval(() => {
      this.processPendingSessions();
    }, this.cronIntervalMs);
    
    console.log(`[SessionManager] Started brain sync cron (${this.cronIntervalMs}ms)`);
  }

  async processPendingSessions() {
    console.log('[SessionManager] Running scheduled brain sync...');
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      console.log('[SessionManager] apiKey is missing!');
      return;
    }

    const currentSession = this.getCurrentSession();
    const sessionsToProcess = currentSession ? [currentSession] : [];
    console.log(`[SessionManager] Processing ${sessionsToProcess.length} sessions.`);
    
    let processedAny = false;

    for (const session of sessionsToProcess) {
      // Only process if there are new messages
      const startIndex = session.lastProcessedIndex >= 0 ? session.lastProcessedIndex + 1 : 0;
      console.log(`[SessionManager] Session ${session.id}: startIndex=${startIndex}, messagesLength=${session.messages.length}`);
      if (startIndex >= session.messages.length) {
        console.log(`[SessionManager] Skipping session ${session.id} because no new messages.`);
        continue;
      }
      
      processedAny = true;

      // Extract memory from ONLY new messages to prevent reprocessing and graph churn
      const newMessages = session.messages.slice(startIndex);
      const chunkText = newMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');
      
      let categoriesText = "general";
      try {
        const catRes = await apiFetch('api/categories');
        if (catRes.ok) {
           const cats = await catRes.json();
           categoriesText = cats.map(c => `"${c.name}"`).join(", ");
        }
      } catch(e) {
        console.error("Failed to fetch categories", e);
      }
      
      try {
        const completion = await apiFetch('api/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `You are an expert cognitive extractor. Your task is to extract GRANULAR, highly detailed facts, preferences, events, and ideas from the transcript segment. Break down the conversation into individual atomic details. For example, if the user talks about a trip to Paris where they visited the Louvre and ate croissants, make three: "Trip to Paris", "Visited the Louvre", "Ate croissants in Paris". Return a JSON object containing an array under the key "memories". Each memory must have "label" (very specific short title, max 35 chars), "description" (2-3 sentences explaining the exact details, names, dates, and emotions mentioned), and "category" (MUST BE EXACTLY ONE OF THESE EXISTING CATEGORIES: ${categoriesText}. Do NOT invent new categories unless absolutely strictly necessary). IMPORTANT: Extract EVERYTHING. CRITICAL: The output MUST ALWAYS BE TRANSLATED TO AND WRITTEN IN ENGLISH. Even if the transcript is in Turkish or another language, ALL labels and descriptions MUST be in English without exception. Provide output in English only.` },
              { role: 'user', content: `Transcript:\n${chunkText}` }
            ],
            response_format: { type: "json_object" }
          })
        });

        if (completion.ok) {
          const data = await completion.json();
          const result = JSON.parse(data.choices[0].message.content);
          
          if (result && result.memories && Array.isArray(result.memories)) {
             for (const memory of result.memories) {
               if (memory.label && memory.description && memory.label.toLowerCase() !== 'no memory') {
                  const newNodeId = `${session.id}-memory-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                  this.kg.addNode(newNodeId, 'concept', memory.label, { 
                     description: memory.description, 
                     category: memory.category || 'general',
                     tags: ['memory', 'session'],
                     domain: memory.category || 'knowledge',
                     sessionId: session.id,
                     timestamp: new Date().toISOString()
                  });
                  
                  // Optionally connect it to the last memory of this session
                  const existingMemories = Array.from(this.kg.nodes.values()).filter(n => n.metadata?.sessionId === session.id && n.id !== newNodeId);
                  if (existingMemories.length > 0) {
                     const lastMemory = existingMemories.reduce((prev, curr) => (prev.id > curr.id ? prev : curr));
                     this.kg.addEdge(lastMemory.id, newNodeId, 'next_memory', 1);
                  }

                  // Connect to related nodes in the knowledge graph
                  const matches = this.kg.query(memory.label + " " + memory.description);
                  let edgeCount = 0;
                  for (const { node, score } of matches) {
                    if (node.id !== newNodeId && score > 0.4 && edgeCount < 3) {
                      this.kg.addEdge(newNodeId, node.id, 'related_to', score);
                      edgeCount++;
                    }
                  }

                  // Map entity to the raw messages
                  apiFetch('api/map_entity', {
                    method: 'POST',
                    body: JSON.stringify({
                      nodeId: newNodeId,
                      sessionId: session.id,
                      messageIds: newMessages.map(m => m.id)
                    })
                  }).catch(e => console.error("[SessionManager] Failed to map entity", e));

                  // Highlight the newly added node and its connections
                  bus.emit('graph:node:focus', newNodeId);
               }
             }
          }
        }
        
        // Update index
        session.lastProcessedIndex = session.messages.length - 1;
        this.saveSessions();

      } catch (err) {
         console.error('[SessionManager] Failed to process session memory', err);
      }
    }
    
    return processedAny;
  }
}
