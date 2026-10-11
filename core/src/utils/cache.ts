// Map<conversation_id + thought_text_hash, signature>
const signatureCache = new Map<string, string>();
const toolCallSignatureCache = new Map<string, string>();

function trimCache(cache: Map<string, string>) {
  if (cache.size > 1000) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}

export function cacheSignature(conversationId: string, thought: string, signature: string) {
  const key = `${conversationId}:${Bun.hash(thought)}`; 
  signatureCache.set(key, signature);
  
  // LRU cleanup if too big (simplified)
  trimCache(signatureCache);
}

export function getSignature(conversationId: string, thought: string): string | undefined {
  const key = `${conversationId}:${Bun.hash(thought)}`;
  return signatureCache.get(key);
}

export function cacheToolCallSignature(conversationId: string, toolCallId: string, signature: string) {
  toolCallSignatureCache.set(`${conversationId}:${toolCallId}`, signature);
  trimCache(toolCallSignatureCache);
}

export function getToolCallSignature(conversationId: string, toolCallId: string): string | undefined {
  return toolCallSignatureCache.get(`${conversationId}:${toolCallId}`);
}
