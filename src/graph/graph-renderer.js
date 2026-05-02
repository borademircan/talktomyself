/**
 * Graph Renderer — D3.js force simulation on HTML5 Canvas
 * Handles node/edge drawing, force layout, and visual distinction by type.
 */
import * as d3 from 'd3';
import { NODE_COLORS, EDGE_COLORS } from '../core/knowledge-graph.js';
import { bus } from '../core/event-bus.js';

export class GraphRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/knowledge-graph.js').KnowledgeGraph} kg
   */
  constructor(canvas, kg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.kg = kg;
    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;
    this.transform = d3.zoomIdentity;
    this.hoveredNode = null;
    this.selectedNode = null;
    this.connectedToSelected = new Set();
    this.dragNode = null;
    this.simulation = null;
    this._animFrame = null;
    this._particleTime = 0;
    this._filters = { concept: true, domain: true, document: true, entity: true };
    this.searchQuery = '';
    
    this.activeNodeIds = new Set();
    this.activeEdges = new Set();

    this._setupCanvas();
    this._setupSimulation();
    this._setupZoom();
    this._setupInteractions();
    this._tick();

    bus.on('graph:changed', () => this._restartSimulation());
    bus.on('query:step', (e) => this._handleQueryStep(e));
    bus.on('graph:node:focus', (nodeId) => this._focusNode(nodeId));
    
    bus.on('graph:node:added', (node) => { this.activeNodeIds.add(node.id); this._restartSimulation(); });
    bus.on('graph:edge:added', (edge) => { this.activeEdges.add(edge); this._restartSimulation(); });
    bus.on('graph:loaded', () => {
      // Start with a completely empty slate as requested
      // The graph is meant to be explored dynamically via queries, not all at once.
      // const domainNodes = this.kg.getNodesArray().filter(n => n.type === 'domain');
      // domainNodes.forEach(n => this.activeNodeIds.add(n.id));
      this._restartSimulation();
    });

    window.addEventListener('resize', () => this._setupCanvas());
  }

  _setupCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _setupSimulation() {
    this._simNodes = [];
    this._simEdges = [];

    this.simulation = d3.forceSimulation(this._simNodes)
      .force('link', d3.forceLink(this._simEdges).id(d => d.id).distance(d => 100 / (d.weight || 1)).strength(d => 0.3 * (d.weight || 1) / 5))
      .force('charge', d3.forceManyBody().strength(-200).distanceMax(400))
      .force('center', d3.forceCenter(0, 0).strength(0.05))
      .force('collision', d3.forceCollide().radius(30))
      .force('x', d3.forceX(0).strength(0.02))
      .force('y', d3.forceY(0).strength(0.02))
      .alphaDecay(0.02)
      .velocityDecay(0.4)
      .on('tick', () => {});
  }

  _restartSimulation() {
    const nodes = Array.from(this.activeNodeIds).map(id => this.kg.getNode(id)).filter(Boolean);
    const edges = Array.from(this.activeEdges).filter(e => {
       const s = typeof e.source === 'object' ? e.source.id : e.source;
       const t = typeof e.target === 'object' ? e.target.id : e.target;
       return this.activeNodeIds.has(s) && this.activeNodeIds.has(t);
    }).map(e => ({
      ...e,
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target
    }));
    this._simNodes = nodes;
    this._simEdges = edges;
    this.simulation.nodes(nodes);
    this.simulation.force('link').links(edges);
    this.simulation.alpha(0.3).restart();
  }

  _setupZoom() {
    this._zoom = d3.zoom()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        this.transform = event.transform;
      });
    d3.select(this.canvas).call(this._zoom);
  }

  _setupInteractions() {
    const self = this;
    this.canvas.addEventListener('mousemove', (e) => {
      const [mx, my] = self._screenToWorld(e.offsetX, e.offsetY);
      self.hoveredNode = self._findNodeAt(mx, my);
      self.canvas.style.cursor = self.hoveredNode ? 'pointer' : (self.dragNode ? 'grabbing' : 'default');

      if (self.hoveredNode) {
        bus.emit('graph:node:hover', self.hoveredNode);
      } else {
        bus.emit('graph:node:hover', null);
      }
    });

    this.canvas.addEventListener('click', (e) => {
      const [mx, my] = self._screenToWorld(e.offsetX, e.offsetY);
      const node = self._findNodeAt(mx, my);
      
      if (!node) {
        self.selectedNode = null;
        self.connectedToSelected = new Set();
        bus.emit('graph:node:selected', null);
        return;
      }
      
      self.selectedNode = node;
      self.connectedToSelected = new Set([node]);
      
      // Find all connected nodes
      for (const edge of self._simEdges) {
        const sourceNode = typeof edge.source === 'object' ? edge.source : self.kg.getNode(edge.source);
        const targetNode = typeof edge.target === 'object' ? edge.target : self.kg.getNode(edge.target);
        
        if (!sourceNode || !targetNode) continue;
        
        if (sourceNode === node) self.connectedToSelected.add(targetNode);
        if (targetNode === node) self.connectedToSelected.add(sourceNode);
      }
      
      bus.emit('graph:node:selected', node);
    });

    // Drag
    this.canvas.addEventListener('mousedown', (e) => {
      const [mx, my] = self._screenToWorld(e.offsetX, e.offsetY);
      const node = self._findNodeAt(mx, my);
      if (node) {
        self.dragNode = node;
        node.fx = node.x;
        node.fy = node.y;
        self.simulation.alphaTarget(0.1).restart();
        // Prevent zoom from kicking in
        e.stopPropagation();
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (self.dragNode) {
        const [mx, my] = self._screenToWorld(e.offsetX, e.offsetY);
        self.dragNode.fx = mx;
        self.dragNode.fy = my;
      }
    });

    const mouseUp = () => {
      if (self.dragNode) {
        self.dragNode.fx = null;
        self.dragNode.fy = null;
        self.dragNode = null;
        self.simulation.alphaTarget(0);
      }
    };
    this.canvas.addEventListener('mouseup', mouseUp);
    this.canvas.addEventListener('mouseleave', mouseUp);

    // Context menu
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [mx, my] = self._screenToWorld(e.offsetX, e.offsetY);
      const node = self._findNodeAt(mx, my);
      bus.emit('graph:contextmenu', { x: e.clientX, y: e.clientY, node, worldX: mx, worldY: my });
    });
  }

  _screenToWorld(sx, sy) {
    return [
      (sx - this.transform.x) / this.transform.k,
      (sy - this.transform.y) / this.transform.k
    ];
  }

  _worldToScreen(wx, wy) {
    return [
      wx * this.transform.k + this.transform.x,
      wy * this.transform.k + this.transform.y
    ];
  }

  _findNodeAt(wx, wy) {
    const r = 20;
    for (const node of this._simNodes) {
      if (!this._filters[node.type]) continue;
      const dx = node.x - wx, dy = node.y - wy;
      if (dx * dx + dy * dy < r * r) return node;
    }
    return null;
  }

  _focusNode(nodeId) {
    // Wait slightly for simulation nodes to be updated
    setTimeout(() => {
      const node = this.kg.getNode(nodeId);
      if (!node) return;
      
      this.selectedNode = node;
      this.connectedToSelected = new Set([node]);
      
      for (const edge of this._simEdges) {
        const sourceNode = typeof edge.source === 'object' ? edge.source : this.kg.getNode(edge.source);
        const targetNode = typeof edge.target === 'object' ? edge.target : this.kg.getNode(edge.target);
        
        if (!sourceNode || !targetNode) continue;
        
        if (sourceNode === node) this.connectedToSelected.add(targetNode);
        if (targetNode === node) this.connectedToSelected.add(sourceNode);
      }
      
      this.searchQuery = ''; // Clear search to see focus clearly
      bus.emit('graph:node:selected', node);
    }, 50);
  }

  setFilter(type, enabled) {
    this._filters[type] = enabled;
  }

  setSearchQuery(query) {
    this.searchQuery = query.toLowerCase().trim();
  }

  zoomToFit() {
    const nodes = this.kg.getNodesArray().filter(n => this._filters[n.type]);
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const padding = 60;
    const dx = maxX - minX + padding * 2;
    const dy = maxY - minY + padding * 2;
    const scale = Math.min(this.width / dx, this.height / dy, 2);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const t = d3.zoomIdentity.translate(this.width / 2, this.height / 2).scale(scale).translate(-cx, -cy);
    d3.select(this.canvas).transition().duration(600).call(this._zoom.transform, t);
  }

  zoomIn() {
    d3.select(this.canvas).transition().duration(300).call(this._zoom.scaleBy, 1.3);
  }

  zoomOut() {
    d3.select(this.canvas).transition().duration(300).call(this._zoom.scaleBy, 0.7);
  }

  _handleQueryStep(step) {
    if (step.step === 'kg_lookup' || step.step === 'vdb_search') {
      let changed = false;
      const items = step.step === 'kg_lookup' ? step.activated.map(a => a.node) : step.results.map(r => this.kg.getNode(r.id)).filter(Boolean);
      
      for (const node of items) {
        if (!this.activeNodeIds.has(node.id)) {
          this.activeNodeIds.add(node.id);
          changed = true;
        }
        
        const edges = this.kg.getEdgesForNode(node.id);
        for (const edge of edges) {
          if (!this.activeEdges.has(edge)) {
            this.activeEdges.add(edge);
            changed = true;
          }
          
          const s = this.kg.getNode(edge.source);
          const t = this.kg.getNode(edge.target);
          if (s && !this.activeNodeIds.has(s.id)) { this.activeNodeIds.add(s.id); changed = true; }
          if (t && !this.activeNodeIds.has(t.id)) { this.activeNodeIds.add(t.id); changed = true; }
          
          edge._highlight = Math.min(1, (edge._highlight || 0) + 0.4);
          edge._particleProgress = 0;
        }
      }
      if (changed) this._restartSimulation();
    }
  }

  _tick() {
    this._particleTime += 0.016;
    this._draw();
    this._animFrame = requestAnimationFrame(() => this._tick());
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.width, h = this.height;
    const t = this.transform;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, h);

    // Draw grid
    this._drawGrid(ctx, t, w, h);

    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    // Draw edges
    for (const edge of this._simEdges) {
      const s = typeof edge.source === 'object' ? edge.source : this.kg.getNode(edge.source);
      const ta = typeof edge.target === 'object' ? edge.target : this.kg.getNode(edge.target);
      if (!s || !ta) continue;
      if (!this._filters[s.type] || !this._filters[ta.type]) continue;
      this._drawEdge(ctx, s, ta, edge);
    }

    // Draw nodes
    for (const node of this._simNodes) {
      if (!this._filters[node.type]) continue;
      this._drawNode(ctx, node);
    }

    ctx.restore();
  }

  _drawGrid(ctx, t, w, h) {
    const step = 40 * t.k;
    if (step < 8) return; // too small
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    const ox = t.x % step, oy = t.y % step;
    ctx.beginPath();
    for (let x = ox; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = oy; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  _drawEdge(ctx, source, target, edge) {
    const color = EDGE_COLORS[edge.type] || '#555';
    let hl = edge._highlight || 0;
    
    let isConnectedToSelected = false;
    if (this.selectedNode) {
      isConnectedToSelected = (source === this.selectedNode || target === this.selectedNode);
      if (isConnectedToSelected) hl = Math.max(hl, 0.8);
    }
    
    let globalAlpha = 1;
    if (this.selectedNode && !isConnectedToSelected) {
      globalAlpha = 0.15;
    }

    const baseAlpha = (0.25 + hl * 0.6) * globalAlpha;
    const lineWidth = (edge.weight || 1) * 0.6 + hl * 2;

    ctx.save();
    ctx.globalAlpha = globalAlpha;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);

    // Dash pattern for certain edge types
    if (edge.type === 'indexed_in') ctx.setLineDash([6, 4]);
    else if (edge.type === 'references') ctx.setLineDash([2, 4]);
    else ctx.setLineDash([]);

    ctx.strokeStyle = hl > 0 ? color : this._adjustAlpha(color, baseAlpha);
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.setLineDash([]);

    // Glow on highlighted edges
    if (hl > 0.3) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 12 * hl;
      ctx.strokeStyle = this._adjustAlpha(color, hl * 0.4);
      ctx.lineWidth = lineWidth + 2;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      ctx.restore();
    }

    // Animated particle along highlighted edges
    if (edge._particleProgress >= 0 && edge._particleProgress <= 1) {
      edge._particleProgress += 0.008;
      const px = source.x + (target.x - source.x) * edge._particleProgress;
      const py = source.y + (target.y - source.y) * edge._particleProgress;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (edge._particleProgress > 1) edge._particleProgress = -1;
    }

    ctx.restore();

    // Decay highlight
    if (edge._highlight > 0) edge._highlight = Math.max(0, edge._highlight - 0.003);
  }

  _drawNode(ctx, node) {
    const colors = NODE_COLORS[node.type] || NODE_COLORS.concept;
    const x = node.x, y = node.y;
    const isHovered = node === this.hoveredNode;
    const isSelected = node === this.selectedNode;
    const isMatch = this.searchQuery && (
      node.label.toLowerCase().includes(this.searchQuery) ||
      (node.metadata && node.metadata.description && node.metadata.description.toLowerCase().includes(this.searchQuery))
    );
    
    let isConnectedToSelected = true;
    if (this.selectedNode) {
      isConnectedToSelected = this.connectedToSelected.has(node);
    }
    
    let globalAlpha = 1;
    if (this.selectedNode && !isConnectedToSelected && !isMatch) {
      globalAlpha = 0.15;
    }
    
    const hl = node._highlight || 0;
    const radius = node.type === 'domain' ? 18 : 14;
    const scale = 1 + (isHovered ? 0.15 : 0) + hl * 0.2 + (isMatch ? 0.15 : 0);

    ctx.save();
    ctx.globalAlpha = globalAlpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    // Glow
    if (hl > 0 || isSelected || isMatch) {
      ctx.shadowColor = isMatch ? '#fff' : colors.glow;
      ctx.shadowBlur = isMatch ? 24 : 16 + hl * 20;
    }

    // Shape
    ctx.beginPath();
    if (node.type === 'concept') {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
    } else if (node.type === 'domain') {
      this._roundRect(ctx, -radius, -radius * 0.7, radius * 2, radius * 1.4, 6);
    } else if (node.type === 'document') {
      ctx.rect(-radius * 0.9, -radius * 0.65, radius * 1.8, radius * 1.3);
    } else if (node.type === 'entity') {
      ctx.moveTo(0, -radius);
      ctx.lineTo(radius, 0);
      ctx.lineTo(0, radius);
      ctx.lineTo(-radius, 0);
      ctx.closePath();
    }

    // Fill
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    grad.addColorStop(0, colors.light);
    grad.addColorStop(1, colors.fill);
    ctx.fillStyle = node._activated || isMatch ? colors.light : grad;
    ctx.fill();

    // Stroke
    ctx.strokeStyle = isSelected || isMatch ? '#fff' : isHovered ? colors.light : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = isSelected || isMatch ? 2 : 1;
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Label
    const labelSize = Math.max(9, 11 / (this.transform.k > 1 ? 1 : this.transform.k));
    ctx.font = `500 ${labelSize}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = isHovered || isSelected || node._activated || isMatch ? '#fff' : 'rgba(228,228,231,0.8)';
    ctx.fillText(node.label, 0, radius + labelSize + 4);

    ctx.restore();

    // Decay highlight
    if (node._highlight > 0) node._highlight = Math.max(0, node._highlight - 0.003);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  _adjustAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  destroy() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    if (this.simulation) this.simulation.stop();
  }
}
