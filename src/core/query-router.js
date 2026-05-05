/**
 * Query Router — Orchestrates the pipeline:
 *   STT text → KG query → domain selection → VDB search → merge → response
 */
import { bus } from './event-bus.js';
import { apiFetch } from './api.js';
import { PlaygroundCompiler } from './playground-compiler.js';

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
    this.playgroundMode = false;
    this.compiler = new PlaygroundCompiler();

    bus.on('playground:toggle', (enabled) => {
      this.playgroundMode = enabled;
    });

    this.interviewMode = false;
    this.interviewQuestionCount = 0;

    bus.on('interview:toggle', (enabled) => {
      this.interviewMode = enabled;
      this.interviewQuestionCount = 0;
      if (enabled) {
        this.route('__START_INTERVIEW__');
      }
    });
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
    let tokens = [];
    let intent = 'general';
    
    if (queryText === '__START_INTERVIEW__') {
      intent = 'start_interview';
      this._trace('Interview Start', `Kicking off profiling...`, performance.now() - parseStart);
    } else {
      tokens = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      intent = this._detectIntent(queryText);
      this._trace('Parse Query', `Tokens: ${tokens.length}, Intent: ${intent}`, performance.now() - parseStart);
    }
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

    let refinement;
    if (queryText === '__START_INTERVIEW__') {
      refinement = { keywords: "user profile background personality past life goals", timeFilter: null, is_simple_chat: false, search_depth: 4, recommended_model: this._model };
    } else {
      refinement = await this._refineQueryWithLLM(queryText, recentMessages);
    }

    // Bypass logic for simple chat or direct answers
    // Strict word count check (<= 8 words) to prevent hallucinated bypasses on long queries
    if (!this.interviewMode && refinement.is_simple_chat && refinement.direct_response && queryText.trim().split(/\s+/).length <= 8) {
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
    // Suppress misleading domain logging since VDB searches globally anyway
    // console.log('[Router] Selected VDB Domains:', selectedDomains);
    this._trace('Domain Selection', `Domains: ${selectedDomains.join(', ')}`, performance.now() - domainStart);
    bus.emit('query:step', { step: 'domain_select', domains: selectedDomains });

    // Step 4: VDB search (Use natural language queryText for embeddings, NOT keyword soup)
    console.log('[Router] Starting VDB Search...');
    bus.emit('agent:progress', 'Starting Vector Database Search...');
    const vdbStart = performance.now();
    const vdbLimit = Math.max(3, searchDepth * 3); // 3 to 15 nodes based on depth
    const { results: vdbResults, dbHits } = await this.vdb.search(searchStr, selectedDomains, vdbLimit, timeFilter);
    console.log(`[Router] VDB Search finished. Found ${vdbResults?.length} results.`);
    bus.emit('agent:progress', `VDB Search finished. Found ${vdbResults?.length} results.`);
    this._trace('Vector DB Search', `${vdbResults.length} results across ${selectedDomains.length} DBs`, performance.now() - vdbStart);
    bus.emit('query:step', { step: 'vdb_search', results: vdbResults, hits: dbHits });

    // Step 5: Merge & rank
    const mergeStart = performance.now();
    const mergedResults = this._mergeResults(activatedNodes, vdbResults);
    this._trace('Merge & Rank', `${mergedResults.length} final results`, performance.now() - mergeStart);

    // Step 6: Generate response
    console.log(`[Router] Starting LLM Generation with recommended model: ${recommendedModel}...`);
    const responseStart = performance.now();
    let response;
    if (this.playgroundMode) {
      response = await this._executePlaygroundMode(queryText, startTime, mergedResults);
    } else {
      response = await this._generateResponse(queryText, mergedResults, intent, expectedLength, recommendedModel);
    }
    let finalResponseText = response;
    let finalFullOutput = response;
    let finalParsedHtml = null;

    if (this.playgroundMode) {
      finalResponseText = response.responseText;
      finalFullOutput = response.fullOutput || response.responseText;
      finalParsedHtml = response.parsedHtml;
    }

    console.log('[Router] LLM Generation finished.');
    this._trace('Generate Response', `${finalResponseText.length} chars`, performance.now() - responseStart);

    // We no longer extract memories synchronously here. 
    // SessionManager will handle it via its cron job.
    console.log('[Router] Adding messages to SessionManager...');
    if (queryText !== '__START_INTERVIEW__') {
      this.sessionManager.addMessage('user', queryText);
    }
    this.sessionManager.addMessage('ai', finalResponseText);

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
      response: finalResponseText,
      fullOutput: finalFullOutput,
      parsedHtml: finalParsedHtml,
      totalTime,
      trace: [...this._traceSteps]
    };

    const ttsMatch = finalResponseText.match(/<tts>([\s\S]*?)<\/tts>/i);
    if (ttsMatch) {
      result.ttsResponse = ttsMatch[1].trim();
    }

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

  async _executePlaygroundMode(queryText, startTime, mergedResults = []) {
    const parseStart = performance.now();
    this._trace('Playground Mode', `Generating code for: ${queryText}`, performance.now() - parseStart);

    const session = this.sessionManager.getCurrentSession();
    const history = session && session.messages ? session.messages : [];

    // Check for existing HTML to enable Editing mode
    let currentHtml = null;
    if (session && session.id) {
      try {
        const res = await apiFetch(`api/load_generations?sessionId=${session.id}`);
        if (res.ok) {
          const gens = await res.json();
          if (gens.length > 0) currentHtml = gens[0].html_content;
        }
      } catch (e) { console.warn("Failed to check for current HTML", e); }
    }

    if (currentHtml) {
      // Intent Check
      const intentSystem = `Reply with exactly one word: "NEW" or "EDIT". Does the user want a completely new UI design from scratch, or to edit the existing one? Unless they specifically ask to 'start over', 'clear the page', or 'create a new page', you MUST reply EDIT. Modifications to the current page (even large ones) are considered EDIT.`;
      let isEdit = false;
      try {
        const intentRes = await this._callLLM(intentSystem, queryText, this._model, false, 10, []);
        if (intentRes.includes("EDIT")) {
          isEdit = true;
        }
      } catch (e) {
        // Default to edit if we can't decide and there is existing HTML
        isEdit = true;
      }

      if (isEdit) {
        const editorResponse = await this._kickoffEditor(queryText, currentHtml, history);
        return { responseText: editorResponse, fullOutput: "", parsedHtml: null };
      }
    }

    let code = "<h1>Error generating code</h1>";
    let aiResponse = "I created the requested UI in the playground.";

    let historyStr = "";
    if (history.length > 0) {
      historyStr = history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    }

    const contextStr = mergedResults.length > 0
      ? mergedResults.map(r => {
        const timeLabel = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'Unknown Time';
        return `- [${r.source} - ${timeLabel}] ${r.label} (score: ${r.score})`;
      }).join('\n')
      : "No relevant context found in the Knowledge Graph.";

    const memoryInstruction = `\n\n==== RETRIEVED MEMORY CONTEXT ====
${contextStr}
==================================\n\nCRITICAL: You must analyze both the PREVIOUS CONVERSATION CONTEXT and the RETRIEVED MEMORY CONTEXT provided above. Put your own perspective on the design based on these memories and chat context, while concentrating specifically on the UI/UX design and the playground implementation. Ensure the final design reflects this contextual awareness.`;

    const architectSystemPrompt = `You are an avant-garde creative director and UX architect. Your task is to plan a stunning, highly creative, production-ready web interface based on the user's request. 

ELITE UI/UX DESIGN SYSTEM & ART DIRECTION:
- Dynamic, Context-Driven Aesthetics: You are an elite creative director. You must dynamically decide the absolute best art direction, color palette, and mood based on the specific emotion and context of the user's request. 
- Award-Winning Design Principles: Apply high-end design rules (e.g., Awwwards-winning layouts, Swiss typography, editorial web design, or immersive maximalism). Use sophisticated color theory (analogous, complementary, monochromatic) and avoid generic or clashing palettes.
- Industry Best Practices: Deeply analyze the field or industry requested (e.g., e-commerce, SaaS, portfolio, creative agency, medical). Apply the absolute best UX/UI practices, proven conversion principles, and standard layout conventions specific to that field, while elevating the visual execution.
- Typography as Art: Treat typography as a primary design element. Use intentional scale, tracking, and leading. Mix modern sans-serifs (like Inter or Space Grotesk) with elegant serifs or monospace fonts where contextually appropriate.
- Modern Techniques: Implement cutting-edge trends when they serve the concept, such as glassmorphism, organic soft shadows, subtle noise textures, dynamic gradients, or brutalist grids. Avoid flat, boring, or "corporate template" looks at all costs.

OUTPUT REQUIREMENTS & CONSTRAINTS:
1. Do NOT write code. Output a highly detailed, structured Design Blueprint explaining the concept, colors, typography, layout, and animations.
2. NEW SYSTEM CAPABILITIES (PIL): The downstream Engineer uses an ultra-compact Playground Intermediate Language (PIL) instead of raw HTML. This means token limits are drastically reduced. You are ENCOURAGED to design rich, complex, multi-layered interfaces with advanced structural DOM elements. Do not arbitrarily hold back on creativity or complexity.
3. You MUST start your response with a <tts> tag containing a short, conversational, 1-2 sentence summary of what you are building. This is what the voice will speak out loud. Example: <tts>I'm designing a dark, immersive techno-club interface with neon magenta accents.</tts>

${memoryInstruction}`;

    let architectPlan = "";
    try {
      console.log(`[Playground] Calling Architect Agent...`);
      bus.emit('agent:progress', 'Calling Architect Agent...');
      architectPlan = await this._callLLM(architectSystemPrompt, queryText, 'claude-sonnet-4-6', false, 2048, history);
      console.log(`[Playground] Architect Plan Generated:\n${architectPlan.substring(0, 150)}...`);
      aiResponse = architectPlan;
    } catch (e) {
      console.error(`[Playground] Architect API Error:`, e);
      aiResponse = `I encountered an error while planning the design: ${e.message}`;
      return { responseText: aiResponse, fullOutput: "", parsedHtml: code };
    }

    const engineerSystemPrompt = `You are an elite, award-winning frontend engineer. Your task is to implement the exact design blueprint provided by the Architect.

CRITICAL ARCHITECTURE RULES:
${this.compiler.getPromptContext()}

4. NEVER use placeholder image services. Use the Pollinations AI Image API by formatting URLs exactly like this: \`https://image.pollinations.ai/prompt/{description}?width={w}&height={h}&nologo=true\`. Replace {description} with a highly descriptive prompt where ALL spaces are replaced by hyphens. Do NOT use raw spaces or %20.
5. NEVER use placeholder video URLs (e.g., \`https://your_video_url.mp4\`) or external audio files. To create dynamic backgrounds, rely PURELY on advanced CSS animations, keyframes, gradient shifting, or parallax effects.

ANTI-LAZINESS PROTOCOL vs TOKEN LIMITS (EXTREMELY IMPORTANT):
You MUST write functional code for every feature, BUT you have a hard limit of 8192 tokens.
TO PREVENT TRUNCATION:
- Do NOT write repetitive HTML structures.
- Keep CSS concise. Use abbreviations.
- Ensure the code finishes before the token limit.

==== ARCHITECT'S DESIGN BLUEPRINT ====
${architectPlan}
======================================`;

    // Kick off Engineer asynchronously so the UI isn't blocked!
    this._kickoffEngineer(engineerSystemPrompt, queryText, history);

    return { responseText: aiResponse, fullOutput: architectPlan, parsedHtml: null };
  }

  async _kickoffEngineer(engineerSystemPrompt, queryText, history) {
    try {
      bus.emit('playground:loading', true);
      console.log(`[Playground] Calling Engineer Agent...`);
      bus.emit('agent:progress', 'Calling Frontend Engineer Agent...');
      const engineerOutput = await this._callLLM(engineerSystemPrompt, queryText, 'claude-sonnet-4-6', false, 8192, history);

      let pilCode = "";
      const codeMatch = engineerOutput.match(/`{1,3}pil\s*([\s\S]*?)`{1,3}/i);
      if (codeMatch) {
        pilCode = codeMatch[1].trim();
      } else {
        pilCode = engineerOutput.trim();
      }

      let code = "";
      if (pilCode) {
        try {
          console.log("\n============= RAW PIL CODE =============\n");
          console.log(pilCode);
          console.log("\n========================================\n");
          
          const compileStart = performance.now();
          code = await this.compiler.compile(pilCode);
          console.log(`[Playground] Compilation finished in ${(performance.now() - compileStart).toFixed(2)}ms`);
          
          console.log("\n=========== COMPILED HTML ==============\n");
          console.log(code.substring(0, 500) + (code.length > 500 ? "\n... [TRUNCATED]" : ""));
          console.log("\n========================================\n");
        } catch (err) {
          console.error("[Playground] PIL Compilation Error:", err);
          code = `<h1>Error compiling PIL to HTML</h1><pre>${err.message}</pre>`;
        }
      } else {
        code = "<h1>Error: No PIL code found in Engineer response</h1>";
      }

      console.log(`[Playground] Engineer finished. Emitting code.`);
      bus.emit('playground:code:generated', code);
      bus.emit('playground:loading', false);
    } catch (e) {
      console.error(`[Playground] Engineer API Error:`, e);
      bus.emit('playground:loading', false);
    }

    return { responseText: aiResponse, fullOutput: "", parsedHtml: code };
  }

  async _kickoffEditor(queryText, currentHtml, history) {
    const editorSystemPrompt = `You are an elite frontend editor. 
The user wants to edit their current web page UI.
User request: ${queryText}

CURRENT HTML:
\`\`\`html
${currentHtml}
\`\`\`

INSTRUCTIONS:
You must output one or more edit blocks to apply the requested changes.
For each element you want to replace, output EXACTLY like this:
<edit>
<selector>VALID_CSS_SELECTOR</selector>
<newHtml>
<!-- The complete new outerHTML for the selected element -->
</newHtml>
</edit>

RULES:
1. Select the smallest, most specific element possible to replace. NEVER use 'html', 'head', 'body', or broad wrappers as your selector unless explicitly asked to redesign the entire page.
2. The <newHtml> MUST be the raw, complete, and valid outerHTML. It will fully replace the existing node matched by the selector. If you select a '<div id="box">', your <newHtml> MUST start with '<div id="box">' and end with '</div>'.
3. Do NOT wrap the contents of <newHtml> in markdown formatting (like \`\`\`html). Just output the raw HTML directly inside the tag.
4. To modify Tailwind classes, simply duplicate the existing HTML node and change the classes inside <newHtml>.
5. You MUST start your response with a <tts> tag containing a short, conversational, 1-2 sentence summary of what you are editing. This is what the voice will speak out loud. Example: <tts>I'll update the event date to 2026 and adjust the font size.</tts>`;

    try {
      console.log(`[Playground] Calling Editor Agent...`);
      bus.emit('agent:progress', 'Calling Frontend Editor Agent...');
      const editorOutput = await this._callLLM(editorSystemPrompt, queryText, 'claude-sonnet-4-6', false, 8192, history);

      const edits = [];
      let editBlocks = editorOutput.match(/<edit>[\s\S]*?<\/edit>/gi) || [];
      if (editBlocks.length === 0) {
        // Fallback: look for <selector> and <newHtml> directly in case the LLM forgot the <edit> wrapper
        const selectorMatch = editorOutput.match(/<selector>([\s\S]*?)<\/selector>/i);
        const htmlMatch = editorOutput.match(/<newHtml>([\s\S]*?)<\/newHtml>/i);
        if (selectorMatch && htmlMatch) {
            editBlocks = [`<edit>${selectorMatch[0]}${htmlMatch[0]}</edit>`];
        }
      }
      
      for (const block of editBlocks) {
        const selectorMatch = block.match(/<selector>([\s\S]*?)<\/selector>/i);
        const htmlMatch = block.match(/<newHtml>([\s\S]*?)<\/newHtml>/i);
        if (selectorMatch && htmlMatch) {
          let cleanedHtml = htmlMatch[1].trim();
          // Remove potential markdown codeblock formatting inside the newHtml tags
          cleanedHtml = cleanedHtml.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
          edits.push({
            selector: selectorMatch[1].trim(),
            newHtml: cleanedHtml
          });
        }
      }

      console.log(`[Playground] Editor finished. Extracted ${edits.length} edits.`);
      bus.emit('playground:code:edited', { edits });
      
      let ttsResponse = "I've applied the requested edits to the UI.";
      const ttsMatch = editorOutput.match(/<tts>([\s\S]*?)<\/tts>/i);
      if (ttsMatch) {
         ttsResponse = ttsMatch[1].trim();
      }
      return ttsResponse;
    } catch (e) {
      console.error(`[Playground] Editor API Error:`, e);
      return "I encountered an error while trying to edit the UI.";
    }
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
3. Extract 1 to 3 highly specific core nouns/entities into "keywords" representing the actual SUBJECT MATTER of the conversation. If the user asks to "build a UI" or "write code", DO NOT extract words like "UI", "code", "canvas", or "playground". Instead, look at the recent context and extract the underlying topic (e.g., if talking about a "financial app", extract "finance app accounting"). DO NOT include generic words like "conversation", "memory", "recall", "AI", "sister", "code", "UI".
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
        endpoint = `${import.meta.env.BASE_URL}api/anthropic/v1/messages`;
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
        endpoint = `${import.meta.env.BASE_URL}api/openai/v1/chat/completions`;
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
        endpoint = `${import.meta.env.BASE_URL}api/openai/v1/chat/completions`;
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
        // Boost VDB scores significantly to ensure semantic matches outrank basic keyword matches
        merged.push({ id: r.id, label: r.text, type: 'vdb', score: r.score * 50.0, source: `VDB: ${r.domain}` });
      }
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, 8); // Reduced to 8 to prevent context bloat with transcripts
  }

  async _getSystemPrompt() {
    try {
      // Always fetch fresh to reflect any edits made by the user
      const timestamp = Date.now();
      const [pRes, aRes] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}persona.md?t=${timestamp}`),
        fetch(`${import.meta.env.BASE_URL}agent.md?t=${timestamp}`)
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
        targetModel = 'moonshot-v1-128k';
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
    // We no longer need historyStr in the prompt because _callLLM uses native chat history arrays!
    const contextIntegrationPrompt = `==== RETRIEVED MEMORY CONTEXT ====
${contextStr}
==================================`;

    let finalSystemPrompt = systemPrompt;
    if (this.interviewMode) {
      if (query === '__START_INTERVIEW__') {
        finalSystemPrompt += `\n\n[INTERVIEW MODE ACTIVE: QUESTION 1 OF 5] You are initiating a 5-question interview to get to know the user better. Look at the retrieved memory context to understand what we already know. Find a missing gap in our knowledge and ask the FIRST question. Ask EXACTLY ONE question. DO NOT ask multiple questions. DO NOT answer on behalf of the user. Your question must be conversational.`;
      } else {
        this.interviewQuestionCount++;
        if (this.interviewQuestionCount >= 5) {
          finalSystemPrompt += `\n\n[INTERVIEW MODE ACTIVE: FINAL SUMMARY] The user has answered the 5th and final question. React to their answer naturally, thank them for sharing, and write a brief summary of what you learned about them during this session. DO NOT ask any more questions.`;
          // Schedule mode reset
          setTimeout(() => {
             bus.emit('interview:completed');
             bus.emit('voice:query', 'save session');
          }, 2000);
        } else {
          finalSystemPrompt += `\n\n[INTERVIEW MODE ACTIVE: QUESTION ${this.interviewQuestionCount + 1} OF 5] We are currently in a 5-question interview. The user just answered question ${this.interviewQuestionCount}. React briefly to their answer, then look at our knowledge base and ask the NEXT question. Ask EXACTLY ONE question. DO NOT ask multiple questions.`;
        }
      }
    }

    const fullSystemPrompt = `${finalSystemPrompt}\n\n${contextIntegrationPrompt}`;
    
    let userPrompt = `My Input/Thought: "${query}"\nIntent: ${intent}`;
    if (this.interviewMode && query === '__START_INTERVIEW__') {
      userPrompt = `Please start the interview now. Introduce yourself and ask the first question.`;
    }

    // Call the unified LLM runner with native history array!
    return await this._callLLM(fullSystemPrompt, userPrompt, targetModel, false, 1024, history);
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

  async _callLLM(systemPrompt, userPrompt, targetModelParam = null, jsonMode = false, customMaxTokens = null, history = []) {
    const openaiKey = import.meta.env?.VITE_OPENAI_API_KEY;
    const claudeKey = import.meta.env?.VITE_CLAUDE_API_KEY;
    const moonshotKey = import.meta.env?.VITE_MOONSHOT_API_KEY;
    const geminiKey = import.meta.env?.VITE_GEMINI_API_KEY;

    let targetModel = targetModelParam || this._model || 'moonshot-v1-128k';
    if (targetModel === 'gemini-3.0-flash') targetModel = 'gemini-3-flash';
    else if (targetModel === 'gemini-3.0-pro') targetModel = 'gemini-3.1-pro-preview';

    let apiProvider = 'moonshot';
    if (targetModel.includes('gpt-')) apiProvider = 'openai';
    if (targetModel.includes('claude-')) apiProvider = 'claude';
    if (targetModel.includes('gemini-')) apiProvider = 'gemini';

    let maxTokens = customMaxTokens || 1024;
    let endpoint, headers, body;

    const buildPayload = (provider, key, model) => {
      if (provider === 'openai') {
        endpoint = `${import.meta.env?.BASE_URL || '/talktomyself/'}api/openai/v1/chat/completions`;
        headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
        body = JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
            { role: 'user', content: userPrompt }
          ],
          response_format: jsonMode ? { type: 'json_object' } : undefined,
          max_tokens: maxTokens
        });
      } else if (provider === 'claude') {
        endpoint = `${import.meta.env?.BASE_URL || '/talktomyself/'}api/anthropic/v1/messages`;
        headers = {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json'
        };
        body = JSON.stringify({
          model: model,
          system: systemPrompt,
          messages: [
            ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
            { role: 'user', content: userPrompt }
          ],
          max_tokens: maxTokens
        });
      } else if (provider === 'gemini') {
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
            { role: 'user', parts: [{ text: userPrompt }] }
          ],
          generationConfig: { maxOutputTokens: maxTokens, responseMimeType: jsonMode ? "application/json" : "text/plain" }
        });
      } else if (provider === 'moonshot') {
        endpoint = 'https://api.moonshot.ai/v1/chat/completions';
        headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
        body = JSON.stringify({
          model: 'moonshot-v1-128k',
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
            { role: 'user', content: userPrompt }
          ],
          response_format: jsonMode ? { type: 'json_object' } : undefined,
          max_tokens: maxTokens
        });
      }
    };

    const getProviderKey = (p) => {
      if (p === 'openai') return openaiKey;
      if (p === 'claude') return claudeKey;
      if (p === 'gemini') return geminiKey;
      if (p === 'moonshot') return moonshotKey;
      return null;
    };

    if (!getProviderKey(apiProvider)) apiProvider = 'moonshot';

    buildPayload(apiProvider, getProviderKey(apiProvider), targetModel);

    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', headers, body });
    } catch (e) {
      response = { ok: false, status: 500, text: async () => e.message };
    }

    // Explicit fallback for Gemini Rate Limits (429) -> Gemini 3 Flash
    if (!response.ok && response.status === 429 && apiProvider === 'gemini' && targetModel !== 'gemini-3-flash') {
      console.warn(`[LLM] Gemini Rate Limit (429) hit for ${targetModel}. Falling back to gemini-3-flash...`);
      buildPayload('gemini', geminiKey, 'gemini-3-flash');
      try { response = await fetch(endpoint, { method: 'POST', headers, body }); } catch (e) { }
    }

    if (!response.ok && apiProvider !== 'moonshot' && moonshotKey) {
      console.warn(`[LLM] ${apiProvider} failed. Falling back to Moonshot...`);
      apiProvider = 'moonshot';
      buildPayload('moonshot', moonshotKey, 'moonshot-v1-128k');
      try { response = await fetch(endpoint, { method: 'POST', headers, body }); } catch (e) { }
    }

    if (!response.ok && apiProvider !== 'gemini' && geminiKey) {
      console.warn(`[LLM] ${apiProvider} failed. Falling back to Gemini...`);
      apiProvider = 'gemini';
      buildPayload('gemini', geminiKey, 'gemini-3.1-pro-preview');
      try { response = await fetch(endpoint, { method: 'POST', headers, body }); } catch (e) { }
    }

    if (!response.ok && apiProvider !== 'openai' && openaiKey) {
      console.warn(`[LLM] ${apiProvider} failed. Falling back to OpenAI...`);
      apiProvider = 'openai';
      buildPayload('openai', openaiKey, 'gpt-4o');
      try { response = await fetch(endpoint, { method: 'POST', headers, body }); } catch (e) { }
    }

    if (!response.ok) {
      const errText = typeof response.text === 'function' ? await response.text() : response;
      throw new Error(`API Error (${apiProvider}): ${response.status} - ${errText}`);
    }

    const data = await response.json();
    let text = "";
    if (apiProvider === 'claude') {
      text = data.content[0].text;
    } else if (apiProvider === 'gemini') {
      text = data.candidates[0].content.parts[0].text;
    } else {
      text = data.choices[0].message.content;
    }

    return text;
  }
}
