/**
 * Vector DB Orchestrator — Client proxy for backend SQLite + OpenAI embeddings.
 */
import { bus } from './event-bus.js';

export class VectorDBOrchestrator {
  constructor() {
    this.unifiedSize = 0;
  }

  async init() {
    console.log('[Vector DB] Initialized remote RAG proxy.');
  }

  async addDocument(domain, id, text, metadata) {
    try {
      const response = await fetch(import.meta.env.BASE_URL + 'api/embed_node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text, type: metadata?.type, category: domain })
      });
      if (response.ok) {
        this.unifiedSize++;
        bus.emit('vdb:changed');
      }
    } catch (e) {
      console.error('[Vector DB] Failed to add document:', e);
    }
  }

  async removeDocument(id) {
    // For now, we only delete from KG. Backend doesn't support deletion endpoint yet.
    // Ideally we would delete from node_embeddings. 
    return false;
  }

  toJSON() {
    // No-op. We don't save embeddings to local storage/json files anymore.
    return {};
  }

  fromJSON(data) {
    // No-op.
  }

  /** Search across SQLite index via backend endpoint */
  async search(queryText, domains = null, topK = 5, timeFilter = null) {
    try {
      const response = await fetch(import.meta.env.BASE_URL + 'api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryText, topK, domains, timeFilter })
      });
      
      if (!response.ok) throw new Error('Search failed on backend');
      
      const { results } = await response.json();
      const finalResults = results.map(r => ({ ...r, metadata: { category: r.domain, domain: r.domain }}));
      
      const dbHits = { unified: finalResults.length };
      bus.emit('vdb:search:complete', { query: queryText, domains: domains || ['all'], hits: dbHits, results: finalResults });
      return { results: finalResults, dbHits };
    } catch (e) {
      console.error('[Vector DB] Search error:', e);
      return { results: [], dbHits: {} };
    }
  }

  getStats() {
    return { unified: this.unifiedSize };
  }
}
