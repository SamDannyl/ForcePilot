/*
 * ForcePilot - Salesforce Record Autofill
 * Lightweight Salesforce-page launcher. The full recording engine is injected on demand.
 */
(function(){
  'use strict';
  if(window.__FORCEPILOT_LAUNCHER_READY__) return;
  window.__FORCEPILOT_LAUNCHER_READY__=true;
  const host=location.hostname.toLowerCase();
  if(location.protocol!=='https:' || !(host.endsWith('.salesforce.com')||host.endsWith('.lightning.force.com')||host.endsWith('.my.salesforce.com')||host.endsWith('.visualforce.com')||host.endsWith('.vf.force.com'))) return;

  const SETTINGS_KEY='forcepilot.settings.v1';
  const defaults={showOverlay:true,launcherMode:'edge',darkMode:false};
  const normalizeMode=mode=>mode==='current'?'bubble':(['edge','bubble','off'].includes(mode)?mode:'edge');
  const safeSend=message=>{
    try{
      if(!chrome?.runtime?.id) return Promise.resolve(null);
      const result=chrome.runtime.sendMessage(message);
      return result?.catch?.(()=>null)||Promise.resolve(result);
    }catch{return Promise.resolve(null)}
  };
  const css=`
#forcepilot-root{--fp-overlay-accent:#0b78d0;--fp-overlay-focus:rgba(11,120,208,.32);--fp-overlay-shadow:rgba(15,35,60,.18);--fp-overlay-surface:rgba(255,255,255,.96);--fp-overlay-border:rgba(152,162,179,.55);--fp-overlay-text:#344054;--fp-overlay-badge-ring:rgba(255,255,255,.96);--fp-overlay-badge:#2e844a;position:fixed!important;z-index:2147483646!important;box-sizing:border-box!important;margin:0!important;display:grid!important;place-items:center!important;overflow:visible!important;pointer-events:auto!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;-webkit-user-drag:none!important;appearance:none!important;outline:none!important;font:inherit!important;color:var(--fp-overlay-text)!important;background:transparent!important;border:0!important;transition:width .14s ease,height .14s ease,transform .14s ease,background .14s ease,box-shadow .14s ease,border-color .14s ease,filter .14s ease!important}
#forcepilot-root[data-theme="dark"]{--fp-overlay-accent:#69b7ff;--fp-overlay-focus:rgba(105,183,255,.48);--fp-overlay-shadow:rgba(0,0,0,.24);--fp-overlay-surface:rgba(34,40,49,.96);--fp-overlay-border:rgba(255,255,255,.14);--fp-overlay-text:#d9e2ee;--fp-overlay-badge-ring:rgba(34,40,49,.96);--fp-overlay-badge:#4cc46b}
#forcepilot-root[data-mode="bubble"]{right:18px!important;bottom:28px!important;width:48px!important;height:48px!important;padding:2px!important;border-radius:0!important;background:transparent!important}
#forcepilot-root[data-mode="edge"]{right:0!important;top:auto!important;bottom:48px!important;width:18px!important;height:42px!important;padding:0!important;border:1px solid rgba(255,255,255,.18)!important;border-right:0!important;border-radius:7px 0 0 7px!important;background:rgba(255,255,255,.25)!important;backdrop-filter:blur(16px) saturate(150%)!important;-webkit-backdrop-filter:blur(16px) saturate(150%)!important;box-shadow:-1px 4px 14px rgba(18,35,55,.10)!important;transform:none!important;opacity:.88!important;color:rgba(35,48,64,.70)!important;transition:width .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease,opacity .16s ease,color .16s ease!important}
#forcepilot-root[data-theme="dark"][data-mode="edge"]{background:rgba(23,29,37,.34)!important;border-color:rgba(255,255,255,.14)!important;box-shadow:-1px 4px 14px rgba(0,0,0,.22)!important;color:rgba(231,238,247,.76)!important}
#forcepilot-root[data-theme="dark"][data-mode="edge"]:hover,#forcepilot-root[data-theme="dark"][data-mode="edge"]:focus-visible{background:rgba(34,40,49,.62)!important;border-color:rgba(255,255,255,.18)!important}
#forcepilot-root[data-mode="edge"]:hover,#forcepilot-root[data-mode="edge"]:focus-visible{width:21px!important;opacity:1!important;background:rgba(255,255,255,.55)!important;border-color:rgba(152,162,179,.48)!important;box-shadow:-2px 5px 14px var(--fp-overlay-shadow)!important}
#forcepilot-root[data-mode="edge"]:active{width:20px!important}
#forcepilot-root[data-mode="bubble"]:hover{transform:translateY(-1px) scale(1.03)!important;filter:drop-shadow(0 3px 6px var(--fp-overlay-shadow))!important}
#forcepilot-root:focus-visible{outline:2px solid var(--fp-overlay-focus)!important;outline-offset:3px!important}
#forcepilot-root .fp-beacon-logo{position:relative;width:42px;height:42px;display:grid;place-items:center;pointer-events:none}
#forcepilot-root .fp-beacon-logo img{width:42px;height:42px;object-fit:contain;display:block;filter:drop-shadow(0 2px 5px var(--fp-overlay-shadow))}
#forcepilot-root .fp-status-badge{position:absolute;right:-1px;bottom:-1px;width:6px;height:6px;border-radius:50%;background:var(--fp-overlay-badge);border:2px solid var(--fp-overlay-badge-ring);box-sizing:content-box;box-shadow:0 1px 3px var(--fp-overlay-shadow);pointer-events:none}
#forcepilot-root.recording .fp-status-badge,#forcepilot-root.replaying .fp-status-badge{background:var(--fp-overlay-accent)}
#forcepilot-root.recording .fp-status-badge{animation:fp-status-pulse 1.4s ease-in-out infinite}
#forcepilot-root .fp-edge-chevron{width:18px;height:18px;display:grid;place-items:center;color:var(--fp-overlay-text);pointer-events:none}
#forcepilot-root .fp-edge-chevron svg{width:16px;height:16px;display:block}
@keyframes fp-status-pulse{0%,100%{box-shadow:0 1px 3px var(--fp-overlay-shadow),0 0 0 0 rgba(99,181,255,0)}50%{box-shadow:0 1px 3px var(--fp-overlay-shadow),0 0 0 3px rgba(99,181,255,.14)}}
@media(max-width:500px){#forcepilot-root[data-mode="bubble"]{right:12px!important}#forcepilot-root[data-mode="edge"]{bottom:44px!important}}
@media(prefers-reduced-motion:reduce){#forcepilot-root{transition:none!important}.fp-status-badge{animation:none!important}}
#forcepilot-root .fp-launcher-tooltip{position:absolute;z-index:3;display:flex;flex-direction:column;gap:0;min-width:146px;padding:8px 10px;border:1px solid rgba(152,162,179,.42);border-radius:8px;background:rgba(255,255,255,.92);backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);box-shadow:0 8px 22px rgba(16,24,40,.16);color:#344054;opacity:0;visibility:hidden;transform:translateY(-50%) translateX(4px);transition:opacity .12s ease,visibility .12s ease,transform .12s ease;pointer-events:none;text-align:left;white-space:nowrap}
#forcepilot-root .fp-launcher-tooltip strong{font-size:12px;line-height:17px;font-weight:650;color:inherit}
#forcepilot-root .fp-launcher-tooltip span{font-size:11px;line-height:16px;font-weight:500;color:#667085}
#forcepilot-root[data-mode="edge"] .fp-launcher-tooltip{right:calc(100% + 10px);top:50%}
#forcepilot-root[data-mode="bubble"] .fp-launcher-tooltip{right:0;bottom:calc(100% + 10px);transform:translateY(4px)}
#forcepilot-root:hover .fp-launcher-tooltip,#forcepilot-root:focus-visible .fp-launcher-tooltip{opacity:1;visibility:visible;transform:translateY(-50%) translateX(0)}
#forcepilot-root[data-mode="bubble"]:hover .fp-launcher-tooltip,#forcepilot-root[data-mode="bubble"]:focus-visible .fp-launcher-tooltip{transform:translateY(0)}
#forcepilot-root[data-theme="dark"] .fp-launcher-tooltip{background:rgba(34,40,49,.94);border-color:rgba(255,255,255,.14);color:#e7eef6;box-shadow:0 10px 24px rgba(0,0,0,.28)}
#forcepilot-root[data-theme="dark"] .fp-launcher-tooltip span{color:#aebbc9}

`;
  const markup=(mode)=>mode==='edge'
    ? '<span class="fp-edge-chevron" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="fp-launcher-tooltip" aria-hidden="true"><strong>Open ForcePilot</strong><span>Shortcut: Alt + X</span></span>'
    : '<span class="fp-beacon-logo"><img src="'+chrome.runtime.getURL('branding/forcepilot-icon.png')+'" alt=""><span class="fp-status-badge" aria-hidden="true"></span></span><span class="fp-launcher-tooltip" aria-hidden="true"><strong>Open ForcePilot</strong><span>Shortcut: Alt + X</span></span>';
  const root=document.getElementById('forcepilot-root')||document.createElement('button');
  const style=document.getElementById('forcepilot-launcher-style')||document.createElement('style');
  root.id='forcepilot-root';root.type='button';root.setAttribute('aria-label','Open ForcePilot');root.title='Open ForcePilot\nShortcut: Alt + X';
  style.id='forcepilot-launcher-style';style.textContent=css;
  if(!style.isConnected)document.documentElement.append(style);
  if(!root.isConnected)document.documentElement.append(root);
  if(!root.__forcePilotLauncherBound){
    root.addEventListener('click',e=>{
      e.preventDefault();e.stopPropagation();root.disabled=true;
      safeSend({type:'OPEN_SIDE_PANEL'}).finally(()=>{root.disabled=false});
    });


    root.__forcePilotLauncherBound=true;
  }

  async function apply(settings){
    const next={...defaults,...(settings||{})};
    const mode=normalizeMode(next.launcherMode);
    root.dataset.mode=mode;
    root.dataset.theme=next.darkMode===true?'dark':'light';
    root.innerHTML=markup(mode);
    root.hidden=next.showOverlay===false || mode==='off';
  }
  async function load(){
    try{const d=await chrome.storage.local.get(SETTINGS_KEY);await apply(d[SETTINGS_KEY]||defaults)}catch{await apply(defaults)}
  }
  load();
  chrome.storage?.onChanged?.addListener((changes,area)=>{
    if(area!=='local'||!changes[SETTINGS_KEY])return;
    apply(changes[SETTINGS_KEY].newValue||defaults);
  });
})();
