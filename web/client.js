// Supply the Electron transport expected by the unchanged upstream preload.
(() => {
  const listeners = new Map();
  const ready = fetch('/api/session').then(async response => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    const events = new EventSource('/api/events?token=' + value.token);
    events.onmessage = event => {
      const { channel, payload } = JSON.parse(event.data);
      for (const callback of listeners.get(channel) || []) callback({}, payload);
    };
    // Establish progress delivery before starting the first operation.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { events.close(); reject(Error('Cannot connect to the Pi. Reload this page to reconnect.')); }, 15000);
      events.onopen = () => { clearTimeout(timeout); resolve(); };
      events.onerror = () => { if (events.readyState === EventSource.CLOSED) { clearTimeout(timeout); reject(Error('Cannot connect to the Pi.')); } };
    });
    return value;
  });
  async function request(url, options = {}) {
    const { token } = await ready;
    const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-Orbit-Token': token } });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || `HTTP ${response.status}`);
    return value;
  }
  const invoke = async (channel, ...args) => {
    const session = await ready;
    if (channel === 'open-ask-directory') return { canceled: false, filePaths: [session.root] };
    if (channel === 'open-ask-game-files' || channel === 'open-ask-elf-files') return pickFiles(channel, args);
    if (channel === 'window-platform') return 'web';
    if (channel === 'window-can-window-controls') return { canMinimize: false, canMaximize: false };
    if (channel === 'window-is-maximized') return false;
    if (channel === 'window-wm-info') return { name: 'browser', env: {} };
    if (channel === 'list-optical-drives' || channel === 'list-optical-drives-cd') return [];
    if (channel === 'check-for-updates') return {
      updateAvailable: false, currentVersion: 'web',
      error: 'Web updates are installed on the Pi by merging upstream and rebuilding. Desktop downloads do not update this service.',
    };
    if (channel === 'open-external') {
      if (!/^https?:\/\//i.test(args[0])) return false;
      window.open(args[0], '_blank', 'noopener,noreferrer');
      return true;
    }
    return (await request('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }) })).result;
  };
  function pickFiles(channel, args) {
    const extensions = channel === 'open-ask-elf-files' ? ['elf'] : [
      ...(args[0] ? ['cue'] : []), ...(args[1] ? ['iso', 'zso'] : []),
    ];
    const accepts = filename => extensions.includes(filename.split('.').pop().toLowerCase());
    return new Promise((resolve, reject) => {
      const dialog = document.createElement('dialog');
      // DaisyUI's modal-box is transparent outside a .modal wrapper. This is
      // a native dialog, so style it directly instead of hiding its contents.
      dialog.className = 'bg-base-100 text-base-content';
      dialog.style.cssText = 'position:fixed;margin:auto;width:min(620px,94vw);max-height:85vh;padding:24px;border:1px solid var(--color-base-300);border-radius:16px;background:var(--color-base-100);color:var(--color-base-content);box-shadow:0 25px 50px #0006;overflow:auto;z-index:10000';
      const title = document.createElement('h2');
      title.id = 'orbit-import-picker-title';
      dialog.setAttribute('aria-labelledby', title.id);
      title.textContent = 'Select files to import';
      title.style.cssText = 'font-size:1.3rem;font-weight:600;margin-bottom:12px';
      const description = document.createElement('p');
      description.textContent = 'Upload from this device, or select files already in the Pi inbox. For CD games, upload the CUE sheet and every referenced BIN together. Keep this tab open while a batch runs.';
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true;
      input.accept = [...extensions, ...(extensions.includes('cue') ? ['bin'] : [])].map(ext => '.' + ext).join(',');
      input.style.cssText = 'display:block;margin:20px 0';
      const list = document.createElement('div');
      list.style.cssText = 'max-height:240px;overflow:auto;margin:16px 0';
      const status = document.createElement('p'); status.setAttribute('role', 'status');
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.className = 'btn btn-ghost';
      const submit = document.createElement('button'); submit.textContent = 'Add selected files'; submit.className = 'btn btn-primary';
      dialog.append(title, description, input, list, status, cancel, submit);
      document.body.append(dialog);
      const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
      cancel.onclick = () => finish({ canceled: true, filePaths: [] });
      dialog.oncancel = event => { event.preventDefault(); if (!submit.disabled) finish({ canceled: true, filePaths: [] }); };
      try { dialog.showModal(); }
      catch (error) { dialog.remove(); reject(error); return; }
      status.textContent = 'Loading files from the server inbox…';
      request('/api/inbox').then(files => {
        for (const file of files.filter(file => accepts(file.name))) {
          const label = document.createElement('label'); label.style.cssText = 'display:block;padding:6px 0;overflow-wrap:anywhere';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = file.path;
          label.append(checkbox, document.createTextNode(' ' + file.name)); list.append(label);
        }
        if (!list.children.length) list.textContent = 'No matching files in the Pi inbox.';
        status.textContent = '';
      }).catch(error => { status.textContent = error.message; });
      submit.onclick = async () => {
        submit.disabled = true; cancel.disabled = true; input.disabled = true;
        try {
          const selected = [...list.querySelectorAll('input:checked')].map(item => item.value);
          const batch = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
          const uploads = [...input.files];
          // CUE/BIN pairs remain together; requests stream one file at a time.
          for (let i = 0; i < uploads.length; i++) {
            const file = uploads[i];
            status.textContent = `Uploading ${i + 1}/${uploads.length}: ${file.name}…`;
            const saved = await request(`/api/upload?batch=${batch}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
            if (accepts(file.name)) selected.push(saved.path);
          }
          if (!selected.length) throw Error('Select a game file or CUE sheet to continue.');
          finish({ canceled: false, filePaths: selected });
        } catch (error) { status.textContent = error.message; }
        finally { submit.disabled = false; cancel.disabled = false; input.disabled = false; }
      };
    });
  }
  window.__orbitElectron = {
    contextBridge: { exposeInMainWorld(key, value) { window[key] = value; } },
    ipcRenderer: {
      invoke, send() {},
      on(channel, callback) {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel).add(callback);
      },
      removeAllListeners(channel) { listeners.delete(channel); },
    },
  };
  window.orbitWeb = { chooseCover: game => window.__orbitChooseCover(game, { request, ready }) };
})();
