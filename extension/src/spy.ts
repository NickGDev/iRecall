// MAIN-world spy: the page's own history.pushState/replaceState calls are not
// visible from the isolated content-script world, so this hooks them where
// they happen and mirrors them as DOM events (DOM is shared across worlds).
(() => {
  const fire = () => document.dispatchEvent(new CustomEvent('irecall:nav'));
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m].bind(history);
    history[m] = (...args: Parameters<typeof history.pushState>) => {
      orig(...args);
      fire();
    };
  }
  window.addEventListener('popstate', fire);
  window.addEventListener('hashchange', fire);
})();
