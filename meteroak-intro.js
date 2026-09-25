(() => {
  const intro = document.getElementById('meteroak-intro');
  const root = document.getElementById('root');
  if (!intro || !root) return;

  const started = performance.now();
  const entranceDuration = 9750;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const previousInert = root.inert;
  const progress = intro.querySelector('.meteroak-intro-progress');
  const arc = intro.querySelector('#meteroak-intro-arc');
  const arcFill = intro.querySelector('.meteroak-intro-arc-fill');
  const dot = intro.querySelector('.meteroak-intro-dot');
  const percentage = intro.querySelector('.meteroak-intro-percentage');
  const arcLength = arc.getTotalLength();
  let leaving = false;
  let ready = false;
  let stalled = false;
  let progressFrame;
  let revealTimer;
  let deadline;
  let mountObserver;
  root.inert = true;
  document.documentElement.classList.add('meteroak-intro-active');

  function renderProgress(value) {
    const point = arc.getPointAtLength(arcLength * value / 100);
    arcFill.style.strokeDashoffset = 100 - value;
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    percentage.setAttribute('x', point.x);
    percentage.setAttribute('y', point.y - 25);
    percentage.textContent = `${Math.floor(value)}%`;
  }

  function animateProgress() {
    if (leaving || stalled || motion.matches) return;
    // This number follows the opening sequence, not the amount of usage data read.
    const value = Math.min(99, (performance.now() - started) / entranceDuration * 100);
    renderProgress(value);
    if (value < 99) progressFrame = requestAnimationFrame(animateProgress);
  }

  function reveal() {
    if (leaving) return;
    leaving = true;
    cancelAnimationFrame(progressFrame);
    renderProgress(100);
    clearTimeout(revealTimer);
    clearTimeout(deadline);
    mountObserver?.disconnect();
    window.removeEventListener('meteroak:ready', onReady);
    motion.removeEventListener('change', onMotionChange);
    // Reveal behind the fading overlay; keep keyboard focus blocked until it is gone.
    document.documentElement.classList.remove('meteroak-intro-active');
    intro.classList.add('is-leaving');
    setTimeout(() => {
      const hadFocus = intro.contains(document.activeElement);
      intro.remove();
      root.inert = previousInert;
      if (hadFocus) root.querySelector('a, button, input, select')?.focus();
    }, motion.matches ? 0 : 250);
  }

  function onReady() {
    ready = true;
    clearTimeout(revealTimer);
    // A 10-second brand entrance including the fade, not measured scan progress.
    const minimum = motion.matches ? 0 : entranceDuration;
    revealTimer = setTimeout(reveal, Math.max(0, minimum - (performance.now() - started)));
  }

  function onMotionChange() {
    cancelAnimationFrame(progressFrame);
    if (!motion.matches) animateProgress();
    if (ready) onReady();
  }

  function onDeadline() {
    if (root.hasChildNodes()) {
      // The existing dashboard handles a slow reader, errors and retry actions.
      reveal();
      return;
    }
    // A failed or very slow bundle should not leave an endless animated screen.
    stalled = true;
    cancelAnimationFrame(progressFrame);
    progress.setAttribute('hidden', '');
    intro.querySelector('.meteroak-intro-label').textContent = 'Taking longer than expected';
    intro.querySelector('.meteroak-intro-label').style.animation = 'none';
    intro.setAttribute('aria-label', 'MeterOak is taking longer to open. You can try again.');
    intro.querySelector('.meteroak-intro-retry').hidden = false;
    mountObserver = new MutationObserver(() => { if (root.hasChildNodes()) reveal(); });
    mountObserver.observe(root, { childList: true });
  }

  window.addEventListener('meteroak:ready', onReady);
  motion.addEventListener('change', onMotionChange);
  deadline = setTimeout(onDeadline, entranceDuration + 500);
  animateProgress();
  if (document.documentElement.dataset.meteroakReady === 'true') onReady();
})();
