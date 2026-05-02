/**
 * Inspector Panel — Right panel: node detail, debug, query trace
 */
import { bus } from '../core/event-bus.js';
import { NODE_COLORS, EDGE_COLORS } from '../core/knowledge-graph.js';

export class InspectorPanel {
  constructor(container, kg) {
    this.el = container;
    this.kg = kg;
    this.debugMode = false;
    this.selectedNode = null;
    this.lastTrace = null;
    this._build();
    this._listen();
  }

  _build() {
    this.el.innerHTML = `
      <div class="inspector-tabs">
        <button class="inspector-tab active" data-tab="node">Node</button>
        <button class="inspector-tab" data-tab="debug">Debug</button>
        <button class="inspector-tab" data-tab="trace">Trace</button>
      </div>
      <div class="inspector-content" id="inspector-content">
        <div class="inspector-empty">
          <div class="inspector-empty__icon">🔍</div>
          <div>Select a node to inspect</div>
          <div style="font-size:11px; color:var(--text-quaternary);">Click any node in the graph</div>
        </div>
      </div>
    `;
    this.tabs = this.el.querySelectorAll('.inspector-tab');
    this.content = this.el.querySelector('#inspector-content');
    this.activeTab = 'node';

    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeTab = tab.dataset.tab;
        this._render();
      });
    });
  }

  _listen() {
    bus.on('graph:node:selected', (node) => {
      this.selectedNode = node;
      if (this.activeTab === 'node') this._render();
    });

    bus.on('query:complete', (result) => {
      this.lastTrace = result.trace;
      this.lastResult = result;
      if (this.activeTab === 'debug' || this.activeTab === 'trace') this._render();
    });
  }

  _render() {
    if (this.activeTab === 'node') this._renderNode();
    else if (this.activeTab === 'debug') this._renderDebug();
    else if (this.activeTab === 'trace') this._renderTrace();
  }

  _renderNode() {
    const node = this.selectedNode;
    if (!node) {
      this.content.innerHTML = `<div class="inspector-empty"><div class="inspector-empty__icon">🔍</div><div>Select a node to inspect</div></div>`;
      return;
    }

    const colors = NODE_COLORS[node.type] || { fill: '#666', glow: 'rgba(100,100,100,0.3)', light: '#999' };
    const edges = this.kg.getEdgesForNode(node.id);
    const neighbors = this.kg.getNeighbors(node.id, 1);
    const icons = { concept: '🧠', domain: '🗂', document: '📄', entity: '🔗' };

    this.content.innerHTML = `
      <div class="node-detail__header">
        <div class="node-detail__icon" style="background:${colors.glow}; color:${colors.light};">${icons[node.type] || '●'}</div>
        <div>
          <div class="node-detail__name">${node.label}</div>
          <div class="node-detail__type" style="color:${colors.light};">${node.type}</div>
        </div>
      </div>

      ${node.metadata.description ? `
        <div class="detail-field">
          <div class="detail-field__label">Description</div>
          <div class="detail-field__value">${node.metadata.description}</div>
        </div>` : ''}

      ${node.metadata.tags ? `
        <div class="detail-field">
          <div class="detail-field__label">Tags</div>
          <div style="display:flex; flex-wrap:wrap; gap:4px;">
            ${node.metadata.tags.map(t => `<span style="padding:2px 8px; background:var(--bg-active); border-radius:var(--radius-full); font-size:11px; color:var(--text-secondary);">${t}</span>`).join('')}
          </div>
        </div>` : ''}

      ${node.metadata.domain ? `
        <div class="detail-field">
          <div class="detail-field__label">Vector DB</div>
          <div class="detail-field__value" style="color:${colors.light};">${node.metadata.domain}</div>
        </div>` : ''}

      <div class="detail-field">
        <div class="detail-field__label">Connections (${edges.length})</div>
        <ul class="connected-list">
          ${neighbors.map(n => {
            const nc = NODE_COLORS[n.type] || { fill: '#666', glow: 'rgba(100,100,100,0.3)', light: '#999' };
            const edge = edges.find(e => e.source === n.id || e.target === n.id || (typeof e.source === 'object' && (e.source.id === n.id || e.target.id === n.id)));
            return `<li class="connected-item" data-id="${n.id}">
              <span class="connected-item__dot" style="background:${nc.fill};"></span>
              <span>${n.label}</span>
              <span class="connected-item__edge">${edge?.type || '—'}</span>
            </li>`;
          }).join('')}
        </ul>
      </div>

      <div class="detail-field">
        <div class="detail-field__label">Node ID</div>
        <div class="detail-field__value" style="font-family:var(--font-mono); font-size:11px; color:var(--text-tertiary);">${node.id}</div>
      </div>
    `;

    // Click to navigate to connected nodes
    this.content.querySelectorAll('.connected-item').forEach(item => {
      item.addEventListener('click', () => {
        const targetNode = this.kg.getNode(item.dataset.id);
        if (targetNode) {
          this.selectedNode = targetNode;
          bus.emit('graph:node:selected', targetNode);
          this._renderNode();
        }
      });
    });
  }

  _renderDebug() {
    if (!this.lastResult) {
      this.content.innerHTML = `<div class="inspector-empty"><div class="inspector-empty__icon">🧪</div><div>Run a query to see debug info</div></div>`;
      return;
    }

    const r = this.lastResult;
    const domainColors = { knowledge: '#9333ea', documents: '#0ea5e9', conversations: '#f97316', creative: '#22c55e' };

    this.content.innerHTML = `
      <div class="detail-field">
        <div class="detail-field__label">Query</div>
        <div class="detail-field__value" style="font-style:italic;">"${r.query}"</div>
      </div>

      <div class="detail-field">
        <div class="detail-field__label">Intent</div>
        <div class="detail-field__value">${r.intent}</div>
      </div>

      <div class="detail-field">
        <div class="detail-field__label">Tokens (${r.tokens.length})</div>
        <div style="display:flex; flex-wrap:wrap; gap:4px;">
          ${r.tokens.map(t => `<span style="padding:2px 8px; background:var(--overlay-primary-10); border:1px solid var(--chakra-crown-glow); border-radius:var(--radius-full); font-size:11px; color:var(--chakra-crown-light); font-family:var(--font-mono);">${t}</span>`).join('')}
        </div>
      </div>

      <div class="detail-field">
        <div class="detail-field__label">KG Nodes Activated (${r.activatedNodes.length})</div>
        ${r.activatedNodes.slice(0, 6).map(({ node, score }) => `
          <div class="score-bar">
            <span class="score-bar__label">${node.label.slice(0, 14)}</span>
            <div class="score-bar__track"><div class="score-bar__fill" style="width:${Math.min(100, score * 25)}%; background:${NODE_COLORS[node.type]?.fill || '#9333ea'};"></div></div>
            <span class="score-bar__value">${score.toFixed(1)}</span>
          </div>
        `).join('')}
      </div>

      <div class="detail-field">
        <div class="detail-field__label">Vector DB Hits</div>
        ${Object.entries(r.dbHits).map(([domain, count]) => `
          <div class="score-bar">
            <span class="score-bar__label">${domain}</span>
            <div class="score-bar__track"><div class="score-bar__fill" style="width:${count * 20}%; background:${domainColors[domain] || '#666'};"></div></div>
            <span class="score-bar__value">${count}</span>
          </div>
        `).join('')}
      </div>

      <div class="detail-field">
        <div class="detail-field__label">Performance</div>
        <div class="detail-field__value" style="font-family:var(--font-mono); font-size:12px;">${Math.round(r.totalTime)}ms total</div>
      </div>
    `;
  }

  _renderTrace() {
    if (!this.lastTrace) {
      this.content.innerHTML = `<div class="inspector-empty"><div class="inspector-empty__icon">📊</div><div>Run a query to see the trace</div></div>`;
      return;
    }

    this.content.innerHTML = `
      <div class="detail-field">
        <div class="detail-field__label">Query Pipeline Trace</div>
      </div>
      <ul class="query-trace">
        ${this.lastTrace.map((step, i) => `
          <li class="trace-step complete">
            <div class="trace-step__name">${step.name}</div>
            <div class="trace-step__detail">${step.detail}</div>
            <div class="trace-step__time">${step.duration.toFixed(1)}ms</div>
          </li>
        `).join('')}
      </ul>
    `;
  }
}
