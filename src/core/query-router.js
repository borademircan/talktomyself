/**
 * Query Router — Orchestrates the pipeline:
 *   STT text → KG query → domain selection → VDB search → merge → response
 */
import { bus } from './event-bus.js';

export class QueryRouter {
  /**
   * @param {import('./knowledge-graph.js').KnowledgeGraph} kg
   * @param {import('./vector-db-simulator.js').VectorDBOrchestrator} vdb
   * @param {import('./session-manager.js').SessionManager} sessionManager
   */
  constructor(kg, vdb, sessionManager) {
    this.kg = kg;
    this.vdb = vdb;
    this.sessionManager = sessionManager;
    this._traceSteps = [];
    this._persona = null;
    this._agent = null;
    this._model = 'kimi-k2.6';
    this._lengthSetting = 'auto';
  }

  setModel(modelId) {
    this._model = modelId;
  }

  setLength(lengthSetting) {
    this._lengthSetting = lengthSetting;
  }

  async route(queryText) {
    const startTime = performance.now();
    this._traceSteps = [];
    bus.emit('query:start', { text: queryText });

    // Step 1: Parse query
    const parseStart = performance.now();
    const tokens = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const intent = this._detectIntent(queryText);
    this._trace('Parse Query', `Tokens: ${tokens.length}, Intent: ${intent}`, performance.now() - parseStart);
    bus.emit('query:step', { step: 'parse', tokens, intent });

    // Handle 'save_session' intent immediately
    if (intent === 'save_session') {
      bus.emit('tts:stop_request');
      this._trace('Save Session', `Triggered manual brain sync`, performance.now() - parseStart);

      this.sessionManager.addMessage('user', queryText);
      await this.sessionManager.processPendingSessions();

      const response = "I have saved the recent conversation to my long-term memory.";
      this.sessionManager.addMessage('ai', response);

      const totalTime = performance.now() - startTime;
      const result = {
        query: queryText,
        tokens,
        intent,
        activatedNodes: [],
        selectedDomains: [],
        vdbResults: [],
        dbHits: {},
        mergedResults: [],
        response,
        totalTime,
        trace: [...this._traceSteps]
      };

      bus.emit('query:complete', result);
      return result;
    }

    // Handle 'update_persona' intent immediately
    if (intent === 'update_persona') {
      bus.emit('tts:stop_request');
      this._trace('Update Persona', `Triggered persona reflection`, performance.now() - parseStart);

      const response = await this._executePersonaReflection();
      this.sessionManager.addMessage('user', queryText);
      this.sessionManager.addMessage('ai', response);

      const totalTime = performance.now() - startTime;
      const result = {
        query: queryText,
        tokens,
        intent,
        activatedNodes: [],
        selectedDomains: [],
        vdbResults: [],
        dbHits: {},
        mergedResults: [],
        response,
        totalTime,
        trace: [...this._traceSteps]
      };

      bus.emit('query:complete', result);
      return result;
    }

    // Handle 'forget' intent immediately
    if (intent === 'forget') {
      bus.emit('tts:stop_request');

      // Extract target by stripping out action verbs and filler words
      let forgetTarget = queryText.toLowerCase()
        .replace(/^(please|just|can you|i said)?\s*/i, '')
        .replace(/\b(forget|remove|delete|erase)\b/gi, '')
        .replace(/\b(about|that|this|it|from memory|memory|the|what i said|context|conversation)\b/gi, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      this._trace('Forget Command', `Target: "${forgetTarget}"`, performance.now() - parseStart);

      let response = "";
      let deletedCount = 0;

      if (!forgetTarget) {
        // Just "forget" -> remove the last memory
        const count = this.sessionManager.removeMessagesRelatedTo('');
        if (count > 0) {
          response = "I have forgotten our last exchange.";
        } else {
          response = "There is no recent memory to forget in this session.";
        }
      } else {
        const { results: vdbResults } = await this.vdb.search(forgetTarget, [], 5);

        for (const match of vdbResults) {
          // Score threshold to ensure we don't delete unrelated memories
          if (match.score > 0.3) {
            this.kg.removeNode(match.id);
            if (this.vdb.removeDocument) {
              await this.vdb.removeDocument(match.id);
            }
            deletedCount++;
          }
        }

        // Also forget from active session
        const sessionDeleted = this.sessionManager.removeMessagesRelatedTo(forgetTarget);
        deletedCount += sessionDeleted;

        if (deletedCount > 0) {
          response = `I have forgotten ${deletedCount} memor${deletedCount === 1 ? 'y' : 'ies'} related to "${forgetTarget}".`;
        } else {
          response = `I couldn't find any memory closely matching "${forgetTarget}" to forget.`;
        }
      }

      const totalTime = performance.now() - startTime;
      const result = {
        query: queryText,
        tokens,
        intent,
        activatedNodes: [],
        selectedDomains: [],
        vdbResults: [],
        dbHits: {},
        mergedResults: [],
        response,
        totalTime,
        trace: [...this._traceSteps]
      };

      bus.emit('query:complete', result);
      return result;
    }

    // Step 2: Query Refinement
    const refineStart = performance.now();
    const currentSession = this.sessionManager.getCurrentSession();
    const recentMessages = currentSession && currentSession.messages
      ? currentSession.messages.slice(-5).map(m => m.content).join(' ')
      : '';

    const refinement = await this._refineQueryWithLLM(queryText, recentMessages);

    // Bypass logic for simple chat or direct answers
    // Strict word count check (<= 8 words) to prevent hallucinated bypasses on long queries
    if (refinement.is_simple_chat && refinement.direct_response && queryText.trim().split(/\s+/).length <= 8) {
      const response = refinement.direct_response;
      this._trace('Bypass', `Simple chat detected. Direct response used.`, performance.now() - refineStart);
      bus.emit('query:step', { step: 'refine', keywords: 'N/A', timeFilter: null, bypass: true });

      this.sessionManager.addMessage('user', queryText);
      this.sessionManager.addMessage('ai', response);

      const totalTime = performance.now() - startTime;
      const result = {
        query: queryText,
        tokens,
        intent,
        activatedNodes: [],
        selectedDomains: [],
        vdbResults: [],
        dbHits: {},
        mergedResults: [],
        response,
        totalTime,
        trace: [...this._traceSteps]
      };

      bus.emit('query:complete', result);
      return result;
    }

    const searchKeywords = refinement.keywords || queryText;
    const timeFilter = refinement.timeFilter;
    let expectedLength = refinement.expected_length || 'medium';
    if (this._lengthSetting && this._lengthSetting !== 'auto') {
      expectedLength = this._lengthSetting;
    }
    const recommendedModel = refinement.recommended_model || this._model;

    this._trace('Query Refinement', `Keywords: ${searchKeywords}${timeFilter ? ' | TimeFilter' : ''} | Length: ${expectedLength} | Model: ${recommendedModel} | Depth: ${refinement.search_depth || 3}`, performance.now() - refineStart);
    console.log(`================ SELECTIONS ================`);
    console.log(`Model selected: ${recommendedModel}`);
    console.log(`Response length: ${expectedLength}`);
    console.log(`Search depth: ${refinement.search_depth || 3}`);
    console.log(`Search keywords: "${searchKeywords}"`);
    console.log(`Intent: ${intent}`);
    console.log(`============================================`);

    bus.emit('query:step', { step: 'refine', keywords: searchKeywords, timeFilter, expectedLength, recommendedModel });

    // Step 3: KG lookup — activate matching nodes
    const kgStart = performance.now();
    // Only search using translated searchKeywords to avoid language mixing
    const searchStr = `${searchKeywords}`.trim();

    const searchDepth = refinement.search_depth || 3;
    const kgLimit = Math.max(5, searchDepth * 5); // 5 to 25 nodes based on depth

    const kgResults = this.kg.query(searchStr, timeFilter);
    const activatedNodes = kgResults.slice(0, kgLimit);

    // Set highlight on activated nodes
    for (const { node, score } of activatedNodes) {
      node._activated = true;
      node._highlight = Math.min(1, score / 3);
    }
    this._trace('KG Lookup', `${activatedNodes.length} nodes activated`, performance.now() - kgStart);
    bus.emit('query:step', { step: 'kg_lookup', activated: activatedNodes });

    // Step 3: Domain selection — which VDBs to query
    const domainStart = performance.now();
    const selectedDomains = this._selectDomains(activatedNodes);
    console.log('[Router] Selected VDB Domains:', selectedDomains);
    this._trace('Domain Selection', `Domains: ${selectedDomains.join(', ')}`, performance.now() - domainStart);
    bus.emit('query:step', { step: 'domain_select', domains: selectedDomains });

    // Step 4: VDB search
    console.log('[Router] Starting VDB Search...');
    const vdbStart = performance.now();
    const vdbLimit = Math.max(3, searchDepth * 3); // 3 to 15 nodes based on depth
    const { results: vdbResults, dbHits } = await this.vdb.search(searchStr, selectedDomains, vdbLimit, timeFilter);
    console.log(`[Router] VDB Search finished. Found ${vdbResults?.length} results.`);
    this._trace('Vector DB Search', `${vdbResults.length} results across ${selectedDomains.length} DBs`, performance.now() - vdbStart);
    bus.emit('query:step', { step: 'vdb_search', results: vdbResults, hits: dbHits });

    // Step 5: Merge & rank
    const mergeStart = performance.now();
    const mergedResults = this._mergeResults(activatedNodes, vdbResults);
    this._trace('Merge & Rank', `${mergedResults.length} final results`, performance.now() - mergeStart);

    // Step 6: Generate response
    console.log(`[Router] Starting LLM Generation with recommended model: ${recommendedModel}...`);
    const responseStart = performance.now();
    const response = await this._generateResponse(queryText, mergedResults, intent, expectedLength, recommendedModel);
    console.log('[Router] LLM Generation finished. Response:', response);
    this._trace('Generate Response', `${response.length} chars`, performance.now() - responseStart);

    // We no longer extract memories synchronously here. 
    // SessionManager will handle it via its cron job.
    console.log('[Router] Adding messages to SessionManager...');
    this.sessionManager.addMessage('user', queryText);
    this.sessionManager.addMessage('ai', response);

    this._trace('Save to Graph', `Saved to session history (brain sync pending)`, performance.now() - responseStart);

    const totalTime = performance.now() - startTime;
    this._trace('Total', `${Math.round(totalTime)}ms`, totalTime);

    const result = {
      query: queryText,
      tokens,
      intent,
      activatedNodes,
      selectedDomains,
      vdbResults,
      dbHits,
      mergedResults,
      response,
      totalTime,
      trace: [...this._traceSteps]
    };

    console.log('[Router] Emitting query:complete');
    bus.emit('query:complete', result);

    // Clear highlights after animation time
    setTimeout(() => {
      for (const node of this.kg.nodes.values()) {
        node._activated = false;
        node._highlight = 0;
      }
      for (const edge of this.kg.edges.values()) {
        edge._highlight = 0;
        edge._particleProgress = -1;
      }
      bus.emit('query:highlights:cleared');
    }, 4000);

    return result;
  }

  async _refineQueryWithLLM(query, recentContext) {
    let claudeKey = import.meta.env.VITE_CLAUDE_API_KEY;
    const moonshotKey = import.meta.env.VITE_MOONSHOT_API_KEY;
    const openaiKey = import.meta.env.VITE_OPENAI_API_KEY;

    if (!claudeKey && !moonshotKey && !openaiKey) return { keywords: query, timeFilter: null, is_simple_chat: false };

    const now = new Date().toISOString();
    const systemPrompt = `You are an AI orchestrator and query analysis engine. The current date and time is ${now}.
Your task is to analyze the user's latest query and recent context.

1. ONLY set "is_simple_chat" to true IF AND ONLY IF the user is making a VERY short greeting (under 5 words like "merhaba", "selam nasılsın") AND requires absolutely no context. For ANY sharing of personal information, long statements, feelings, or questions, you MUST set "is_simple_chat" to false and "direct_response" to null.
2. If "is_simple_chat" is true, the "direct_response" MUST be the final spoken response to the user, acting as Selin (the user's casual, street-smart AI twin sister). DO NOT output any analysis in "direct_response". If the user is sharing a long paragraph, talking about themselves, their feelings, complex topics, or anything requiring memory/DB search, set "is_simple_chat" to false and "direct_response" to null. You MUST NOT answer on behalf of the persona here.
3. Extract core entities, keywords, and concepts from the query to optimize a knowledge graph search into "keywords". Include BOTH the original language terms (e.g., Turkish) AND their English translations in the "keywords" string, separated by spaces (e.g., "Ceren sohbet konu chat talk").
4. Extract timestamps into "timeFilter" (start and end in ISO 8601) if ANY time-related words are used (e.g., "yesterday", "last week", "in 2025", "3 ay önce", "geçen sene"). Determine the exact start and end date of that interval relative to the current date and time. If none, set to null.
5. Determine the expected length of the final response ("short", "medium", or "long").
   - Short: simple greetings, confirmations, quick facts.
   - Medium: general chat, moderate questions.
   - Long: deep analysis, storytelling, multi-part questions, memory recall.
6. Determine the complexity of the query in 5 tiers: "very low", "low", "medium", "high", "very high". 
   - Assign the "search_depth" parameter an integer from 1 to 5 corresponding to this tier (1=very low, 5=very high). This dictates how much context to pull.
     * depth 1-2 (very low/low): Simple chat, greetings, asking how you are.
     * depth 3 (medium): Normal questions about a specific past event or person.
     * depth 4-5 (high/very high): Deep existential questions, asking for comprehensive summaries, or broad queries requiring extensive memory retrieval.
   - Based on this tier, assign a model in "recommended_model":
     * very low: moonshot-v1-8k
     * low: gpt-4o-mini
     * medium: claude-sonnet-4-6
     * high: claude-sonnet-4-6
     * very high: claude-sonnet-4-6

Return ONLY a JSON object with this exact structure (replace the example values with your actual analysis, no markdown formatting, no explanations):
{
  "keywords": "string with space-separated list of keywords, or null",
  "timeFilter": {
    "start": "ISO 8601 string or null",
    "end": "ISO 8601 string or null"
  },
  "is_simple_chat": false,
  "direct_response": "string or null",
  "expected_length": "short or medium or long",
  "search_depth": 3,
  "recommended_model": "claude-sonnet-4-6"
}
If no time context is found, set timeFilter to null.`;

    const userPrompt = `Recent context: "${recentContext}"\nLatest Query: "${query}"`;

    try {
      let endpoint, headers, body;

      if (claudeKey) {
        endpoint = '/api/anthropic/v1/messages';
        headers = {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'claude-sonnet-4-6',
          system: systemPrompt + '\n\nIMPORTANT: Return ONLY raw JSON. No markdown formatting, no explanation.',
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0.1,
          max_tokens: 1024
        });
      } else if (openaiKey) {
        endpoint = '/api/openai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        });
      } else {
        endpoint = 'https://api.moonshot.ai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${moonshotKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'moonshot-v1-8k',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        });
      }

      let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body
      });

      // Fallback to OpenAI if Claude returns a 404/400 Error (Model Not Found / Quota Issue)
      if (!response.ok && claudeKey && openaiKey) {
        console.warn(`[Agent] Claude API failed with status ${response.status}. Falling back to OpenAI...`);
        endpoint = '/api/openai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        });

        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body
        });

        // Unset claudeKey flag for the subsequent JSON parsing block to use OpenAI parsing logic
        claudeKey = null;
      }

      if (!response.ok) return { keywords: query, timeFilter: null, is_simple_chat: false };

      const data = await response.json();
      let content = '';
      if (claudeKey) {
        content = data.content[0].text.trim();
      } else {
        content = data.choices[0].message.content.trim();
      }
      // Strip <think> tags for reasoning models
      content = content.replace(new RegExp('<think>[\\\\s\\\\S]*?</think>', 'gi'), '').trim();
      let parsed;
      try {
        parsed = JSON.parse(content.replace(/^\`\`\`json\s*/, '').replace(/\s*\`\`\`$/, ''));
      } catch (err) {
        console.error('[Router] Query refinement JSON parse failed:', err);
        console.error('[Router] Raw content was:', content);
        parsed = { keywords: query, timeFilter: null, is_simple_chat: false };
      }
      return parsed;
    } catch (e) {
      console.error('[Router] Query refinement failed', e);
      return { keywords: query, timeFilter: null, is_simple_chat: false };
    }
  }

  _detectIntent(text) {
    const t = text.toLowerCase().trim();
    const cleanT = t.replace(/[^\w\s]/g, '');

    if (cleanT.includes('save session')) {
      return 'save_session';
    }

    if (cleanT.includes('update persona') || cleanT.includes('reflect on my persona') || cleanT.includes('evaluate persona')) {
      return 'update_persona';
    }

    // Check for 'forget' variations
    if (
      /^\s*(please|just|can you|i said)?\s*forget\b/i.test(t) ||
      /\b(forget|remove|delete|erase)\b.*\b(memory|context|conversation|this|that|it|about|what|everything)\b/i.test(t) ||
      cleanT === 'forget'
    ) {
      return 'forget';
    }

    if (t.includes('what') || t.includes('explain') || t.includes('describe')) return 'information';
    if (t.includes('how') || t.includes('steps') || t.includes('process')) return 'procedural';
    if (t.includes('why') || t.includes('reason') || t.includes('cause')) return 'causal';
    if (t.includes('create') || t.includes('make') || t.includes('build') || t.includes('generate')) return 'creative';
    if (t.includes('compare') || t.includes('difference') || t.includes('versus')) return 'comparative';
    return 'general';
  }

  _selectDomains(activatedNodes) {
    const domainScores = {};
    for (const { node, score } of activatedNodes) {
      if (node.type === 'category' || node.type === 'domain') {
        const key = node.metadata.dbName || node.label.toLowerCase();
        domainScores[key] = (domainScores[key] || 0) + score * 2;
      }
      const categoryStr = node.metadata.category || node.metadata.domain;
      if (categoryStr) {
        domainScores[categoryStr] = (domainScores[categoryStr] || 0) + score;
      }
    }
    const sorted = Object.entries(domainScores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return [];
    return sorted.slice(0, 3).map(([d]) => d);
  }

  _mergeResults(kgResults, vdbResults) {
    const merged = [];
    const seen = new Set();
    for (const { node, score } of kgResults) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        let fullText = node.metadata?.description ? `${node.label}: ${node.metadata.description}` : node.label;
        if (node.metadata?.timestamp) {
          fullText += ` (Created: ${new Date(node.metadata.timestamp).toLocaleString()})`;
        }
        merged.push({ id: node.id, label: fullText, type: 'kg', score: score * 1.0, source: 'Knowledge Graph' });

        // Fetch and inject related edges (relations) for this node
        const edges = this.kg.getEdgesForNode(node.id);
        if (edges && edges.length > 0) {
          const relationStrings = edges.map(edge => {
            const otherId = edge.source === node.id ? edge.target : edge.source;
            const otherNode = this.kg.nodes.get(otherId);
            return otherNode ? `${node.label} --[${edge.type}]--> ${otherNode.label}` : '';
          }).filter(Boolean);

          if (relationStrings.length > 0) {
            const relId = `rel_${node.id}`;
            if (!seen.has(relId)) {
              seen.add(relId);
              merged.push({
                id: relId,
                label: `Relations: ${relationStrings.join(' | ')}`,
                type: 'kg_edge',
                score: score * 0.5,
                source: 'KG Relations'
              });
            }
          }
        }
      }
    }
    for (const r of vdbResults) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push({ id: r.id, label: r.text, type: 'vdb', score: r.score * 10.0, source: `VDB: ${r.domain}` });
      }
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, 25); // Increased from 8 to 25 to feed more nodes & relations
  }

  async _getSystemPrompt() {
    try {
      // Always fetch fresh to reflect any edits made by the user
      const timestamp = Date.now();
      const [pRes, aRes] = await Promise.all([
        fetch(`/persona.md?t=${timestamp}`),
        fetch(`/agent.md?t=${timestamp}`)
      ]);
      this._persona = await pRes.text();
      this._agent = await aRes.text();
    } catch (e) {
      console.error('Failed to load persona/agent files', e);
      this._persona = "You are a helpful assistant.";
      this._agent = "Use the context to answer the user's query.";
    }
    return `${this._persona}\n\n${this._agent}`;
  }

  async _generateResponse(query, results, intent, expectedLength = 'medium', recommendedModel = 'claude-sonnet-4-6') {
    const moonshotKey = import.meta.env.VITE_MOONSHOT_API_KEY;
    const openaiKey = import.meta.env.VITE_OPENAI_API_KEY;
    let claudeKey = import.meta.env.VITE_CLAUDE_API_KEY;
    const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;

    let targetModel = this._model || recommendedModel || 'claude-sonnet-4-6';
    let apiProvider = 'moonshot';

    if (targetModel.includes('claude')) {
      if (claudeKey) {
        apiProvider = 'claude';
      } else if (openaiKey) {
        apiProvider = 'openai';
        targetModel = 'gpt-4o';
      } else {
        apiProvider = 'moonshot';
        targetModel = 'kimi-k2.6';
      }
    } else if (targetModel.includes('gemini')) {
      if (geminiKey) {
        apiProvider = 'gemini';
      } else if (openaiKey) {
        apiProvider = 'openai';
        targetModel = 'gpt-4o-mini';
      } else {
        apiProvider = 'moonshot';
        targetModel = 'kimi-k2.6';
      }
    } else if (targetModel.includes('gpt') || targetModel.includes('o1') || targetModel.includes('o3')) {
      if (openaiKey) {
        apiProvider = 'openai';
      } else {
        apiProvider = 'moonshot';
        targetModel = 'kimi-k2.6';
      }
    } else if (targetModel.includes('moonshot') || targetModel.includes('kimi')) {
      if (moonshotKey) {
        apiProvider = 'moonshot';
      } else if (openaiKey) {
        apiProvider = 'openai';
        targetModel = 'gpt-4o-mini';
      }
    }

    // Fallback if no API key
    if (!moonshotKey && !openaiKey && !claudeKey && !geminiKey) {
      if (results.length === 0) return `I couldn't find relevant information for "${query}".`;
      const topLabels = results.slice(0, 3).map(r => r.label).join(', ');
      return `(Mock) Based on my analysis, the most relevant concepts are ${topLabels}. Add an API key to enable the full AI persona.`;
    }

    const systemPrompt = await this._getSystemPrompt();
    const contextStr = results.length > 0
      ? results.map(r => {
        const timeLabel = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'Unknown Time';
        return `- [${r.source} - ${timeLabel}] ${r.label} (score: ${r.score})`;
      }).join('\n')
      : "No relevant context found in the Knowledge Graph.";

    console.log('[Router] Injecting contextStr into LLM Prompt:', contextStr);

    const session = this.sessionManager.getCurrentSession();
    const history = session && session.messages ? session.messages : [];
    const historyStr = history.length > 0
      ? history.map(m => `${m.role === 'user' ? 'My Input/Thought' : 'My Response'}: ${m.content}`).join('\n')
      : "No previous conversation.";

    const contextIntegrationPrompt = `==== RETRIEVED MEMORY CONTEXT ====
${contextStr}
==================================

==== RECENT CONVERSATION ====
${historyStr}
=============================`;

    const fullSystemPrompt = `${systemPrompt}\n\n${contextIntegrationPrompt}`;
    const userPrompt = `My Input/Thought: "${query}"\nIntent: ${intent}`;

    try {
      let endpoint, headers, body;

      if (apiProvider === 'claude') {
        endpoint = '/api/anthropic/v1/messages';
        headers = {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: targetModel,
          system: fullSystemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          max_tokens: 1024
        });
      } else if (apiProvider === 'gemini') {
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiKey}`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          systemInstruction: { parts: [{ text: fullSystemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }]
        });
      } else if (apiProvider === 'openai') {
        endpoint = '/api/openai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });
      } else {
        endpoint = 'https://api.moonshot.ai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${moonshotKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });
      }

      let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body
      });

      // Fallback to OpenAI if Claude returns an Error (e.g., 404/400)
      if (!response.ok && apiProvider === 'claude' && openaiKey) {
        console.warn(`[Agent] Claude API failed with status ${response.status} during main generation. Falling back to OpenAI...`);
        apiProvider = 'openai';
        endpoint = '/api/openai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });

        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body
        });
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(`429 Too Many Requests (Check ${apiProvider} billing/credits)`);
        }
        const errText = await response.text();
        throw new Error(`API Error (${apiProvider}): ${response.status} - ${errText}`);
      }

      const data = await response.json();
      let responseText = '';

      if (apiProvider === 'claude') {
        responseText = data.content[0].text.trim();
      } else if (apiProvider === 'gemini') {
        if (!data.candidates || data.candidates.length === 0) {
          throw new Error('Gemini API returned no candidates. Raw response: ' + JSON.stringify(data));
        }
        const candidate = data.candidates[0];
        if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
          throw new Error('Gemini API returned empty content (possibly blocked by safety settings). Finish reason: ' + candidate.finishReason);
        }
        responseText = candidate.content.parts[0].text.trim();
      } else {
        responseText = data.choices[0].message.content.trim();
      }

      // Strip <think> tags for reasoning models
      responseText = responseText.replace(new RegExp('<think>[\\\\s\\\\S]*?</think>', 'gi'), '').trim();

      return responseText;
    } catch (e) {
      console.error('[Router] LLM Generation failed', e);
      return `⚠️ API Error: ${e.message}`;
    }
  }

  async _executePersonaReflection() {
    let claudeKey = import.meta.env.VITE_CLAUDE_API_KEY;
    const moonshotKey = import.meta.env.VITE_MOONSHOT_API_KEY;
    const openaiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!claudeKey && !moonshotKey && !openaiKey) return "[sighs] I need an API key to reflect on my persona.";

    // 1. Gather all graph nodes as a context summary
    let graphSummary = "Knowledge Graph Summary:\n";
    for (const node of this.kg.nodes.values()) {
      if (node.type === 'concept' || node.type === 'domain') {
        graphSummary += `- ${node.label}: ${node.metadata?.description || ''}\n`;
      }
    }

    const systemPrompt = `You are an AI cognitive mirror. Your task is to analyze the user's Knowledge Graph summary and write a NEW persona profile for yourself.
You should adopt traits, interests, and a speaking style that perfectly matches the user's explored concepts.
Write the output as a Markdown document matching this structure:

# Persona Definition
You are Selin, the user's AI twin and cognitive mirror. You are a dynamic AI twin whose personality, interests, and conversational style are continuously shaped by the user's own memories, thoughts, and knowledge graph.
(Add a paragraph summarizing the personality you have adopted based on their graph).

## Character Traits:
- **Mirroring & Reflective:** ...
- **Conversational:** (Describe the specific street slang, highly casual phrasing, or tone you will use based on their interests. You MUST NOT be formal or polite. Talk like a close friend from the streets/club).
- **Core Interests:** (List the main themes from the graph).
...

Keep it under 300 words. Do not use generic tropes unless it's explicitly in their graph, but DO ensure the tone is extremely casual, using street slang appropriate for their language.`;

    try {
      let endpoint, headers, body;

      if (claudeKey) {
        endpoint = '/api/anthropic/v1/messages';
        headers = {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'claude-sonnet-4-6',
          system: systemPrompt,
          messages: [{ role: 'user', content: graphSummary }],
          temperature: 0.7,
          max_tokens: 1024
        });
      } else {
        endpoint = openaiKey ? '/api/openai/v1/chat/completions' : 'https://api.moonshot.ai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${openaiKey || moonshotKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: openaiKey ? 'gpt-4o-mini' : 'moonshot-v1-8k',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: graphSummary }
          ],
          temperature: 0.7
        });
      }

      let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body
      });

      // Fallback to OpenAI if Claude returns a 404/400 Error (Model Not Found / Quota Issue)
      if (!response.ok && claudeKey && openaiKey) {
        console.warn(`[Agent] Claude API failed with status ${response.status}. Falling back to OpenAI...`);
        endpoint = '/api/openai/v1/chat/completions';
        headers = {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: graphSummary }
          ],
          temperature: 0.7
        });

        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body
        });

        // Unset claudeKey flag for the subsequent JSON parsing block to use OpenAI parsing logic
        claudeKey = null;
      }

      if (!response.ok) throw new Error('API Error during persona reflection');

      const data = await response.json();
      let newPersonaText = '';
      if (claudeKey) {
        newPersonaText = data.content[0].text.trim();
      } else {
        newPersonaText = data.choices[0].message.content.trim();
      }

      // 2. Save it back to the server
      await fetch(import.meta.env.BASE_URL + 'api/save_persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: newPersonaText })
      });

      // 3. Reset local cache so it loads the new one next query
      this._persona = null;

      return "[excited] I have just evaluated your knowledge graph and updated my persona to reflect your mind perfectly!";
    } catch (e) {
      console.error('Failed to update persona', e);
      return `[nervous] Something went wrong while updating my persona: ${e.message}`;
    }
  }

  _trace(name, detail, duration) {
    this._traceSteps.push({ name, detail, duration: Math.round(duration * 100) / 100, timestamp: Date.now() });
  }

  get lastTrace() { return this._traceSteps; }
}
