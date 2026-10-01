// Synthetic native endpoint for JSONL goal transport tests, not a Bridge store.
import readline from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(64);
const goals = new Map();
const requests = [];
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "goal-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "test/requests") return send({ id: message.id, result: requests });
  requests.push({ method: message.method, params: message.params });
  const p = message.params;
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: goals.get(p.threadId) ?? null } });
  if (message.method === "thread/goal/set") {
    const goal = goals.get(p.threadId) ?? {
      threadId: p.threadId, objective: "Synthetic fixture goal", status: "paused", tokenBudget: 500,
      tokensUsed: 23, timeUsedSeconds: 4, createdAt: 100, updatedAt: 105, futureField: "preserved",
    };
    if (p.objective != null) goal.objective = p.objective;
    if (p.status != null) goal.status = p.status;
    if (Object.hasOwn(p, "tokenBudget")) goal.tokenBudget = p.tokenBudget;
    goals.set(p.threadId, goal);
    send({ method: "thread/goal/updated", params: { threadId: p.threadId, turnId: null, goal } });
    return send({ id: message.id, result: { goal } });
  }
  if (message.method === "thread/goal/clear") {
    const cleared = goals.delete(p.threadId);
    if (cleared) send({ method: "thread/goal/cleared", params: { threadId: p.threadId } });
    return send({ id: message.id, result: { cleared } });
  }
  send({ id: message.id, error: { code: -32601, message: "Unexpected request in goal fixture" } });
});
lines.on("close", () => process.exit(0));
