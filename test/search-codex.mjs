// Synthetic native search endpoint; the Bridge must never build a search store.
import readline from 'node:readline';
if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://') process.exit(64);
const requests = [];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'search-fixture' } });
  if (message.method === 'initialized') return;
  if (message.method === 'test/requests') return send({ id: message.id, result: requests });
  requests.push({ method: message.method, params: message.params });
  const p = message.params;
  if (p.searchTerm === 'legacy') return send({ id: message.id, error: { code: -32602, message: 'requires paginated history' } });
  const snippet = p.searchTerm === 'sensitive' ? 'password=synthetic-search-only' : '🌱 Hit';
  if (message.method === 'thread/search') return send({ id: message.id, result: {
    data: p.cursor ? [] : [{ thread: { id: 'search-thread', historyMode: 'paginated', canAcceptDirectInput: null, turns: [] }, snippet }],
    nextCursor: p.cursor ? null : 'native-threads-next', backwardsCursor: p.cursor ? null : 'native-threads-back', future: true,
  } });
  if (message.method === 'thread/searchOccurrences') return send({ id: message.id, result: {
    data: [{ turnId: 'turn-a', itemId: p.cursor ? 'final-a' : 'user-a', snippet, snippetMatchRange: { start: 3, end: 6 }, turnCursor: 'native-inclusive-turn-a' }],
    nextCursor: p.cursor ? null : 'native-occurrences-next',
  } });
  send({ id: message.id, error: { code: -32601, message: 'Unexpected request: no hydration or implicit reads allowed' } });
});
lines.on('close', () => process.exit(0));
