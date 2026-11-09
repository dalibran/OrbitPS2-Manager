const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const repositories = { PS2: 'Sony_-_PlayStation_2', PS1: 'Sony_-_PlayStation' };
const hash = value => createHash('sha256').update(value).digest('hex');
const coverDirectory = config => path.join(config.data, 'web-covers', hash(config.root));
function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[/\\\x00-\x1f]/.test(value)) throw Error('Invalid cover identity.');
  return value;
}
async function readLimited(stream, limit = MAX_IMAGE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Error(`Response exceeds the ${Math.floor(limit / 1024 / 1024)} MiB limit.`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function imageInfo(bytes) {
  let width, height, extension, mime;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); extension = 'png'; mime = 'image/png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); extension = 'jpg'; mime = 'image/jpeg'; break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    }
    extension = 'webp'; mime = 'image/webp';
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16000000) throw Error('Choose a PNG, JPEG or WebP image up to 16 megapixels and 8192 pixels per side.');
  return { width, height, extension, mime };
}
function allowedImageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
    !['raw.githubusercontent.com', 'cdn2.steamgriddb.com', 'cdn.steamgriddb.com'].includes(url.hostname)) throw Error('Unrecognized artwork host.');
  if (url.hostname === 'raw.githubusercontent.com' && !url.pathname.startsWith('/libretro-thumbnails/')) throw Error('Unrecognized artwork repository.');
  return url.href;
}
function searchWords(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[^a-z0-9]+/).filter(word => word && !['the', 'a', 'an'].includes(word));
}
async function savedArtwork(config) {
  const dir = path.join(coverDirectory(config), 'records');
  const result = [];
  for (const filename of await fs.readdir(dir).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, filename), 'utf8'));
      identity(record.identity);
      if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(record.asset)) continue;
      await fs.access(path.join(coverDirectory(config), 'images', record.asset));
      result.push({ ...record, url: `/api/covers/image?asset=${record.asset}` });
    } catch { /* An interrupted/corrupt record must not hide the library. */ }
  }
  return result;
}
function createCoverService(config) {
  const fetcher = config.coverFetch || fetch;
  const candidates = new Map();
  const indexRequests = new Map();
  const images = new Map();
  let cacheBytes = 0, active = 0;
  const waiting = [];
  const dir = coverDirectory(config);
  async function limited(task) {
    if (active >= 2) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await task(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  async function remote(url, headers = {}, maxBytes = 8 * 1024 * 1024) {
    return limited(async () => {
      try {
        const response = await fetcher(url, { headers: { 'User-Agent': 'OrbitPS2-Web', ...headers }, redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw Error(`Provider returned HTTP ${response.status}${response.status === 403 ? ' (check rate limits or API key)' : ''}.`);
        return await readLimited(response.body, maxBytes);
      } catch (error) {
        if (error.cause?.code) throw Error(`Cannot connect to ${new URL(url).hostname} (${error.cause.code}). Check the server's internet connection.`);
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Error(`Request to ${new URL(url).hostname} timed out. Try again.`);
        throw error;
      }
    });
  }
  async function remoteJson(url, headers) { return JSON.parse((await remote(url, headers)).toString()); }
  async function libretroIndex(system) {
    if (indexRequests.has(system)) return indexRequests.get(system);
    const promise = (async () => {
      const indexPath = path.join(config.data, `libretro-${system}-index.json`);
      let cached;
      try { cached = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch {}
      if (cached?.version === 2 && Array.isArray(cached.paths) && cached.paths.length && Date.now() - cached.updated < 86400000) return cached.paths;
      try {
        const base = `https://api.github.com/repos/libretro-thumbnails/${repositories[system]}/git/trees/`;
        // A recursive tree also includes thousands of screenshots/logos and can
        // exceed the response limit. Fetch only the two box-art subtrees.
        const root = await remoteJson(base + 'master');
        if (root.truncated || !Array.isArray(root.tree)) throw Error('Libretro returned an incomplete directory listing.');
        const directories = root.tree.filter(item => item.type === 'tree' && /^Named_Boxarts(?:_1024)?$/.test(item.path));
        if (!directories.length) throw Error('Libretro did not return any box-art directories.');
        const paths = [];
        for (const directory of directories) {
          if (!/^[a-f0-9]{40,64}$/i.test(directory.sha || '')) throw Error('Libretro returned an invalid directory reference.');
          const listing = await remoteJson(base + directory.sha);
          if (listing.truncated || !Array.isArray(listing.tree)) throw Error('Libretro returned an incomplete box-art directory.');
          for (const item of listing.tree) {
            if (item.type === 'blob' && /^[^/]+\.(png|jpe?g)$/i.test(item.path)) paths.push(`${directory.path}/${item.path}`);
          }
        }
        if (!paths.length) throw Error('Libretro returned an empty box-art index.');
        await fs.mkdir(config.data, { recursive: true });
        await fs.writeFile(indexPath, JSON.stringify({ version: 2, updated: Date.now(), paths }));
        return paths;
      } catch (error) { if (Array.isArray(cached?.paths) && cached.paths.length) return cached.paths; throw error; }
    })();
    indexRequests.set(system, promise);
    try { return await promise; } finally { indexRequests.delete(system); }
  }
  function remember(candidate) {
    const id = randomUUID();
    candidates.set(id, { ...candidate, created: Date.now() });
    while (candidates.size > 256) candidates.delete(candidates.keys().next().value);
    const { fullUrl, thumbUrl, created, ...publicFields } = candidate;
    return { ...publicFields, id, preview: `/api/covers/preview?id=${id}` };
  }
  function candidateFor(id) {
    const candidate = candidates.get(id);
    if (!candidate || Date.now() - candidate.created > 1800000) throw Error('Artwork result expired. Search again.');
    return candidate;
  }
  async function image(url) {
    url = allowedImageUrl(url);
    if (images.has(url)) return images.get(url);
    const bytes = await remote(url, {}, MAX_IMAGE_BYTES);
    const info = imageInfo(bytes);
    const image = { bytes, ...info };
    while (cacheBytes + bytes.length > 12 * 1024 * 1024 && images.size) {
      const key = images.keys().next().value; cacheBytes -= images.get(key).bytes.length; images.delete(key);
    }
    images.set(url, image); cacheBytes += bytes.length;
    return image;
  }
  let saving = Promise.resolve();
  async function persist(id, bytes, metadata) {
    identity(id);
    if (bytes.length > MAX_IMAGE_BYTES) throw Error('Cover images must be no larger than 10 MiB.');
    const info = imageInfo(bytes);
    const asset = `${hash(bytes)}.${info.extension}`;
    const record = { identity: id, asset, width: info.width, height: info.height, ...metadata };
    const promise = saving.then(async () => {
      await fs.mkdir(path.join(dir, 'records'), { recursive: true });
      await fs.mkdir(path.join(dir, 'images'), { recursive: true });
      await fs.writeFile(path.join(dir, 'images', asset), bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const target = path.join(dir, 'records', `${hash(id)}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(record)); await fs.rename(temporary, target); }
      finally { await fs.rm(temporary, { force: true }); }
      return { ...record, url: `/api/covers/image?asset=${asset}` };
    });
    saving = promise.catch(() => {});
    return promise;
  }
  return {
    async search(query, system, provider = 'all') {
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 150 || !repositories[system] || !['all', 'libretro', 'steamgriddb'].includes(provider)) throw Error('Enter a title (2–150 characters) and choose PS1 or PS2.');
      const warnings = [], results = [], providers = [];
      const words = searchWords(query);
      if (!words.length) throw Error('Enter a game title to search.');
      if (provider !== 'steamgriddb') {
        try {
          const paths = await libretroIndex(system);
          const matches = paths.filter(filename => words.every(word => searchWords(path.basename(filename)).some(candidate => candidate.includes(word))));
          providers.push({ source: 'Libretro', status: 'ok', indexed: paths.length, matches: matches.length });
          matches.sort((a, b) => Number(b.startsWith('Named_Boxarts_1024/')) - Number(a.startsWith('Named_Boxarts_1024/')) || a.localeCompare(b));
          for (const filename of matches.slice(0, 24)) results.push(remember({
            source: 'Libretro', title: path.basename(filename, path.extname(filename)), system,
            collection: filename.startsWith('Named_Boxarts_1024/') ? 'High-resolution box art' : 'Box art',
            fullUrl: `https://raw.githubusercontent.com/libretro-thumbnails/${repositories[system]}/master/${filename.split('/').map(encodeURIComponent).join('/')}`,
          }));
        } catch (error) { warnings.push(`Libretro: ${error.message}`); providers.push({ source: 'Libretro', status: 'error' }); }
      }
      if (provider !== 'libretro' && config.steamgridKey) {
        try {
          const base = 'https://www.steamgriddb.com/api/v2';
          const headers = { Authorization: `Bearer ${config.steamgridKey}` };
          const games = await remoteJson(`${base}/search/autocomplete/${encodeURIComponent(query.trim())}`, headers);
          if (!games.success) throw Error('Search failed.');
          for (const game of (games.data || []).slice(0, 3)) {
            if (!Number.isSafeInteger(game.id)) continue;
            const grids = await remoteJson(`${base}/grids/game/${game.id}?types=static&nsfw=false&humor=false`, headers);
            if (!grids.success) continue;
            for (const cover of (grids.data || []).filter(cover => cover.width <= cover.height).slice(0, 8)) {
              try {
                results.push(remember({ source: 'SteamGridDB', title: game.name, system,
                  collection: 'Community cover · check platform/edition', width: cover.width, height: cover.height,
                  fullUrl: allowedImageUrl(cover.url), thumbUrl: cover.thumb ? allowedImageUrl(cover.thumb) : undefined }));
              } catch { /* Ignore unsupported provider hosts/formats. */ }
            }
          }
          providers.push({ source: 'SteamGridDB', status: 'ok' });
        } catch (error) { warnings.push(`SteamGridDB: ${error.message}`); providers.push({ source: 'SteamGridDB', status: 'error' }); }
      }
      if (provider === 'steamgriddb' && !config.steamgridKey) warnings.push('SteamGridDB needs STEAMGRIDDB_API_KEY on the server.');
      return { results, warnings, providers, steamgriddbEnabled: Boolean(config.steamgridKey) };
    },
    async preview(id, full = false) { const candidate = candidateFor(id); return image(!full && candidate.thumbUrl ? candidate.thumbUrl : candidate.fullUrl); },
    async select(id, candidateId) {
      const candidate = candidateFor(candidateId);
      const selected = await image(candidate.fullUrl);
      return persist(id, selected.bytes, { source: candidate.source, title: candidate.title, sourceUrl: candidate.fullUrl });
    },
    async upload(id, bytes) { return persist(id, bytes, { source: 'Local upload', title: 'Custom cover' }); },
    async current(id) { identity(id); return (await savedArtwork(config)).find(record => record.identity === id) || null; },
    async reset(id) { identity(id); await saving; await fs.rm(path.join(dir, 'records', `${hash(id)}.json`), { force: true }); },
    assetPath(asset) {
      if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(asset || '')) throw Error('Invalid saved cover.');
      return path.join(dir, 'images', asset);
    },
  };
}
module.exports = { createCoverService, savedArtwork, readLimited, imageInfo, MAX_IMAGE_BYTES, allowedImageUrl };
