// Build output is sealed; the immutable verifier and frozen root live outside it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const out = resolve(process.argv[2] ?? join(root, 'releases', version));
const trust = resolve(process.argv[3] ?? join(root, 'releases', 'trust', version));
const pkg = join(out, 'package');
if (existsSync(out) || existsSync(trust)) throw new Error('Release and trust paths must be new; immutable outputs are never overwritten');
if (trust === pkg || trust.startsWith(pkg + '/')) throw new Error('External trust path required');
const git = args => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (r.status !== 0) throw new Error('Git inventory failed'); return r.stdout.trim(); };
const sha = value => createHash('sha256').update(value).digest('hex');
const incidentAllowlist = new Set(['incidents/2026-09-28-jsonl-overflow/README.md', 'incidents/2026-09-28-jsonl-overflow/provenance.json', 'incidents/2026-09-28-jsonl-overflow/acceptance-matrix.json', 'incidents/2026-09-28-jsonl-overflow/local-validation.json', 'incidents/2026-09-28-jsonl-overflow/historical-acceptance.json']);
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).filter(name => !name.startsWith('releases/') && (!name.startsWith('incidents/') || incidentAllowlist.has(name)));
mkdirSync(pkg, { recursive: true }); mkdirSync(trust, { recursive: true, mode: 0o700 });
if (realpathSync(trust).startsWith(realpathSync(pkg) + '/') || realpathSync(trust) === realpathSync(pkg)) throw new Error('External trust path must be physically outside package');
for (const name of tracked) { mkdirSync(dirname(join(pkg, name)), { recursive: true }); cpSync(join(root, name), join(pkg, name), { verbatimSymlinks: true }); }
cpSync(join(root, 'dist'), join(pkg, 'dist'), { recursive: true });
const provenance = JSON.parse(readFileSync(join(root, 'incidents/2026-09-28-jsonl-overflow/provenance.json')));
const changed = [...provenance.live_changed.map(row => row.path), 'package-lock.json', 'src/version.ts'];
const payload = {}, links = {};
function walk(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name, file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file, name + '/');
    else if (entry.isFile()) payload[name] = sha(readFileSync(file));
    else throw new Error('Release symlinks or nonregular files disallowed: ' + name);
  }
}
walk(pkg);
const manifest = { version, claim: 'candidate', source_commit: git(['rev-parse', 'HEAD']), upstream_commit: provenance.baseline_head, production: provenance.production, agent: provenance.production_identity.agent, git_head: provenance.baseline_head, git_index_hash: provenance.production_identity.git_index_hash, host_code_hashes: provenance.production_identity.host_code_hashes, changed, baseline: { ...provenance.production_files_before }, payload, baseline_links: {}, payload_links: {} };
for (const name of changed) if (!(name in manifest.baseline)) manifest.baseline[name] = null;
writeFileSync(join(pkg, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
payload['manifest.json'] = sha(readFileSync(join(pkg, 'manifest.json')));
const sealed = JSON.stringify({ version, files: payload, links }, null, 2) + '\n';
writeFileSync(join(pkg, 'package-manifest.json'), sealed);
const rootHash = sha(sealed);
const verifier = readFileSync(join(root, 'scripts/verify-package.mjs'), 'utf8');
const anchor = verifier + `\nexport const verifyAnchoredPackage = root => verifyPackage(root, '${rootHash}');\nif (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify(verifyAnchoredPackage(process.argv[2])));\n`;
writeFileSync(join(trust, 'verify-package.mjs'), anchor, { mode: 0o500 });
const checked = spawnSync(process.execPath, [join(trust, 'verify-package.mjs'), pkg], { encoding: 'utf8' });
if (checked.status !== 0) throw new Error('Candidate seal verification failed');
const archive = join(out, `local-codex-bridge-${version}.tar.gz`);
const tar = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', out, 'package'], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
if (tar.status !== 0) throw new Error('Archive creation failed');
const receipt = { version, claim: 'candidate', source_commit: manifest.source_commit, package: pkg, archive, archive_sha256: sha(readFileSync(archive)), manifest_sha256: sha(readFileSync(join(pkg, 'manifest.json'))), package_root_sha256: rootHash, trust_verifier: join(trust, 'verify-package.mjs'), trust_verifier_sha256: sha(anchor), production_modified: false, sealed_files: Object.keys(payload).length };
writeFileSync(join(out, 'release.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
