import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { ownedProofLifecycle, gate, tunnelSnapshot, restartForRollback, verifyRollbackAttempt, metadata, sha256, canonical } from '../scripts/bootstrap-method.mjs';

function fixture() {
  const root = fs.mkdtempSync('/private/tmp/lcb-bootstrap-method-test-');
  return { root, cleanup() {
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name);
      if (fs.lstatSync(file).isDirectory()) { for (const child of fs.readdirSync(file)) fs.unlinkSync(path.join(file, child)); fs.rmdirSync(file); }
      else fs.unlinkSync(file);
    }
    fs.rmdirSync(root);
  } };
}
const hashes = { 'dist/src/index.js': 'a'.repeat(64), 'dist/src/app-server.js': 'b'.repeat(64) };
for (const scenario of ['complete', 'missing', 'partial', 'failed', 'truncated']) test(`closed child ${scenario} proof records final identity and cleans exact owned files`, () => {
  const f = fixture(), records = [], lifecycle = ownedProofLifecycle(value => records.push(value), f.root);
  try {
    const proof = lifecycle.create(f.root, hashes);
    const source = `const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));const scenario=process.argv[2];if(scenario!=='missing'){const body={pid:process.pid,root:c.root,loaded:scenario==='partial'?{}:c.expected,failure:scenario==='failed'};fs.writeFileSync(c.receipt,scenario==='truncated'?'{':JSON.stringify(body),{mode:0o600});}process.exit(scenario==='failed'?1:0);`;
    const child = spawnSync(process.execPath, ['-e', source, proof.config, scenario]);
    lifecycle.spawned(proof, child.pid);
    const result = lifecycle.finish(proof, { code: child.status, signal: child.signal });
    assert.equal(result.receipt_state, scenario === 'truncated' ? 'partial' : scenario);
    assert.equal(result.cleanup.ok, true); assert.equal(fs.existsSync(path.dirname(proof.config)), false);
    assert.equal(result.child.pid, child.pid); assert.equal(result.child.closed, true); assert.equal(result.child.exit.code, child.status);
    assert.equal(result.config.sha256.length, 64);
    if (scenario !== 'missing') { assert.equal(result.receipt.sha256.length, 64); assert.ok(result.receipt.ino > 0); }
    assert.deepEqual(records.map(x => x.action), ['proof_created', 'proof_child', 'proof_final_identity', 'proof_cleanup']);
  } finally { f.cleanup(); }
});
for (const scenario of ['unknown file', 'wrong PID', 'config drift', 'receipt symlink', 'no close']) test(`proof ${scenario} stays fail closed and never deletes unknown content`, () => {
  const f = fixture(), lifecycle = ownedProofLifecycle(() => {}, f.root);
  try {
    const proof = lifecycle.create(f.root, hashes), directory = path.dirname(proof.config);
    lifecycle.spawned(proof, 777);
    if (scenario === 'unknown file') fs.writeFileSync(path.join(directory, 'unknown'), 'preserve');
    if (scenario === 'wrong PID') fs.writeFileSync(proof.receipt, JSON.stringify({ pid: 778, root: proof.root, loaded: hashes, failure: false }), { mode: 0o600 });
    if (scenario === 'config drift') fs.appendFileSync(proof.config, ' ');
    if (scenario === 'receipt symlink') fs.symlinkSync(proof.config, proof.receipt);
    const result = lifecycle.finish(proof, scenario === 'no close' ? null : { code: 0, signal: null });
    assert.equal(result.cleanup.ok, false); assert.equal(result.cleanup.classification, 'scratch_ownership_unknown');
    assert.equal(fs.existsSync(proof.config), true); assert.equal(fs.existsSync(directory), true);
    if (scenario === 'unknown file') assert.equal(fs.readFileSync(path.join(directory, 'unknown'), 'utf8'), 'preserve');
  } finally { f.cleanup(); }
});

test('spawn failure with absent child receipt cleans the explicitly allocated proof', () => {
  const f = fixture(), lifecycle = ownedProofLifecycle(() => {}, f.root);
  try { const proof = lifecycle.create(f.root, hashes); const result = lifecycle.finish(proof, { code: null, signal: null, spawn_error: true }); assert.equal(result.cleanup.ok, true); assert.equal(result.receipt_state, 'missing'); }
  finally { f.cleanup(); }
});

test('gate marks only the currently attempted failure and preserves later not_run', async () => {
  const record = { gates: { health: 'not_run', wrapper: 'not_run', remote: 'not_run', daemon: 'not_run' } };
  await gate(record, 'health', async () => {});
  await assert.rejects(gate(record, 'wrapper', async () => { throw new Error('wrapper failed'); }), /wrapper/);
  assert.deepEqual(record.gates, { health: 'passed', wrapper: 'failed', remote: 'not_run', daemon: 'not_run' });
  assert.equal(record.failed_gate, 'wrapper');
});
test('scratch cleanup failure is independent of passed gates and later not_run', async () => {
  const record = { gates: { health: 'not_run', wrapper: 'not_run', remote: 'not_run' }, scratch_cleanup: [{ ok: false, classification: 'scratch_ownership_unknown' }] };
  await gate(record, 'health', async () => {}); await gate(record, 'wrapper', async () => {});
  assert.equal(record.scratch_cleanup[0].ok, false); assert.deepEqual(record.gates, { health: 'passed', wrapper: 'passed', remote: 'not_run' });
  const remoteRecord = { gates: { remote: 'not_run', daemon: 'not_run' } };
  await assert.rejects(gate(remoteRecord, 'remote', async () => { throw Object.assign(new Error('unknown scratch'), { failure_domain: 'scratch_cleanup', verification_result: { ok: true }, cleanup: { ok: false } }); }), /scratch/);
  assert.deepEqual(remoteRecord.gates, { remote: 'passed', daemon: 'not_run' }); assert.equal(remoteRecord.failure_domain, 'scratch_cleanup');
});

const config = { agent: 'gui/502/com.openai.tunnel-client.lcb-remote', uid: 502, tunnelProgram: '/exact/tunnel', plist: '/exact/agent.plist' };
const fakeOS = (file, args) => {
  if (file === '/bin/launchctl') { assert.deepEqual(args, ['print', config.agent]); return 'state = running\npid = 91\nruns = 8\nprogram = /exact/tunnel\npath = /exact/agent.plist\n'; }
  assert.deepEqual(args, ['-p', '91', '-o', 'pid=,ppid=,uid=,lstart=']); return '91 1 502 Mon Sep 28 23:30:00 2026';
};
test('missing new Bridge permits guarded exact rollback kickstart and restored-service verification', async () => {
  const f = fixture(); let guards = 0, kicks = 0, snapshots = 0;
  const wrapper = path.join(f.root, 'wrapper'), backup = path.join(f.root, 'backup');
  fs.writeFileSync(wrapper, 'new wrapper'); fs.writeFileSync(backup, 'old wrapper');
  try {
    fs.copyFileSync(backup, wrapper);
    const guard = () => { guards++; assert.equal(fs.readFileSync(wrapper, 'utf8'), 'old wrapper'); assert.equal(fs.readFileSync(backup, 'utf8'), 'old wrapper'); };
    const result = await restartForRollback({ applyRestart: true, readTunnel: () => tunnelSnapshot(config, fakeOS), restoreGuard: guard, kick: () => { kicks++; return { status: 0 }; } });
    assert.equal(kicks, 1); assert.equal(result.restart_before.tunnel.pid, 91); assert.equal(result.restart_before.bridge, undefined);
    const restored = { gates: { exact_tunnel: 'not_run', health: 'not_run', wrapper: 'not_run', remote: 'not_run', final_identity: 'not_run' } };
    const identity = { agent: config.agent, tunnel: { pid: 92, start: 'restored start' }, bridge: { pid: 93, ppid: 92, start: 'restored Bridge' } };
    await verifyRollbackAttempt({ record: restored, applyRestart: true, restartBefore: result.restart_before, baseline: guard, readIdentity: () => { snapshots++; return identity; }, verifyLive: async () => ({ healthz: { ok: true }, readyz: { ok: true }, control_plane: { ok: true, pid: 92 }, wrapper: { ok: true } }), remoteModels: async () => ({ ok: true }), restoreGuard: guard, deadline: Date.now() + 1000 });
    assert.equal(restored.ok, true); assert.equal(snapshots, 2); assert.equal(guards, 4); assert.ok(Object.values(restored.gates).every(v => v === 'passed'));
  } finally { f.cleanup(); }
});
test('rollback retains wrapper/backup/agent guard failures and never invokes restart', async () => {
  let kicks = 0;
  await assert.rejects(restartForRollback({ applyRestart: true, readTunnel: () => tunnelSnapshot(config, fakeOS), restoreGuard: () => { throw new Error('backup drift'); }, kick: () => { kicks++; } }), /backup drift/);
  await assert.rejects(restartForRollback({ applyRestart: true, readTunnel: () => tunnelSnapshot({ ...config, agent: 'gui/502/other' }, fakeOS), restoreGuard: () => {}, kick: () => { kicks++; } }), /exact agent/);
  assert.equal(kicks, 0);
});
test('rollback service restoration remains distinct from unknown scratch retention', async () => {
  const record = { gates: { exact_tunnel: 'not_run', health: 'not_run', wrapper: 'not_run', remote: 'not_run', final_identity: 'not_run' } };
  const identity = { tunnel: { pid: 92, start: 'restored' }, bridge: { pid: 93 } };
  await verifyRollbackAttempt({ record, applyRestart: true, restartBefore: { tunnel: { pid: 91, start: 'new failed' } }, baseline: () => {}, readIdentity: () => identity, verifyLive: async () => ({ healthz: { ok: true }, readyz: { ok: true }, control_plane: { ok: true, pid: 92 }, wrapper: { ok: true } }), remoteModels: async () => { throw Object.assign(new Error('unknown scratch'), { failure_domain: 'scratch_cleanup', verification_result: { ok: true }, cleanup: { ok: false, retained_paths: ['/owned/retained'] } }); }, restoreGuard: () => {}, deadline: Date.now() + 1000 });
  assert.equal(record.ok, true); assert.equal(record.gates.remote, 'passed'); assert.equal(record.failure_domain, 'scratch_cleanup'); assert.equal(record.scratch_cleanup[0].ok, false);
});
test('preserved backup root is unchanged while each invocation uses an exclusive new child', () => {
  const f = fixture();
  try {
    const before = metadata(f.root); fs.mkdirSync(path.join(f.root, 'bootstrap-one'), { mode: 0o700 }); fs.mkdirSync(path.join(f.root, 'bootstrap-two'), { mode: 0o700 });
    assert.deepEqual(metadata(f.root), before); assert.throws(() => fs.mkdirSync(path.join(f.root, 'bootstrap-one')), /EEXIST/);
  } finally { f.cleanup(); }
});
test('executor import has no effects and needs external frozen identity', async () => {
  const { runBootstrap } = await import('../scripts/daemon-bootstrap-executor.mjs');
  await assert.rejects(runBootstrap({}), /Externally frozen contract/);
  const bytes = fs.readFileSync(new URL('../scripts/daemon-bootstrap-executor.mjs', import.meta.url)); assert.equal(sha256(bytes).length, 64);
});
test('executor rejects frozen dependency drift before importing helpers or touching host', async () => {
  const f = fixture();
  try {
    const helper = path.join(f.root, 'helper.mjs'), sentinel = path.join(f.root, 'imported');
    fs.writeFileSync(helper, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'must never execute');`);
    const executorPath = new URL('../scripts/daemon-bootstrap-executor.mjs', import.meta.url).pathname;
    const bytes = canonical({ executor: { path: executorPath, sha256: sha256(fs.readFileSync(executorPath)), dependencies: [{ source: helper, sha256: '0'.repeat(64), byte_length: fs.statSync(helper).size }] }, verification: { frozen_modules: [] } });
    const contractPath = path.join(f.root, 'contract.json'); fs.writeFileSync(contractPath, bytes);
    const { runBootstrap } = await import('../scripts/daemon-bootstrap-executor.mjs');
    await assert.rejects(runBootstrap({ contractPath, contractHash: sha256(bytes), head: '0'.repeat(40), phase: 'prepare' }), /dependency drift before import/);
    assert.equal(fs.existsSync(sentinel), false);
  } finally { f.cleanup(); }
});

test('real isolated verifyLive wrapper binds proof child close/final hash and cleans before return', async () => {
  const f = fixture(), saved = { ...process.env }, records = [];
  const server = createServer((_q, response) => { response.writeHead(200); response.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dist = path.join(f.root, 'dist'), src = path.join(dist, 'src'); fs.mkdirSync(dist); fs.mkdirSync(src);
  const root = fs.realpathSync(f.root);
  const app = 'export const value=1;\n';
  const index = `import './app-server.js';import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result=q.method==='initialize'?{}:q.method==='tools/list'?{tools:Array(8).fill({name:'fixture'})}:{content:[{type:'text',text:JSON.stringify({data:[{id:'synthetic'}]})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});\n`;
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(src, 'app-server.js'), app); fs.writeFileSync(path.join(src, 'index.js'), index);
  const wrapper = path.join(f.root, 'wrapper'), tunnel = path.join(f.root, 'tunnel'), health = path.join(f.root, 'health');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(new URL('../scripts/runtime-load-proof.mjs', import.meta.url).pathname)} ${shellQuote(path.join(src, 'index.js'))}\n`, { mode: 0o700 });
  fs.writeFileSync(tunnel, '#!/bin/sh\nprintf \'{"control_plane_poll":{"ok":true},"process":{"pid":77}}\'\n', { mode: 0o700 });
  fs.writeFileSync(health, `http://127.0.0.1:${server.address().port}\n`);
  Object.assign(process.env, { LCB_HEALTH_URL_FILE: health, CODEX_EXE: process.execPath, LCB_TUNNEL_CLIENT: tunnel, LCB_PID_FILE: path.join(f.root, 'pid'), LCB_STDIO_WRAPPER: wrapper });
  try {
    const { verifyLive } = await import(`../scripts/verify-fix-live.mjs?isolated=${Date.now()}`);
    const result = await verifyLive({ wrapper: true, runtimeProof: { root, hashes: { 'dist/src/index.js': sha256(index), 'dist/src/app-server.js': sha256(app) }, scratch: f.root, record: value => records.push(value) }, deadline: Date.now() + 5000 });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.wrapper.exit.code, 0);
    const final = result.wrapper.runtime_proof_cleanup;
    assert.equal(final.child.pid, result.wrapper.probe_loaded_runtime.pid); assert.equal(final.child.closed, true);
    assert.equal(final.receipt_state, 'complete'); assert.equal(final.cleanup.ok, true); assert.equal(fs.existsSync(final.directory), false);
    assert.ok(records.some(v => v.action === 'proof_final_identity' && v.receipt.sha256 === final.receipt.sha256));
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved);
    await new Promise(resolve => server.close(resolve));
    fs.unlinkSync(path.join(src, 'index.js')); fs.unlinkSync(path.join(src, 'app-server.js')); fs.rmdirSync(src); fs.rmdirSync(dist); f.cleanup();
  }
});
