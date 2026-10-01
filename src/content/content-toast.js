/**
 * Content-side notification toast.
 *
 * Model text and translated text must never be placed in this light-DOM
 * surface. `showCopyToast()` therefore renders only a static confirmation.
 * Translation is entered through the browser's trusted context-menu flow and
 * rendered only inside its extension-origin mini surface, never through DOM or
 * data-* attributes owned by the host page.
 */
(() => {
  if (window.__hpToast) return;

  const t = window.__hp.t;
  const RESULT_TOAST_HIDE_MS = 10000;
  const NOTICE_TOAST_HIDE_MS = 5000;

  function removeExistingToast() {
    const old = document.getElementById('hp-copy-toast');
    if (!old) return;
    old._cleanup?.();
    old.remove();
  }

  function buildStaticToast(message, variant = 'info') {
    const toast = document.createElement('div');
    toast.id = 'hp-copy-toast';
    toast.className = `hp-copy-toast${variant === 'error' ? ' error' : ''}`;
    toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');

    const header = document.createElement('div');
    header.className = 'hp-copy-toast-header';
    const messageEl = document.createElement('span');
    messageEl.className = 'hp-notice-text';
    messageEl.textContent = message == null ? '' : String(message);
    header.appendChild(messageEl);

    const progress = document.createElement('div');
    progress.className = 'hp-copy-toast-progress';
    toast.appendChild(header);
    toast.appendChild(progress);
    return { toast, progress };
  }

  /** Static success only; the former `text` argument is intentionally ignored. */
  function showCopyToast() {
    removeExistingToast();
    const { toast, progress } = buildStaticToast(t('content.overlay.copyToast.copiedTitle'));
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    let hideTimer = null;
    let bindTimer = null;
    function closeToast() {
      clearTimeout(hideTimer);
      toast._cleanup?.();
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 500);
    }
    function clickOutsideHandler(event) {
      if (!toast.contains(event.target)) closeToast();
    }
    toast._cleanup = () => {
      clearTimeout(bindTimer);
      document.removeEventListener('click', clickOutsideHandler);
    };
    bindTimer = setTimeout(() => document.addEventListener('click', clickOutsideHandler), 50);

    function scheduleHide() {
      clearTimeout(hideTimer);
      progress.style.animation = 'none';
      void progress.offsetHeight;
      progress.style.animation = `hp-toast-countdown ${RESULT_TOAST_HIDE_MS / 1000}s linear forwards`;
      progress.style.animationPlayState = 'running';
      hideTimer = setTimeout(closeToast, RESULT_TOAST_HIDE_MS);
    }
    toast.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      progress.style.animationPlayState = 'paused';
    });
    toast.addEventListener('mouseleave', scheduleHide);
    scheduleHide();
  }

  /**
   * Lightweight non-model notice. Dynamic text uses textContent; this API must
   * not be used for model or translation output.
   */
  function showNotice(text, variant = 'info') {
    removeExistingToast();
    const { toast, progress } = buildStaticToast(text, variant);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    let hideTimer = null;
    let bindTimer = null;
    function closeToast() {
      clearTimeout(hideTimer);
      toast._cleanup?.();
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 500);
    }
    function clickOutsideHandler(event) {
      if (!toast.contains(event.target)) closeToast();
    }
    toast._cleanup = () => {
      clearTimeout(bindTimer);
      document.removeEventListener('click', clickOutsideHandler);
    };
    bindTimer = setTimeout(() => document.addEventListener('click', clickOutsideHandler), 50);
    progress.style.animation = `hp-toast-countdown ${NOTICE_TOAST_HIDE_MS / 1000}s linear forwards`;
    hideTimer = setTimeout(closeToast, NOTICE_TOAST_HIDE_MS);
  }

  window.__hpToast = { showCopyToast, showNotice };
})();
