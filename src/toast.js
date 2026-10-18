/* ForcePilot toast system shared by the sidebar and Options page. */
const STACK_ID = 'forcepilot-toast-stack';
const activeTransient = new Map();

const normalizeType = value => ['success', 'error', 'warning', 'info'].includes(value) ? value : 'info';
const ICONS = {
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.6 2.6L16.4 9"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  warning: '<path d="M10.3 4.7a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3z"/><path d="M12 9v4m0 3h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>'
};

function ensureStack() {
  let stack = document.getElementById(STACK_ID);
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = STACK_ID;
  stack.className = 'fp-toast-stack';
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-atomic', 'false');
  document.body.appendChild(stack);
  return stack;
}

export function showToast(message, { type = 'info', duration = 2600, transientKey = '', subtitle = '' } = {}) {
  const text = String(message ?? '').trim();
  if (!text) return null;
  const kind = normalizeType(type);
  const stack = ensureStack();
  const key = String(transientKey || '').trim();
  const subtitleText = String(subtitle ?? '').trim();

  // Screenshot/clipboard acknowledgements replace their previous instance.
  if (key) {
    activeTransient.get(key)?.close?.();
    activeTransient.delete(key);
  }
  if (!key) while (stack.children.length >= 4) stack.firstElementChild?.remove();

  const toast = document.createElement('div');
  toast.className = `fp-toast fp-toast-${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <svg class="fp-toast-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</svg>
    <div class="fp-toast-copy"><div class="fp-toast-title"></div>${subtitleText ? '<div class="fp-toast-subtitle"></div>' : ''}</div>`;
  toast.querySelector('.fp-toast-title').textContent = text;
  if (subtitleText) toast.querySelector('.fp-toast-subtitle').textContent = subtitleText;

  let closed = false;
  let timer = 0;
  let remaining = Math.max(key ? 950 : 1500, Number(duration) || 2600);
  let startedAt = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    if (key && activeTransient.get(key) === api) activeTransient.delete(key);
    toast.classList.remove('is-visible');
    window.setTimeout(() => toast.remove(), 180);
  };
  const api = { close };
  if (key) activeTransient.set(key, api);

  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  const schedule = () => {
    startedAt = Date.now();
    timer = window.setTimeout(close, Math.max(0, remaining - 180));
  };
  const pause = () => {
    if (closed) return;
    window.clearTimeout(timer);
    remaining = Math.max(250, remaining - (Date.now() - startedAt));
  };
  const resume = () => { if (!closed) schedule(); };
  toast.addEventListener('mouseenter', pause);
  toast.addEventListener('mouseleave', resume);
  schedule();
  return toast;
}
