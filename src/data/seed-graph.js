/**
 * Seed Graph — Empty graph to start from scratch.
 */

import kgData from './kg.json';
import vdbKnowledge from './vdb_knowledge.json';
import vdbDocuments from './vdb_documents.json';
import vdbConversations from './vdb_conversations.json';
import vdbCreative from './vdb_creative.json';

export const SEED_NODES = kgData.nodes || [];

export const SEED_EDGES = kgData.edges || [];

export const VDB_DOCUMENTS = {
  knowledge: vdbKnowledge,
  documents: vdbDocuments,
  conversations: vdbConversations,
  creative: vdbCreative
};
