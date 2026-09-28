import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkHashes, hashFile, nativeSwap, targetedRestart, validateChanged, externalTrustPath } from './deploy-fix.mjs';
import { safePackagePath } from './verify-package.mjs';
import { verifyLive } from './verify-fix-live.mjs';
import { remoteModels } from './remote-model-probe.mjs';
export async function rollback(config, ops) {
  const source = join(config.backup, 'files');
  const baselineFile = join(config.backup, 'baseline.json');
  const baselineBytes = readFileSync(baselineFile);
  if (!/^[a-f0-9]{64}$/.test(config.backup_baseline_sha256 ?? '') || createHash('sha256').update(baselineBytes).digest('hex') !== config.backup_baseline_sha256) throw new Error('Frozen backup baseline digest mismatch');
  const old = JSON.parse(baselineBytes);
  const payload = Object.fromEntries(config.changed.map(name => [name, old[name] ?? '0'.repeat(64)]));
  validateChanged({ production: config.production, candidate: source, baseline: config.expected_current, payload, changed: config.changed });
  checkHashes(config.production, config.expected_current, 'current rollback baseline');
  const restoreHashes = Object.fromEntries(Object.entries(old).filter(([name]) => name.startsWith('dist/') || config.changed.includes(name)));
  checkHashes(source, restoreHashes, 'backup');
  if (ops.identity) ops.identity();
  const stageRoot = mkdtempSync(join(dirname(config.production), '.lcb-rollback-stage-'));
  const stage = join(stageRoot, 'dist');
  cpSync(join(source, 'dist'), stage, { recursive: true });
  try {
    for (const name of config.changed) {
      const target = safePackagePath(config.production, name);
      if (old[name] === null || !(name in old)) { if (existsSync(target)) unlinkSync(target); }
      else { const tmp = target + '.rollback-' + process.pid; mkdirSync(dirname(target), { recursive: true }); cpSync(safePackagePath(source, name), tmp, { errorOnExist: true, force: false }); renameSync(tmp, target); }
    }
    ops.swap(join(config.production, 'dist'), stage);
    checkHashes(config.production, old, 'restored baseline');
    await ops.restart();
    const verification = await ops.verify(old);
    if (verification?.ok !== true || verification?.loaded_instance?.ok !== true) throw new Error('Old loaded instance proof missing');
    const receipt = { rolled_back: true, backup: config.backup, displaced_runtime: stage, verification };
    writeFileSync(join(stageRoot, 'rollback-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    writeFileSync(join(stageRoot, 'rollback-receipt.json'), JSON.stringify({ rolled_back: false, manual_recovery_required: true }));
    throw new Error('MANUAL_RECOVERY_REQUIRED; explicit rollback incomplete; receipt=' + join(stageRoot, 'rollback-receipt.json'));
  }
}
async function main() {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  if (!process.env.LCB_TRUST_VERIFIER) throw new Error('External trusted runner required');
  const { verifyAnchoredPackage } = await import(pathToFileURL(externalTrustPath(packageRoot, process.env.LCB_TRUST_VERIFIER)).href);
  verifyAnchoredPackage(packageRoot);
  const contract = process.argv[2], anchor = process.env.LCB_ROLLBACK_CONTRACT_SHA256;
  if (!contract || !/^[a-f0-9]{64}$/.test(anchor ?? '')) throw new Error('Frozen external rollback contract required');
  const contractBytes = readFileSync(contract);
  if (createHash('sha256').update(contractBytes).digest('hex') !== anchor) throw new Error('Frozen external rollback contract required');
  const config = JSON.parse(contractBytes);
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 }); if (r.status !== 0) throw new Error('Target command failed'); return r; };
  const instance = () => { const r = run('/bin/launchctl', ['print', config.agent]); const pid = Number(r.stdout.match(/^\s*pid = (\d+)$/m)?.[1]); if (!pid) throw new Error('LaunchAgent running identity missing'); return pid; };
  let previous;
  const receipt = await rollback(config, {
    identity: () => { for (const [path, hash] of Object.entries(config.host_code_hashes ?? {})) if (hashFile(path) !== hash) throw new Error('Host identity changed'); },
    swap: nativeSwap,
    restart: async () => { previous = instance(); targetedRestart(config.agent, run); },
    verify: async old => {
      const deadline = Date.now() + 45000;
      do {
        const result = await verifyLive({ wrapper: true, runtimeProof: { root: config.production, hashes: old } });
        if (result.ok && result.wrapper.runtime_proof?.ok && instance() !== previous) { result.remote_codex_models = await remoteModels(); result.loaded_instance = result.wrapper.runtime_proof; return result; }
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error('Rollback loaded-instance verification deadline');
    },
  });
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ rolled_back: false, error: error.message })); process.exitCode = 1; });
