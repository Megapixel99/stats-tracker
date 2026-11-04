// Keeps the page current without reloading it: every 10 seconds, and when
// another period is picked, it fetches the page's content as rendered by the
// server (`?fragment=1`) and swaps it in. The server escapes every name, so
// nothing here builds markup from data. Without JavaScript the period links
// still work as ordinary links.
(() => {
  const REFRESH = 10 * 1000;
  const main = document.querySelector('main[data-live]');
  const conn = document.getElementById('conn');
  const tip = document.getElementById('tip');
  if (!main) return;

  let timer;
  let pending;

  const period = () => main.querySelector('[data-period]')?.dataset.period || 'day';

  const hideTip = () => { tip.hidden = true; };

  async function load(p, { visibly = false } = {}) {
    const content = main.firstElementChild;
    if (visibly && content) content.classList.add('loading');
    pending?.abort();
    const request = new AbortController();
    pending = request;
    try {
      const url = `${window.location.pathname}?period=${encodeURIComponent(p)}&fragment=1`;
      const res = await fetch(url, { signal: request.signal, headers: { accept: 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      hideTip();
      main.innerHTML = html;
      conn.hidden = true;
      // The address follows what is on screen, so it can be bookmarked.
      if (visibly) window.history.replaceState(null, '', `?period=${encodeURIComponent(p)}`);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Keep what is on screen and say so, rather than blanking the page.
      conn.hidden = false;
      content?.classList.remove('loading');
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!document.hidden) await load(period());
      schedule();
    }, REFRESH);
  }

  main.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-period]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    load(link.dataset.period, { visibly: true }).then(schedule);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load(period()).then(schedule);
  });

  // Sparkline tooltips. The same values are in each chart's aria-label.
  function place(event) {
    const pad = 12;
    const { offsetWidth: w, offsetHeight: h } = tip;
    let x = event.clientX + pad;
    let y = event.clientY - h - pad;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
    if (y < 64) y = event.clientY + pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${y}px`;
  }

  main.addEventListener('pointerover', (event) => {
    const bar = event.target.closest('[data-value]');
    if (!bar) return;
    const value = document.createElement('strong');
    value.textContent = bar.dataset.value;
    tip.replaceChildren(value, document.createTextNode(bar.dataset.label));
    tip.hidden = false;
    place(event);
  });
  main.addEventListener('pointermove', (event) => {
    if (!tip.hidden && event.target.closest('[data-value]')) place(event);
  });
  main.addEventListener('pointerout', (event) => {
    if (event.target.closest('[data-value]')) hideTip();
  });

  schedule();
})();
