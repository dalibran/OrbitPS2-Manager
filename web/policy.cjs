const fs = require('node:fs/promises');
const path = require('node:path');

// Every upstream RPC needs an explicit filesystem policy before being exposed.
// r = configured root, l = within library, p = library or import inbox.
const rules = {
  'check-opl-structure': { 0: 'r' }, 'create-opl-folders': { 0: 'r' },
  'directory-exists': { 0: 'l' }, 'get-games-files': { 0: 'r' },
  'get-ul-games': { 0: 'r' }, 'get-art-folder': { 0: 'r' },
  'get-ember-games': { 0: 'l' }, 'get-apps': { 0: 'r' },
  'get-ps1-launchers': { 0: 'r' },
  'resolve-iso-gameid': { 0: 'p' }, 'try-determine-gameid-from-hex': { 0: 'p' },
  'try-determine-ps1-gameid-from-hex': { 0: 'p' }, 'try-determine-ps1-gameid-from-vcd': { 0: 'p' },
  'download-art-by-gameid': { 0: 'l' }, 'check-art-files-exist': { 0: 'l' },
  'list-available-art': {}, 'rename-gamefile': { 0: 'l' },
  'rename-ps1-launcher-step1': { 0: 'l' },
  'convert-ps1-to-popsloader': { 0: 'l' }, 'convert-ps1-to-popstarter': { 0: 'l' },
  'delete-app': { 0: 'r' }, 'delete-app-with-progress': { 0: 'r' },
  'delete-game-and-related-files': { 0: 'l', 1: 'l', 3: 'l?' },
  'delete-ember-game-and-related-files': { 0: 'l', 1: 'l' },
  'import-ps1-game': { 0: 'p', 1: 'r' }, 'import-ps2-cd-game': { 0: 'p', 1: 'r' },
  'import-app': { 0: 'r', 1: 'p' },
  'read-game-cfg': { 0: 'r' }, 'write-game-cfg': { 0: 'r' },
  'read-app-title-cfg': { 0: 'r' }, 'update-ps1-title-cfg': { 0: 'l' },
  'list-vmc': { 0: 'r' }, 'check-pops-vmc': { 0: 'r' },
  'create-vmc': { 0: 'r' }, 'delete-vmc': { 0: 'r' },
  'compress-iso-to-zso': { 0: 'l', 1: 'l' },
  'decompress-zso-to-iso': { 0: 'l', 1: 'l' },
  'convert-vcd-to-bin': { 0: 'l', 1: 'l', 2: 'l' },
  'move-file': { 0: 'p', 1: 'l' }, 'get-settings': {}, 'set-setting': {},
  'normalize-riptopl-ps1-storage': {}, 'rename-ps1-launcher-step2': {},
};
const readOnly = new Set([
  'check-opl-structure', 'directory-exists', 'get-games-files', 'get-ul-games',
  'get-art-folder', 'get-ember-games', 'get-apps', 'get-ps1-launchers',
  'resolve-iso-gameid', 'try-determine-gameid-from-hex', 'try-determine-ps1-gameid-from-hex',
  'try-determine-ps1-gameid-from-vcd', 'check-art-files-exist', 'list-available-art',
  'read-game-cfg', 'read-app-title-cfg', 'list-vmc', 'check-pops-vmc', 'get-settings',
]);
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function name(value) {
  if (typeof value !== 'string' || /[/\\\x00-\x1f]/.test(value) || value === '.' || value === '..' || value.length > 1024)
    throw Error('Invalid name or text value. Paths must stay in the configured library.');
  return value;
}
async function checkPath(value, roots) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw Error('Expected an absolute server path.');
  const target = path.resolve(value);
  const root = roots.find(r => inside(r, target));
  if (!root) throw Error('Path is outside the configured library/inbox.');
  let existing = target;
  while (true) {
    try {
      const real = await fs.realpath(existing);
      if (!inside(root, real)) throw Error('Symlink leaves the configured library/inbox.');
      return target;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}
async function validate(channel, args, config) {
  if (!Object.hasOwn(rules, channel)) throw Error(`This operation is unavailable in the web build: ${channel}`);
  if (!Array.isArray(args) || args.length > 16) throw Error('Invalid RPC arguments.');
  // Root-based services derive their own paths. Reject top-level OPL symlinks
  // that would redirect these services outside the configured filesystem root.
  if (Object.values(rules[channel]).includes('r')) {
    for (const dir of ['APPS', 'ART', 'CD', 'CFG', 'DVD', 'POPS', 'VCD', 'VMC', 'EMBER'])
      await checkPath(path.join(config.root, dir), [config.root]);
  }
  const special = rules[channel];
  async function walk(value, key = '') {
    if (typeof value === 'string') { name(value); return; }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return;
    if (typeof value !== 'object') throw Error('Invalid argument.');
    for (const [k, v] of Object.entries(value)) {
      name(k);
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw Error('Invalid property.');
      // Two upstream handlers carry paths in a parameter object.
      if (['newAppsFolder', 'oldElfFile', 'newElfFile', 'sourcePath', 'artDir'].includes(k) && v)
        await checkPath(v, [config.root]);
      else if (k === 'newCfgContent') {
        if (typeof v !== 'string' || v.length > 65536 || v.includes('\0')) throw Error('Invalid CFG.');
        for (const line of v.split(/\r?\n/)) {
          const match = line.match(/^\s*boot\s*=\s*(.*)$/i);
          if (match) name(match[1]);
        }
      } else await walk(v, k);
    }
  }
  if (channel === 'set-setting') {
    const [key, value] = args;
    if (key === 'lastDirectory') {
      if (value !== config.root) throw Error('The library root is configured on the server.');
      return;
    }
    if (key === 'emberDirectories') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Ember settings.');
      for (const [root, dir] of Object.entries(value)) {
        if (root !== config.root) throw Error('Invalid Ember library root.');
        if (dir) await checkPath(dir, [config.root]);
      }
      return;
    }
    if (!((key === 'autoReconnect' && typeof value === 'boolean') ||
      (key === 'theme' && ['orbitps2', 'orbitps2-light', 'legacy', 'system'].includes(value)) ||
      (key === 'ps1LauncherMode' && ['popstarter', 'popsloader', 'ember'].includes(value)))) throw Error('Unsupported setting.');
  }
  for (let i = 0; i < args.length; i++) {
    if (channel === 'check-art-files-exist' && i === 1) {
      if (!Array.isArray(args[i])) throw Error('Expected artwork filenames.');
      for (const filename of args[i]) {
        if (typeof filename !== 'string' || /[\\\x00-\x1f]/.test(filename)) throw Error('Invalid artwork filename.');
        await checkPath(path.resolve(args[0], filename), [config.root]);
      }
      continue;
    }
    const rule = special[i];
    if (!rule) { await walk(args[i]); continue; }
    if (rule.endsWith('?') && !args[i]) continue;
    if (rule === 'r' && args[i] !== config.root) throw Error('Use the configured library root.');
    await checkPath(args[i], rule[0] === 'p' ? [config.root, config.inbox] : [config.root]);
    if (/\.zip$/i.test(args[i])) throw Error('ZIP import is not enabled on the Pi. Extract CUE/BIN files into the inbox first.');
    if (/\.cue$/i.test(args[i])) {
      const stat = await fs.stat(args[i]);
      if (stat.size > 1024 * 1024) throw Error('CUE sheet is too large.');
      const cue = await fs.readFile(args[i], 'utf8');
      for (const match of cue.matchAll(/^\s*FILE\s+"([^"]+)"/gmi)) {
        await checkPath(path.resolve(path.dirname(args[i]), match[1]), [config.root, config.inbox]);
      }
    }
  }
  if (channel === 'read-game-cfg' || channel === 'write-game-cfg')
    await checkPath(path.join(config.root, 'CFG', `${args[1]}.cfg`), [config.root]);
  if (['read-app-title-cfg', 'delete-app', 'delete-app-with-progress'].includes(channel))
    await checkPath(path.join(config.root, 'APPS', args[1]), [config.root]);
  if (channel === 'create-vmc' || channel === 'delete-vmc') {
    const safe = args[1].trim().replace(/\.bin$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32);
    await checkPath(path.join(config.root, 'VMC', `${safe}.bin`), [config.root]);
  }
  if (['compress-iso-to-zso', 'decompress-zso-to-iso', 'convert-vcd-to-bin'].includes(channel)) {
    const outputs = channel === 'convert-vcd-to-bin' ? args.slice(1, 3) : [args[1]];
    for (const output of outputs) {
      try { await fs.lstat(output); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw Error('Conversion output already exists. Choose a different filename.');
    }
  }
}
module.exports = { rules, readOnly, inside, name, checkPath, validate };
