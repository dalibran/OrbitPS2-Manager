const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { createCoverService, savedArtwork, imageInfo, allowedImageUrl, readLimited } = require('../covers.cjs');
const { createDispatcher } = require('../transport.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
const response = value => ({ ok: true, body: Readable.from([Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))]) });
async function fixture(t, overrides = {}) {
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-covers-')));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const root = path.join(data, 'library');
  await fs.mkdir(path.join(root, 'ART'), { recursive: true });
  return { data, root, ...overrides };
}
test('Libretro searches regional and high-resolution covers, caches its index, and stores originals offline', async t => {
  let indexCalls = 0, imageCalls = 0;
  const config = await fixture(t, { coverFetch: async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://api.github.com/')) {
      indexCalls++;
      assert.ok(!url.includes('recursive'));
      if (url.endsWith('/master')) return response({ tree: [
        { type: 'tree', path: 'Named_Boxarts', sha: 'a'.repeat(40) },
        { type: 'tree', path: 'Named_Boxarts_1024', sha: 'b'.repeat(40) },
        { type: 'tree', path: 'Named_Snaps', sha: 'c'.repeat(40) },
      ] });
      if (url.endsWith('a'.repeat(40))) return response({ tree: [{ type: 'blob', path: 'Simpsons, The - Hit & Run (USA).png' }] });
      if (url.endsWith('b'.repeat(40))) return response({ tree: [{ type: 'blob', path: 'Simpsons, The - Hit & Run (Europe).png' }] });
      throw Error('Non-cover directory must not be fetched');
    }
    imageCalls++; return response(png);
  } });
  const service = createCoverService(config);
  const found = await service.search('THE SIMPSONS HIT & RUN', 'PS2');
  assert.equal(found.results.length, 2);
  assert.equal(found.results[0].collection, 'High-resolution box art');
  assert.equal(found.steamgriddbEnabled, false);
  assert.equal(found.results[0].fullUrl, undefined);
  await service.search('Simpsons', 'PS2');
  assert.equal(indexCalls, 3);
  assert.equal(found.providers[0].status, 'ok');
  assert.equal(found.providers[0].indexed, 2);
  const preview = await service.preview(found.results[0].id);
  assert.deepEqual(preview.bytes, png);
  const selected = await service.select('SLUS_206.24', found.results[0].id);
  assert.deepEqual(await fs.readFile(service.assetPath(selected.asset)), png);
  assert.equal(imageCalls, 1);
  assert.equal((await fs.readdir(path.join(config.root, 'ART'))).length, 0);
  const restarted = createCoverService({ ...config, coverFetch: async () => { throw Error('Offline'); } });
  assert.equal((await restarted.current('SLUS_206.24')).source, 'Libretro');
  assert.equal((await restarted.search('Simpsons', 'PS2')).results.length, 2);
  assert.equal((await savedArtwork({ ...config, root: '/another-library' })).length, 0);
  await restarted.reset('SLUS_206.24');
  assert.equal(await restarted.current('SLUS_206.24'), null);
});
test('SteamGridDB searches are optional, hide credentials, preserve source dimensions, and tolerate another provider failing', async t => {
  const config = await fixture(t, { steamgridKey: 'test-secret', coverFetch: async (url, options) => {
    if (url.startsWith('https://api.github.com')) throw Error('Libretro unavailable');
    if (url.includes('steamgriddb.com/api/')) assert.equal(options.headers.Authorization, 'Bearer test-secret');
    else assert.equal(options.headers.Authorization, undefined);
    if (url.includes('/search/autocomplete/')) return response({ success: true, data: [{ id: 12, name: 'Test Game' }] });
    if (url.includes('/grids/game/12')) return response({ success: true, data: [
      { width: 600, height: 900, url: 'https://cdn2.steamgriddb.com/grid/example.png', thumb: 'https://cdn2.steamgriddb.com/thumb/example.png' },
      { width: 900, height: 600, url: 'https://cdn2.steamgriddb.com/grid/landscape.png' },
      { width: 600, height: 900, url: 'http://127.0.0.1/private' },
    ] });
    return response(png);
  } });
  const service = createCoverService(config);
  const found = await service.search('Test Game', 'PS2');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].width, 600);
  assert.equal(found.results[0].height, 900);
  assert.match(found.warnings[0], /Libretro/);
  assert.ok(!JSON.stringify(found).includes('test-secret'));
  await service.select('GAME', found.results[0].id);
  await assert.rejects(service.select('GAME', 'client-supplied-url'), /expired/);
});
test('uploaded covers override browser COV metadata, preserve OPL files, and reset to the existing cover', async t => {
  const config = await fixture(t, { parseArtworkBaseName: name => ({ identity: name.slice(0, -4), type: name.slice(-3) }) });
  const original = path.join(config.root, 'ART/SLUS_206.24_COV.png');
  await fs.writeFile(original, png);
  const service = createCoverService(config);
  const uploaded = await service.upload('SLUS_206.24', png);
  const dispatch = createDispatcher(new Map(), config);
  let metadata = await dispatch.invoke('get-art-folder', [config.root]);
  assert.equal(metadata.data.length, 1);
  assert.equal(metadata.data[0].url, uploaded.url);
  assert.deepEqual(await fs.readFile(original), png);
  await service.reset('SLUS_206.24');
  metadata = await dispatch.invoke('get-art-folder', [config.root]);
  assert.match(metadata.data[0].url, /^\/api\/art\?/);
  await assert.rejects(service.upload('../../escape', png), /identity/);
  await assert.rejects(service.upload('GAME', Buffer.from('<svg></svg>')), /PNG/);
});
test('image and download validation reject unsafe hosts, unexpected types, oversized dimensions and byte limits', async () => {
  assert.equal(imageInfo(png).width, 1);
  const huge = Buffer.from(png); huge.writeUInt32BE(10000, 16);
  assert.throws(() => imageInfo(huge), /megapixels/);
  for (const url of ['http://cdn2.steamgriddb.com/a.png', 'https://127.0.0.1/a.png', 'https://cdn2.steamgriddb.com.evil.test/a.png', 'https://user:pass@cdn2.steamgriddb.com/a.png', 'https://raw.githubusercontent.com/unrelated/private/main/a.png'])
    assert.throws(() => allowedImageUrl(url), /Unrecognized/);
  await assert.rejects(readLimited(Readable.from([Buffer.alloc(20)]), 10), /limit/);
});

test('empty cached indexes are retried and provider failures are distinct from no title matches', async t => {
  let calls = 0;
  const config = await fixture(t, { coverFetch: async () => {
    calls++;
    const error = new TypeError('fetch failed'); error.cause = { code: 'ENOTFOUND' }; throw error;
  } });
  await fs.writeFile(path.join(config.data, 'libretro-PS2-index.json'), JSON.stringify({ version: 2, updated: Date.now(), paths: [] }));
  const result = await createCoverService(config).search('Simpsons', 'PS2');
  assert.equal(calls, 1);
  assert.equal(result.results.length, 0);
  assert.equal(result.providers[0].status, 'error');
  assert.match(result.warnings[0], /api.github.com \(ENOTFOUND\)/);
});
