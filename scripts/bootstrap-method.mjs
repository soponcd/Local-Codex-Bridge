// Bootstrap execution primitives. No host effects occur on import.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntimeProof } from './runtime-load-proof.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => Buffer.from(JSON.stringify(sort(value)) + '\n');
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
export const metadata = file => {
  const s = fs.lstatSync(file);
  return { path: file, dev: s.dev, ino: s.ino, type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other', mode: '0' + (s.mode & 0o7777).toString(8), uid: s.uid, gid: s.gid, ...(s.isFile() ? { length: s.size, sha256: sha256(fs.readFileSync(file)) } : {}) };
};
export const sameIdentity = (a, b) => ['path', 'dev', 'ino', 'type', 'mode', 'uid', 'gid', 'length', 'sha256'].every(k => a[k] === b[k]);
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// Bind the allocated directory/config and absent receipt before spawning, then
// adopt only that child output after close. Never infer ownership from a prefix.
export function ownedProofLifecycle(record = () => {}, scratch = '/private/tmp') {
  const owned = new Map();
  return {
    create(root, hashes) {
      const proof = createRuntimeProof(root, hashes, scratch), directory = path.dirname(proof.config);
      const state = { proof, directory: metadata(directory), config: metadata(proof.config), receipt_prestate: 'absent', child: null };
      requireThat(state.directory.type === 'directory' && state.directory.mode === '0700' && state.directory.uid === process.getuid() && fs.realpathSync(directory) === directory, 'proof directory identity');
      requireThat(state.config.type === 'file' && state.config.mode === '0600' && state.config.uid === state.directory.uid && !exists(proof.receipt), 'proof config/receipt prestate');
      owned.set(proof, state); record({ action: 'proof_created', ...state, proof: { root: proof.root, expected: proof.expected, config: proof.config, receipt: proof.receipt } }); return proof;
    },
    spawned(proof, pid) {
      const state = owned.get(proof); requireThat(state && state.child === null && Number.isSafeInteger(pid) && pid > 0, 'proof child PID');
      state.child = { pid, closed: false }; record({ action: 'proof_child', directory: state.directory.path, child_pid: pid });
    },
    finish(proof, exit) {
      const state = owned.get(proof); requireThat(state, 'proof lifecycle binding');
      const result = { directory: state.directory.path, config: state.config, child: state.child ? { ...state.child, closed: true, exit } : { pid: null, closed: true, exit }, receipt: null, receipt_state: 'missing', cleanup: { ok: false, classification: 'scratch_ownership_unknown', retained_paths: [state.directory.path] } };
      try {
        requireThat(exit && (Number.isInteger(exit.code) || exit.signal || exit.spawn_error) && (!state.child || exit.spawn_error || Number.isInteger(exit.code) || exit.signal), 'proof child exit unavailable');
        requireThat(sameIdentity(metadata(state.directory.path), state.directory) && sameIdentity(metadata(proof.config), state.config), 'proof directory/config drift');
        const bound = JSON.parse(fs.readFileSync(proof.config, 'utf8'));
        requireThat(canonical(bound).equals(canonical(proof)), 'proof exact config binding');
        const names = fs.readdirSync(state.directory.path);
        requireThat(names.every(n => n === 'config.json' || n === 'loaded.json'), 'unknown proof content');
        if (exists(proof.receipt)) {
          const receipt = metadata(proof.receipt);
          requireThat(receipt.type === 'file' && receipt.mode === '0600' && receipt.uid === state.directory.uid && receipt.gid === state.config.gid && receipt.length <= 65536 && fs.realpathSync(proof.receipt) === proof.receipt && state.child, 'proof receipt ownership');
          let body; try { body = JSON.parse(fs.readFileSync(proof.receipt, 'utf8')); } catch {}
          if (body) {
            requireThat(Object.keys(body).sort().join('|') === 'failure|loaded|pid|root' && body.pid === state.child.pid && body.root === proof.root && body.loaded && typeof body.loaded === 'object' && !Array.isArray(body.loaded) && typeof body.failure === 'boolean', 'proof receipt child/config mismatch');
            result.receipt_state = body.failure || exit.code !== 0 ? 'failed' : Object.keys(proof.expected).every(k => body.loaded[k] === proof.expected[k]) ? 'complete' : 'partial';
          } else result.receipt_state = 'partial';
          result.receipt = receipt;
        }
        record({ action: 'proof_final_identity', ...result });
        // Validate every identity before any unlink, then check again at unlink.
        if (result.receipt) { requireThat(sameIdentity(metadata(proof.receipt), result.receipt), 'proof receipt changed'); fs.unlinkSync(proof.receipt); }
        requireThat(sameIdentity(metadata(proof.config), state.config), 'proof config changed'); fs.unlinkSync(proof.config);
        requireThat(sameIdentity(metadata(state.directory.path), state.directory) && fs.readdirSync(state.directory.path).length === 0, 'proof directory changed'); fs.rmdirSync(state.directory.path);
        result.cleanup = { ok: true, classification: 'owned_scratch_removed', retained_paths: [] };
      } catch (e) { result.cleanup.error = e.message; }
      record({ action: 'proof_cleanup', ...result }); owned.delete(proof); return result;
    }
  };
}

export async function gate(record, name, operation) {
  requireThat(record.gates[name] === 'not_run', 'gate already attempted');
  try { const result = await operation(); record.gates[name] = 'passed'; return result; }
  catch (e) {
    if (e.failure_domain === 'scratch_cleanup' && e.verification_result?.ok) {
      record.gates[name] = 'passed'; record.failure_domain = 'scratch_cleanup';
      (record.scratch_cleanup ??= []).push(e.cleanup);
    } else { record.gates[name] = 'failed'; record.failed_gate = name; }
    throw e;
  }
}

// The LaunchAgent/Tunnel authority survives a missing or crashed Bridge child.
export function tunnelSnapshot({ agent, uid, tunnelProgram, plist }, readOS) {
  requireThat(agent === `gui/${uid}/com.openai.tunnel-client.lcb-remote`, 'exact agent required');
  const launch = readOS('/bin/launchctl', ['print', agent]);
  const pid = Number(launch.match(/^\s*pid = (\d+)$/m)?.[1]);
  requireThat(pid > 0 && /^\s*state = running$/m.test(launch) && launch.match(/^\s*program = (.+)$/m)?.[1] === tunnelProgram && launch.match(/^\s*path = (.+)$/m)?.[1] === plist, 'exact LaunchAgent/Tunnel unavailable');
  const match = readOS('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=']).trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  requireThat(match && Number(match[1]) === pid && Number(match[3]) === uid, 'Tunnel OS identity');
  return { agent, tunnel: { pid, ppid: Number(match[2]), uid: Number(match[3]), start: match[4] }, runs: Number(launch.match(/^\s*runs = (\d+)$/m)?.[1]) };
}

export async function restartForRollback({ applyRestart, readTunnel, restoreGuard, kick }) {
  restoreGuard(); const before = readTunnel();
  return { restart_before: before, ...(applyRestart ? { restart: await kick() } : {}) };
}

export async function verifyRollbackAttempt({ record, applyRestart, originalBefore, restartBefore, baseline, readIdentity, verifyLive, remoteModels, restoreGuard, deadline }) {
  let first, live;
  await gate(record, 'exact_tunnel', async () => {
    baseline(); first = readIdentity();
    if (applyRestart) requireThat(first.tunnel.pid !== restartBefore.tunnel.pid && first.tunnel.start !== restartBefore.tunnel.start, 'rollback replacement');
    else requireThat(canonical(first).equals(canonical(originalBefore)), 'old preflight instance');
  });
  await gate(record, 'health', async () => {
    live = await verifyLive(); record.health = live;
    requireThat(live.healthz?.ok && live.readyz?.ok && live.control_plane?.ok && live.control_plane.pid === first.tunnel.pid, 'rollback service health');
  });
  await gate(record, 'wrapper', async () => requireThat(live.wrapper?.ok, 'rollback wrapper failed'));
  try { await gate(record, 'remote', async () => { const value = await remoteModels(); record.remote_codex_models = value; requireThat(value.ok, 'rollback remote'); }); }
  catch (error) {
    if (error.failure_domain !== 'scratch_cleanup' || !error.verification_result?.ok) throw error;
    record.remote_codex_models = error.verification_result;
  }
  await gate(record, 'final_identity', async () => {
    const final = readIdentity(); requireThat(canonical(first).equals(canonical(final)), 'rollback service unstable');
    baseline(); restoreGuard(); requireThat(Date.now() < deadline, 'rollback deadline'); record.identity = final;
  });
  record.ok = true; return record;
}
