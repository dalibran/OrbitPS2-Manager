// The browser-only gallery is kept outside upstream's Angular components.
window.__orbitChooseCover = async (game, { request, ready }) => {
  const session = await ready;
  return new Promise((resolve, reject) => {
    const element = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const dialog = element('dialog', '', 'orbit-cover-dialog');
    const heading = element('h2', 'Choose cover'); heading.id = 'orbit-cover-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    const subtitle = element('p', `${game.title} · ${game.system}`, 'orbit-cover-muted');
    const explanation = element('p', 'Choose a full-resolution cover for the web library. OPL artwork stays unchanged.', 'orbit-cover-muted');
    const form = element('form', '', 'orbit-cover-search');
    const query = element('input'); query.type = 'search'; query.value = game.title; query.required = true; query.minLength = 2; query.maxLength = 150;
    query.setAttribute('aria-label', 'Game title');
    const provider = element('select'); provider.setAttribute('aria-label', 'Artwork source');
    for (const [value, label] of [['all', 'All sources'], ['libretro', 'Libretro'], ['steamgriddb', 'SteamGridDB']]) {
      const option = element('option', label); option.value = value; provider.append(option);
    }
    const search = element('button', 'Search', 'btn btn-primary'); search.type = 'submit';
    form.append(query, provider, search);
    const status = element('p', '', 'orbit-cover-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const current = element('p', 'Current: OPL artwork', 'orbit-cover-muted');
    const uploadLabel = element('label', 'Upload your own PNG, JPEG or WebP (up to 10 MiB)', 'orbit-cover-upload');
    const upload = element('input'); upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp';
    uploadLabel.append(upload);
    const localPreview = element('div', '', 'orbit-cover-local');
    const results = element('div', '', 'orbit-cover-results');
    const footer = element('div', '', 'orbit-cover-footer');
    const reset = element('button', 'Use OPL artwork', 'btn btn-ghost');
    const close = element('button', 'Close', 'btn btn-ghost');
    footer.append(reset, close);
    dialog.append(heading, subtitle, explanation, current, form, uploadLabel, localPreview, status, results, footer);
    document.body.append(dialog);
    let busy = false, changed = false, disposed = false, searchNumber = 0, localUrl;
    const identityQuery = encodeURIComponent(game.identity);
    function finish() {
      if (busy) return;
      disposed = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
      dialog.close(); dialog.remove(); resolve(changed);
    }
    close.onclick = finish;
    dialog.oncancel = event => { event.preventDefault(); finish(); };
    async function apply(action) {
      if (busy) return;
      busy = true;
      for (const control of dialog.querySelectorAll('button,input,select')) control.disabled = true;
      status.textContent = 'Saving cover on the server…';
      try {
        const record = await action();
        changed = true;
        current.textContent = record ? `Current: ${record.source} · ${record.width} × ${record.height} pixels` : 'Current: OPL artwork';
        status.textContent = record ? 'Saved at original resolution. Close to update the library.' : 'OPL artwork restored. Close to update the library.';
      } catch (error) { status.textContent = error.message; }
      finally {
        busy = false;
        for (const control of dialog.querySelectorAll('button,input,select')) control.disabled = false;
      }
    }
    reset.onclick = () => apply(async () => { await request(`/api/covers/current?identity=${identityQuery}`, { method: 'DELETE' }); return null; });
    upload.onchange = () => {
      localPreview.replaceChildren();
      if (localUrl) URL.revokeObjectURL(localUrl);
      const file = upload.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { status.textContent = 'Choose a cover smaller than 10 MiB.'; return; }
      const image = element('img'); image.alt = 'Uploaded cover preview';
      const dimensions = element('p', 'Reading image dimensions…');
      const use = element('button', 'Use uploaded cover', 'btn btn-primary'); use.disabled = true;
      image.onload = () => { dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} pixels`; use.disabled = false; };
      image.onerror = () => { dimensions.textContent = 'This image could not be opened. Choose a PNG, JPEG or WebP.'; };
      localUrl = URL.createObjectURL(file); image.src = localUrl;
      use.onclick = () => apply(() => request(`/api/covers/upload?identity=${identityQuery}`, { method: 'POST', body: file }));
      localPreview.append(image, dimensions, use);
    };
    async function runSearch(event) {
      event?.preventDefault();
      if (busy || query.value.trim().length < 2) return;
      const number = ++searchNumber;
      search.disabled = true;
      results.replaceChildren();
      status.textContent = 'Searching artwork sources…';
      try {
        const response = await request(`/api/covers/search?query=${encodeURIComponent(query.value.trim())}&system=${game.system}&provider=${provider.value}`);
        if (disposed || number !== searchNumber) return;
        const notices = [...response.warnings];
        if (!response.steamgriddbEnabled && provider.value === 'all') notices.push('SteamGridDB is optional: configure STEAMGRIDDB_API_KEY on the server to search it too.');
        const searched = response.providers?.some(source => source.status === 'ok');
        const failed = response.providers?.some(source => source.status === 'error');
        const summary = response.results.length ? `${response.results.length} covers found. Click an image for a full-size preview.`
          : failed && !searched ? 'Cover search failed; no source could be searched. You can retry or upload a cover.'
          : provider.value === 'steamgriddb' && !response.steamgriddbEnabled ? 'SteamGridDB is not configured.'
          : 'No matching covers in the available sources. Try a shorter title or upload your own.';
        status.textContent = `${summary} ${notices.join(' ')}`;
        for (const cover of response.results) {
          const card = element('article', '', 'orbit-cover-result');
          const link = element('a'); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = 'Open original-size preview';
          link.href = `${cover.preview}&full=1&token=${session.token}`;
          const image = element('img'); image.alt = cover.title; image.loading = 'lazy';
          const dimensions = element('p', cover.width && cover.height ? `${cover.width} × ${cover.height} pixels` : 'Loading dimensions…', 'orbit-cover-muted');
          image.onload = () => {
            if (!cover.width) dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} pixels`;
          };
          image.onerror = () => { dimensions.textContent = 'Preview unavailable. Try searching again.'; };
          image.src = `${cover.preview}&token=${session.token}`;
          link.append(image);
          const use = element('button', 'Use this cover', 'btn btn-primary');
          use.onclick = () => apply(() => request('/api/covers/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: game.identity, candidateId: cover.id }) }));
          card.append(link, element('h3', cover.title), element('p', cover.source), dimensions, element('p', cover.collection, 'orbit-cover-muted'), use);
          results.append(card);
        }
      } catch (error) { if (!disposed && number === searchNumber) status.textContent = `${error.message} You can still upload a cover.`; }
      finally { if (number === searchNumber) search.disabled = false; }
    }
    form.onsubmit = runSearch;
    try { dialog.showModal(); }
    catch (error) { dialog.remove(); reject(error); return; }
    request(`/api/covers/current?identity=${identityQuery}`).then(record => {
      if (!changed && !disposed && record) current.textContent = `Current: ${record.source} · ${record.width} × ${record.height} pixels`;
    }).catch(() => {});
    void runSearch();
  });
};
