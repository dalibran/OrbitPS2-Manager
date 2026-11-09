// Build-time replacement for the small Electron surface used by shared code.
const handlers = new Map();
let config;
exports.configure = value => { config = value; };
exports.handlers = handlers;
exports.ipcMain = {
  handle(channel, handler) { handlers.set(channel, handler); },
  on() {},
};
exports.app = {
  isPackaged: false,
  getPath(name) {
    if (name !== 'userData') throw Error(`Unsupported Electron path: ${name}`);
    return config.data;
  },
  getAppPath() { return config.repo; },
};
exports.dialog = { showOpenDialog() { throw Error('Use the web file picker.'); } };
exports.shell = { openExternal() { throw Error('External links open in the browser.'); } };
exports.BrowserWindow = { fromWebContents() { return null; } };
