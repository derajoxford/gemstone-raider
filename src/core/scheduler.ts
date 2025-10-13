export function every(ms: number, fn: () => Promise<void> | void) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await fn(); } catch (e) { console.error(e); }
    finally { ticking = false; }
  };
  tick();
  return setInterval(tick, ms);
}
