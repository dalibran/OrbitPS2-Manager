const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { name, checkPath } = require('./policy.cjs');
const { createDispatcher, initializeLibrary } = require('./transport.cjs');
const { createCoverService, readLimited, MAX_IMAGE_BYTES } = require('./covers.cjs');

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw Error('Request too large.');
  }
  return JSON.parse(data);
}
function privateAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) || /^(fc|fd|fe80:)/i.test(ip);
}
function allowedHosts(extra = '') {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase(), os.hostname().toLowerCase() + '.local']);
  for (const entries of Object.values(os.networkInterfaces())) for (const item of entries || []) {
    if (privateAddress(item.address)) hosts.add(item.family === 'IPv6' ? `[${item.address}]` : item.address);
  }
  for (const host of extra.split(',').filter(Boolean)) hosts.add(host.trim().toLowerCase());
  return hosts;
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
async function file(res, target, html = false, noCache = false) {
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw Error('Not a file.');
  let contents;
  if (html) {
    contents = (await fsp.readFile(target, 'utf8'))
      .replace(/<html(?=\s|>)/i, '<html data-orbit-web')
      .replace('<head>', '<head><link rel="stylesheet" href="/web.css"><script src="/bridge.js"></script>');
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream',
    'Content-Length': contents ? Buffer.byteLength(contents) : stat.size,
    'Cache-Control': html || noCache ? 'no-store' : 'private, max-age=60' });
  if (contents) res.end(contents);
  else await pipeline(fs.createReadStream(target), res);
}
async function listInbox(dir, base = dir, depth = 0) {
  const files = [];
  for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const target = path.join(dir, item.name);
    if (item.isDirectory() && depth < 1) files.push(...await listInbox(target, base, depth + 1));
    if (item.isFile() && /\.(iso|zso|cue|bin|elf)$/i.test(item.name)) files.push({ path: target, name: path.relative(base, target) });
    if (files.length >= 500) break;
  }
  return files.slice(0, 500);
}
async function createServer(config, handlers) {
  const sessions = new Map();
  const hosts = allowedHosts(config.allowedHosts);
  const dispatch = createDispatcher(handlers, config);
  const covers = createCoverService(config);
  let uploadBusy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    let session;
    try {
      if (!privateAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Local networks only.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!hosts.has(url.hostname.toLowerCase())) return json(res, 403, { error: 'Unrecognized host.' });
      if (req.headers.origin && req.headers.origin !== url.origin) return json(res, 403, { error: 'Cross-origin access denied.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site access denied.' });
      if (url.pathname === '/api/session' && req.method === 'GET') {
        for (const [key, s] of sessions) if (Date.now() - s.lastSeen > 3600000 && !s.events.size) sessions.delete(key);
        if (sessions.size >= 32) return json(res, 503, { error: 'Too many browser sessions. Close unused tabs or restart the service.' });
        const token = randomBytes(32).toString('hex');
        session = { token, events: new Set(), lastSeen: Date.now() };
        sessions.set(token, session);
        return json(res, 200, { token, root: config.root, inbox: config.inbox });
      }
      if (url.pathname.startsWith('/api/') && !['/api/art', '/api/covers/image'].includes(url.pathname)) {
        session = sessions.get(req.headers['x-orbit-token'] || url.searchParams.get('token'));
        if (!session) return json(res, 401, { error: 'Open the manager to start a browser session.' });
        session.lastSeen = Date.now();
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        session.events.add(res);
        const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy(); }, 15000);
        req.on('close', () => { clearInterval(heartbeat); session.events.delete(res); });
        return;
      }
      if (url.pathname === '/api/jobs' && req.method === 'GET') return json(res, 200, dispatch.jobs);
      if (url.pathname === '/api/inbox' && req.method === 'GET') return json(res, 200, await listInbox(config.inbox));
      if (url.pathname === '/api/covers/search' && req.method === 'GET')
        return json(res, 200, await covers.search(url.searchParams.get('query'), url.searchParams.get('system'), url.searchParams.get('provider') || 'all'));
      if (url.pathname === '/api/covers/preview' && req.method === 'GET') {
        const image = await covers.preview(url.searchParams.get('id'), url.searchParams.get('full') === '1');
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=300' });
        return res.end(image.bytes);
      }
      if (url.pathname === '/api/covers/image' && req.method === 'GET') return await file(res, covers.assetPath(url.searchParams.get('asset')));
      if (url.pathname === '/api/covers/current' && req.method === 'GET') return json(res, 200, await covers.current(url.searchParams.get('identity')));
      if (url.pathname === '/api/covers/current' && req.method === 'DELETE') {
        await covers.reset(url.searchParams.get('identity')); return json(res, 200, { success: true });
      }
      if (url.pathname === '/api/covers/select' && req.method === 'POST') {
        const selection = await body(req);
        return json(res, 200, await covers.select(selection.identity, selection.candidateId));
      }
      if (url.pathname === '/api/covers/upload' && req.method === 'POST')
        return json(res, 200, await covers.upload(url.searchParams.get('identity'), await readLimited(req, MAX_IMAGE_BYTES)));
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        if (uploadBusy) return json(res, 409, { error: 'Another upload is active. Try again when it finishes.' });
        const batch = url.searchParams.get('batch');
        const filename = name(url.searchParams.get('name'));
        if (!/^[a-f0-9]{32}$/.test(batch || '') || !/\.(iso|zso|cue|bin|elf)$/i.test(filename)) throw Error('Invalid upload.');
        const dir = path.join(config.inbox, batch);
        await checkPath(dir, [config.inbox]);
        await fsp.mkdir(dir, { recursive: true });
        const target = await checkPath(path.join(dir, filename), [config.inbox]);
        const temporary = path.join(dir, `.${randomUUID()}.part`);
        uploadBusy = true;
        try {
          const available = await fsp.statfs(dir);
          const capacity = Math.max(0, Math.min(config.maxUploadBytes, available.bavail * available.bsize - 256 * 1024 * 1024));
          let bytes = 0;
          await pipeline(req, new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > capacity ? Error('Upload exceeds the size limit or available disk space.') : null, chunk);
          } }), fs.createWriteStream(temporary, { flags: 'wx' }));
          await fsp.link(temporary, target); // exclusive publication; never overwrite an existing file
          return json(res, 200, { path: target });
        } finally { uploadBusy = false; await fsp.rm(temporary, { force: true }); }
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw Error('Expected JSON.');
        const { channel, args } = await body(req);
        const send = (event, payload) => {
          const frame = `data: ${JSON.stringify({ channel: event, payload })}\n\n`;
          for (const sink of session.events) if (!sink.write(frame)) sink.destroy();
        };
        return json(res, 200, { result: await dispatch.invoke(channel, args, send) });
      }
      if (url.pathname === '/api/art' && req.method === 'GET') {
        const target = await checkPath(url.searchParams.get('path'), [path.join(config.root, 'ART')]);
        if (!/\.(png|jpe?g|webp)$/i.test(target)) throw Error('Not an artwork image.');
        return await file(res, target);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      if (url.pathname === '/bridge.js') return await file(res, path.join(__dirname, 'dist/bridge.js'), false, true);
      if (url.pathname === '/web.css') return await file(res, path.join(__dirname, 'ui.css'), false, true);
      let target = await checkPath(path.join(config.staticDir, decodeURIComponent(url.pathname)), [config.staticDir]);
      if (url.pathname === '/' || !path.extname(url.pathname)) target = path.join(config.staticDir, 'index.html');
      return await file(res, target, target.endsWith('index.html'));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || String(error) });
    }
  });
  // Disc transfers and conversions can outlast Node's default request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.maxConnections = 64;
  server.broadcast = (channel, payload) => {
    for (const session of sessions.values()) for (const sink of session.events)
      if (!sink.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)) sink.destroy();
  };
  return server;
}

async function main() {
  if (!process.env.ORBIT_LIBRARY_ROOT) throw Error('Set ORBIT_LIBRARY_ROOT to an existing OPL library directory.');
  const root = await fsp.realpath(process.env.ORBIT_LIBRARY_ROOT);
  if (!(await fsp.stat(root)).isDirectory() || root === path.parse(root).root)
    throw Error('ORBIT_LIBRARY_ROOT must be a library directory, not the filesystem root.');
  const data = path.resolve(process.env.ORBIT_DATA_DIR || path.join(__dirname, '.data'));
  const inboxPath = path.resolve(process.env.ORBIT_INBOX || path.join(data, 'inbox'));
  await fsp.mkdir(data, { recursive: true });
  await fsp.mkdir(inboxPath, { recursive: true });
  const inbox = await fsp.realpath(inboxPath);
  const staticDir = path.resolve(__dirname, '../dist/angular/browser');
  await fsp.access(path.join(staticDir, 'index.html'));
  const config = { root, data, inbox, staticDir, repo: path.resolve(__dirname, '..'),
    steamgridKey: process.env.STEAMGRIDDB_API_KEY || '',
    allowedHosts: process.env.ORBIT_ALLOWED_HOSTS || '',
    maxUploadBytes: Number(process.env.ORBIT_MAX_UPLOAD_GIB || 16) * 1024 ** 3 };
  if (!Number.isFinite(config.maxUploadBytes) || config.maxUploadBytes <= 0)
    throw Error('ORBIT_MAX_UPLOAD_GIB must be a positive number.');
  const shim = require('./dist/electron.cjs');
  shim.configure(config);
  config.parseArtworkBaseName = require('./dist/src/utils/artwork-name.js').parseArtworkBaseName;
  require('./dist/src/ipc/index.js').registerAllIpc();
  await initializeLibrary(shim.handlers, config);
  require('./dist/src/services/settings.service.js').setSetting('lastDirectory', root);
  const { WorkerPool } = require('./dist/src/utils/worker-pool.js');
  const workers = Number(process.env.ORBIT_WORKERS || 1);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw Error('ORBIT_WORKERS must be 1–8.');
  WorkerPool.defaultSize = () => workers;
  const server = await createServer(config, shim.handlers);
  require('./dist/src/logger.js').setLogWindow({
    isDestroyed: () => false, webContents: { send: server.broadcast },
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.ORBIT_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`OrbitPS2 Web: http://${host}:${port} | Library: ${root} | Workers: ${workers}`));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createServer, privateAddress, allowedHosts };
