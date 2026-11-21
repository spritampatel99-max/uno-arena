'use strict';
// Syntax check for every JavaScript file in the project, using Node's own parser (no dependencies).
//   server/ and tests/   -> CommonJS, checked with `node --check`
//   public/js/           -> ES modules, copied to a temp .mjs file and checked with `node --check`
// Also verifies that every relative import in the client resolves to a real file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uno-syntax-'));
let failures = 0;
let checked = 0;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

function check(file, asModule) {
  let target = file;
  if (asModule) {
    target = path.join(tmp, String(checked) + '.mjs');
    fs.copyFileSync(file, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  checked++;
  if (r.status !== 0) {
    failures++;
    console.error('FAIL ' + path.relative(root, file) + '\n' + (r.stderr || r.stdout));
  }
}

for (const dir of ['server', 'tests']) {
  const d = path.join(root, dir);
  if (fs.existsSync(d)) for (const f of walk(d)) check(f, false);
}

const clientDir = path.join(root, 'public', 'js');
for (const f of walk(clientDir)) {
  check(f, true);
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]/g)) {
    const spec = m[1] || m[2];
    if (!fs.existsSync(path.resolve(path.dirname(f), spec))) {
      failures++;
      console.error('FAIL ' + path.relative(root, f) + ': unresolved import ' + spec);
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} problem(s) in ${checked} file(s).`);
  process.exit(1);
}
console.log(`syntax OK - ${checked} files parsed, all client imports resolve.`);
