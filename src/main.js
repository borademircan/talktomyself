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

    const res = await fetch('/api/load');
    const { kg: kgData } = await res.json();

    // Hydrate Knowledge Graph
    kg.fromJSON(kgData);

    await sessionManager.loadSessions();
    // sessionManager.startCron(30 * 60 * 1000); // 30 minutes (Disabled as requested)
  } catch (err) {
    console.error('[Cognitive AI] Failed to load data from disk:', err);
  }
}
initializeSystem();

// ── Persistence Hooks ───────────────────────────────────────
let saveTimeout;
function saveState(e) {
  // Ignore visual node updates (like hover glow or physics)
  if (e && e.type === 'node:updated') return;
  
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kg: kg.toJSON(), vdb: vdb.toJSON() })
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
      <select id="model-select" class="btn btn-secondary btn-sm" style="margin-right: 8px; max-width: 150px;" title="Select Model">
        <option value="moonshot-v1-8k">moonshot-v1-8k</option>
        <option value="moonshot-v1-32k">moonshot-v1-32k</option>
        <option value="moonshot-v1-128k">moonshot-v1-128k</option>
        <option value="gemini-2.5-flash">gemini-2.5-flash</option>
        <option value="gemini-2.5-pro">gemini-2.5-pro</option>
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
