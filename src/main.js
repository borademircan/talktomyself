/**
 * Main — Application bootstrap
 * Wires all modules together: KG, VDB, Voice, Graph, Inspector
 */
import './styles/index.css';
import './styles/layout.css';
import './styles/voice-panel.css';
import './styles/graph.css';
import './styles/inspector.css';
import './styles/animations.css';

import { bus } from './core/event-bus.js';
import { apiFetch } from './core/api.js';
import { KnowledgeGraph, NODE_COLORS } from './core/knowledge-graph.js';
import { VectorDBOrchestrator } from './core/vector-db-simulator.js';
import { QueryRouter } from './core/query-router.js';
import { SessionManager } from './core/session-manager.js';
import { GraphRenderer } from './graph/graph-renderer.js';
import { OpenAISttEngine } from './voice/openai-stt-engine.js';
import { ElevenLabsTtsEngine } from './voice/elevenlabs-tts-engine.js';
import { ElevenLabsStsEngine } from './voice/elevenlabs-sts-engine.js';
import { ElevenLabsAgentEngine } from './voice/elevenlabs-agent-engine.js';
import { VoicePanel } from './voice/voice-panel.js';
import { InspectorPanel } from './inspector/inspector-panel.js';
// ── Initialize Systems ─────────────────────────────
const kg = new KnowledgeGraph();
const vdb = new VectorDBOrchestrator();
const sessionManager = new SessionManager(kg);
const router = new QueryRouter(kg, vdb, sessionManager);
const stt = new OpenAISttEngine();
const tts = new ElevenLabsTtsEngine();
const sts = new ElevenLabsStsEngine();
const agentEngine = new ElevenLabsAgentEngine(router);

// ── Auto-index Graph Nodes to Vector DB ─────────────────────
function indexNode(node) {
  const domain = node.metadata?.domain || (node.type === 'document' ? 'documents' : 'knowledge');
  const text = `${node.label}. ${node.metadata?.description || ''} ${node.metadata?.tags ? node.metadata.tags.join(' ') : ''}`.trim();
  vdb.addDocument(domain, node.id, text, { type: node.type, label: node.label, timestamp: node.metadata?.timestamp });
}
bus.on('graph:node:added', indexNode);
bus.on('graph:node:updated', indexNode);

// ── Load Data ───────────────────────────────────────
async function initializeSystem() {
  try {
    // Pre-warm backend integration
    vdb.init();

    const res = await fetch(import.meta.env.BASE_URL + 'api/load');
    const { kg: kgData } = await res.json();

    // Hydrate Knowledge Graph
    kg.fromJSON(kgData);

    await sessionManager.loadSessions();
    // sessionManager.startCron(30 * 60 * 1000); // 30 minutes (Disabled as requested)
  } catch (err) {
    console.error('[Cognitive AI] Failed to load data from disk:', err);
  }
}
// ── Authentication & Fetch Override ──────────────────────────
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  let [resource, config] = args;
  let url = (resource instanceof URL) ? resource.href : resource;

  if (url.includes('/api/')) {
    config = config || {};
    config.headers = config.headers || {};
    const token = localStorage.getItem('app_auth');
    if (token) {
      if (config.headers instanceof Headers) {
        config.headers.set('X-App-Auth', token);
      } else {
        config.headers['X-App-Auth'] = token;
      }
    }
  }

  const response = await originalFetch(resource, config);
  const isExternalApi = url.includes('/api/openai') || url.includes('/api/anthropic') || url.includes('/api/google-tts') || url.includes('/api/elevenlabs');
  if (response.status === 401 && url.includes('/api/') && !isExternalApi) {
    document.getElementById('login-overlay').style.display = 'flex';
    localStorage.removeItem('app_auth');
  }
  return response;
};

// Handle Login UI
const overlay = document.getElementById('login-overlay');
const loginBtn = document.getElementById('login-submit');
const passwordInput = document.getElementById('login-password');
const errorMsg = document.getElementById('login-error');

async function handleLogin() {
  const pw = passwordInput.value.trim();
  if (!pw) return;
  loginBtn.innerHTML = 'Unlocking...';
  
  try {
    const res = await originalFetch(import.meta.env.BASE_URL + 'api/verify_login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pw })
    });
    
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('app_auth', data.token);
      overlay.style.display = 'none';
      errorMsg.style.display = 'none';
      initializeSystem();
    } else {
      errorMsg.style.display = 'block';
      errorMsg.textContent = data.error || 'Invalid password';
    }
  } catch (err) {
    errorMsg.style.display = 'block';
    errorMsg.textContent = 'Server connection error';
  }
  loginBtn.innerHTML = 'Unlock';
}

if (loginBtn) {
  loginBtn.addEventListener('click', handleLogin);
  passwordInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleLogin(); });
}

// Auto-login check
if (localStorage.getItem('app_auth')) {
  if (overlay) overlay.style.display = 'none';
  initializeSystem();
}
// ── Persistence Hooks ───────────────────────────────────────
let saveTimeout;
let dirtyNodes = new Set();
let dirtyEdges = new Set();

function saveState(e) {
  // Ignore visual node updates
  if (e && e.type === 'node:updated') return;

  if (e && e.node && e.type === 'node:added') {
    dirtyNodes.add(e.node);
  }
  if (e && e.edge && e.type === 'edge:added') {
    dirtyEdges.add(e.edge);
  }
  
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (dirtyNodes.size === 0 && dirtyEdges.size === 0) return;

    const nodesArray = Array.from(dirtyNodes).map(n => ({ id: n.id, type: n.type, label: n.label, metadata: n.metadata }));
    const edgesArray = Array.from(dirtyEdges).map(e => ({ id: e.id, source: e.source, target: e.target, type: e.type, weight: e.weight, metadata: e.metadata }));
    
    dirtyNodes.clear();
    dirtyEdges.clear();

    fetch(import.meta.env.BASE_URL + 'api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kg: { nodes: nodesArray, edges: edgesArray } })
    }).catch(err => console.error('[Cognitive AI] Failed to save state to workspace', err));
  }, 2000);
}

bus.on('graph:changed', saveState);
bus.on('vdb:changed', saveState);

// ── Build UI ────────────────────────────────────────
const app = document.getElementById('app');
app.innerHTML = `
  <header class="app-header">
    <div class="app-header__left">
      <div class="app-header__logo">
        <div class="app-header__logo-icon">🧠</div>
        <span>Cognitive AI</span>
      </div>
      <div class="app-header__divider"></div>
      <div class="app-header__breadcrumb">
        <span>Knowledge Graph</span>
        <span class="app-header__breadcrumb-sep" style="color:var(--text-quaternary);">›</span>
        <span style="color:var(--text-secondary);">Explorer</span>
      </div>
    </div>
    <div class="app-header__right">
      <label style="font-size: 12px; display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary); margin-right: 8px;" title="Render HTML/CSS/JS Playground">
        <input type="checkbox" id="toggle-playground" style="accent-color: #6366f1;">
        <span>Web Playground</span>
      </label>
      <label style="font-size: 12px; display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary); margin-right: 8px;" title="5 Q&A Interview Mode">
        <input type="checkbox" id="toggle-interview" style="accent-color: #ec4899;">
        <span>5 Q&A</span>
      </label>
      <select id="playground-history" class="btn btn-secondary btn-sm" style="margin-right: 8px; max-width: 150px; display: none;" title="Playground History">
      </select>
      <select id="model-select" class="btn btn-secondary btn-sm" style="margin-right: 8px; max-width: 150px;" title="Select Model">
        <option value="moonshot-v1-8k">moonshot-v1-8k</option>
        <option value="moonshot-v1-32k">moonshot-v1-32k</option>
        <option value="moonshot-v1-128k">moonshot-v1-128k</option>
        <option value="gemini-3.0-flash">gemini-3.0-flash</option>
        <option value="gemini-3.0-pro">gemini-3.0-pro</option>
        <option value="gpt-4o-mini">gpt-4o-mini</option>
        <option value="claude-sonnet-4-6" selected>claude-sonnet-4.6</option>
      </select>
      <select id="length-select" class="btn btn-secondary btn-sm" style="margin-right: 8px; max-width: 100px;" title="Response Length">
        <option value="auto">Auto</option>
        <option value="short">Short</option>
        <option value="medium">Medium</option>
        <option value="long">Long</option>
      </select>
      <button class="btn btn-secondary btn-sm" id="btn-update-persona" title="Evaluate graph and update persona" style="margin-right: 8px; display: flex; align-items: center; gap: 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        Reflect Persona
      </button>
      <button class="header-btn" id="btn-fit" title="Fit to view">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
      <button class="header-btn" id="btn-debug" title="Toggle Debug">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
      </button>
    </div>
  </header>

  <div class="panel-left" id="panel-left"></div>

  <div class="panel-center" id="panel-center">
    <canvas id="graph-canvas"></canvas>
    <div id="playground-loading" style="display:none; position:absolute; inset:0; z-index:20; background:rgba(15,16,21,0.8); backdrop-filter:blur(8px); flex-direction:column; justify-content:center; align-items:center; color:#00FFD1; font-family:monospace; border-radius:8px;">
      <div style="width:40px;height:40px;border:2px solid rgba(0,255,209,0.2);border-top-color:#00FFD1;border-radius:50%;animation:pg-spin 1s linear infinite;margin-bottom:16px;"></div>
      <div style="font-size:12px; letter-spacing:0.2em; text-transform:uppercase;">Synthesizing UI...</div>
      <style>@keyframes pg-spin { 100% { transform: rotate(360deg); } }</style>
    </div>
    <iframe id="playground-iframe" style="display:none; width: 100%; height: 100%; border: none; background-color: #0f1015; background-image: linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px); background-size: 20px 20px; border-radius: 8px;"></iframe>

    <div class="graph-search" style="position: absolute; top: var(--sp-4); right: var(--sp-4); z-index: 10;">
      <input type="text" id="node-search" class="form-input" placeholder="Search nodes..." style="width: 300px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); border-radius: 20px; padding: 8px 16px; background: rgba(30,30,35,0.8); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1);">
    </div>

    <div class="graph-filters" id="graph-filters">
      <button class="filter-chip active" data-type="concept">
        <span class="filter-chip__dot" style="background:#9333ea;"></span>
        Concepts
      </button>
      <button class="filter-chip active" data-type="domain">
        <span class="filter-chip__dot" style="background:#4f46e5;"></span>
        Domains
      </button>
      <button class="filter-chip active" data-type="document">
        <span class="filter-chip__dot" style="background:#0ea5e9;"></span>
        Documents
      </button>
      <button class="filter-chip active" data-type="entity">
        <span class="filter-chip__dot" style="background:#22c55e;"></span>
        Entities
      </button>
    </div>

    <div class="graph-controls">
      <button id="btn-zoom-in" title="Zoom in">+</button>
      <button id="btn-zoom-out" title="Zoom out">−</button>
      <button id="btn-zoom-fit" title="Fit view">⊡</button>
    </div>

    <div class="node-tooltip" id="node-tooltip">
      <div class="node-tooltip__type" id="tooltip-type"></div>
      <div class="node-tooltip__label" id="tooltip-label"></div>
      <div class="node-tooltip__meta" id="tooltip-meta"></div>
    </div>
  </div>

  <div class="panel-right" id="panel-right"></div>

  <div class="status-bar">
    <div class="status-bar__left">
      <div class="status-bar__item">
        <span class="status-bar__dot"></span>
        <span>System Active</span>
      </div>
      <div class="status-bar__item" id="status-nodes">
        Nodes: ${kg.nodeCount}
      </div>
      <div class="status-bar__item" id="status-edges">
        Edges: ${kg.edgeCount}
      </div>
    </div>
    <div class="status-bar__right">
      <div class="status-bar__item" id="status-vdbs">
        VDBs: ${Object.entries(vdb.getStats()).map(([k, v]) => `${k}(${v})`).join(' · ')}
      </div>
      <div class="status-bar__item">
        <span style="font-family:var(--font-mono);">v1.0.0</span>
      </div>
    </div>
  </div>
`;

// ── Model Selection Logic ────────────────────────────────────
const modelSelect = document.getElementById('model-select');
const lengthSelect = document.getElementById('length-select');
const savedModel = localStorage.getItem('moonshot_model') || 'gemini-2.5-flash';
const savedLength = localStorage.getItem('response_length') || 'auto';

modelSelect.value = savedModel;
lengthSelect.value = savedLength;

router.setModel(savedModel);
router.setLength(savedLength);
sessionManager.setModel(savedModel);

modelSelect.addEventListener('change', (e) => {
  const newModel = e.target.value;
  localStorage.setItem('moonshot_model', newModel);
  router.setModel(newModel);
  sessionManager.setModel(newModel);
  console.log('[Cognitive AI] Model switched to:', newModel);
});

lengthSelect.addEventListener('change', (e) => {
  const newLength = e.target.value;
  localStorage.setItem('response_length', newLength);
  router.setLength(newLength);
  console.log('[Cognitive AI] Response length switched to:', newLength);
});

// ── Initialize Components ───────────────────────────
const graphCanvas = document.getElementById('graph-canvas');
const renderer = new GraphRenderer(graphCanvas, kg);

const voicePanel = new VoicePanel(document.getElementById('panel-left'), stt, tts, sessionManager, agentEngine);
const inspectorPanel = new InspectorPanel(document.getElementById('panel-right'), kg);

// ── Zoom Controls ───────────────────────────────────
document.getElementById('btn-zoom-in').addEventListener('click', () => renderer.zoomIn());
document.getElementById('btn-zoom-out').addEventListener('click', () => renderer.zoomOut());
document.getElementById('btn-zoom-fit').addEventListener('click', () => renderer.zoomToFit());
document.getElementById('btn-fit').addEventListener('click', () => renderer.zoomToFit());

document.getElementById('btn-update-persona').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '⏳ Reflecting...';
  btn.disabled = true;
  await router.route('update persona');
  btn.innerHTML = originalHtml;
  btn.disabled = false;
});

// ── Filter Chips ────────────────────────────────────
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('active');
    renderer.setFilter(chip.dataset.type, chip.classList.contains('active'));
  });
});

// ── Search Input ────────────────────────────────────
document.getElementById('node-search').addEventListener('input', (e) => {
  renderer.setSearchQuery(e.target.value);
});

// ── Tooltip ─────────────────────────────────────────
const tooltip = document.getElementById('node-tooltip');
const tooltipType = document.getElementById('tooltip-type');
const tooltipLabel = document.getElementById('tooltip-label');
const tooltipMeta = document.getElementById('tooltip-meta');

bus.on('graph:node:hover', (node) => {
  if (node) {
    const colors = NODE_COLORS[node.type];
    tooltipType.textContent = node.type;
    tooltipType.style.color = colors.light;
    tooltipLabel.textContent = node.label;
    tooltipMeta.textContent = node.metadata.description || `ID: ${node.id}`;
    tooltip.classList.add('visible');

    const [sx, sy] = renderer._worldToScreen(node.x, node.y);
    const centerEl = document.getElementById('panel-center');
    const rect = centerEl.getBoundingClientRect();
    tooltip.style.left = (sx + rect.left + 16) + 'px';
    tooltip.style.top = (sy + rect.top - 10) + 'px';
  } else {
    tooltip.classList.remove('visible');
  }
});

// ── Query Pipeline ──────────────────────────────────
bus.on('voice:query', async (text) => {
  await router.route(text);
});

// ── Playground Flow ─────────────────────────────────
bus.on('playground:toggle', (enabled) => {
  const canvas = document.getElementById('graph-canvas');
  const iframe = document.getElementById('playground-iframe');
  const filters = document.getElementById('graph-filters');
  const controls = document.querySelector('.graph-controls');
  const search = document.querySelector('.graph-search');
  const appElement = document.getElementById('app');

  if (enabled) {
    appElement.classList.add('playground-mode');
    canvas.style.display = 'none';
    if(filters) filters.style.display = 'none';
    if(controls) controls.style.display = 'none';
    if(search) search.style.display = 'none';
    iframe.style.display = 'block';
  } else {
    appElement.classList.remove('playground-mode');
    canvas.style.display = 'block';
    if(filters) filters.style.display = 'flex';
    if(controls) controls.style.display = 'flex';
    if(search) search.style.display = 'block';
    iframe.style.display = 'none';
  }
});

bus.on('playground:loading', (isLoading) => {
  const loader = document.getElementById('playground-loading');
  if (loader) loader.style.display = isLoading ? 'flex' : 'none';
});

bus.on('playground:code:generated', async (rawCode) => {
  try {
    const iframe = document.getElementById('playground-iframe');
    if (iframe) {
      // Force inject CSS to ensure scrolling works inside the playground and inject dark grid
      let safeCode = rawCode;
      const scrollStyles = `<style>
        html, body { 
          overflow-y: auto !important; 
          margin: 0; 
          padding: 0; 
          min-height: 100vh; 
        }
      </style>`;
      
      if (safeCode.includes('</head>')) {
        safeCode = safeCode.replace('</head>', scrollStyles + '</head>');
      } else if (safeCode.includes('<style>')) {
        safeCode = safeCode.replace('<style>', scrollStyles + '<style>');
      } else {
        safeCode = scrollStyles + safeCode;
      }

      iframe.srcdoc = safeCode;
      
      // Save generation
      const sessionId = router.sessionManager.activeSessionId;
      if (sessionId) {
        await apiFetch('api/save_generation', {
          method: 'POST',
          body: JSON.stringify({ sessionId, htmlCode: safeCode })
        });
        
        // Refresh dropdown
        const generations = await fetchGenerations(sessionId);
        updatePlaygroundHistoryDropdown(generations);
      }
    }
  } catch (e) {
    console.error("[Playground] Error generating or saving code:", e);
  }
});

bus.on('playground:code:edited', async ({ edits }) => {
  try {
    const iframe = document.getElementById('playground-iframe');
    if (!iframe || !iframe.contentDocument) return;

    const iframeDoc = iframe.contentDocument;

    let applied = 0;
    let needsReload = false;
    for (const edit of edits) {
      try {
        const els = iframeDoc.querySelectorAll(edit.selector);
        if (els.length > 0) {
          els.forEach(el => {
            el.outerHTML = edit.newHtml;
            if (edit.newHtml.toLowerCase().includes('<script') || edit.selector.toLowerCase().includes('script')) {
              needsReload = true;
            }
          });
          applied++;
        } else {
          console.warn("[Playground Editor] Selector not found:", edit.selector);
        }
      } catch (e) {
        console.error("[Playground Editor] Invalid selector:", edit.selector);
      }
    }

    if (applied > 0) {
      // Serialize the live DOM to save it
      const newSrcdoc = "<!DOCTYPE html>\n" + iframeDoc.documentElement.outerHTML;
      
      // If we injected a script, we must reload the iframe to execute it safely without memory conflicts
      if (needsReload) {
        iframe.srcdoc = newSrcdoc;
      }

      
      // Save generation
      const sessionId = router.sessionManager.activeSessionId;
      if (sessionId) {
        await apiFetch('api/save_generation', {
          method: 'POST',
          body: JSON.stringify({ sessionId, htmlCode: newSrcdoc })
        });
        
        // Refresh dropdown without reloading iframe
        const generations = await fetchGenerations(sessionId);
        updatePlaygroundHistoryDropdown(generations, true);
      }
    } else {
      if (edits.length > 0) {
        bus.emit('agent:tts', `I'm sorry, I couldn't find the element "${edits[0].selector}" on the page to edit it.`);
      } else {
        bus.emit('agent:tts', `I'm sorry, my code generation failed formatting so I couldn't apply the edit.`);
      }
    }
  } catch (e) {
    console.error("[Playground] Error applying code edit:", e);
  }
});

// ── Playground History & Interview Logic ─────────────────────────────
document.getElementById('toggle-playground').addEventListener('change', (e) => {
  bus.emit('playground:toggle', e.target.checked);
});

document.getElementById('toggle-interview').addEventListener('change', (e) => {
  bus.emit('interview:toggle', e.target.checked);
});

bus.on('interview:completed', () => {
  const toggle = document.getElementById('toggle-interview');
  if (toggle) toggle.checked = false;
});

async function fetchGenerations(sessionId) {
  try {
    const res = await apiFetch(`api/load_generations?sessionId=${sessionId}`);
    return await res.json();
  } catch (e) {
    console.error("Failed to load generations", e);
    return [];
  }
}

function updatePlaygroundHistoryDropdown(generations, preventReload = false) {
  const dropdown = document.getElementById('playground-history');
  if (!dropdown) return;
  
  if (generations && generations.length > 0) {
    dropdown.style.display = 'inline-block';
    dropdown.innerHTML = '';
    generations.forEach((gen, index) => {
      const opt = document.createElement('option');
      opt.value = gen.html_content;
      const d = new Date(gen.timestamp);
      opt.textContent = `Gen ${generations.length - index} (${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})})`;
      dropdown.appendChild(opt);
    });
    
    // The most recent generation is first, load it
    if (!preventReload) {
      const iframe = document.getElementById('playground-iframe');
      if (iframe) iframe.srcdoc = generations[0].html_content;
    }
  } else {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    if (!preventReload) {
      const iframe = document.getElementById('playground-iframe');
      if (iframe) iframe.srcdoc = '';
    }
  }
}

document.getElementById('playground-history').addEventListener('change', (e) => {
  const iframe = document.getElementById('playground-iframe');
  if (iframe && e.target.value) {
    iframe.srcdoc = e.target.value;
  }
});

bus.on('session:switched', async (session) => {
  if (session && session.id) {
    const generations = await fetchGenerations(session.id);
    updatePlaygroundHistoryDropdown(generations);
  }
});

// ── Speech-to-Speech (STS) Flow ─────────────────────────────
bus.on('voice:sts_request', async (audioBlob) => {
  await sts.convertAndPlay(audioBlob);
});

// ── Context Menu (Add Node) ─────────────────────────
bus.on('graph:contextmenu', ({ x, y, node, worldX, worldY }) => {
  // Remove existing
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'context-menu animate-scale-in';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  if (node) {
    menu.innerHTML = `
      <div class="context-menu__item" data-action="inspect">🔍 Inspect Node</div>
      <div class="context-menu__item" data-action="expand">↔ Expand Neighbors</div>
      <div class="context-menu__sep"></div>
      <div class="context-menu__item context-menu__item--danger" data-action="delete">🗑 Delete Node</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="context-menu__item" data-action="add-concept">🧠 Add Concept</div>
      <div class="context-menu__item" data-action="add-document">📄 Add Document</div>
      <div class="context-menu__item" data-action="add-entity">🔗 Add Entity</div>
    `;
  }

  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'inspect') bus.emit('graph:node:selected', node);
    if (action === 'delete') {
      kg.removeNode(node.id);
      if (renderer.selectedNode === node) { renderer.selectedNode = null; bus.emit('graph:node:selected', null); }
    }
    if (action === 'add-concept') _addNodePrompt('concept', worldX, worldY);
    if (action === 'add-document') _addNodePrompt('document', worldX, worldY);
    if (action === 'add-entity') _addNodePrompt('entity', worldX, worldY);
    menu.remove();
  });

  const dismiss = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
});

function _addNodePrompt(type, wx, wy) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const icons = { concept: '🧠', document: '📄', entity: '🔗' };
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <span>${icons[type]} Add ${type.charAt(0).toUpperCase() + type.slice(1)}</span>
        <button class="btn-ghost btn-sm" id="modal-close">✕</button>
      </div>
      <div class="modal__body">
        <div class="form-group">
          <label class="form-label">Label</label>
          <input class="form-input" id="node-label" placeholder="Node label…" autofocus />
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <input class="form-input" id="node-desc" placeholder="Brief description…" />
        </div>
        <div class="form-group">
          <label class="form-label">Tags (comma-separated)</label>
          <input class="form-input" id="node-tags" placeholder="tag1, tag2, tag3" />
        </div>
      </div>
      <div class="modal__footer">
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Add Node</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#node-label').focus();

  const close = () => overlay.remove();
  overlay.querySelector('#modal-close').addEventListener('click', close);
  overlay.querySelector('#modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('#modal-save').addEventListener('click', () => {
    const label = overlay.querySelector('#node-label').value.trim();
    if (!label) return;
    const desc = overlay.querySelector('#node-desc').value.trim();
    const tags = overlay.querySelector('#node-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    kg.addNode(null, type, label, { description: desc, tags, x: wx, y: wy });
    close();
  });
}

// ── Initial zoom to fit ─────────────────────────────
setTimeout(() => renderer.zoomToFit(), 600);

// ── Update status bar on graph changes ──────────────
bus.on('graph:changed', () => {
  document.getElementById('status-nodes').textContent = `Nodes: ${kg.nodeCount}`;
  document.getElementById('status-edges').textContent = `Edges: ${kg.edgeCount}`;
});

console.log('[Cognitive AI] System initialized', {
  nodes: kg.nodeCount,
  edges: kg.edgeCount,
  vdbs: vdb.getStats(),
  sttSupported: stt.supported,
  ttsSupported: tts.supported
});
