// Synthetic native endpoint for transport qualification, never a Bridge store.
import readline from "node:readline";
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(64);
let queue = [];
let nextId = 1;
const requests = [];
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const message = JSON.parse(line);
  const p = message.params;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "queue-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "test/requests") return send({ id: message.id, result: requests });
  requests.push({ method: message.method, params: p });
  let result;
  const found = () => queue.find(item => item.id === p.queuedSubmissionId);
  if (message.method === "thread/queue/list") {
    const offset = p.cursor ? Number(p.cursor.replace("native:", "")) : 0;
    const data = queue.slice(offset, offset + p.limit);
    return send({ id: message.id, result: { data, nextCursor: offset + p.limit < queue.length ? `native:${offset + p.limit}` : null } });
  }
  if (message.method === "thread/queue/add") {
    const queuedSubmission = { id: `queue-${nextId++}`, input: p.input, clientUserMessageId: p.clientUserMessageId, futureField: { native: true } };
    queue.push(queuedSubmission); result = { queuedSubmission };
  } else if (message.method === "thread/queue/update" && found()) {
    const queuedSubmission = found(); queuedSubmission.input = p.input; result = { queuedSubmission };
  } else if (message.method === "thread/queue/delete") {
    const deleted = Boolean(found()); queue = queue.filter(item => item.id !== p.queuedSubmissionId); result = { deleted };
  } else if (message.method === "thread/queue/reorder" && p.queuedSubmissionIds.length === queue.length && new Set(p.queuedSubmissionIds).size === queue.length && p.queuedSubmissionIds.every(id => queue.some(item => item.id === id))) {
    queue = p.queuedSubmissionIds.map(id => queue.find(item => item.id === id)); result = {};
  } else return send({ id: message.id, error: { code: -32600, message: "native queue operation rejected" } });
  send({ method: "thread/queue/changed", params: { threadId: p.threadId } });
  send({ id: message.id, result });
});
lines.on("close", () => process.exit(0));
