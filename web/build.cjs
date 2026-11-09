// Compile an isolated copy; never rewrite upstream's source or desktop output.
const fs = require('node:fs');
const path = require('node:path');
const { transform } = require('sucrase');
const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(out, 'package.json'));
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'electron.cjs'), path.join(out, 'electron.cjs'));

function compile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) { compile(source); continue; }
    if ([path.join(root, 'src/main.ts'), path.join(root, 'src/preload.ts')].includes(source)) continue;
    if (entry.name.endsWith('.json')) {
      const target = path.join(out, path.relative(root, source));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      continue;
    }
    if (!entry.name.endsWith('.ts') || /\.(test|d)\.ts$/.test(entry.name)) continue;
    const target = path.join(out, path.relative(root, source)).replace(/\.ts$/, '.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const shim = './' + path.relative(path.dirname(target), path.join(out, 'electron.cjs')).split(path.sep).join('/');
    const { code } = transform(fs.readFileSync(source, 'utf8'), {
      transforms: ['typescript', 'imports'], filePath: source,
    });
    fs.writeFileSync(target, code.replace(/require\(["']electron["']\)/g, `require(${JSON.stringify(shim)})`));
  }
}
compile(path.join(root, 'src'));
const preload = transform(fs.readFileSync(path.join(root, 'src/preload.ts'), 'utf8'), {
  transforms: ['typescript', 'imports'], filePath: 'preload.ts',
}).code;
const client = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const coverClient = fs.readFileSync(path.join(__dirname, 'cover-client.js'), 'utf8');
fs.writeFileSync(path.join(out, 'bridge.js'), client + '\n' + coverClient + '\n' +
  `((exports, require) => {\n${preload}\n})({}, name => { if (name !== 'electron') throw Error(name); return window.__orbitElectron; });\n`);
console.log('Compiled upstream services, workers and preload into web/dist (no Electron runtime).');
