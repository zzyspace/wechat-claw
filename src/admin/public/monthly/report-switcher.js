(() => {
  'use strict';
  const root = document.getElementById('reportSwitcher');
  if (!root) return;
  const trigger = document.getElementById('reportSwitcherTrigger');
  const menu = document.getElementById('reportSwitcherMenu');
  const backdrop = document.getElementById('reportSwitcherBackdrop');
  const links = [...menu.querySelectorAll('[role="menuitem"]')];
  const destinations = new Map(links.map(link => [link, link.getAttribute('href')]));
  function close(restoreFocus = false) {
    menu.hidden = true;
    backdrop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    document.body.classList.remove('report-menu-open');
    if (restoreFocus) trigger.focus();
  }
  function open(index) {
    // Read the latest selection when opening; both pages update their URL after loading.
    for (const link of links) {
      const destination = new URL(destinations.get(link), location.origin);
      for (const key of ['store', 'month']) {
        const value = new URL(location.href).searchParams.get(key);
        if (value) destination.searchParams.set(key, value);
      }
      link.href = destination.pathname + destination.search;
    }
    menu.hidden = false;
    backdrop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    document.body.classList.add('report-menu-open');
    links[index ?? Math.max(0, links.findIndex(link => link.hasAttribute('aria-current')))].focus();
  }
  trigger.addEventListener('click', () => menu.hidden ? open() : close(true));
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open(event.key === 'ArrowUp' ? links.length - 1 : 0);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = links.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 :
      (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[index].focus();
  });
  menu.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    if (link.hasAttribute('aria-current')) { event.preventDefault(); close(true); }
    else { event.preventDefault(); location.assign(link.href); }
  });
  root.addEventListener('focusout', event => {
    // WebKit may temporarily focus the body on pointer-down; keep links alive until click.
    if (event.relatedTarget && !root.contains(event.relatedTarget)) close();
  });
  backdrop.addEventListener('click', () => close(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); }
  });
})();
