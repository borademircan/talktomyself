/**
 * Knowledge Graph — Core data model
 * Manages nodes, edges, CRUD, querying, and neighborhood expansion.
 */
import { bus } from './event-bus.js';

export const NODE_TYPES = {
  CONCEPT:  'concept',
  DOMAIN:   'domain',
  DOCUMENT: 'document',
  ENTITY:   'entity'
};

export const EDGE_TYPES = {
  BELONGS_TO:  'belongs_to',
  RELATED_TO:  'related_to',
  INDEXED_IN:  'indexed_in',
  REFERENCES:  'references',
  DEPENDS_ON:  'depends_on'
};

export const NODE_COLORS = {
  concept:  { fill: '#9333ea', glow: 'rgba(147,51,234,0.3)', light: '#a855f7' },
  domain:   { fill: '#4f46e5', glow: 'rgba(79,70,229,0.3)', light: '#6366f1' },
  document: { fill: '#0ea5e9', glow: 'rgba(14,165,233,0.3)', light: '#38bdf8' },
  entity:   { fill: '#22c55e', glow: 'rgba(34,197,94,0.3)', light: '#4ade80' }
};

export const EDGE_COLORS = {
  belongs_to:  '#0ea5e9',
  related_to:  '#9333ea',
  indexed_in:  '#22c55e',
  references:  '#f97316',
  depends_on:  '#eab308',
  follows:     '#ec4899'
};

let _nextId = 1;

export class KnowledgeGraph {
  constructor() {
    /** @type {Map<string, Object>} */
    this.nodes = new Map();
    /** @type {Map<string, Object>} */
    this.edges = new Map();
  }

  addNode(id, type, label, metadata = {}) {
    const node = {
      id: id || `n${_nextId++}`,
      type,
      label,
      metadata: { ...metadata },
      x: metadata.x ?? (Math.random() - 0.5) * 600,
      y: metadata.y ?? (Math.random() - 0.5) * 400,
      vx: 0,
      vy: 0,
      _highlight: 0, // 0-1, for animation glow
      _activated: false
    };
    this.nodes.set(node.id, node);
    if (!this._isBulkLoading) {
      bus.emit('graph:node:added', node);
      bus.emit('graph:changed', { type: 'node:added', node });
    }
    return node;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    // Remove connected edges
    for (const [eid, edge] of this.edges) {
      if (edge.source === id || edge.target === id) {
        this.edges.delete(eid);
        bus.emit('graph:edge:removed', edge);
      }
    }
    this.nodes.delete(id);
    bus.emit('graph:node:removed', node);
    bus.emit('graph:changed', { type: 'node:removed', node });
  }

  updateNode(id, updates) {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node, updates);
    if (updates.metadata) Object.assign(node.metadata, updates.metadata);
    bus.emit('graph:node:updated', node);
    bus.emit('graph:changed', { type: 'node:updated', node });
    return node;
  }

  addEdge(sourceId, targetId, type, weight = 1, metadata = {}) {
    const id = `e${_nextId++}`;
    const edge = {
      id,
      source: sourceId,
      target: targetId,
      type,
      weight: Math.max(0.1, Math.min(5, weight)),
      metadata: { ...metadata },
      _highlight: 0,
      _particleProgress: -1
    };
    this.edges.set(id, edge);
    if (!this._isBulkLoading) {
      bus.emit('graph:edge:added', edge);
      bus.emit('graph:changed', { type: 'edge:added', edge });
    }
    return edge;
  }

  removeEdge(id) {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.edges.delete(id);
    bus.emit('graph:edge:removed', edge);
    bus.emit('graph:changed', { type: 'edge:removed', edge });
  }

  updateEdge(id, updates) {
    const edge = this.edges.get(id);
    if (!edge) return;
    Object.assign(edge, updates);
    bus.emit('graph:edge:updated', edge);
    bus.emit('graph:changed', { type: 'edge:updated', edge });
    return edge;
  }

  getNode(id) { return this.nodes.get(id); }
  getEdge(id) { return this.edges.get(id); }

  getNeighbors(nodeId, depth = 1) {
    const visited = new Set([nodeId]);
    let frontier = [nodeId];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const nid of frontier) {
        for (const edge of this.edges.values()) {
          const other = edge.source === nid ? edge.target : edge.target === nid ? edge.source : null;
          if (other && !visited.has(other)) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    visited.delete(nodeId);
    return [...visited].map(id => this.nodes.get(id)).filter(Boolean);
  }

  getEdgesForNode(nodeId) {
    const result = [];
    for (const edge of this.edges.values()) {
      if (edge.source === nodeId || edge.target === nodeId) result.push(edge);
    }
    return result;
  }

  /** Simple keyword-based query: returns activated nodes sorted by relevance */
  query(text, timeFilter = null) {
    const terms = text.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (!terms.length && !timeFilter) return [];

    const scored = [];
    for (const node of this.nodes.values()) {
      let score = 0;
      
      let timeMatch = true;
      if (timeFilter && timeFilter.start && timeFilter.end) {
        if (!node.metadata.timestamp) {
           timeMatch = false; 
        } else {
           const ts = new Date(node.metadata.timestamp).getTime();
           const start = new Date(timeFilter.start).getTime();
           const end = new Date(timeFilter.end).getTime();
           if (ts < start || ts > end) {
             timeMatch = false;
           }
        }
      }

      if (timeFilter && !timeMatch) continue;

      const haystack = `${node.label} ${node.metadata.description || ''} ${node.metadata.tags?.join(' ') || ''}`.toLowerCase();
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
        if (node.label.toLowerCase().includes(term)) score += 2; // label match is stronger
      }

      if (terms.length > 0) {
         if (score > 0) scored.push({ node, score });
      } else if (timeFilter && timeMatch) {
         scored.push({ node, score: 1 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  getNodesArray() { return [...this.nodes.values()]; }
  getEdgesArray() { return [...this.edges.values()]; }

  toJSON() {
    return {
      nodes: this.getNodesArray().map(n => ({ id: n.id, type: n.type, label: n.label, metadata: n.metadata })),
      edges: this.getEdgesArray().map(e => ({ id: e.id, source: e.source, target: e.target, type: e.type, weight: e.weight, metadata: e.metadata }))
    };
  }

  fromJSON(data) {
    this.nodes.clear();
    this.edges.clear();
    this._isBulkLoading = true;
    for (const n of data.nodes) this.addNode(n.id, n.type, n.label, n.metadata);
    for (const e of data.edges) this.addEdge(e.source, e.target, e.type, e.weight, e.metadata);
    this._isBulkLoading = false;
    bus.emit('graph:loaded', { nodeCount: this.nodes.size, edgeCount: this.edges.size });
  }

  get nodeCount() { return this.nodes.size; }
  get edgeCount() { return this.edges.size; }
}
