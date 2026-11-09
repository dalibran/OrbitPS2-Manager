const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');
const { validate, checkPath } = require('../policy.cjs');
const { createDispatcher, initializeLibrary } = require('../transport.cjs');
const { createServer, privateAddress } = require('../server.cjs');
let temporary, config, dispatch, handlers;
before(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-web-test-')));
  const root = path.join(temporary, 'library');
  const inbox = path.join(temporary, 'inbox');
  const data = path.join(temporary, 'data');
  const staticDir = path.join(temporary, 'static');
  for (const dir of [root, inbox, data, staticDir]) await fs.mkdir(dir);
  await fs.writeFile(path.join(staticDir, 'index.html'), '<html><head></head><body>Orbit</body></html>');
  config = { root, inbox, data, staticDir, repo: path.resolve(__dirname, '../..'), maxUploadBytes: 1024 * 1024 };
  const shim = require('../dist/electron.cjs');
  shim.configure(config);
  config.parseArtworkBaseName = require('../dist/src/utils/artwork-name.js').parseArtworkBaseName;
  require('../dist/src/ipc/index.js').registerAllIpc();
  require('../dist/src/utils/worker-pool.js').WorkerPool.defaultSize = () => 1;
  handlers = shim.handlers;
  dispatch = createDispatcher(handlers, config);
});
after(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

test('upstream services create and browse a library, preserve CFG keys, and manage VMCs', async () => {
  const root = config.root;
  const missing = await dispatch.invoke('check-opl-structure', [root]);
  assert.equal(missing.missing.length, 8);
  assert.equal((await dispatch.invoke('create-opl-folders', [root, missing.missing])).success, true);
  await fs.writeFile(path.join(root, 'DVD/SLUS_200.01.Test.iso'), Buffer.alloc(2048));
  const games = await dispatch.invoke('get-games-files', [root]);
  assert.equal(games.data[0].name, 'SLUS_200.01.Test');
  await fs.writeFile(path.join(root, 'CFG/SLUS_200.01.cfg'), 'Unknown=keep\n');
  const originalCfg = await dispatch.invoke('read-game-cfg', [root, 'SLUS_200.01']);
  await dispatch.invoke('write-game-cfg', [root, 'SLUS_200.01', { ...originalCfg.entries, '$Name': 'Test' }]);
  const cfg = await fs.readFile(path.join(root, 'CFG/SLUS_200.01.cfg'), 'utf8');
  assert.match(cfg, /Unknown=keep/);
  assert.match(cfg, /\$Name=Test/);
  assert.equal((await dispatch.invoke('create-vmc', [root, 'test', 8])).success, true);
  assert.equal((await dispatch.invoke('list-vmc', [root])).cards[0].sizeMb, 8);
  await dispatch.invoke('delete-vmc', [root, 'test']);
  assert.equal((await dispatch.invoke('list-vmc', [root])).cards.length, 0);
  const settings = await dispatch.invoke('get-settings', []);
  assert.equal(settings.lastDirectory, root);
});

test('upstream worker compression round trip and progress work without Electron', async () => {
  const original = path.join(config.root, 'DVD/roundtrip.iso');
  const compressed = path.join(config.root, 'DVD/roundtrip.zso');
  const restored = path.join(config.root, 'DVD/restored.iso');
  const bytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) bytes.writeUInt32LE(i, i);
  await fs.writeFile(original, bytes);
  const events = [];
  const result = await dispatch.invoke('compress-iso-to-zso', [original, compressed, false], (...event) => events.push(event));
  assert.equal(result.success, true, result.message);
  assert.ok(events.some(([channel]) => channel === 'zso-compress-progress'));
  assert.equal((await dispatch.invoke('decompress-zso-to-iso', [compressed, restored, false])).success, true);
  assert.deepEqual(await fs.readFile(restored), bytes);
  await assert.rejects(dispatch.invoke('compress-iso-to-zso', [original, compressed, false]), /already exists/);
});

test('path policy denies traversal, escaping symlinks, unknown RPCs, and unsafe CUE references', async () => {
  await assert.rejects(validate('get-games-files', [temporary], config), /configured/);
  await assert.rejects(validate('read-game-cfg', [config.root, '../../secret'], config), /Invalid name/);
  await assert.rejects(validate('new-upstream-feature', [], config), /unavailable/);
  await fs.symlink(temporary, path.join(config.root, 'escape'));
  await assert.rejects(checkPath(path.join(config.root, 'escape/secret'), [config.root]), /Symlink/);
  await fs.writeFile(path.join(config.inbox, 'bad.cue'), 'FILE "../../secret.bin" BINARY\n');
  await assert.rejects(validate('import-ps1-game', [path.join(config.inbox, 'bad.cue'), config.root], config), /outside/);
  await validate('check-art-files-exist', [path.join(config.root, 'ART'), ['PSBBN/SLUS_200.01.png']], config);
  await assert.rejects(validate('check-art-files-exist', [path.join(config.root, 'ART'), ['../../../secret']], config), /outside/);
});

// Drive the actual HTTP request listener without requiring a socket permission.
async function httpRequest(server, address, options = {}) {
  const url = new URL(address);
  const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  req.url = url.pathname + url.search;
  req.method = options.method || 'GET';
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: url.host };
  for (const [key, value] of Object.entries(options.headers || {})) req.headers[key.toLowerCase()] = value;
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headersSent = true; Object.assign(res.headers, headers); };
  const done = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
  server.emit('request', req, res);
  await done;
  const text = Buffer.concat(chunks).toString();
  return { status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: async () => text, json: async () => JSON.parse(text) };
}

test('HTTP serves browser bridge, protects mutations, streams uploads, and scopes artwork', async () => {
  const server = await createServer(config, handlers);
  const base = 'http://127.0.0.1:3000';
  const fetch = (url, options) => httpRequest(server, url, options);
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /data-orbit-web/);
    assert.match(html, /<link rel="stylesheet" href="\/web.css">/);
    assert.equal((await fetch(base + '/web.css')).status, 200);
    assert.match(html, /<script src="\/bridge.js"><\/script>/);
    assert.equal((await fetch(base + '/bridge.js')).status, 200);
    assert.equal((await fetch(base + '/api/rpc', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/api/session', { headers: { Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await fetch(base + '/api/session', { headers: { Host: 'evil.test' } })).status, 403);
    const session = await (await fetch(base + '/api/session')).json();
    const headers = { 'X-Orbit-Token': session.token };
    const filename = 'upload.iso';
    const uploadUrl = base + `/api/upload?batch=${'a'.repeat(32)}&name=${filename}`;
    const uploaded = await fetch(uploadUrl, { method: 'POST', headers, body: 'disc bytes' });
    assert.equal(uploaded.status, 200);
    const saved = await uploaded.json();
    assert.equal(await fs.readFile(saved.path, 'utf8'), 'disc bytes');
    assert.equal((await fetch(uploadUrl, { method: 'POST', headers, body: 'overwrite' })).status, 400);
    assert.equal(await fs.readFile(saved.path, 'utf8'), 'disc bytes');
    const rpc = async (channel, args) => (await (await fetch(base + '/api/rpc', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args }),
    })).json()).result;
    const moved = await rpc('move-file', [saved.path, path.join(config.root, 'DVD')]);
    assert.equal(moved.success, true);
    assert.equal((await rpc('rename-gamefile', [moved.newPath, 'SLUS_200.02', 'Uploaded'])).success, true);
    assert.equal(await fs.readFile(path.join(config.root, 'DVD/SLUS_200.02.Uploaded.iso'), 'utf8'), 'disc bytes');
    const scanned = await fetch(base + '/api/rpc', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'get-games-files', args: [config.root] }) });
    assert.equal((await scanned.json()).result.success, true);
    const art = path.join(config.root, 'ART/SLUS_200.01_COV.png');
    await fs.writeFile(art, 'image bytes');
    const metadata = await createDispatcher(handlers, config).invoke('get-art-folder', [config.root]);
    assert.equal(metadata.data[0].base64, '');
    assert.equal(metadata.data[0].gameId, 'SLUS_200.01');
    assert.equal(await (await fetch(base + metadata.data[0].url)).text(), 'image bytes');
    assert.equal((await fetch(base + '/api/art?path=' + encodeURIComponent(path.join(config.root, 'DVD/roundtrip.iso')))).status, 400);
    const jobs = await (await fetch(base + '/api/jobs', { headers })).json();
    assert.ok(Array.isArray(jobs));
  } finally { server.close(); }
});

test('mutation queue serializes requests and records completed operations', async () => {
  let active = 0, peak = 0;
  const isolated = createDispatcher(new Map([['create-vmc', async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return { success: true };
  }]]), config);
  await Promise.all([isolated.invoke('create-vmc', [config.root, 'one', 8]), isolated.invoke('create-vmc', [config.root, 'two', 8])]);
  assert.equal(peak, 1);
  assert.ok(isolated.jobs.every(job => job.state === 'complete'));
});

test('public network clients are denied', () => {
  assert.equal(privateAddress('192.168.1.2'), true);
  assert.equal(privateAddress('::ffff:10.0.0.2'), true);
  assert.equal(privateAddress('8.8.8.8'), false);
});

test('an empty library is initialized and DVD imports stay discoverable when its folder is missing', async () => {
  const root = path.join(temporary, 'fresh-library');
  await fs.mkdir(root);
  const fresh = { ...config, root };
  await initializeLibrary(handlers, fresh);
  for (const folder of ['APPS', 'ART', 'CD', 'CFG', 'DVD', 'POPS', 'VCD', 'VMC'])
    assert.equal((await fs.stat(path.join(root, folder))).isDirectory(), true);
  // A removed folder must not cause moveFile to reinterpret it as a filename.
  await fs.rmdir(path.join(root, 'DVD'));
  await fs.rmdir(path.join(root, 'CFG'));
  const source = path.join(config.inbox, 'fresh.iso');
  await fs.writeFile(source, 'disc bytes');
  const adapter = createDispatcher(handlers, fresh);
  const moved = await adapter.invoke('move-file', [source, path.join(root, 'DVD')]);
  assert.equal(moved.success, true, moved.message);
  assert.equal(moved.newPath, path.join(root, 'DVD/fresh.iso'));
  assert.equal((await fs.stat(path.join(root, 'CFG'))).isDirectory(), true);
  assert.equal((await adapter.invoke('rename-gamefile', [moved.newPath, 'SLUS_206.24', 'Test Game'])).success, true);
  const scan = await adapter.invoke('get-games-files', [root]);
  assert.equal(scan.data.length, 1);
  assert.equal(scan.data[0].extension, '.iso');
  assert.equal(scan.data[0].name, 'SLUS_206.24.Test Game');
  assert.equal(await fs.readFile(scan.data[0].path, 'utf8'), 'disc bytes');
});

test('DVD imports preserve ISO/ZSO extensions under both naming conventions and reject extensionless files', async () => {
  for (const [filename, nameOnly] of [['uppercase.ISO', false], ['modern.iso', true], ['compressed.ZSO', true]]) {
    const source = path.join(config.inbox, filename);
    await fs.writeFile(source, filename);
    const moved = await dispatch.invoke('move-file', [source, path.join(config.root, 'DVD')]);
    assert.equal(moved.success, true);
    const renamed = await dispatch.invoke('rename-gamefile', [moved.newPath, 'SLUS_200.03', filename.split('.')[0], nameOnly]);
    assert.equal(renamed.success, true);
    assert.equal(path.extname(renamed.newPath), path.extname(filename).toLowerCase());
    const scan = await dispatch.invoke('get-games-files', [config.root]);
    assert.ok(scan.data.some(file => file.path === renamed.newPath));
    assert.equal(await fs.readFile(renamed.newPath, 'utf8'), filename);
  }
  const source = path.join(config.inbox, 'extensionless');
  await fs.writeFile(source, 'untouched');
  await assert.rejects(dispatch.invoke('move-file', [source, path.join(config.root, 'DVD')]), /require an .iso or .zso/);
  assert.equal(await fs.readFile(source, 'utf8'), 'untouched');
});

test('library initialization refuses to overwrite files obstructing required folders', async () => {
  const root = path.join(temporary, 'obstructed-library');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'DVD'), 'existing data');
  await assert.rejects(initializeLibrary(handlers, { ...config, root }), /EEXIST/);
  assert.equal(await fs.readFile(path.join(root, 'DVD'), 'utf8'), 'existing data');
});

test('the generated browser bridge uses upstream API signatures and dispatches progress', async () => {
  const vm = require('node:vm');
  const calls = [];
  let eventSource;
  class FakeEventSource {
    constructor() { eventSource = this; queueMicrotask(() => this.onopen()); }
  }
  const context = vm.createContext({
    window: {}, setTimeout, clearTimeout, EventSource: FakeEventSource,
    fetch: async (url, options) => {
      if (url === '/api/session') return { ok: true, json: async () => ({ token: 'token', root: config.root }) };
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ result: { autoReconnect: true } }) };
    },
  });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../dist/bridge.js'), 'utf8'), context);
  const api = context.window.libraryAPI;
  assert.equal((await api.openAskDirectory()).filePaths[0], config.root);
  assert.equal(await context.window.windowAPI.platform(), 'web');
  assert.equal((await api.getSettings()).autoReconnect, true);
  assert.equal(calls[0].channel, 'get-settings');
  let progress = 0;
  api.onZsoCompressProgress(value => { progress = value.percent; });
  eventSource.onmessage({ data: JSON.stringify({ channel: 'zso-compress-progress', payload: { percent: 75 } }) });
  assert.equal(progress, 75);
  api.removeAllZsoCompressProgressListeners();
  eventSource.onmessage({ data: JSON.stringify({ channel: 'zso-compress-progress', payload: { percent: 99 } }) });
  assert.equal(progress, 75);
});

test('new upstream preload methods must receive an explicit web policy', async () => {
  const source = await fs.readFile(path.join(config.repo, 'src/preload.ts'), 'utf8');
  const browserOnly = new Set(['open-ask-directory', 'open-ask-game-files', 'open-ask-elf-files', 'open-external',
    'check-for-updates', 'list-optical-drives', 'list-optical-drives-cd', 'window-platform',
    'window-can-window-controls', 'window-wm-info', 'window-is-maximized']);
  const unavailable = new Set(['rip-ps2-dvd-from-drive', 'rip-ps2-cd-from-drive', 'delete-temp-disc-rip']);
  const { rules } = require('../policy.cjs');
  for (const [, channel] of source.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g))
    assert.ok(Object.hasOwn(rules, channel) || browserOnly.has(channel) || unavailable.has(channel), `Review new upstream channel: ${channel}`);
});

test('file picker opens and cancels while the inbox is loading; failed opens reject and clean up', async () => {
  const vm = require('node:vm');
  let failOpen = false;
  const body = { children: [], append(element) { this.children.push(element); } };
  const document = { body, createElement(tag) { return {
    tag, children: [], style: {}, disabled: false, attributes: {},
    append(...elements) { this.children.push(...elements); },
    setAttribute(key, value) { this.attributes[key] = value; },
    showModal() { if (failOpen) throw Error('Cannot open dialog'); this.open = true; },
    close() { this.open = false; },
    remove() { body.children = body.children.filter(element => element !== this); },
  }; } };
  class FakeEventSource { constructor() { queueMicrotask(() => this.onopen()); } }
  const context = vm.createContext({ window: {}, document, setTimeout, clearTimeout, EventSource: FakeEventSource,
    fetch: async url => {
      if (url === '/api/session') return { ok: true, json: async () => ({ token: 'token', root: config.root }) };
      if (url === '/api/inbox') return new Promise(() => {}); // unresponsive inbox must not trap the user
      throw Error(`Unexpected request: ${url}`);
    },
  });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../dist/bridge.js'), 'utf8'), context);
  const api = context.window.libraryAPI;
  await api.openAskDirectory(); // session and progress connection are ready
  for (const picker of [() => api.openAskGameFiles(false, true), () => api.openAskElfFiles()]) {
    const result = picker();
    await new Promise(resolve => setImmediate(resolve));
    const dialog = body.children[0];
    assert.equal(dialog.open, true);
    // DaisyUI hides standalone modal-box elements (opacity: 0); only use that
    // class when its required .modal parent exists.
    assert.ok(!dialog.className.split(/\s+/).includes('modal-box'));
    const input = dialog.children.find(child => child.tag === 'input');
    assert.equal(input.type, 'file');
    const cancel = dialog.children.find(child => child.textContent === 'Cancel');
    cancel.onclick();
    assert.equal((await result).canceled, true);
    assert.equal(body.children.length, 0);
  }
  const escapeResult = api.openAskGameFiles(true, false);
  await new Promise(resolve => setImmediate(resolve));
  body.children[0].oncancel({ preventDefault() {} });
  assert.equal((await escapeResult).canceled, true);
  assert.equal(body.children.length, 0);
  failOpen = true;
  await assert.rejects(api.openAskElfFiles(), /Cannot open dialog/);
  assert.equal(body.children.length, 0);
});

test('cover HTTP flow searches, previews, selects, uploads, serves offline originals, and resets', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
  const coverFetch = async url => ({ ok: true, body: Readable.from([url.includes('api.github.com')
    ? Buffer.from(JSON.stringify({ tree: url.endsWith('/master')
      ? [{ type: 'tree', path: 'Named_Boxarts_1024', sha: 'a'.repeat(40) }]
      : [{ type: 'blob', path: 'Test Game (USA).png' }] })) : png]) });
  const server = await createServer({ ...config, coverFetch }, handlers);
  const base = 'http://127.0.0.1:3000';
  const fetch = (url, options) => httpRequest(server, base + url, options);
  const session = await (await fetch('/api/session')).json();
  const headers = { 'X-Orbit-Token': session.token };
  try {
    assert.equal((await fetch('/api/covers/upload?identity=TEST', { method: 'POST', body: png })).status, 401);
    const found = await (await fetch('/api/covers/search?query=Test%20Game&system=PS2', { headers })).json();
    assert.equal(found.results.length, 1);
    const preview = await fetch(found.results[0].preview, { headers });
    assert.equal(preview.headers['Content-Type'], 'image/png');
    assert.deepEqual(preview.bytes, png);
    const selectedResponse = await fetch('/api/covers/select', { method: 'POST', headers,
      body: JSON.stringify({ identity: 'TEST', candidateId: found.results[0].id }) });
    assert.equal(selectedResponse.status, 200);
    const selected = await selectedResponse.json();
    assert.deepEqual((await fetch(selected.url)).bytes, png);
    assert.equal((await (await fetch('/api/covers/current?identity=TEST', { headers })).json()).source, 'Libretro');
    const uploaded = await fetch('/api/covers/upload?identity=TEST', { method: 'POST', headers, body: png });
    assert.equal((await uploaded.json()).source, 'Local upload');
    assert.equal((await fetch('/api/covers/upload?identity=..%2Fescape', { method: 'POST', headers, body: png })).status, 400);
    assert.equal((await fetch('/api/covers/image?asset=../../secret')).status, 400);
    await fetch('/api/covers/current?identity=TEST', { method: 'DELETE', headers });
    assert.equal(await (await fetch('/api/covers/current?identity=TEST', { headers })).json(), null);
  } finally { server.close(); }
});

test('cover gallery lets a user search, apply a choice, close, or cancel without saving', async () => {
  const vm = require('node:vm');
  const body = { children: [], append(element) { this.children.push(element); } };
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const document = { body, createElement(tag) { return {
    tag, children: [], attributes: {}, disabled: false,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(key, value) { this.attributes[key] = value; },
    querySelectorAll() { return descendants(this).filter(child => ['button', 'input', 'select'].includes(child.tag)); },
    showModal() { this.open = true; }, close() { this.open = false; },
    remove() { body.children = body.children.filter(child => child !== this); },
  }; } };
  const calls = [];
  let searchFails = false;
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('/api/covers/current')) return null;
    if (url.startsWith('/api/covers/search') && searchFails) return {
      steamgriddbEnabled: false, warnings: ['Libretro: connection failed'], results: [],
      providers: [{ source: 'Libretro', status: 'error' }],
    };
    if (url.startsWith('/api/covers/search')) return { steamgriddbEnabled: false, warnings: [], results: [
      { id: 'result', preview: '/api/covers/preview?id=result', title: 'Test Game (USA)', source: 'Libretro', collection: 'High-resolution box art' },
    ] };
    if (url === '/api/covers/select') return { source: 'Libretro', width: 700, height: 1000 };
    throw Error(url);
  };
  const context = vm.createContext({ window: {}, document });
  vm.runInContext(await fs.readFile(path.join(config.repo, 'web/cover-client.js'), 'utf8'), context);
  const open = () => context.window.__orbitChooseCover({ title: 'Test Game', identity: 'TEST', system: 'PS2' }, { request, ready: Promise.resolve({ token: 'session' }) });
  const result = open();
  await new Promise(resolve => setImmediate(resolve));
  let dialog = body.children[0];
  assert.equal(dialog.open, true);
  const use = descendants(dialog).find(node => node.textContent === 'Use this cover');
  await use.onclick();
  const selection = calls.find(call => call.url === '/api/covers/select');
  assert.deepEqual(JSON.parse(selection.options.body), { identity: 'TEST', candidateId: 'result' });
  descendants(dialog).find(node => node.textContent === 'Close').onclick();
  assert.equal(await result, true);
  assert.equal(body.children.length, 0);
  const cancelled = open();
  await new Promise(resolve => setImmediate(resolve));
  dialog = body.children[0];
  dialog.oncancel({ preventDefault() {} });
  assert.equal(await cancelled, false);
  assert.equal(body.children.length, 0);
  searchFails = true;
  const failedSearch = open();
  await new Promise(resolve => setImmediate(resolve));
  dialog = body.children[0];
  const status = descendants(dialog).find(node => node.attributes.role === 'status');
  assert.match(status.textContent, /Cover search failed/);
  assert.doesNotMatch(status.textContent, /No matching covers/);
  dialog.oncancel({ preventDefault() {} });
  assert.equal(await failedSearch, false);
});
