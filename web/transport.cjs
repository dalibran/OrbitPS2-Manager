const fs = require('node:fs/promises');
const path = require('node:path');
const { readOnly, validate, checkPath } = require('./policy.cjs');
const { savedArtwork } = require('./covers.cjs');

function createDispatcher(handlers, config) {
  let tail = Promise.resolve();
  let pending = 0;
  const jobs = [];
  async function artwork() {
    const artDir = path.join(config.root, 'ART');
    const result = [];
    // Keep base64 out of the library response: each image is streamed on demand.
    for (const sub of ['', 'PSBBN', 'SCROLL']) {
      const dir = path.join(artDir, sub);
      for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!item.isFile() || item.name.startsWith('.') || !/\.(png|jpe?g)$/i.test(item.name)) continue;
        const target = await checkPath(path.join(dir, item.name), [config.root]);
        const stem = path.parse(item.name).name;
        const parsed = config.parseArtworkBaseName(stem);
        const type = sub === 'PSBBN' ? 'PSBBN' : sub === 'SCROLL' ? 'SCROLL' : parsed?.type || '';
        const identity = sub === 'PSBBN' ? stem : parsed?.identity || stem;
        result.push({ name: sub ? `${identity}_${type}` : stem, extension: path.extname(item.name),
          path: target, gameId: identity, type, base64: '', url: `/api/art?path=${encodeURIComponent(target)}` });
      }
    }
    const selected = await savedArtwork(config);
    const selectedIdentities = new Set(selected.map(cover => cover.identity));
    const original = result.filter(art => art.type !== 'COV' || !selectedIdentities.has(art.gameId));
    return { success: true, data: [...original, ...selected.map(cover => ({
      name: `${cover.identity}_COV`, extension: path.extname(cover.asset), path: '',
      gameId: cover.identity, type: 'COV', base64: '', url: cover.url,
    }))] };
  }
  async function run(channel, args, send) {
    // Validate again at execution time: a queued operation may follow a rename.
    await validate(channel, args, config);
    let handlerArgs = args;
    if (channel === 'get-art-folder') return artwork();
    if (['move-file', 'import-ps1-game', 'import-ps2-cd-game', 'import-app'].includes(channel)) {
      // Recheck at import time too: a drive may have been newly mounted, or a
      // folder removed, since startup. Never reinterpret a missing OPL folder
      // as a destination filename.
      await initializeLibrary(handlers, config);
    }
    if (channel === 'move-file') {
      if (args[1] !== path.join(config.root, 'DVD') || !/\.(iso|zso)$/i.test(args[0]))
        throw Error('DVD imports require an .iso or .zso source and the library DVD folder. No file was moved.');
      const extension = path.extname(args[0]);
      const filename = path.basename(args[0], extension) + extension.toLowerCase();
      const destination = await checkPath(path.join(args[1], filename), [config.root]);
      handlerArgs = [args[0], destination];
    }
    if (channel === 'rename-gamefile' && !/\.(iso|zso|vcd)$/i.test(args[0])) {
      throw Error('Disc-image files must have their .iso, .zso or .vcd extension before renaming.');
    }
    if (channel === 'check-art-files-exist') {
      for (const filename of args[1]) await checkPath(path.resolve(args[0], filename), [config.root]);
    }
    const handler = handlers.get(channel);
    if (!handler) throw Error(`Upstream handler not found: ${channel}`);
    const result = await handler({ sender: { send } }, ...handlerArgs);
    if (result?.success && ['move-file', 'rename-gamefile'].includes(channel)) {
      const destination = await checkPath(result.newPath, [config.root]);
      if (path.extname(destination).toLowerCase() !== path.extname(args[0]).toLowerCase() ||
        !(await fs.stat(destination)).isFile()) throw Error('Import did not preserve the disc-image extension. Refresh the library and inspect the destination.');
    }
    if (channel === 'get-settings' || channel === 'set-setting') return { ...result, lastDirectory: config.root };
    return result;
  }
  return { jobs, async invoke(channel, args, send = () => {}) {
    await validate(channel, args, config);
    if (readOnly.has(channel)) return run(channel, args, send);
    if (pending >= 16) throw Error('The operation queue is full. Try again shortly.');
    pending++;
    const job = { id: require('node:crypto').randomUUID(), channel, state: 'queued', createdAt: new Date().toISOString() };
    jobs.push(job);
    while (jobs.length > 32 && ['complete', 'failed'].includes(jobs[0].state)) jobs.shift();
    const promise = tail.then(async () => {
      job.state = 'running';
      try {
        const result = await run(channel, args, (event, payload) => {
          job.progress = payload;
          send(event, payload);
        });
        job.state = result?.success === false ? 'failed' : 'complete';
        if (result?.message) job.message = String(result.message);
        return result;
      } catch (error) { job.state = 'failed'; job.message = error.message; throw error; }
      finally { pending--; job.finishedAt = new Date().toISOString(); }
    });
    tail = promise.catch(() => {});
    return promise;
  } };
}
async function initializeLibrary(handlers, config) {
  const dispatch = createDispatcher(handlers, config);
  const structure = await dispatch.invoke('check-opl-structure', [config.root]);
  if (!structure.success) throw Error(structure.message || 'Cannot inspect the OPL library.');
  if (structure.missing.length) {
    const created = await dispatch.invoke('create-opl-folders', [config.root, structure.missing]);
    if (!created.success) throw Error(created.message || 'Cannot create the OPL library folders.');
  }
}
module.exports = { createDispatcher, initializeLibrary };
