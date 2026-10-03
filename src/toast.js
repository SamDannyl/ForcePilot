/* ForcePilot shared toast system. */
const STACK_ID = 'forcepilot-toast-stack';
const activeTransient = new Map();

const normalizeType = value => ['success','error','warning','info'].includes(value) ? value : 'info';

function ensureStack(){
  let stack=document.getElementById(STACK_ID);
  if(stack) return stack;
  stack=document.createElement('div');
  stack.id=STACK_ID;
  stack.className='fp-toast-stack';
  stack.setAttribute('aria-live','polite');
  stack.setAttribute('aria-atomic','false');
  document.body.appendChild(stack);
  return stack;
}

export function showToast(message, { type='info', duration=2600, transientKey='' } = {}){
  const text=String(message ?? '').trim();
  if(!text) return null;
  const kind=normalizeType(type);
  const stack=ensureStack();
  const key=String(transientKey || '').trim();

  // Screenshot-captured / clipboard toasts are transient acknowledgements. A new
  // acknowledgement replaces the old one instead of stacking several copies.
  if(key){
    const previous=activeTransient.get(key);
    previous?.close?.();
    activeTransient.delete(key);
  }

  // Keep ordinary global notifications useful without growing indefinitely.
  if(!key){
    while(stack.children.length >= 4) stack.firstElementChild?.remove();
  }

  const toast=document.createElement('div');
  toast.className=`fp-toast fp-toast-${kind}`;
  toast.setAttribute('role', kind==='error' ? 'alert' : 'status');
  toast.innerHTML=`<span class="fp-toast-message"></span><button class="fp-toast-close" type="button" aria-label="Dismiss notification">×</button>`;
  toast.querySelector('.fp-toast-message').textContent=text;

  let closed=false;
  let timer=0;
  let remaining=Math.max(key ? 950 : 1500, Number(duration)||2600);
  let startedAt=0;
  const close=()=>{
    if(closed) return;
    closed=true;
    window.clearTimeout(timer);
    if(key && activeTransient.get(key)===api) activeTransient.delete(key);
    toast.dataset.closing='1';
    toast.classList.remove('is-visible');
    window.setTimeout(()=>toast.remove(),140);
  };
  const api={close};
  if(key) activeTransient.set(key,api);

  toast.querySelector('.fp-toast-close')?.addEventListener('click', close);
  stack.appendChild(toast);
  requestAnimationFrame(()=>toast.classList.add('is-visible'));

  const schedule=()=>{
    startedAt=Date.now();
    timer=window.setTimeout(close, remaining);
  };
  const pause=()=>{
    if(closed) return;
    window.clearTimeout(timer);
    remaining=Math.max(250, remaining-(Date.now()-startedAt));
  };
  const resume=()=>{ if(!closed) schedule(); };
  toast.addEventListener('mouseenter',pause);
  toast.addEventListener('mouseleave',resume);
  schedule();
  return toast;
}
