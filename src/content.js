/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

(function(){
  'use strict';
  if(window.__FORCEPILOT_CONTENT_READY__) return;
  const FP=window.ForcePilotShared;
  if(!FP||!FP.isSalesforceHost()) return;
  window.__FORCEPILOT_CONTENT_READY__=true;
  const IS_TOP_FRAME=window===window.top;

  const BRIDGE_BUILD='2.0';
  const state={
    recording:false,paused:false,replaying:false,recordingId:null,recordingDate:null,darkMode:false,launcherMode:'edge',steps:[],currentStepIndex:-1,lastContext:null,
    baselines:new Map(),lastCommitted:new Map(),touched:new Set(),touchedDescriptors:new Map(),inputTimers:new Map(),reconcileTimer:0,
    replayInitial:new Map(),replayFillOnly:true,ignoreEvents:false,overlay:null,observer:null,captureHidden:null,
    runId:0,metadataPromise:null,targetCache:new Map(),appendOnly:false,appendExistingKeys:new Set(),pendingRecording:null,randomizationRun:null
  };
  function id(){return crypto.randomUUID?.()||`fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const key=d=>d?.key||d?.apiName||d?.name||`label:${FP.normalizeLabel(d?.label)}`;
  function sameFieldTarget(a,d){
    if(!a||!d)return false;
    if(a.key&&d.key&&a.key===d.key)return true;
    const ao=String(a.objectApiName||'').toLowerCase(),doj=String(d.objectApiName||'').toLowerCase();
    if(ao&&doj&&ao===doj&&a.apiName&&d.apiName&&String(a.apiName).toLowerCase()===String(d.apiName).toLowerCase())return true;
    if(!ao&&a.apiName&&doj===String(state.lastContext?.objectApiName||detectContext().objectApiName||'').toLowerCase()&&String(a.apiName).toLowerCase()===String(d.apiName||'').toLowerCase())return true;
    return !!(a.targetSelectionName&&d.targetSelectionName&&a.targetSelectionName===d.targetSelectionName);
  }
  function targetCacheKeys(target){
    const out=[];const hasObject=!!target?.objectApiName;
    const keys=hasObject
      ? [target?.key,target?.targetSelectionName,target?.apiName&&`field:${target.objectApiName}:${target.apiName}`,target?.name&&`field:${target.objectApiName}:${target.name}`]
      : [target?.key,target?.targetSelectionName,target?.apiName&&`api:${target.apiName}`,target?.name&&`name:${target.name}`,target?.label&&`label:${FP.normalizeLabel(target.label)}`];
    for(const k of keys)if(k&&!out.includes(k))out.push(k);
    return out;
  }

  function inferObjectLabel(objectApiName){
    const api=String(objectApiName||'').trim();
    if(!api || api==='Salesforce') return '';
    const objectName=(api.replace(/__c$/i,'').split('__').pop()||api);
    return objectName.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim();
  }

  function candidateObjectApiNames(){
    const out=[];
    const add=v=>{const value=String(v||'').trim();if(value&&!out.includes(value))out.push(value);};
    const route=location.pathname;
    // Salesforce is an SPA, so DOM dataset values can lag behind the URL after
    // navigation. Always prefer the current route because it identifies the
    // record/object the user is actually looking at.
    const rec=route.match(/\/lightning\/r\/([^/]+)\/([A-Za-z0-9]{15,18})(?:\/|$)/i);
    const obj=route.match(/\/lightning\/o\/([^/]+)(?:\/|$)/i);
    add(rec?.[1]);
    add(obj?.[1]);
    add(document.documentElement.dataset.sfObject);
    add(document.querySelector('[data-sf-object]')?.getAttribute('data-sf-object'));
    const targets=[...document.querySelectorAll('[data-target-selection-name^="sfdc:Record."]')];
    for(const el of targets.slice(0,12)){
      const raw=String(el.getAttribute('data-target-selection-name')||'');
      const m=raw.match(/^sfdc:Record\.([^.]*)/i);
      if(m) add(m[1]);
    }
    // Generic fallback for custom Salesforce pages that are not represented by
    // the normal /lightning/o or /lightning/r route. Prefer an active object tab
    // over guessing from labels, and use StandardButton.<Object>.New only when
    // no stronger object context exists.
    if(!out.length){
      const tabTargets=[...document.querySelectorAll('[data-target-selection-name^="sfdc:TabDefinition."]')]
        .filter(el=>el.matches?.('.slds-is-active,[aria-current="page"]') || el.querySelector?.('[aria-current="page"]'))
        .slice(0,8);
      for(const el of tabTargets){
        const raw=String(el.getAttribute('data-target-selection-name')||'');
        const m=raw.match(/^sfdc:TabDefinition\.([^.]*)$/i);
        if(m?.[1]){add(m[1]);break;}
      }
    }
    if(!out.length){
      const newTargets=[...document.querySelectorAll('[data-target-selection-name^="sfdc:StandardButton."]')].slice(0,24);
      for(const el of newTargets){
        const raw=String(el.getAttribute('data-target-selection-name')||'');
        const m=raw.match(/^sfdc:StandardButton\.([^.]+)\.New$/i);
        if(m?.[1]){add(m[1]);break;}
      }
    }
    return out;
  }

  function detectContext(){
    const path=location.pathname;
    const rec=path.match(/\/lightning\/r\/([^/]+)\/([A-Za-z0-9]{15,18})(?:\/|$)/i);
    const obj=path.match(/\/lightning\/o\/([^/]+)(?:\/|$)/i);
    const routeObjectApiName=String(rec?.[1]||obj?.[1]||'').trim();
    const candidates=candidateObjectApiNames();
    const objectApiName=routeObjectApiName||candidates[0]||'';
    // Never reuse the previous object's label. On Lightning SPA navigation that
    // can leave an Opportunity label attached to an Agreement URL.
    const explicitObjectLabel=routeObjectApiName
      ? ''
      : (document.documentElement.dataset.sfObjectLabel||document.querySelector('[data-sf-object-label]')?.getAttribute('data-sf-object-label')||'');
    const objectLabel=String(explicitObjectLabel||inferObjectLabel(objectApiName)||objectApiName||'Salesforce').replace(/^\s*[*.•·]+\s*/,'').trim();
    const recordId=rec?.[2]||document.documentElement.dataset.sfRecordId||'';
    const mode=/\/new(?:\/|$)|\/edit(?:\/|$)|\/e\//i.test(path)?'edit':recordId?'view':'new';
    return{objectApiName:objectApiName||'Salesforce',objectLabel,recordId,stage:'',mode,origin:location.origin,url:location.href};
  }


  // ForcePilot launcher. Three persisted modes: bubble, edge, off.
  // Bubble is the legacy/current launcher, retained under its new user-facing name.
  const LAUNCHER={bubble:{size:48,right:18,bottom:28},edge:{width:20,height:40,right:0,bottom:48}};

  function launcherMarkup(mode){
    if(mode==='edge'){
      return '<span class="fp-edge-chevron" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    }
    return '<span class="fp-beacon-logo"><img src="'+chrome.runtime.getURL('branding/forcepilot-icon.png')+'" alt=""/><span class="fp-status-badge" aria-hidden="true"></span></span>';
  }
  function applyLauncherMode(mode){
    const root=state.overlay;if(!root)return;
    const requested=String(mode||'');
    const next=requested==='current'?'bubble':(['edge','bubble','off'].includes(requested)?requested:'edge');
    root.dataset.mode=next;
    root.innerHTML=next==='edge'?launcherMarkup('edge'):launcherMarkup(next);
    root.title='Open ForcePilot (Alt + X)';
    root.setAttribute('aria-label','Open ForcePilot (Alt + X)');
    root.hidden=next==='off';
    updatePresence();
  }
  function ensureOverlay(){
    if(!IS_TOP_FRAME)return;
    if(state.overlay)return;
    const existing=document.getElementById('forcepilot-root');
    if(existing){
      state.overlay=existing;
      if(!existing.__forcePilotLauncherBound){
        existing.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();existing.disabled=true;safeRuntimeSendMessage({type:'OPEN_SIDE_PANEL'}).finally(()=>{existing.disabled=false;});});
        existing.__forcePilotLauncherBound=true;
      }
      applyLauncherMode(state.launcherMode||'edge');
      return;
    }
    const root=document.createElement('button');
    root.id='forcepilot-root';root.type='button';root.setAttribute('aria-label','Open ForcePilot (Alt + X)');root.title='Open ForcePilot (Alt + X)';
    const style=document.getElementById('forcepilot-launcher-style')||document.createElement('style');
    style.id='forcepilot-launcher-style';
    style.textContent=`
#forcepilot-root{--fp-overlay-accent:#0b78d0;--fp-overlay-focus:rgba(11,120,208,.32);--fp-overlay-shadow:rgba(15,35,60,.18);--fp-overlay-surface:rgba(255,255,255,.96);--fp-overlay-border:rgba(152,162,179,.55);--fp-overlay-text:#344054;--fp-overlay-badge:#2e844a;position:fixed!important;z-index:2147483646!important;box-sizing:border-box!important;margin:0!important;display:grid!important;place-items:center!important;overflow:visible!important;pointer-events:auto!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;-webkit-user-drag:none!important;appearance:none!important;outline:none!important;font:inherit!important;color:var(--fp-overlay-text)!important;background:transparent!important;border:0!important;transition:width .14s ease,height .14s ease,transform .14s ease,background .14s ease,box-shadow .14s ease,border-color .14s ease,filter .14s ease!important}
#forcepilot-root[data-theme="dark"]{--fp-overlay-accent:#69b7ff;--fp-overlay-focus:rgba(105,183,255,.48);--fp-overlay-shadow:rgba(0,0,0,.24);--fp-overlay-surface:rgba(34,40,49,.96);--fp-overlay-border:rgba(255,255,255,.14);--fp-overlay-text:#d9e2ee;--fp-overlay-badge:#4cc46b}
#forcepilot-root[data-mode="bubble"]{right:18px!important;bottom:28px!important;width:48px!important;height:48px!important;padding:2px!important;border-radius:0!important;background:transparent!important}
#forcepilot-root[data-mode="edge"]{right:0!important;top:auto!important;bottom:48px!important;width:18px!important;height:42px!important;padding:0!important;border:1px solid rgba(255,255,255,.18)!important;border-right:0!important;border-radius:7px 0 0 7px!important;background:rgba(255,255,255,.25)!important;backdrop-filter:blur(16px) saturate(150%)!important;-webkit-backdrop-filter:blur(16px) saturate(150%)!important;box-shadow:-1px 4px 14px rgba(18,35,55,.10)!important;transform:none!important;opacity:.88!important;color:rgba(35,48,64,.70)!important;transition:width .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease,opacity .16s ease,color .16s ease!important}
#forcepilot-root[data-theme="dark"][data-mode="edge"]{background:rgba(23,29,37,.34)!important;border-color:rgba(255,255,255,.14)!important;box-shadow:-1px 4px 14px rgba(0,0,0,.22)!important;color:rgba(231,238,247,.76)!important}
#forcepilot-root[data-theme="dark"][data-mode="edge"]:hover,#forcepilot-root[data-theme="dark"][data-mode="edge"]:focus-visible{background:rgba(34,40,49,.62)!important;border-color:rgba(255,255,255,.18)!important;}
#forcepilot-root[data-mode="edge"]:hover,#forcepilot-root[data-mode="edge"]:focus-visible{width:21px!important;opacity:1!important;background:rgba(255,255,255,.55)!important;border-color:rgba(152,162,179,.48)!important;box-shadow:-2px 5px 14px var(--fp-overlay-shadow)!important}
#forcepilot-root[data-mode="edge"]:active{width:20px!important}
#forcepilot-root[data-mode="bubble"]:hover{transform:translateY(-1px) scale(1.03)!important;filter:drop-shadow(0 3px 6px var(--fp-overlay-shadow))!important}
#forcepilot-root:focus-visible{outline:2px solid var(--fp-overlay-focus)!important;outline-offset:3px!important}
#forcepilot-root .fp-beacon-logo{position:relative;width:42px;height:42px;display:grid;place-items:center;pointer-events:none}
#forcepilot-root .fp-beacon-logo img{width:42px;height:42px;object-fit:contain;display:block;filter:drop-shadow(0 2px 5px var(--fp-overlay-shadow))}
#forcepilot-root .fp-status-badge{position:absolute;right:-1px;bottom:-1px;width:6px;height:6px;border-radius:50%;background:var(--fp-overlay-badge);border:0;box-sizing:border-box;box-shadow:none;pointer-events:none}
#forcepilot-root.recording .fp-status-badge,#forcepilot-root.replaying .fp-status-badge{background:var(--fp-overlay-accent)}
#forcepilot-root.recording .fp-status-badge{animation:fp-status-pulse 1.4s ease-in-out infinite}
#forcepilot-root .fp-edge-chevron{width:18px;height:18px;display:grid;place-items:center;color:var(--fp-overlay-text);pointer-events:none}
#forcepilot-root .fp-edge-chevron svg{width:16px;height:16px;display:block}
@keyframes fp-status-pulse{0%,100%{opacity:1}50%{opacity:.62}}
@media(max-width:500px){#forcepilot-root[data-mode="bubble"]{right:12px!important}#forcepilot-root[data-mode="edge"]{bottom:44px!important}}
@media(prefers-reduced-motion:reduce){#forcepilot-root{transition:none!important}.fp-status-badge{animation:none!important}}
#forcepilot-root[hidden],#forcepilot-root[data-mode="off"]{display:none!important}
`;
    root.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();root.disabled=true;safeRuntimeSendMessage({type:'OPEN_SIDE_PANEL'}).finally(()=>{root.disabled=false;});});
    if(!style.isConnected)document.documentElement.append(style);document.documentElement.append(root);state.overlay=root;root.__forcePilotLauncherBound=true;applyLauncherMode(state.launcherMode||'bubble');
  }
  function updatePresence(){const b=state.overlay;if(!b)return;b.dataset.theme=state.darkMode?'dark':'light';b.classList.toggle('recording',state.recording);b.classList.toggle('replaying',state.replaying);b.classList.toggle('paused',state.paused);b.setAttribute('aria-label',state.recording?(state.paused?`Recording paused, ${state.steps.length} fields`:`Recording ${state.steps.length} fields`):state.replaying?`Autofill, field ${state.currentStepIndex+1}`:'Open ForcePilot');}
  function safeRuntimeSendMessage(message){
    try{if(!chrome?.runtime?.id)return Promise.resolve(null);const r=chrome.runtime.sendMessage(message);return r?.catch?.(()=>null)||Promise.resolve(r);}catch{return Promise.resolve(null);}
  }
  function recordingBeforeUnload(e){if(!state.recording)return;reconcile();e.preventDefault();e.returnValue='';return '';}

  function normalizeTypeLabel(d){
    const semantic=String(d?.kind||'').toLowerCase();
    const rawCandidates=[d?.sfDataType,d?.salesforceType,d?.type].map(v=>String(v||'').toLowerCase()).filter(Boolean);
    const meaningful=rawCandidates.find(v=>!['text','string','field','input'].includes(v));
    const raw=meaningful||semantic||rawCandidates[0]||'';
    if(raw==='boolean'||raw==='checkbox'||d?.kind==='boolean')return'Checkbox';
    if(raw==='multipicklist'||raw==='multi-picklist'||d?.kind==='multi-picklist')return'Multipicklist';
    if(raw==='picklist'||raw==='combobox'||d?.kind==='picklist')return'Picklist';
    if(raw==='date'||d?.kind==='date')return'Date';
    if(raw==='datetime'||d?.kind==='datetime')return'Date/Time';
    if(raw==='time'||d?.kind==='time')return'Time';
    if(raw==='currency')return'Currency';if(raw==='percent')return'Percent';if(raw==='double'||raw==='int'||raw==='integer'||raw==='long'||raw==='decimal'||raw==='number'||d?.kind==='number')return'Number';
    if(raw==='reference'||d?.kind==='lookup'||d?.reference)return'Lookup';
    if(raw==='textarea'||raw==='longtextarea'||raw==='richtext'||d?.kind==='longText')return'Text';
    return'Text';
  }
  function valueFor(d){const value=FP.readValue(d);if(d?.kind==='picklist'){const label=selectedPicklistDisplayValue(d,value);if(label)return label;}return value}
  function emptyValue(d,v){
    // Centralized empty-state semantics live in shared.js so replay and future callers
    // use the same interpretation. Multi-picklist behavior is intentionally preserved.
    return FP.isValueEmpty?.(d,v) ?? (v===null||v===undefined||String(v).trim()==='');
  }
  function baselineFor(d){return state.baselines.get(key(d))}
  function lastFor(d){return state.lastCommitted.get(key(d))}

  function setBaseline(){
    state.baselines.clear();state.lastCommitted.clear();state.touched.clear();state.touchedDescriptors.clear();
    for(const d of FP.candidateFields()){
      if(d.disabled||d.readOnly)continue;
      const v=FP.normalizeRecordedValue(d,valueFor(d));state.baselines.set(key(d),v);state.lastCommitted.set(key(d),v);
    }
  }
  function storeTouchedDescriptor(d){
    if(!d)return;const k=key(d),capture=state.lookupCreationCapture;
    if(capture&&!sameFieldTarget(capture.lookupTarget,d)&&modalRootForDescriptor(d)){
      capture.childKeys.add(k);capture.descriptors.set(k,d);
      const existing=state.touchedDescriptors.get(k);
      // Keep an outer-page descriptor if the new-record modal has the same field key;
      // the nested workflow owns its own descriptor map and should not replace it.
      if(!existing||modalRootForDescriptor(existing))state.touchedDescriptors.set(k,d);
      return;
    }
    state.touchedDescriptors.set(k,d);
  }
  function markTouched(e){
    if(!state.recording||state.ignoreEvents)return null;
    const d=FP.findDescriptorFromEvent(e);if(!d||d.disabled||d.readOnly)return null;
    const k=key(d);state.touched.add(k);storeTouchedDescriptor(d);return d;
  }
  async function refreshForCommit(d){
    if(!d)return d;
    // Salesforce Currency/Percent controls can expose a generic HTML text input.
    // Refresh the descriptor after Salesforce finishes formatting on blur/change so
    // the semantic type can be inferred from the live control (formatter or display).
    const raw=String(d?.sfDataType||'').toLowerCase();
    const needsNumericRefresh=d.kind==='number' && ['','text','string','field','input','number'].includes(raw);
    if(!needsNumericRefresh)return d;
    const target=d.host||d.element||d;
    let fresh=FP.refreshFieldDescriptor?.(target);
    if(fresh && ['currency','percent','number','double','int','integer','long','decimal'].includes(String(fresh.sfDataType||'').toLowerCase())){
      storeTouchedDescriptor(fresh);
      return fresh;
    }
    // Salesforce applies Currency/Percent formatting asynchronously on blur.
    // Re-read the same control a few times without changing the user's value.
    for(const delay of [80,160,280]){
      await wait(delay);
      fresh=FP.refreshFieldDescriptor?.(target)||fresh;
      const ft=String(fresh?.sfDataType||'').toLowerCase();
      if(['currency','percent','number','double','int','integer','long','decimal'].includes(ft)){
        storeTouchedDescriptor(fresh);
        return fresh;
      }
    }
    return fresh||d;
  }
  function localDateISO(date=new Date()){
    const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),day=String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function dateAtLocalMidnight(iso){
    const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m)return null;
    const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
    return Number.isNaN(d.getTime())?null:d;
  }
  function dateOffsetDays(fromISO,toISO){
    const from=dateAtLocalMidnight(fromISO),to=dateAtLocalMidnight(toISO);
    if(!from||!to)return null;
    return Math.round((to.getTime()-from.getTime())/86400000);
  }
  function shiftLocalDateISO(baseISO,offsetDays){
    const d=dateAtLocalMidnight(baseISO);
    if(!d||!Number.isFinite(Number(offsetDays)))return baseISO;
    d.setDate(d.getDate()+Number(offsetDays));
    return localDateISO(d);
  }
  function dateMetaForStep(d,value){
    if(d?.kind!=='date')return {};
    const recordedDate=state.recordingDate||localDateISO();
    const recordedValue=FP.normalizeDate(value);
    // New recordings preserve the exact calendar date. Relative-to-today now
    // belongs to per-field randomization; legacy relative steps are still replayed.
    return /^\d{4}-\d{2}-\d{2}$/.test(recordedValue) ? {dateRecordedOn:recordedDate,dateMode:'absolute'} : {};
  }
  function selectedPicklistDisplayValue(d,value){
    if(d?.kind!=='picklist')return undefined;
    const norm=FP.normalizeLabel;
    const clean=value=>{
      const text=FP.normalizeText(value);
      if(!text||FP.isPicklistPlaceholder(text)||/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(text)||/help\s*info/i.test(text))return '';
      const fieldLabel=norm(d?.label||''),n=norm(text);
      if(fieldLabel&&(n===fieldLabel||(n.startsWith(fieldLabel)&&n.length>fieldLabel.length+8)))return '';
      return text;
    };
    const raw=typeof value==='string'?value:(value&&typeof value==='object'?value.value??value.displayValue:'');
    const hit=(d.options||[]).find(o=>norm(o?.value)===norm(raw)||norm(o?.displayValue)===norm(raw));
    if(hit?.displayValue)return FP.normalizeText(hit.displayValue);
    const candidate=clean(raw);if(candidate)return candidate;
    const live=clean(FP.readValue?.(d));if(live)return live;
    return undefined;
  }
  function makeStep(d,value,before,source,sequence){
    const normalizedValue=FP.normalizeRecordedValue(d,value);
    return{ id:id(),sequence,action:d.kind==='boolean'?'set-boolean':d.kind==='picklist'?'select-option':d.kind==='multi-picklist'?'set-multi-option':d.kind==='lookup'?'select-lookup':d.kind==='address'?'set-address':'set-value',
      target:{key:d.key,label:FP.normalizeText(d.label).replace(/^\s*\*\s*/,''),apiName:d.apiName,name:d.name,kind:d.kind,fieldType:FP.canonicalFieldType(d),sfDataType:d.sfDataType||'',salesforceType:d.sfDataType||'',length:d.length,maxLength:d.maxLength,scale:d.scale,precision:d.precision,required:d.required,updateable:d.updateable,createable:d.createable,reference:d.reference,referenceObject:d.referenceObject,referenceId:d.referenceId||undefined,multiSelect:d.multiSelect,objectApiName:d.objectApiName,targetSelectionName:d.targetSelectionName,fieldId:d.fieldId,fieldPath:d.fieldPath,identitySource:d.identitySource,identityConfidence:d.identityConfidence,controllerName:d.controllerName||undefined,controllingFields:Array.isArray(d.controllingFields)?d.controllingFields.slice():undefined,options:Array.isArray(d.options)?d.options.map(o=>({value:o.value,displayValue:o.displayValue,active:o.active,validFor:o.validFor})):[],dataTableColumnKey:d.dataTableColumnKey||undefined,dataTableFieldApiName:d.dataTableFieldApiName||undefined},value:normalizedValue,before:FP.normalizeRecordedValue(d,before),meta:{source,recordedAt:new Date().toISOString(),...dateMetaForStep(d,value),selectedDisplayValue:d.kind==='picklist'?selectedPicklistDisplayValue(d,value):undefined,lookupDisplayValue:d.kind==='lookup'&&normalizedValue?.displayValue?normalizedValue.displayValue:undefined,lookupRecordId:d.kind==='lookup'&&normalizedValue?.recordId?normalizedValue.recordId:undefined}}
  }

  // A lookup's "New <Object>" action opens a related-record form. Keep
  // that form's edited fields as a child workflow on the lookup step instead of
  // flattening them into the parent record's ordinary field list.
  function composedParent(node){
    if(!node)return null;
    try{if(node.parentElement)return node.parentElement;const root=node.getRootNode?.();if(root?.host)return root.host}catch{}
    return null;
  }
  function composedContains(root,node){
    if(!root||!node)return false;const seen=new Set();let cur=node;
    while(cur&&!seen.has(cur)){if(cur===root)return true;seen.add(cur);cur=composedParent(cur)}
    return false;
  }
  const CREATE_MODAL_SELECTOR='[role="dialog"],[aria-modal="true"],.slds-modal,.uiModal,.modal-container,lightning-modal,records-modal,force-modal';
  function activeSalesforceModals(){
    return FP.deepQueryAll(document,CREATE_MODAL_SELECTOR,140).filter((el,i,all)=>all.indexOf(el)===i&&isVisible(el)&&el.getAttribute?.('aria-hidden')!=='true'&&el.getAttribute?.('data-hidden')!=='true')
      // Salesforce often marks both the modal shell and an inner content region as
      // dialogs. Prefer the outer shell so child fields AND the footer Save button
      // remain inside the chosen root during recording and replay.
      .sort((a,b)=>{const area=el=>{try{const r=el.getBoundingClientRect();return Math.max(1,r.width*r.height)}catch{return 0}};return area(b)-area(a)});
  }
  function modalRootForNode(node){
    let cur=node;const seen=new Set();
    while(cur&&!seen.has(cur)){
      seen.add(cur);
      try{if(cur.matches?.(CREATE_MODAL_SELECTOR)&&isVisible(cur)&&cur.getAttribute?.('aria-hidden')!=='true')return cur}catch{}
      cur=composedParent(cur);
    }
    return activeSalesforceModals().find(root=>composedContains(root,node))||null;
  }
  function modalRootForDescriptor(d){return modalRootForNode(d?.host||d?.element)||null}
  function lookupActionNodeFromEvent(e){
    const path=typeof e?.composedPath==='function'?e.composedPath():[e?.target];
    for(const n of path){if(!n||n.nodeType!==1)continue;const tag=String(n.tagName||'').toLowerCase();if(tag==='lightning-base-combobox-item'||n.getAttribute?.('role')==='option'||n.matches?.('.slds-listbox__option[data-value],.slds-listbox__item[data-value]'))return n;}
    return null;
  }
  function lookupCreateActionLabel(node){
    if(!node)return'';
    const raw=String(node.getAttribute?.('data-value')||'');
    let text='';
    try{
      const labelNode=node.querySelector?.('.slds-listbox__option-text_entity lightning-base-combobox-formatted-text[title],.slds-listbox__option-text_entity [title],.slds-listbox__option-text_entity,[title]');
      text=FP.normalizeText(labelNode?.getAttribute?.('title')||labelNode?.textContent||'');
    }catch{}
    if(!text){try{text=FP.normalizeText(node.getAttribute?.('title')||node.textContent||'')}catch{}}
    if(/^actionCreateNew$/i.test(raw))return /^new\s+.+/i.test(text)||/^create new(?:\s+.+)?$/i.test(text)?text:'New record';
    return /^new\s+.+/i.test(text)||/^create new(?:\s+.+)?$/i.test(text)?text:'';
  }
  function recordTypeEntries(root){
    if(!root)return[];
    const entries=[],seen=new Set();
    const allLabels=()=>FP.deepQueryAll(root,'label,[role="radio"],.slds-radio__label,[data-record-type-label]',240);
    const labels=allLabels();
    const readText=el=>FP.normalizeText(el?.getAttribute?.('aria-label')||el?.getAttribute?.('title')||el?.textContent||'');
    const labelForInput=input=>{
      const idValue=String(input?.id||'');
      let label='';
      try{label=[...(input?.labels||[])].map(readText).find(Boolean)||''}catch{}
      if(!label)label=readText(input?.closest?.('label'));
      if(!label&&idValue)label=readText(labels.find(x=>String(x.getAttribute?.('for')||'')===idValue));
      if(!label){
        let cur=composedParent(input),depth=0;
        while(cur&&cur!==root&&depth++<5){
          if(cur.matches?.('label,.slds-radio,.slds-radio_button__label,[role="radio"],[data-record-type-label]')){label=readText(cur.querySelector?.('.slds-radio__label,[data-record-type-label],span')||cur);if(label)break;}
          cur=composedParent(cur);
        }
      }
      return label;
    };
    const add=(el,label,control,kind='radio')=>{
      label=FP.normalizeText(label);
      if(!el||!label||/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(label)||/^(choose a record type|record type|next|cancel|continue)$/i.test(label))return;
      const norm=FP.normalizeLabel(label),key=`${kind}:${norm}`;
      if(seen.has(key))return;seen.add(key);
      const value=String(control?.value??el?.getAttribute?.('data-value')??el?.getAttribute?.('data-record-type-id')??'');
      const selected=!!(control?.checked||control?.getAttribute?.('aria-checked')==='true'||el?.getAttribute?.('aria-checked')==='true'||el?.getAttribute?.('aria-selected')==='true'||/\b(selected|checked|is-active|active)\b/i.test(String(el?.className||'')));
      const source=control||el;
      const controlHint=[source?.name,source?.id,source?.getAttribute?.('name'),source?.getAttribute?.('id'),source?.getAttribute?.('data-record-type-id'),el?.getAttribute?.('data-record-type-label')].map(FP.normalizeText).filter(Boolean).join(' ');
      entries.push({el,label,value,selected,kind,control:source,controlHint});
    };
    for(const control of FP.deepQueryAll(root,'input[type="radio"],[role="radio"],lightning-radio-button,select[name*="recordtype" i],select[id*="recordtype" i]',180)){
      if(!isVisible(control)&&!isVisible(composedParent(control)))continue;
      const tag=String(control.tagName||'').toLowerCase();
      if(tag==='select'){
        for(const opt of [...(control.options||[])]){
          const optionLabel=FP.normalizeText(opt.textContent||opt.label||'');
          if(!optionLabel||opt.disabled||!opt.value)continue;
          add(control,optionLabel,{value:opt.value,checked:opt.selected,getAttribute:()=>null},'select-option');
        }
        continue;
      }
      const label=tag==='input'?labelForInput(control):FP.normalizeText(control.getAttribute?.('aria-label')||control.getAttribute?.('title')||control.querySelector?.('.slds-radio__label,[data-record-type-label]')?.textContent||control.textContent||'');
      let clickTarget=control;
      if(tag==='input'){
        try{clickTarget=control.closest?.('label')||labels.find(x=>String(x.getAttribute?.('for')||'')===String(control.id||''))||control}catch{}
      }else if(tag==='lightning-radio-button'){
        clickTarget=control.querySelector?.('label,[role="radio"],button')||control;
      }
      add(clickTarget,label,control,'radio');
    }
    // The selected option is commonly represented by both its radio input and
    // a role=radio node. Deduplicate by human label; never expose its ID as label.
    return entries;
  }
  function recordTypeAdvanceButton(root){
    const candidates=FP.deepQueryAll(root,'button,input[type="button"],input[type="submit"],[role="button"],lightning-button',160).filter(el=>isVisible(el)&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true');
    const label=el=>[el?.getAttribute?.('aria-label'),el?.getAttribute?.('title'),el?.getAttribute?.('label'),el?.value,el?.textContent].map(FP.normalizeText).filter(Boolean);
    return candidates.find(el=>label(el).some(x=>/^(next|continue|next step|select record type)$/i.test(x)))||null;
  }
  function recordTypeChooserState(root){
    if(!root||!isVisible(root))return null;
    const entries=recordTypeEntries(root),advance=recordTypeAdvanceButton(root);
    if(!entries.length||!advance)return null;
    const text=FP.normalizeText(root.textContent||'');
    // Do not mistake an ordinary form containing multiple radio fields and a Next
    // button for Salesforce's record-type chooser. Require record-type context.
    const isChooser=/record\s*type/i.test(text)||entries.some(entry=>/record.?type/i.test(entry.controlHint||''));
    return isChooser?{entries,advance}:null;
  }
  function selectedRecordType(root){
    const chooser=recordTypeChooserState(root);if(!chooser)return null;
    const entry=chooser.entries.find(x=>x.selected)||chooser.entries.find(x=>x.kind==='select'&&x.label)||null;
    if(!entry)return null;
    return{label:FP.normalizeText(entry.label)};
  }
  function descriptorForLookupAction(node,e){
    const direct=FP.findDescriptorFromEvent?.(e);if(direct&&String(direct.kind||'').toLowerCase()==='lookup')return direct;
    for(const d of FP.candidateFields()){
      if(String(d?.kind||'').toLowerCase()!=='lookup')continue;
      const dropdown=lookupControlledDropdown(d,findComboInput(d));
      if(dropdown&&composedContains(dropdown,node))return d;
    }
    const path=typeof e?.composedPath==='function'?e.composedPath():[node];
    for(const n of path){if(!n||n.nodeType!==1)continue;const tag=String(n.tagName||'').toLowerCase();if(['lightning-lookup','lightning-record-picker','records-record-layout-lookup','lightning-input-field','lightning-base-combobox'].includes(tag)){const d=FP.describeField(n);if(d&&String(d.kind||'').toLowerCase()==='lookup')return d;}}
    return null;
  }
  function captureLookupCreateInteraction(e){
    if(!state.recording||state.paused||state.ignoreEvents||e?.type!=='click'||!e.isTrusted)return;
    const target=e.target;
    if(state.lookupCreationCapture){
      const modal=modalRootForNode(target);
      if(modal){
        const path=typeof e.composedPath==='function'?e.composedPath():[target];
        const action=path.find(n=>n?.nodeType===1&&(/^(button|input)$/.test(String(n.tagName||'').toLowerCase())||n.getAttribute?.('role')==='button'||String(n.tagName||'').toLowerCase()==='lightning-button'))||target;
        const text=FP.normalizeText(action?.getAttribute?.('aria-label')||action?.getAttribute?.('title')||action?.value||action?.textContent||'').toLowerCase();
        if(/\b(cancel|close|dismiss)\b/.test(text)){state.lookupCreationCapture.cancelled=true;return;}
        if(/^(next|continue|next step|select record type)$/i.test(text)){
          const chooser=recordTypeChooserState(modal);
          const selected=selectedRecordType(modal);
          if(selected?.label)state.lookupCreationCapture.recordTypeLabel=selected.label;
          if(chooser)state.lookupCreationCapture.recordTypeOptions=[...new Set(chooser.entries.map(entry=>FP.normalizeText(entry.label)).filter(Boolean))];
        }
        if(/^save\b|^create(?:\s+record)?\b/.test(text))state.lookupCreationCapture.saveRequested=true;
      }
    }
    const node=lookupActionNodeFromEvent(e);if(!node)return;
    const actionLabel=lookupCreateActionLabel(node);if(!actionLabel)return;
    // Only capture the Create New action for an active Lightning lookup. Other New
    // buttons on the record page must remain ordinary navigation/actions.
    const d=descriptorForLookupAction(node,e);if(!d||String(d.kind||'').toLowerCase()!=='lookup')return;
    if(state.lookupCreationCapture&&modalRootForNode(node))return;
    const current=valueFor(d);const targetStep=makeStep(d,current,baselineFor(d),'lookup-create-new',state.steps.length+1);
    const typedLabel=FP.normalizeText(actionLabel).replace(/^new\s+/i,'').replace(/^create new\s*/i,'');
    const capture={lookupKey:key(d),lookupTarget:{...targetStep.target},lookupLabel:FP.normalizeText(d.label||'Lookup'),objectLabel:typedLabel||'record',initialValue:FP.normalizeRecordedValue(d,current),initialQuery:FP.normalizeText(findComboInput(d)?.value||current?.displayValue||''),fields:[],descriptors:new Map(),childKeys:new Set(),baselines:new Map(),lastCommitted:new Map(),recordTypeLabel:'',recordTypeOptions:[],saveRequested:false,cancelled:false,startedAt:Date.now(),modalSeen:false,modalBaseline:activeSalesforceModals()};
    state.lookupCreationCapture=capture;
    state.touched.add(capture.lookupKey);state.touchedDescriptors.set(capture.lookupKey,d);
    // Salesforce inserts the new-record modal asynchronously. Snapshot its initial
    // values before the user edits them, so clicking a prefilled field isn't recorded
    // as a change unless its value actually changes.
    void snapshotLookupCreationModal(capture);
  }
  async function snapshotLookupCreationModal(capture){
    for(let attempt=0;attempt<25;attempt++){
      if(state.lookupCreationCapture!==capture||capture.cancelled||!state.recording)return;
      const modal=activeSalesforceModals().find(root=>!composedContains(state.overlay,root)&&!(capture.modalBaseline||[]).includes(root));
      if(modal){
        capture.modalSeen=true;capture.modalRoot=modal;FP.invalidateFieldCaches();
        for(const d of candidateFieldsWithin(modal))if(composedContains(modal,d?.host||d?.element)){
          const k=key(d);if(!capture.baselines.has(k))capture.baselines.set(k,FP.normalizeRecordedValue(d,valueFor(d)));
        }
        // One additional pass covers forms whose fields render a beat after the shell.
        await wait(160);if(state.lookupCreationCapture!==capture||capture.cancelled||!state.recording)return;
        FP.invalidateFieldCaches();for(const d of candidateFieldsWithin(modal))if(composedContains(modal,d?.host||d?.element)){const k=key(d);if(!capture.baselines.has(k))capture.baselines.set(k,FP.normalizeRecordedValue(d,valueFor(d)));}
        return;
      }
      await wait(80);
    }
  }
  function commitLookupCreationChild(d,source,userInitiated=false){
    const capture=state.lookupCreationCapture;if(!capture||capture.cancelled||!d)return;
    const k=key(d),current=valueFor(d),normalized=FP.normalizeRecordedValue(d,current);
    const before=capture.baselines.has(k)?capture.baselines.get(k):undefined;
    const existing=capture.fields.find(s=>sameFieldTarget(s?.target,d));
    if(recordingValueIsEmpty(d,normalized))return;
    if(before!==undefined&&FP.valuesEqual(d,before,normalized)){
      if(existing&&userInitiated&&source!=='blur'){const i=capture.fields.findIndex(s=>s.id===existing.id);if(i>=0)capture.fields.splice(i,1);}
      capture.lastCommitted.set(k,normalized);return;
    }
    if(capture.lastCommitted.has(k)&&FP.valuesEqual(d,capture.lastCommitted.get(k),normalized))return;
    const previous=capture.lastCommitted.has(k)?capture.lastCommitted.get(k):before;
    if(existing){existing.value=FP.normalizeRecordedValue(d,current);existing.before=existing.before??FP.normalizeRecordedValue(d,previous);syncStepWithDescriptor(existing,d);existing.meta={...(existing.meta||{}),source,updatedAt:new Date().toISOString(),...dateMetaForStep(d,current)};}
    else capture.fields.push(makeStep(d,current,previous,source,capture.fields.length+1));
    capture.descriptors.set(k,d);capture.childKeys.add(k);capture.lastCommitted.set(k,normalized);
  }
  function finalizeLookupCreationCapture(){
    const capture=state.lookupCreationCapture;if(!capture)return;
    state.lookupCreationCapture=null;
    if(capture.cancelled)return;
    let d=state.touchedDescriptors.get(capture.lookupKey);
    if(!d||(!d.host?.isConnected&&!d.element?.isConnected))d=resolveTarget(capture.lookupTarget)||FP.candidateFields().find(x=>sameFieldTarget(capture.lookupTarget,x))||d;
    if(d){try{d=FP.refreshFieldDescriptor?.(d.host)||d}catch{}}
    if(!d||String(d.kind||'').toLowerCase()!=='lookup')return;
    const live=FP.normalizeRecordedValue(d,valueFor(d));
    const initialId=String(capture.initialValue?.recordId||'');
    const liveId=String(live?.recordId||'');
    // Saving a Lightning New-record modal usually selects the newly created record
    // into its originating lookup. Treat that as save evidence if Salesforce's
    // nested Save button wasn't surfaced through the delegated click event.
    const newlySelectedRecord=!!liveId&&liveId!==initialId;
    // A confirmed newly selected record after a captured New modal is enough to
    // retain the workflow even if the field/change events or Save click were missed.
    // An empty child list is preferable to silently degrading the step to a normal lookup.
    if(!capture.saveRequested&&!(newlySelectedRecord&&capture.modalSeen))return;
    let parent=state.steps.find(s=>sameFieldTarget(s?.target,d))||state.steps.find(s=>String(s?.id||'')===String(capture.parentStepId||''));
    const fallbackValue=live?.displayValue||live?.recordId?live:capture.initialValue?.displayValue||capture.initialQuery?{displayValue:capture.initialValue?.displayValue||capture.initialQuery,recordId:''}:live;
    if(!parent){parent=makeStep(d,fallbackValue,baselineFor(d),'lookup-create-new',state.steps.length+1);state.steps.push(parent);}else{syncStepWithDescriptor(parent,d);parent.value=FP.normalizeRecordedValue(d,fallbackValue);}
    const childSteps=capture.fields.map((original,i)=>{const s={...original,target:{...(original.target||{})}};const desc=capture.descriptors.get(s.target.key);if(desc)syncStepWithDescriptor(s,desc);s.sequence=i+1;return s;});
    parent.action='select-lookup';parent.target={...parent.target,kind:'lookup',fieldType:'Lookup'};
    parent.meta={...(parent.meta||{}),lookupDisplayValue:parent.value?.displayValue||capture.initialValue?.displayValue||capture.initialQuery||'',lookupRecordId:parent.value?.recordId||'',createNewRecord:{version:3,objectLabel:capture.objectLabel,recordTypeLabel:FP.normalizeText(capture.recordTypeLabel||''),recordTypeOptions:[...new Set((capture.recordTypeOptions||[]).map(FP.normalizeText).filter(Boolean))],fields:sanitizeRecordedSteps(childSteps),recordedAt:new Date().toISOString()}};
    state.steps.forEach((step,i)=>{step.sequence=i+1});
    updatePresence();
  }

  // Keep persisted values canonical when Salesforce upgrades a generic text control
  // to a Currency/Percent descriptor. The DOM may display $1.00 / 1.00%, but the
  // recording must retain only the underlying numeric value (1).
  function syncStepWithDescriptor(step,d){
    if(!step||!d)return step;
    const target={...(step.target||{})};
    let currentValue=FP.normalizeRecordedValue(d,step.value);
    if(d.kind==='picklist'){const label=selectedPicklistDisplayValue(d,step.value);if(label)currentValue=label;}
    step.value=currentValue;
    if(step.before!==undefined){let before=FP.normalizeRecordedValue(d,step.before);if(d.kind==='picklist'){const label=selectedPicklistDisplayValue(d,step.before);if(label)before=label;}step.before=before;}
    step.target={...target,
      key:d.key,label:d.label,apiName:d.apiName,name:d.name,kind:d.kind,
      fieldType:FP.canonicalFieldType(d),
      sfDataType:d.sfDataType||target.sfDataType||'',
      salesforceType:d.sfDataType||target.salesforceType||'',
      reference:d.reference,referenceObject:d.referenceObject,referenceId:d.referenceId||target.referenceId||undefined,
      multiSelect:d.multiSelect,objectApiName:d.objectApiName||target.objectApiName,
      targetSelectionName:d.targetSelectionName||target.targetSelectionName,fieldId:d.fieldId||target.fieldId,fieldPath:d.fieldPath||target.fieldPath,
      identitySource:d.identitySource||target.identitySource,identityConfidence:d.identityConfidence||target.identityConfidence,
      length:d.length??target.length,maxLength:d.maxLength??target.maxLength,scale:d.scale??target.scale,precision:d.precision??target.precision,required:d.required??target.required,updateable:d.updateable??target.updateable,createable:d.createable??target.createable,
      controllerName:d.controllerName||target.controllerName,controllingFields:Array.isArray(d.controllingFields)?d.controllingFields.slice():(target.controllingFields||[]),controllerValues:d.controllerValues||target.controllerValues,isDependentPicklist:d.isDependentPicklist??target.isDependentPicklist,options:Array.isArray(d.options)?d.options.map(o=>({value:o.value,displayValue:o.displayValue,active:o.active,validFor:o.validFor})):target.options||[],
      dataTableColumnKey:d.dataTableColumnKey||target.dataTableColumnKey,dataTableFieldApiName:d.dataTableFieldApiName||target.dataTableFieldApiName
    };
    if(d.kind==='picklist'){const label=selectedPicklistDisplayValue(d,step.value);if(label)step.meta={...(step.meta||{}),selectedDisplayValue:label};}
    if(d.kind==='lookup'&&step.value&&typeof step.value==='object'){step.meta={...(step.meta||{}),lookupDisplayValue:step.value.displayValue||'',lookupRecordId:step.value.recordId||''};}
    return step;
  }

  function recordingValueIsEmpty(d,v){
    if(v===null||v===undefined)return true;
    const kind=String(d?.kind||'').toLowerCase();
    // False is a meaningful Salesforce checkbox value. The baseline comparison
    // below filters unchanged unchecked boxes while preserving true -> false edits.
    if(kind==='boolean')return false;
    if(kind==='picklist')return !!FP.isPicklistPlaceholder?.(v);
    if(kind==='multi-picklist'){
      const vals=Array.isArray(v)?v:FP.parseMultiValues(v);
      return vals.length===0||vals.every(x=>FP.isMultiPicklistPlaceholder?.(x));
    }
    if(kind==='lookup')return !v?.displayValue&&!v?.recordId;
    if(kind==='address')return !v||Object.values(v).every(x=>FP.normalizeText(x)==='');
    if(Array.isArray(v))return v.length===0;
    if(typeof v==='object')return Object.values(v).every(x=>x==null||FP.normalizeText(x)==='');
    if(typeof v==='string')return !v.trim();
    return false;
  }

  function removeRecordedStepForTarget(d){
    const index=state.steps.findIndex(s=>sameFieldTarget(s?.target,d));
    if(index<0)return false;
    state.steps.splice(index,1);
    state.steps.forEach((s,i)=>{s.sequence=i+1});
    return true;
  }

  function commitDescriptor(d,source,userInitiated=false){
    if(!state.recording||state.ignoreEvents||!d||d.disabled||d.readOnly||!state.touched.has(key(d)))return;
    const capture=state.lookupCreationCapture;
    if(capture&&!sameFieldTarget(capture.lookupTarget,d)&&(capture.childKeys.has(key(d))||!!modalRootForDescriptor(d))){capture.childKeys.add(key(d));if(capture.cancelled)return;return commitLookupCreationChild(d,source,userInitiated);}
    const current=valueFor(d), normalized=FP.normalizeRecordedValue(d,current), last=lastFor(d), baseline=baselineFor(d);
    const existing=state.steps.find(s=>sameFieldTarget(s?.target,d));

    // Click/blur/focus events can reach a Salesforce field before the user actually
    // enters or selects anything. Never create a recording step for an empty value.
    if(recordingValueIsEmpty(d,normalized)){
      // A Salesforce save/rerender can temporarily clear a control. Only an
      // explicit user edit (not blur or reconciliation) may remove a saved step.
      if(existing&&!state.appendOnly&&userInitiated&&source!=='blur')removeRecordedStepForTarget(d);
      state.lastCommitted.set(key(d),normalized);
      updatePresence();
      return;
    }

    // Returning a field to its original value means there is no net change to record.
    if(baseline!==undefined&&FP.valuesEqual(d,baseline,normalized)){
      if(existing&&!state.appendOnly&&userInitiated&&source!=='blur')removeRecordedStepForTarget(d);
      state.lastCommitted.set(key(d),normalized);
      updatePresence();
      return;
    }
    if(last!==undefined&&FP.valuesEqual(d,last,normalized))return;

    const previous=last===undefined?baseline:last;
    if(existing){
      if(state.appendOnly&&(state.appendExistingKeys.has(key(d))||state.appendExistingKeys.has(existing?.target?.key)))return;
      // One stored value per field: a later edit replaces the earlier recorded value.
      // The sequence keeps the field's original place in the form.
      existing.value=FP.normalizeRecordedValue(d,current);
      existing.before=existing.before??FP.normalizeRecordedValue(d,previous);
      syncStepWithDescriptor(existing,d);
      existing.meta={...(existing.meta||{}),source,updatedAt:new Date().toISOString(),...dateMetaForStep(d,current)};
    }else{
      state.steps.push(makeStep(d,current,previous,source,state.steps.length+1));
    }
    state.lastCommitted.set(key(d),normalized);updatePresence();
  }
  function onInteraction(e){
    if(!state.recording||state.paused||state.ignoreEvents)return;
    if(e.type==='click')captureLookupCreateInteraction(e);
    if(e.composedPath?.().some(n=>n===state.overlay||n?.id==='forcepilot-root'))return;
    const creation=state.lookupCreationCapture;
    const eventModal=creation?modalRootForNode(e.target):null;
    if(creation&&eventModal&&recordTypeChooserState(eventModal)){
      const selected=selectedRecordType(eventModal);
      if(selected?.label)creation.recordTypeLabel=selected.label;
      return;
    }
    const d=markTouched(e);if(!d)return;
    const capture=state.lookupCreationCapture;if(capture&&!capture.cancelled&&!sameFieldTarget(capture.lookupTarget,d)&&modalRootForDescriptor(d))capture.childKeys.add(key(d));
    const target=d.host||d.element;
    const userInitiated=!!e.isTrusted;
    if(e.type==='input'){
      clearTimeout(state.inputTimers.get(target));
      state.inputTimers.set(target,setTimeout(()=>{state.inputTimers.delete(target);commitDescriptor(d,'input',userInitiated)},300));return;
    }
    if(e.type==='change'||e.type==='blur'){
      if(d.kind==='multi-picklist'){
        const target=d.host||d.element;
        clearTimeout(state.inputTimers.get(target));
        state.inputTimers.set(target,setTimeout(()=>{state.inputTimers.delete(target);commitDescriptor(d,'selection-settled',userInitiated)},650));
      }else if(d.kind==='number' && ['','text','string','field','input','number'].includes(String(d?.sfDataType||'').toLowerCase())){
        const target=d.host||d.element;
        clearTimeout(state.inputTimers.get(target));
        state.inputTimers.set(target,setTimeout(async()=>{state.inputTimers.delete(target);const fresh=await refreshForCommit(d);commitDescriptor(fresh,e.type,userInitiated)},90));
      }else commitDescriptor(d,e.type,userInitiated);
    }
    if(e.type==='click'&&(d.kind==='picklist'||d.kind==='multi-picklist')){
      const target=d.host||d.element;
      const delay=d.kind==='multi-picklist'?650:220;
      clearTimeout(state.inputTimers.get(target));
      state.inputTimers.set(target,setTimeout(()=>{
        state.inputTimers.delete(target);
        commitDescriptor(d,d.kind==='multi-picklist'?'selection-settled':'selection',userInitiated);
      },delay));
    }
  }
  function reconcile(){if(!state.recording||state.paused||state.replaying||state.touchedDescriptors.size===0)return;const started=performance.now();for(const d of state.touchedDescriptors.values())commitDescriptor(d,'reconcile');const elapsed=performance.now()-started;if(elapsed>50)console.debug('[ForcePilot] reconcile took',Math.round(elapsed),'ms for',state.touchedDescriptors.size,'fields')}
  function installListeners(){
    if(state.observer)return;
    for(const type of ['input','change','blur','click','pointerup'])document.addEventListener(type,onInteraction,true);
    state.reconcileTimer=setInterval(reconcile,1200);
    let cacheInvalidationTimer=0;
    state.observer=new MutationObserver(()=>{
      if(cacheInvalidationTimer)return;
      cacheInvalidationTimer=setTimeout(()=>{cacheInvalidationTimer=0;if(state.recording)FP.invalidateFieldCaches();},80);
    });
    state.observer.observe(document.body||document.documentElement,{subtree:true,childList:true});
  }
  function removeListeners(){for(const type of ['input','change','blur','click','pointerup'])document.removeEventListener(type,onInteraction,true);if(state.reconcileTimer){clearInterval(state.reconcileTimer);state.reconcileTimer=0}state.observer?.disconnect();state.observer=null;for(const t of state.inputTimers.values())clearTimeout(t);state.inputTimers.clear()}

  function ssPageAction(target,action,value){
    if(!target)return Promise.resolve({ok:false,reason:'Target unavailable'});
    let targetId=target.getAttribute?.('data-forcepilot-target-id');if(!targetId){targetId=`forcepilot-${Math.random().toString(36).slice(2,14)}`;try{target.setAttribute('data-forcepilot-target-id',targetId)}catch{}}
    const requestId=`req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nonce=id();
    return new Promise(resolve=>{
      let done=false;const finish=r=>{if(done)return;done=true;window.removeEventListener('forcepilot-page-result',onResult);resolve(r||{ok:false})};
      const timer=setTimeout(()=>finish({ok:false,reason:'Page bridge timeout'}),1800);
      function onResult(e){if(e.detail?.requestId!==requestId)return;clearTimeout(timer);finish(e.detail?.result||{ok:false})}
      window.addEventListener('forcepilot-page-result',onResult);
      window.dispatchEvent(new CustomEvent('forcepilot-bridge-init',{detail:{version:BRIDGE_BUILD,requestId,nonce:nonce,id:targetId,action,expiresAt:Date.now()+2500}}));
      window.dispatchEvent(new CustomEvent('forcepilot-page-action',{detail:{id:targetId,action,value,requestId,nonce:nonce,version:BRIDGE_BUILD}}));
    });
  }

  function findComboInput(desc){for(const s of ['input[role="combobox"][data-value="lookup"]','input[role="combobox"].slds-combobox__input','input[role="combobox"]','input[aria-haspopup="listbox"]','input.slds-combobox__input','input.slds-input','input:not([type=hidden])']){const f=FP.deepQueryFirst(desc.host,s);if(f)return f}return desc.element?.matches?.('input')?desc.element:null}
  function findComboTrigger(desc){const selector='button[role="combobox"],input[role="combobox"],[role="combobox"],button[aria-haspopup="listbox"],input[aria-haspopup="listbox"],[aria-haspopup="listbox"]';if(desc.element?.matches?.(selector))return desc.element;if(desc.host?.matches?.(selector))return desc.host;return FP.deepQueryFirst(desc.host,selector)}
  function optionRoots(desc){
    const hostRoots=[desc.host,desc.element?.getRootNode?.()].filter(Boolean);
    const input=findComboInput(desc)||findComboTrigger(desc);
    const ids=[input?.getAttribute?.('aria-controls'),findComboTrigger(desc)?.getAttribute?.('aria-controls')].filter(Boolean);
    const controlledRoots=[];
    for(const id of ids){
      for(const root of FP.walkRoots()){try{const x=root.querySelector?.(`#${CSS.escape(id)}`);if(x)controlledRoots.push(x)}catch{}}
      try{const x=document.getElementById(id);if(x)controlledRoots.push(x)}catch{}
    }
    // aria-controls identifies this field's popover. When present, never scan the
    // surrounding shadow root: another open combobox must not donate its options.
    return[...new Set((controlledRoots.length?controlledRoots:hostRoots).filter(Boolean))];
  }
  function optionMeta(el){if(!el)return null;const value=String(el.getAttribute?.('data-value')||el.getAttribute?.('value')||el.value||'').trim();const display=FP.normalizeText(el.getAttribute?.('data-label')||el.getAttribute?.('label')||el.getAttribute?.('title')||el.textContent||'');return{el,value:value||display,displayValue:display||value}}
  function isVisible(el){try{const r=el.getBoundingClientRect?.(),cs=getComputedStyle(el);return !!r&&r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'}catch{return false}}
  function livePicklistOptions(desc){const out=[],seen=new Set();for(const root of optionRoots(desc)){FP.deepQueryAll(root,'[role="option"],lightning-base-combobox-item,.slds-listbox__option,.slds-listbox__item,.slds-dropdown__item,[data-option-index]',300).forEach(el=>{if(seen.has(el)||!isVisible(el))return;const m=optionMeta(el);if(!m||!m.value||!m.displayValue||FP.isPicklistPlaceholder(m.displayValue))return;seen.add(el);out.push(m)})}return out}
  function pickMatches(desc,wanted){const expected=typeof wanted==='object'&&wanted?wanted:{value:String(wanted??''),displayValue:''};const values=[expected.value,expected.displayValue].map(FP.normalizeLabel).filter(Boolean);if(!values.length)return false;const trigger=findComboTrigger(desc);const triggerValues=[trigger?.getAttribute?.('data-value'),trigger?.getAttribute?.('value')].map(FP.normalizeLabel).filter(Boolean);if(triggerValues.some(v=>values.includes(v)))return true;const triggerText=FP.normalizeLabel(trigger?.textContent||'');if(triggerText&&!FP.isPicklistPlaceholder(triggerText)&&values.includes(triggerText))return true;const sel=FP.deepQueryFirst(desc.host,'[role="option"][aria-selected="true"],lightning-base-combobox-item[aria-selected="true"]');const m=optionMeta(sel);if(m&&(values.includes(FP.normalizeLabel(m.value))||values.includes(FP.normalizeLabel(m.displayValue))))return true;const actual=FP.normalizeLabel(FP.readValue(desc));return!!actual&&!FP.isPicklistPlaceholder(actual)&&values.includes(actual)}
  async function openCombobox(desc){
    const trigger=findComboTrigger(desc)||desc.element||desc.host;
    if(!trigger)return false;
    const isOpen=()=>trigger.getAttribute?.('aria-expanded')==='true';
    const hasOptions=()=>livePicklistOptions(desc).length>0;
    // Never blindly click a combobox repeatedly: Lightning treats a second click as
    // close, which was especially flaky for dependent picklists that populate slowly.
    if(isOpen()||hasOptions())return true;
    try{trigger.focus?.({preventScroll:true})}catch{}
    try{trigger.click?.()}catch{}
    for(let i=0;i<6;i++){
      await wait(65);
      if(hasOptions()||isOpen())return true;
    }
    // Searchable controls may route activation through their inner input rather than
    // the outer field host. Try that path once only if the first click did not open it.
    const input=findComboInput(desc);
    if(input&&input!==trigger&&!isOpen()&&!hasOptions()){
      try{input.focus?.({preventScroll:true});input.click?.()}catch{}
      for(let i=0;i<5;i++){
        await wait(65);
        if(hasOptions()||isOpen())return true;
      }
    }
    return hasOptions()||isOpen();
  }

  async function fillPicklist(d,wanted){
    const expected=typeof wanted==='object'&&wanted?wanted:{value:String(wanted??''),displayValue:''};
    const wantedValue=String(expected.value||'').trim();
    const wantedLabel=String(expected.displayValue||expected.label||'').trim();
    const wantedNorms=[wantedValue,wantedLabel].map(FP.normalizeLabel).filter(Boolean);
    const el=d.element;
    if(el?.tagName==='SELECT'){
      const opt=[...el.options].find(o=>wantedNorms.includes(FP.normalizeLabel(o.value))||wantedNorms.includes(FP.normalizeLabel(o.textContent)));
      if(!opt)return{ok:false,reason:'Recorded picklist value is not available'};
      el.value=opt.value;
      el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      return{ok:true,selected:opt.textContent.trim()};
    }
    const hostTarget=d.host?.tagName?.toLowerCase()==='lightning-input-field'?(FP.deepQueryFirst(d.host,'lightning-combobox,lightning-base-combobox:not([data-lookup])')||d.host):d.element?.tagName?.toLowerCase()==='lightning-combobox'?d.element:d.host;
    if(await openCombobox(d)){
      const options=livePicklistOptions(d);
      const hit=options.find(o=>wantedNorms.includes(FP.normalizeLabel(o.value))||wantedNorms.includes(FP.normalizeLabel(o.displayValue)));
      if(hit){
        try{hit.el.click?.()}catch{}
        await wait(120);
        if(pickMatches(d,{value:hit.value,displayValue:hit.displayValue}))return{ok:true,selected:hit.displayValue||hit.value};
        const bridge=await ssPageAction(hostTarget,'set-pick',hit.value||hit.displayValue);
        if(bridge?.ok&&pickMatches(d,{value:hit.value,displayValue:hit.displayValue}))return{ok:true,selected:hit.displayValue||hit.value};
      }
      const bridgeValue=wantedValue||wantedLabel;
      if(bridgeValue){
        const bridge=await ssPageAction(hostTarget,'set-pick',bridgeValue);
        if(bridge?.ok&&pickMatches(d,expected))return{ok:true,selected:wantedLabel||wantedValue};
      }
      const input=findComboInput(d);
      if(input){
        try{
          const proto=Object.getPrototypeOf(input),valueDesc=Object.getOwnPropertyDescriptor(proto,'value');
          valueDesc?.set?valueDesc.set.call(input,wantedLabel||wantedValue):input.value=wantedLabel||wantedValue;
          input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
        }catch{}
        await wait(120);
        const f=livePicklistOptions(d).find(o=>wantedNorms.includes(FP.normalizeLabel(o.value))||wantedNorms.includes(FP.normalizeLabel(o.displayValue)));
        if(f){try{f.el.click?.()}catch{}await wait(120);if(pickMatches(d,expected))return{ok:true,selected:f.displayValue||f.value}}
      }
    }
    return pickMatches(d,expected)?{ok:true,selected:wantedLabel||wantedValue}:{ok:false,reason:'Picklist value could not be selected'};
  }

  function multiListBuckets(dual){
    const empty={source:[],selected:[],sourceList:null,selectedList:null};
    if(!dual)return empty;
    const raw=[],seen=new Set();
    const add=list=>{
      if(!list||seen.has(list)||!list.querySelectorAll)return;
      const opts=FP.deepQueryAll(list,'[role=\"option\"],option,[data-value]',220);
      if(!opts.length)return;
      if(raw.some(x=>{try{return x.contains?.(list)}catch{return false}}))return;
      for(let i=raw.length-1;i>=0;i--){try{if(list.contains?.(raw[i]))raw.splice(i,1)}catch{}}
      seen.add(list);raw.push(list);
    };
    FP.deepQueryAll(dual,'[data-source-list],[data-selected-list],[role=\"listbox\"],.slds-dueling-list__options,[aria-multiselectable=\"true\"]',140).forEach(add);
    if(raw.length<2)FP.deepQueryAll(dual,'ul.slds-listbox,ul.slds-listbox_vertical',140).forEach(add);
    const classify=list=>{
      const hints=[];
      for(const n of [list,list.parentElement,list.parentElement?.parentElement].filter(Boolean)){
        for(const a of ['aria-label','title','data-label','data-testid','name']){const v=n.getAttribute?.(a);if(v)hints.push(v)}
      }
      try{list.parentElement?.querySelectorAll?.('label,.slds-dueling-list__label,.slds-form-element__label,.slds-listbox__label,[class*=label]')?.forEach(x=>{const t=FP.normalizeText(x.textContent);if(t&&t.length<120)hints.push(t)})}catch{}
      const text=hints.join(' ').replace(/\s+/g,' ').trim().toLowerCase();
      let role='';if(/\b(selected|chosen|current)\b/.test(text))role='selected';else if(/\b(available|source)\b/.test(text))role='source';
      let rect={left:0,top:0};try{const r=list.getBoundingClientRect?.();if(r)rect={left:r.left||0,top:r.top||0}}catch{}
      const options=FP.deepQueryAll(list,'[role=\"option\"],option,[data-value]',220).map(el=>{
        const value=String(el.getAttribute?.('data-value')||el.getAttribute?.('value')||el.value||'').trim();
        const display=FP.normalizeText(el.getAttribute?.('data-label')||el.getAttribute?.('label')||el.getAttribute?.('title')||el.textContent||'');
        if((FP.isMultiPicklistPlaceholder?.(display)) || (FP.isMultiPicklistPlaceholder?.(value)))return null;
        return value||display?{el,value:value||display,displayValue:display||value}:null;
      }).filter(Boolean);
      return{list,role,text,rect,options};
    };
    const items=raw.map(classify);
    if(!items.length)return empty;
    const attrSource=items.find(x=>x.list?.hasAttribute?.('data-source-list'))||null;
    const attrSelected=items.find(x=>x.list?.hasAttribute?.('data-selected-list'))||null;
    const ordered=[...items].sort((a,b)=>a.rect.left-b.rect.left);
    let source=attrSource||items.find(x=>x.role==='source')||null;
    let selected=attrSelected||items.find(x=>x.role==='selected'&&x!==source)||null;
    // When every option is selected Salesforce may render only the Selected list.
    // Do not invent an Available list from the same element; verification can use the
    // selected list and the component's public value instead.
    if(!source&&!selected&&items.length===1){
      const only=items[0];
      const marked=only.options.filter(o=>o.el?.getAttribute?.('aria-selected')==='true'||o.el?.getAttribute?.('data-selected')==='true').length; if(only.role==='selected'||marked>0||/\b(selected|chosen|current)\b/.test(only.text)) selected=only;
      else source=only;
    }
    if(!source&&!selected&&items.length>1){source=ordered[0];selected=ordered[1]||null}
    if(source&&selected&&source.rect.left>selected.rect.left){const t=source;source=selected;selected=t}
    const unique=arr=>arr.filter((x,i,a)=>i===a.findIndex(y=>FP.normalizeLabel(y.value)===FP.normalizeLabel(x.value)));
    return{source:unique(source?.options||[]),selected:unique(selected?.options||[]),sourceList:source?.list||null,selectedList:selected?.list||null};
  }
  function multiEvidence(desc){
    const dual=multiHosts(desc).find(x=>String(x?.tagName||'').toLowerCase()==='lightning-dual-listbox');
    if(dual){
      // Verification should use the Lightning component's public value first.
      // The rendered Selected list can be incomplete when every value is selected.
      try{
        const v=dual.value;
        if(Array.isArray(v)&&v.length)return v.filter(x=>!FP.isMultiPicklistPlaceholder?.(x)).map(x=>({value:String(x),label:String(x)}));
        if(typeof v==='string'&&v.trim()){
          const vals=FP.parseMultiValues(v).filter(x=>!FP.isMultiPicklistPlaceholder?.(x));
          if(vals.length)return vals.map(x=>({value:x,label:x}));
        }
      }catch{}
      const b=multiListBuckets(dual);
      if(b.selectedList||b.selected.length)return b.selected.map(o=>({value:o.value,label:o.displayValue||o.value}));
      const marked=FP.deepQueryAll(dual,'[aria-selected="true"][data-value],[data-selected="true"][data-value],option:checked',250).map(el=>({value:String(el.getAttribute?.('data-value')||el.value||el.textContent||'').trim(),label:FP.normalizeText(el.textContent||'')})).filter(x=>x.value&&!FP.isMultiPicklistPlaceholder?.(x.value)&&!FP.isMultiPicklistPlaceholder?.(x.label));
      return marked;
    }
    const el=multiHosts(desc).find(x=>x?.tagName?.toLowerCase()==='select'&&x.multiple);
    if(el)return[...el.selectedOptions].map(o=>{const label=FP.normalizeText(o.textContent||o.label||o.value);return{value:label||String(o.value||'').trim(),label:label||String(o.value||'').trim()}}).filter(x=>!FP.isMultiPicklistPlaceholder?.(x.value)&&!FP.isMultiPicklistPlaceholder?.(x.label));
    return[];
  }
  function multiPicklistMatches(desc,value){
    const rawWanted=[...new Set((Array.isArray(value)?value:FP.parseMultiValues(value)).map(FP.normalizeText).filter(v=>v&&!FP.isMultiPicklistPlaceholder?.(v)))];
    const native=multiHosts(desc).find(x=>x?.tagName?.toLowerCase()==='select'&&x.multiple);
    // Native Classic/Setup selects may submit option IDs while showing labels. Verify
    // those controls by their current visible labels, resolving either recorded ID or
    // label to the same option before comparing. Lightning's public values stay intact.
    const wanted=native?rawWanted.map(v=>{const opt=[...native.options].find(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(v)||FP.normalizeLabel(o.textContent)===FP.normalizeLabel(v));return FP.normalizeLabel(opt?.textContent||opt?.label||v)}):rawWanted.map(FP.normalizeLabel);
    const evidence=[...new Set(multiEvidence(desc).map(x=>FP.normalizeLabel(x.value||x.label)).filter(v=>v&&!FP.isMultiPicklistPlaceholder?.(v)))];
    return sameSet(evidence,wanted);
  }
  function multiHosts(desc){
    const host=desc?.host;
    return[host,FP.deepQueryFirst(host,'lightning-dual-listbox'),FP.deepQueryFirst(host,'select[multiple]'),FP.deepQueryFirst(host,'[aria-multiselectable="true"]')].filter((x,i,a)=>x&&a.indexOf(x)===i);
  }
  function classicMultiSelectParts(el){
    try{
      if(String(el?.tagName||'').toLowerCase()!=='select'||!el.multiple||!el.id||/(?:_unselected|_selected)$/.test(el.id))return null;
      const doc=el.ownerDocument||document,id=String(el.id),available=doc.getElementById(`${id}_unselected`),selected=doc.getElementById(`${id}_selected`);
      const isHelper=x=>String(x?.tagName||'').toLowerCase()==='select'&&x.multiple&&/MultiSelectPicklist\.handleMSP(?:Select|UnSelect)/.test(String(x.getAttribute?.('ondblclick')||''));
      return isHelper(available)&&isHelper(selected)?{base:el,available,selected,id}:null;
    }catch{return null}
  }
  function sameSet(a,b){
    const aa=[...new Set((a||[]).map(FP.normalizeLabel).filter(Boolean))].sort();
    const bb=[...new Set((b||[]).map(FP.normalizeLabel).filter(Boolean))].sort();
    return aa.length===bb.length&&aa.every((v,i)=>v===bb[i]);
  }
  function clickMoveButton(dual,right){
    const re=right
      ? /move\s+selection\s+to\s+(?:selected|chosen)|move.*to\s+(?:selected|chosen)/i
      : /move\s+selection\s+to\s+(?:source|available)|move.*to\s+(?:source|available)/i;
    const buttons=FP.deepQueryAll(dual,'button,[role="button"],lightning-button-icon,lightning-button',240);
    const b=buttons.find(x=>!FP.isDisabled(dual,x)&&re.test([
      x.getAttribute?.('aria-label'),x.getAttribute?.('title'),x.getAttribute?.('name'),
      x.getAttribute?.('data-label'),x.textContent
    ].filter(Boolean).join(' ')));
    if(!b)return false;
    try{b.click?.()}catch{}
    return true;
  }
  async function selectDualOption(item,multi=false){
    if(!item?.el)return false;
    const isSelected=()=>item.el.getAttribute?.('aria-selected')==='true'||item.el.getAttribute?.('data-selected')==='true';
    if(isSelected())return true;
    try{item.el.focus?.({preventScroll:true})}catch{}
    try{
      const init={bubbles:true,composed:true,button:0,buttons:1,view:window,cancelable:true};
      if(typeof PointerEvent==='function'){
        item.el.dispatchEvent(new PointerEvent('pointerdown',{...init,pointerId:1,pointerType:'mouse',isPrimary:true}));
        item.el.dispatchEvent(new PointerEvent('pointerup',{...init,pointerId:1,pointerType:'mouse',isPrimary:true,buttons:0}));
      }
      item.el.dispatchEvent(new MouseEvent('mousedown',init));
      item.el.dispatchEvent(new MouseEvent('mouseup',{...init,buttons:0}));
    }catch{}
    try{item.el.click?.()}catch{}
    await wait(90);
    if(isSelected())return true;
    try{
      const mac=/Mac|iPhone|iPad/i.test(String(navigator.platform||navigator.userAgent||''));
      const init={key:' ',code:'Space',bubbles:true,composed:true};init[mac?'metaKey':'ctrlKey']=true;
      item.el.dispatchEvent(new KeyboardEvent('keydown',init));item.el.dispatchEvent(new KeyboardEvent('keyup',init));
    }catch{}
    await wait(90);
    return isSelected();
  }
  async function fillNativeMultiSelect(desc,values){
    const el=desc.element;if(!el?.options||!el.multiple)return false;
    const requested=[...new Set(values.map(FP.normalizeLabel).filter(Boolean))];
    const resolved=requested.map(v=>[...el.options].find(o=>FP.normalizeLabel(o.value)===v||FP.normalizeLabel(o.textContent||o.label)===v)).filter(Boolean);
    if(resolved.length!==requested.length)return false;
    const selected=new Set(resolved);
    for(const option of [...el.options])option.selected=selected.has(option);
    el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    await wait(120);
    const actual=[...el.selectedOptions].map(o=>FP.normalizeLabel(o.textContent||o.label||o.value));
    const expected=resolved.map(o=>FP.normalizeLabel(o.textContent||o.label||o.value));
    return sameSet(actual,expected);
  }
  async function trySetPublicMultiValue(target,values){
    if(!target||!('value' in target))return false;
    for(const candidate of [values,[...values].join('; '),[...values].join(';')]){
      try{
        target.value=candidate;
        target.dispatchEvent(new CustomEvent('change',{bubbles:true,composed:true,detail:{value:candidate}}));
        target.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
        await wait(120);
        if(sameSet(multiEvidence({host:target,element:target}),values))return true;
      }catch{}
    }
    return false;
  }
  async function fillMultiPicklist(desc,value){
    const requested=[...new Set((Array.isArray(value)?value:FP.parseMultiValues(value)).map(FP.normalizeText).filter(Boolean))];
    if(!requested.length)return{ok:false,reason:'No recorded multi-select values'};
    const native=multiHosts(desc).find(x=>x?.tagName?.toLowerCase()==='select'&&x.multiple);
    if(native){
      // Salesforce Classic multi-picklists submit through a hidden base <select>, but
      // display separate Available/Chosen lists. Use Salesforce's own mover so the UI,
      // hidden submitted values, and validation stay in sync. Do not silently change
      // only the hidden select if the Classic handler is unavailable.
      if(classicMultiSelectParts(native)){
        const bridge=await ssPageAction(native,'set-multi',requested);
        for(let i=0;i<10;i++){
          if(multiPicklistMatches({...desc,element:native},requested))return{ok:true,selected:requested.join('; '),mode:'classic-multiselect'};
          await wait(65);
        }
        return{ok:false,reason:bridge?.reason||'Salesforce Classic multi-select did not confirm the requested values'};
      }
      const ok=await fillNativeMultiSelect({...desc,element:native},requested);
      return ok?{ok:true,selected:requested.join('; ')}:{ok:false,reason:'Recorded multi-select values are not available'};
    }
    const dual=multiHosts(desc).find(x=>String(x?.tagName||'').toLowerCase()==='lightning-dual-listbox');
    if(!dual)return{ok:false,reason:'Multi-select control not found'};

    const wantedNorm=new Set(requested.map(FP.normalizeLabel));
    const current=multiListBuckets(dual);
    const catalog=[...current.source,...current.selected];
    const resolved=requested.map(v=>catalog.find(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(v)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(v))).filter(Boolean);
    if(resolved.length!==requested.length){
      // Metadata/live options may be available even when one side is virtualized.
      const metadata=await FP.loadSalesforceMetadata?.(desc.objectApiName||detectContext().objectApiName,desc.objectApiName===detectContext().objectApiName?detectContext().recordId:'');
      const d2=FP.describeField?.(desc.host);
      const metaOptions=d2?.options||[];
      for(const v of requested){
        if(resolved.some(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(v)))continue;
        const m=metaOptions.find(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(v)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(v));
        if(m)resolved.push({...m,el:null});
      }
    }
    if(resolved.length!==requested.length){
      const missing=requested.filter(v=>!resolved.some(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(v)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(v)));
      return{ok:false,reason:`Recorded multi-select value not available: ${missing.join(', ')}`};
    }

    // Bridge first: it knows the Lightning component in the page world.
    const bridged=await ssPageAction(dual,'set-multi',resolved.map(x=>x.value));
    if(bridged?.ok){
      for(let i=0;i<12;i++){if(multiPicklistMatches(desc,requested))return{ok:true,selected:requested.join('; ')};await wait(70)}
      // Salesforce can visually apply the selection while its public value/evidence
      // remains stale. Do not report a false failure when the page bridge accepted it.
      return{ok:true,selected:requested.join('; '),verificationSoft:true};
    }

    // DOM path: first remove selections not requested, then move requested values.
    let movedRequested=0;
    for(let attempt=0;attempt<3;attempt++){
      let buckets=multiListBuckets(dual);
      const extras=buckets.selected.filter(o=>!wantedNorm.has(FP.normalizeLabel(o.value))&&!wantedNorm.has(FP.normalizeLabel(o.displayValue)));
      for(const extra of extras){
        const fresh=multiListBuckets(dual).selected.find(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(extra.value)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(extra.displayValue));
        if(fresh&&await selectDualOption(fresh,false)){clickMoveButton(dual,false);await wait(180)}
      }

      for(const wanted of resolved){
        buckets=multiListBuckets(dual);
        const already=buckets.selected.some(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(wanted.value)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(wanted.displayValue)||FP.normalizeLabel(o.value)===FP.normalizeLabel(wanted.displayValue)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(wanted.value));
        if(already)continue;
        const fresh=buckets.source.find(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(wanted.value)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(wanted.displayValue)||FP.normalizeLabel(o.value)===FP.normalizeLabel(wanted.displayValue)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(wanted.value));
        if(!fresh)return{ok:false,reason:`Recorded multi-select value not available: ${wanted.displayValue||wanted.value}`};
        if(!await selectDualOption(fresh,false))return{ok:false,reason:`Could not select ${wanted.displayValue||wanted.value}`};
        let moved=false;
        for(let n=0;n<10;n++){
          await wait(55);
          if(clickMoveButton(dual,true)){moved=true;break}
        }
        if(!moved)return{ok:false,reason:'Could not move value to Selected'};
        movedRequested++;
        for(let n=0;n<8;n++){
          await wait(60);
          const latest=multiListBuckets(dual);
          const selected=latest.selected.some(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(wanted.value)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(wanted.displayValue));
          const available=latest.source.some(o=>FP.normalizeLabel(o.value)===FP.normalizeLabel(wanted.value)||FP.normalizeLabel(o.displayValue)===FP.normalizeLabel(wanted.displayValue));
          if(selected&&!available)break;
        }
      }
      if(multiPicklistMatches(desc,requested))return{ok:true,selected:requested.join('; ')};
    }
    const finalBridge=await ssPageAction(dual,'set-multi',resolved.map(x=>x.value));
    if(finalBridge?.ok){
      for(let i=0;i<15;i++){if(multiPicklistMatches(desc,requested))return{ok:true,selected:requested.join('; ')};await wait(80)}
      return{ok:true,selected:requested.join('; '),verificationSoft:true};
    }
    if(movedRequested===resolved.length)return{ok:true,selected:requested.join('; '),verificationSoft:true};
    return{ok:false,reason:'Salesforce did not confirm the selected multi-select values'};
  }

  function setNative(el,value){if(!el)return false;try{const proto=Object.getPrototypeOf(el),desc=Object.getOwnPropertyDescriptor(proto,'value');desc?.set?desc.set.call(el,value):el.value=value}catch{return false}el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return true}
  function lookupOptionRecordId(el){
    if(!el)return '';
    const direct=FP.readLookupId?.(el,el)||'';
    if(direct)return direct;
    try{
      const nested=el.querySelector?.('[data-record-id],[data-recordid],[data-id],a[href*="/lightning/r/"]');
      const id=FP.readLookupId?.(nested,nested)||'';
      if(id)return id;
      const href=nested?.getAttribute?.('href')||el.getAttribute?.('href')||'';
      const m=String(href).match(/\/(?:lightning\/r\/)?[^/]+\/([A-Za-z0-9]{15,18})(?:\/|$)/i);
      return m?.[1]||'';
    }catch{return ''}
  }
  function exactLookupText(v){return FP.normalizeText(v||'').replace(/\s+/g,' ').trim().toLowerCase()}
  function lookupRecordId(el){if(!el)return'';for(const a of ['data-record-id','data-recordid','data-record-id-value','data-id','record-id','data-lookup-id','data-selection-id','data-value','value']){try{const v=el.getAttribute?.(a);if(v&&/^[A-Za-z0-9]{15,18}$/.test(String(v).trim()))return String(v).trim()}catch{}}const fromShared=FP.readLookupId?.(el,el)||'';if(fromShared)return fromShared;try{const href=el.getAttribute?.('href')||el.querySelector?.('a[href*="/lightning/r/"]')?.getAttribute?.('href')||'';const m=String(href).match(/\/lightning\/r\/[^/]+\/([A-Za-z0-9]{15,18})(?:\/|$)/i);return m?.[1]||''}catch{return''}}
  function lookupSelectionEvidence(d,expectedId,expectedLabel){const actual=FP.readValue(d),actualId=String(actual?.recordId||'');if(expectedId&&actualId===String(expectedId))return true;if(expectedId&&actualId&&actualId!==String(expectedId))return false;const trigger=findComboTrigger(d),input=findComboInput(d),expanded=trigger?.getAttribute?.('aria-expanded')==='true';const expected=exactLookupText(expectedLabel);if(!expected||expanded)return false;const hasPill=!!(input?.readOnly||input?.getAttribute?.('aria-readonly')==='true'||FP.deepQueryFirst(d?.host,'[data-input-pill],lightning-pill,[data-selection-index],[data-selected-record]'));if(!hasPill)return false;const candidates=[actual?.displayValue,d?.element?.value,input?.value,input?.getAttribute?.('data-value'),trigger?.getAttribute?.('data-value'),trigger?.textContent].map(exactLookupText).filter(Boolean);return candidates.some(label=>label===expected)}
  function canonicalLookupOption(el){
    if(!el)return null;
    let node=el,option=null,base=null;
    for(let depth=0;node&&depth<12;depth++){
      const tag=String(node.tagName||'').toLowerCase();
      if(tag==='lightning-base-combobox-item')base=node;
      if(!option&&(node.getAttribute?.('role')==='option'||node.matches?.('.slds-listbox__option,.slds-listbox__item,[data-option-index]')))option=node;
      if(tag==='lightning-base-combobox-item')break;
      let parent=node.parentElement;
      if(!parent){try{parent=node.getRootNode?.()?.host||null}catch{parent=null}}
      node=parent;
    }
    return base||option||el;
  }
  function lookupOptionLabel(node){
    if(!node)return'';
    // Salesforce's current Lightning lookup renders the actual record name in a
    // lightning-base-combobox-formatted-text[title] node. The surrounding option
    // also contains icon assistive text and secondary metadata (e.g. username),
    // so using the whole option's textContent prevents exact label matching.
    const selectors=[
      'lightning-base-combobox-formatted-text[title]',
      '.slds-listbox__option-text_entity [title]',
      '.slds-listbox__option-text_entity',
      '[data-label]',
      '.slds-truncate[title]',
      '.slds-truncate'
    ];
    for(const selector of selectors){
      try{
        const el=node.querySelector?.(selector);if(!el)continue;
        const value=el.getAttribute?.('title')||el.getAttribute?.('data-label')||el.textContent||'';
        const label=exactLookupText(value);
        if(label)return label;
      }catch{}
    }
    return exactLookupText(node.getAttribute?.('data-label')||node.getAttribute?.('label')||node.getAttribute?.('title')||node.getAttribute?.('aria-label')||node.textContent||'');
  }
  function lookupControlledDropdown(desc,input=findComboInput(desc)){
    const ids=[input?.getAttribute?.('aria-controls'),findComboTrigger(desc)?.getAttribute?.('aria-controls')].filter(Boolean);
    for(const id of ids){
      const selector=`#${CSS.escape(String(id))}`;
      for(const root of FP.walkRoots()){
        try{
          if(root?.id===id)return root;
          const found=root.querySelector?.(selector);if(found)return found;
        }catch{}
      }
    }
    return null;
  }
  function lookupOptions(desc){
    const raw=[],seenNodes=new Set(),input=findComboInput(desc);
    // Salesforce exposes the active popup through aria-controls. Treat it as the
    // authoritative list: scanning the page/document mixes other open lookups and
    // makes a single exact result appear ambiguous.
    const controlled=lookupControlledDropdown(desc,input);
    const roots=controlled?[controlled]:[desc?.host].filter(Boolean);
    const add=el=>{
      if(!el||!isVisible(el))return;
      const node=canonicalLookupOption(el);if(!node||seenNodes.has(node)||!isVisible(node))return;
      if(node.getAttribute?.('role')==='presentation')return;
      const tag=String(node.tagName||'').toLowerCase();
      if(tag!=='lightning-base-combobox-item'&&node.getAttribute?.('role')!=='option'&&!node.matches?.('.slds-listbox__option[aria-selected],.slds-listbox__option[data-value]'))return;
      const label=lookupOptionLabel(node);
      const value=String(node.getAttribute?.('data-value')||'');
      // Ignore group headings and Lightning action rows; only real record options
      // belong in the candidate list.
      if(!label||/^(search results|recent records|assigned|available)$/i.test(label)||/^action(?:advancedsearch|createnew)$/i.test(value)||/^(show all results|show more results(?: for .*)?|create new|new property|recent records|search all)$/i.test(label))return;
      seenNodes.add(node);raw.push({el:node,label,id:lookupRecordId(node)});
    };
    for(const root of roots)FP.deepQueryAll(root,'[role="option"],lightning-base-combobox-item[data-value],.slds-listbox__option[aria-selected],.slds-listbox__option[data-value]',300).forEach(add);
    // Collapse duplicate DOM representations by label/record identity. When one
    // label has one real record ID plus ID-less wrapper copies, retain the identified
    // option. Keep separate IDs for genuinely distinct same-name records.
    const byLabel=new Map();
    for(const item of raw){const key=exactLookupText(item.label);if(!byLabel.has(key))byLabel.set(key,[]);byLabel.get(key).push(item)}
    const logical=[];
    for(const items of byLabel.values()){
      const byId=new Map();for(const item of items)if(item.id&&!byId.has(item.id))byId.set(item.id,item);
      if(byId.size){for(const item of byId.values())logical.push(item);}
      else if(items.length)logical.push(items[0]);
    }
    return logical;
  }
  function lookupClickCandidates(el){
    const out=[];const add=x=>{if(x&&!out.includes(x))out.push(x)};
    // Try the Salesforce option host first, then its actual interactive descendants.
    // Lightning versions differ on whether the delegated listener is attached to the
    // host or to the option content rendered inside it.
    try{add(el?.closest?.('lightning-base-combobox-item'))}catch{}
    try{add(el?.closest?.('[role="option"]'))}catch{}
    try{add(el?.closest?.('.slds-listbox__option,.slds-listbox__item'))}catch{}
    add(el);
    try{el?.querySelectorAll?.('[role="option"],.slds-listbox__option,.slds-listbox__option-text_entity,lightning-base-combobox-formatted-text,button,a,.slds-truncate').forEach(add)}catch{}
    return out.filter(isVisible).slice(0,8);
  }
  function lookupClearButton(desc){return FP.deepQueryFirst(desc?.host,'button[data-clear-selection-button],button[title^="Clear "],button[aria-label^="Clear "]')||FP.deepQueryFirst(desc?.element,'button[data-clear-selection-button],button[title^="Clear "],button[aria-label^="Clear "]')}
  async function clearLookupSelection(desc){
    let input=findComboInput(desc);
    const clear=lookupClearButton(desc);
    const selected=!!(input?.readOnly||input?.getAttribute?.('aria-readonly')==='true'||clear||FP.deepQueryFirst(desc?.host,'[data-input-pill]'));
    if(!selected)return{desc,input};
    if(clear){try{clear.click?.()}catch{}await wait(90)}
    for(let i=0;i<8;i++){
      const fresh=FP.refreshFieldDescriptor?.(desc.host)||desc;
      const candidates=FP.deepQueryAll(fresh.host,'input[role="combobox"],input.slds-combobox__input',40).filter(isVisible);
      input=candidates.find(x=>!x.readOnly&&x.getAttribute?.('aria-readonly')!=='true'&&x.getAttribute?.('aria-disabled')!=='true')||findComboInput(fresh);
      if(input&&!input.readOnly&&input.getAttribute?.('aria-readonly')!=='true')return{desc:fresh,input};
      await wait(70);
    }
    return{desc:FP.refreshFieldDescriptor?.(desc.host)||desc,input};
  }
  async function typeLookupSearchInputFast(input,text){
    if(!input||input.readOnly||input.getAttribute?.('aria-readonly')==='true'||input.getAttribute?.('aria-disabled')==='true')return false;
    const value=String(text||'');try{input.focus?.({preventScroll:true});input.click?.()}catch{}
    const proto=Object.getPrototypeOf(input),desc=Object.getOwnPropertyDescriptor(proto,'value');
    const setValue=v=>{try{desc?.set?desc.set.call(input,v):input.value=v;return true}catch{return false}};
    if(!setValue(''))return false;
    try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}))}catch{try{input.dispatchEvent(new Event('input',{bubbles:true,composed:true}))}catch{}}
    if(!setValue(value))return false;
    try{input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,composed:true,inputType:'insertText',data:value}))}catch{}
    try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:value}))}catch{try{input.dispatchEvent(new Event('input',{bubbles:true,composed:true}))}catch{}}
    try{input.dispatchEvent(new Event('change',{bubbles:true,composed:true}))}catch{}
    return true;
  }
  async function typeLookupSearchInput(input,text){
    if(!input||input.readOnly||input.getAttribute?.('aria-readonly')==='true'||input.getAttribute?.('aria-disabled')==='true')return false;
    const value=String(text||'');try{input.focus?.({preventScroll:true});input.click?.()}catch{}
    const proto=Object.getPrototypeOf(input),desc=Object.getOwnPropertyDescriptor(proto,'value'),setValue=v=>{try{desc?.set?desc.set.call(input,v):input.value=v;return true}catch{return false}};
    const dispatch=(type,key,mods={})=>{try{input.dispatchEvent(new KeyboardEvent(type,{key,code:key.length===1?'Key'+key.toUpperCase():key,bubbles:true,composed:true,ctrlKey:!!mods.ctrl,metaKey:!!mods.meta,cancelable:true}))}catch{}};
    dispatch('keydown','Control',{ctrl:true});dispatch('keydown','a',{ctrl:true});dispatch('keyup','a',{ctrl:true});dispatch('keyup','Control',{ctrl:true});setValue('');
    try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}))}catch{}
    for(const ch of value){dispatch('keydown',ch);setValue(String(input.value||'')+ch);try{input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,composed:true,inputType:'insertText',data:ch}))}catch{}try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:ch}))}catch{try{input.dispatchEvent(new Event('input',{bubbles:true,composed:true}))}catch{}}dispatch('keyup',ch);await wait(5)}
    try{input.dispatchEvent(new Event('change',{bubbles:true,composed:true}))}catch{}return true;
  }
  async function activateLookupOption(d,hit,input){
    if(!hit?.el)return false;
    for(const candidate of lookupClickCandidates(hit.el)){
      // The dropdown can be positioned far above/below the viewport in Lightning
      // record forms. Scroll the option into its scroll container before activation.
      try{candidate.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}
      try{candidate.focus?.({preventScroll:true})}catch{}
      try{candidate.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1,view:window}))}catch{}
      try{candidate.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,composed:true,cancelable:true,button:0,buttons:1,view:window}))}catch{}
      try{candidate.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,composed:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:0,view:window}))}catch{}
      try{candidate.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,composed:true,cancelable:true,button:0,buttons:0,view:window}))}catch{}
      try{candidate.click?.()}catch{}
      await wait(110);const fresh=FP.refreshFieldDescriptor?.(d.host)||d;
      if(lookupSelectionEvidence(fresh,hit.id,hit.label))return true;
    }
    // The native keyboard route is a fallback for Salesforce components that ignore
    // synthetic clicks but keep keyboard selection enabled.
    try{
      const fresh=FP.refreshFieldDescriptor?.(d.host)||d;const nextInput=findComboInput(fresh)||input;nextInput?.focus?.({preventScroll:true});
      nextInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',code:'Home',bubbles:true,composed:true,cancelable:true}));
      nextInput.dispatchEvent(new KeyboardEvent('keyup',{key:'Home',code:'Home',bubbles:true,composed:true,cancelable:true}));
      nextInput.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true,cancelable:true}));
      nextInput.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true,cancelable:true}));
      nextInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,composed:true,cancelable:true}));
      nextInput.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,composed:true,cancelable:true}));
      await wait(140);const verified=FP.refreshFieldDescriptor?.(d.host)||d;return lookupSelectionEvidence(verified,hit.id,hit.label);
    }catch{return false}
  }
  async function fillClassicLookup(d,wanted){
    const parts=FP.classicLookupParts?.(d.host,d.element);
    if(!parts?.input||!parts?.idInput)return null;
    const label=FP.normalizeText(wanted?.displayValue||wanted?.label||wanted?.name||'');
    const expectedId=String(wanted?.recordId||'').trim();
    const validId=v=>/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(String(v||''))&&!/^0+$/.test(String(v||''));
    const input=parts.input,idField=parts.idInput,oldField=parts.oldInput,modified=parts.modifiedInput;
    const currentId=String(idField.value||'').trim(),currentLabel=FP.normalizeText(input.value||'');
    if(currentLabel===label&&validId(currentId)&&(!validId(expectedId)||currentId===expectedId))return{ok:true,selected:label||currentLabel,selectedRecordId:currentId,mode:'classic-lookup-already-selected'};
    // Classic's server form submits the reference ID from *_lkid, while the visible
    // text input's onchange handler intentionally clears that hidden ID. Dispatch the
    // standard input/change events first, then restore the validated recorded ID last.
    // This branch only runs when the complete Classic lookup sibling signature exists;
    // Lightning lookup behavior continues through the unchanged Lightning path below.
    if(!validId(expectedId)){
      if(label&&currentLabel===label&&validId(currentId))return{ok:true,selected:currentLabel,selectedRecordId:currentId,mode:'classic-lookup-preserved-current'};
      return{ok:false,reason:'This Classic lookup recording has no valid Salesforce record ID. Re-record it after selecting a lookup result.'};
    }
    if(!label)return{ok:false,reason:'The recorded Classic lookup is missing its display label.'};
    if(!setNative(input,label))return{ok:false,reason:'Classic lookup text input could not be updated'};
    try{input.dispatchEvent(new Event('blur',{bubbles:true,composed:true}));}catch{}
    // Salesforce Classic can synchronously clear _lkid on change/blur, so write the
    // target identity after native events and never dispatch another input change.
    try{idField.value=expectedId;if(oldField)oldField.value=label;if(modified)modified.value='1';}catch{return{ok:false,reason:'Classic lookup reference fields could not be updated'};}
    await wait(45);
    const confirmedId=String(idField.value||'').trim(),confirmedLabel=FP.normalizeText(input.value||'');
    if(confirmedId===expectedId&&confirmedLabel===label)return{ok:true,selected:label,selectedRecordId:confirmedId,mode:'classic-lookup-record-id'};
    return{ok:false,reason:'Salesforce Classic did not retain the lookup record ID after updating the field.'};
  }

  function lookupCreateNewOption(desc){
    const input=findComboInput(desc),dropdown=lookupControlledDropdown(desc,input);
    if(!dropdown)return null;
    const candidates=FP.deepQueryAll(dropdown,'lightning-base-combobox-item,[role="option"],.slds-listbox__option[data-value],.slds-listbox__item[data-value]',160);
    const seen=new Set();
    for(const raw of candidates){
      const node=canonicalLookupOption(raw);if(!node||seen.has(node)||!isVisible(node))continue;seen.add(node);
      const value=String(node.getAttribute?.('data-value')||'');const label=lookupCreateActionLabel(node);
      if(/^actionCreateNew$/i.test(value)||/^new\s+.+/i.test(label)||/^create new(?:\s+.+)?$/i.test(label))return{el:node,label:FP.normalizeText(label||node.textContent||'New record'),value};
    }
    return null;
  }
  async function waitForNewLookupModal(previousRoots,timeout=4200){
    const previous=new Set(previousRoots||[]),deadline=Date.now()+timeout;
    while(Date.now()<deadline){
      const roots=activeSalesforceModals();
      const fresh=roots.find(root=>!previous.has(root)&&!composedContains(state.overlay,root));
      if(fresh)return fresh;
      await wait(90);
    }
    return null;
  }
  async function activateLookupCreateNew(desc,action,input){
    const previous=activeSalesforceModals();
    for(const candidate of lookupClickCandidates(action?.el)){
      try{candidate.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}
      try{candidate.focus?.({preventScroll:true})}catch{}
      try{candidate.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1,view:window}))}catch{}
      try{candidate.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,composed:true,cancelable:true,button:0,buttons:1,view:window}))}catch{}
      try{candidate.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,composed:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:0,view:window}))}catch{}
      try{candidate.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,composed:true,cancelable:true,button:0,buttons:0,view:window}))}catch{}
      try{candidate.click?.()}catch{}
      const modal=await waitForNewLookupModal(previous,450);if(modal)return modal;
      // A Salesforce release may delegate its activation listener to the inner option
      // host. Keep trying the small, de-duplicated set of interactive descendants.
    }
    try{
      const fresh=FP.refreshFieldDescriptor?.(desc.host)||desc;const current=findComboInput(fresh)||input;current?.focus?.({preventScroll:true});
      current?.dispatchEvent(new KeyboardEvent('keydown',{key:'End',code:'End',bubbles:true,composed:true,cancelable:true}));
      current?.dispatchEvent(new KeyboardEvent('keyup',{key:'End',code:'End',bubbles:true,composed:true,cancelable:true}));
      current?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true,cancelable:true}));
      current?.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true,cancelable:true}));
      current?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,composed:true,cancelable:true}));
      current?.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,composed:true,cancelable:true}));
    }catch{}
    return waitForNewLookupModal(previous,1600);
  }
  function creationModalSaveButton(modal){
    const candidates=FP.deepQueryAll(modal,'button,input[type="submit"],input[type="button"],[role="button"],lightning-button',180).filter(el=>isVisible(el)&&!el.disabled&&el.getAttribute?.('aria-disabled')!=='true');
    // Prefer one accessible label at a time. Concatenating aria-label, title and
    // textContent turns a normal button into strings like "Save Save Save" and
    // prevents the nested workflow from finding its Save action.
    const labelsOf=el=>[el.getAttribute?.('aria-label'),el.getAttribute?.('title'),el.getAttribute?.('label'),el.value,el.textContent].map(FP.normalizeText).filter(Boolean);
    const isLabel=(el,re)=>labelsOf(el).some(label=>re.test(label));
    return candidates.find(el=>isLabel(el,/^save(?:\s*&\s*new)?(?:\s*\(.*\))?$/i))||candidates.find(el=>isLabel(el,/^create(?:\s+record)?$/i))||null;
  }
  async function saveLookupCreationModal(modal,objectLabel){
    const button=creationModalSaveButton(modal);
    if(!button)return{ok:false,reason:`Could not find the Save button in the new ${objectLabel||'record'} form.`};
    const start=Date.now();
    try{button.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}
    try{button.click?.()}catch{return{ok:false,reason:`Could not click Save in the new ${objectLabel||'record'} form.`}}
    while(Date.now()-start<9000){
      await wait(120);
      const stillActive=activeSalesforceModals().some(root=>root===modal||composedContains(root,modal)||composedContains(modal,root));
      if(!stillActive||!isVisible(modal))return{ok:true};
      const err=FP.deepQueryFirst(modal,'[role="alert"],.slds-form-element__help,.formMsg,.errorMsg');
      if(err&&FP.normalizeText(err.textContent)){
        // Let Salesforce finish rendering validation. Keep waiting because a save can
        // show a transient required-field error before async field state settles.
        await wait(180);
      }
    }
    return{ok:false,reason:`The new ${objectLabel||'record'} form did not close after Save. Check required fields or Salesforce validation messages.`};
  }
  async function chooseLookupCreateRecordType(modal,workflow){
    let current=modal;
    const deadline=Date.now()+1400;
    while(Date.now()<deadline){
      const roots=activeSalesforceModals();
      current=roots.find(root=>root===current||composedContains(root,current))||roots[0]||current;
      const chooser=recordTypeChooserState(current);
      if(chooser){
        const expected=FP.normalizeText(workflow?.recordTypeLabel||'');
        let target=null;
        if(expected){
          target=chooser.entries.find(entry=>FP.normalizeLabel(entry.label)===FP.normalizeLabel(expected))||
            chooser.entries.find(entry=>FP.normalizeLabel(entry.label).includes(FP.normalizeLabel(expected))||FP.normalizeLabel(expected).includes(FP.normalizeLabel(entry.label)));
          if(!target){
            const labels=chooser.entries.map(entry=>entry.label).filter(Boolean);
            return{ok:false,reason:`The recorded record type “${expected}” is not available. Available record types: ${labels.join(', ')||'none detected'}.`};
          }
        }else target=chooser.entries.find(entry=>entry.selected)||chooser.entries[0];
        if(!target)return{ok:false,reason:'Salesforce requires a record type, but no selectable record type labels were found.'};
        try{target.el?.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}
        try{target.control?.click?.()}catch{}
        if(target.kind==='select-option'){
          // Some classic-like Lightning modals expose record type as a native select.
          const select=target.el;
          if(String(select?.tagName||'').toLowerCase()==='select'){
            try{select.value=target.value;select.dispatchEvent(new Event('input',{bubbles:true,composed:true}));select.dispatchEvent(new Event('change',{bubbles:true,composed:true}))}catch{}
          }
        }
        await wait(100);
        const advance=recordTypeAdvanceButton(current)||chooser.advance;
        if(!advance)return{ok:false,reason:'Selected the record type, but Salesforce did not expose a Next or Continue button.'};
        try{advance.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}
        try{advance.click?.()}catch{return{ok:false,reason:'Could not continue after selecting the record type.'}}
        const formDeadline=Date.now()+6500;
        while(Date.now()<formDeadline){
          await wait(110);
          const rootsNow=activeSalesforceModals();
          const formRoot=rootsNow.find(root=>!composedContains(state.overlay,root)&&!!creationModalSaveButton(root)&&candidateFieldsWithin(root).length>0);
          if(formRoot)return{ok:true,modal:formRoot,recordTypeLabel:target.label};
          const updated=rootsNow.find(root=>root===current||composedContains(root,current))||rootsNow[0];
          if(updated)current=updated;
          // If the chooser was replaced by a separate modal, follow the largest active
          // modal and wait for its fields/footer instead of accidentally using parent-page fields.
          if(!recordTypeChooserState(current)&&creationModalSaveButton(current)&&candidateFieldsWithin(current).length>0)return{ok:true,modal:current,recordTypeLabel:target.label};
        }
        return{ok:false,reason:`Selected record type “${target.label}”, but the new-record form did not open. Check Salesforce validation or permissions.`};
      }
      // A non-record-type New form remains exactly on the existing replay path.
      if(creationModalSaveButton(current)&&candidateFieldsWithin(current).length>0)return{ok:true,modal:current,recordTypeLabel:''};
      await wait(100);
    }
    return{ok:true,modal:current,recordTypeLabel:''};
  }
  async function fillLookupCreateNew(d,expected,workflow,opts={}){
    const label=FP.normalizeText(expected?.displayValue||expected?.label||expected?.name||'');
    if(FP.classicLookupParts?.(d.host,d.element))return{ok:false,reason:'Create New workflows for Classic lookup popups are not supported yet. Existing Classic lookup autofill is unchanged.'};
    const cleared=await clearLookupSelection(d);d=cleared.desc||d;let input=cleared.input||findComboInput(d);
    if(!input||input.readOnly||input.getAttribute?.('aria-readonly')==='true')return{ok:false,reason:'Could not open the lookup search input to create a new record.'};
    if(!(await typeLookupSearchInputFast(input,label||workflow?.objectLabel||''))){
      if(!(await typeLookupSearchInput(input,label||workflow?.objectLabel||'')))return{ok:false,reason:'Could not search this lookup before creating a new record.'};
    }
    let action=null;
    for(let attempt=0;attempt<16;attempt++){
      await wait(attempt===0?80:90);d=FP.refreshFieldDescriptor?.(d.host)||d;action=lookupCreateNewOption(d);if(action)break;
    }
    if(!action){
      input=findComboInput(d);
      if(input&&await typeLookupSearchInput(input,label||workflow?.objectLabel||'')){
        for(let attempt=0;attempt<10;attempt++){await wait(90);d=FP.refreshFieldDescriptor?.(d.host)||d;action=lookupCreateNewOption(d);if(action)break;}
      }
    }
    if(!action)return{ok:false,reason:`Salesforce did not show the New ${workflow?.objectLabel||'record'} action in this lookup.`};
    let modal=await activateLookupCreateNew(d,action,input);
    if(!modal)return{ok:false,reason:`Could not open the New ${workflow?.objectLabel||'record'} form from the lookup.`};
    const recordTypeResult=await chooseLookupCreateRecordType(modal,workflow);
    if(!recordTypeResult?.ok)return{ok:false,reason:recordTypeResult?.reason||'Could not select the record type for the new record.'};
    modal=recordTypeResult.modal||modal;
    const oldScope=state.replayScope,oldModalRoot=state.replayModalRoot;state.replayScope='modal';state.replayModalRoot=modal;FP.invalidateFieldCaches();
    const childResults=[];
    try{
      await wait(120);
      const fields=Array.isArray(workflow?.fields)?workflow.fields:[];
      for(const childStep of fields){
        if(childStep?.enabled===false)continue;
        const result=await executeStep(childStep,{fillOnlyBlank:false,settings:opts.settings||{verifyAfterReplay:true},fastOverwrite:!!opts.fastOverwrite,lookupCreateChild:true});
        childResults.push({id:childStep.id||'',label:childStep.target?.label||'Field',status:result?.status||(result?.ok?'filled':'failed'),message:result?.message||result?.reason||'',workflowResults:result?.workflowResults||[],randomized:!!result?.randomized,generatedValue:result?.generatedValue,generationStrategy:result?.generationStrategy||'',generationMetaPatch:result?.generationMetaPatch||{}});
        if(!result?.ok)return{ok:false,reason:`Could not fill ${childStep.target?.label||'a field'} in the new ${workflow?.objectLabel||'record'} form: ${result?.message||result?.reason||'Field autofill failed.'}`,workflowResults:childResults};
      }
      const saved=await saveLookupCreationModal(modal,workflow?.objectLabel);
      if(!saved.ok)return{...saved,workflowResults:childResults,recordTypeLabel:recordTypeResult.recordTypeLabel||workflow?.recordTypeLabel||''};
    }finally{
      state.replayScope=oldScope;state.replayModalRoot=oldModalRoot;FP.invalidateFieldCaches();
    }
    // Lightning usually writes the created record into the original lookup as the
    // modal closes. Trust the live selected record here: its ID is necessarily new
    // and need not equal the ID from the original recording.
    const deadline=Date.now()+2600;let fresh=d,actual=null;
    while(Date.now()<deadline){
      FP.invalidateFieldCaches();fresh=FP.refreshFieldDescriptor?.(d.host)||resolveTarget(d)||d;actual=FP.readValue(fresh);
      if(actual?.recordId&&actual?.displayValue)return{ok:true,selected:actual.displayValue,selectedRecordId:String(actual.recordId),mode:'lookup-create-new',workflowResults:childResults,recordTypeLabel:recordTypeResult.recordTypeLabel||workflow?.recordTypeLabel||''};
      const inputNow=findComboInput(fresh);const hasPill=!!(inputNow?.readOnly||inputNow?.getAttribute?.('aria-readonly')==='true'||FP.deepQueryFirst(fresh?.host,'[data-input-pill],lightning-pill,[data-selection-index],[data-selected-record]'));
      if(hasPill&&FP.normalizeText(actual?.displayValue||inputNow?.value||''))return{ok:true,selected:FP.normalizeText(actual?.displayValue||inputNow?.value||label),selectedRecordId:String(actual?.recordId||''),mode:'lookup-create-new',workflowResults:childResults,recordTypeLabel:recordTypeResult.recordTypeLabel||workflow?.recordTypeLabel||''};
      await wait(100);
    }
    return{ok:false,reason:`The new ${workflow?.objectLabel||'record'} was saved, but Salesforce did not select it in the original lookup.`,workflowResults:childResults,recordTypeLabel:recordTypeResult.recordTypeLabel||workflow?.recordTypeLabel||''};
  }

  async function fillLookup(d,wanted,createWorkflow=null,opts={}){
    const expected=wanted&&typeof wanted==='object'?wanted:{displayValue:String(wanted??''),recordId:''};
    if(createWorkflow&&Array.isArray(createWorkflow.fields)&&!FP.classicLookupParts?.(d.host,d.element))return fillLookupCreateNew(d,expected,createWorkflow,opts);
    const classicResult=await fillClassicLookup(d,expected);
    if(classicResult)return classicResult;
    const expectedId=String(expected.recordId||'').trim(),expectedLabel=FP.normalizeText(expected.displayValue||expected.label||expected.name||'');
    if(!expectedId&&!expectedLabel)return{ok:false,reason:'Recorded lookup has no selectable value'};
    if(lookupSelectionEvidence(d,expectedId,expectedLabel))return{ok:true,selected:expectedLabel||expectedId,selectedRecordId:expectedId||String(FP.readValue(d)?.recordId||''),alreadySelected:true};
    const lookupHostTarget=d.host?.tagName?.toLowerCase()==='lightning-input-field'?(FP.deepQueryFirst(d.host,'lightning-lookup,lightning-record-picker,lightning-base-combobox[data-lookup]')||d.host):(FP.deepQueryFirst(d.host,'lightning-lookup,lightning-record-picker,lightning-base-combobox[data-lookup]')||d.element||d.host);
    const bridgeFallback=async()=>{
      const bridge=await ssPageAction(lookupHostTarget,'set-lookup',{displayValue:expectedLabel,recordId:expectedId});
      if(!bridge?.ok)return null;
      const fresh=FP.refreshFieldDescriptor?.(d.host)||d;
      // When choosing a suggestion fallback, the selected record may legitimately
      // have a different ID from the saved recording (another org or a duplicate
      // name). Verify the record reported by the bridge, or verify by selected label
      // when the bridge cannot expose an ID; do not re-impose a stale saved ID.
      const selectedId=String(bridge.selectedRecordId||'');
      const label=bridge.selected||expectedLabel;
      const verified=lookupSelectionEvidence(fresh,selectedId,label)||(!selectedId&&lookupSelectionEvidence(fresh,'',label))||bridge.mode==='lookup-public-api';
      return verified?{ok:true,selected:label||expectedId,selectedRecordId:selectedId,mode:bridge.mode||'lookup-bridge-fallback'}:null;
    };
    const cleared=await clearLookupSelection(d);
    d=cleared.desc||d;
    let input=cleared.input||findComboInput(d);
    if(!input||input.readOnly||input.getAttribute?.('aria-readonly')==='true'){
      const bridged=await bridgeFallback();
      return bridged||{ok:false,reason:'Could not clear the existing lookup selection before searching'};
    }
    if(!(await typeLookupSearchInputFast(input,expectedLabel||expectedId))){const bridged=await bridgeFallback();return bridged||{ok:false,reason:'Lookup search input could not be edited'}}
    let lastLookupOptions=[];
    const selectBestHit=options=>{
      lastLookupOptions=options;
      const ids=expectedId?options.filter(o=>o.id===expectedId):[];
      // Prefer the saved record ID whenever it is actually present in suggestions.
      if(ids.length)return ids[0];
      const labels=expectedLabel?options.filter(o=>o.label===exactLookupText(expectedLabel)):[];
      // Exact-name match is next best. If several distinct records have that exact
      // label, intentionally choose the first record in Salesforce's suggestion order
      // (the requested behavior) instead of failing with an ambiguity error.
      if(labels.length)return labels[0];
      return null;
    };
    let hit=null;
    for(let attempt=0;attempt<9;attempt++){
      await wait(attempt===0?55:85);
      hit=selectBestHit(lookupOptions(d));
      if(hit)break;
    }
    // Some Lightning lookup instances only react to keyboard-style per-character
    // input events. Fall back to that path only when the faster native input update
    // did not produce an exact suggestion.
    if(!hit){
      if(await typeLookupSearchInput(input,expectedLabel||expectedId)){
        for(let attempt=0;attempt<10;attempt++){
          await wait(75);hit=selectBestHit(lookupOptions(d));if(hit)break;
        }
      }
    }
    let usedFirstSuggestionFallback=false;
    // If Salesforce returned real record options but none matched the saved name/ID,
    // choose the first actual record suggestion. lookupOptions already filters out
    // command rows such as "Show more results" and "New ...".
    if(!hit&&lastLookupOptions.length){hit=lastLookupOptions[0];usedFirstSuggestionFallback=true;}
    if(hit&&await activateLookupOption(d,hit,input)){
      for(let i=0;i<8;i++){
        await wait(55);const fresh=FP.refreshFieldDescriptor?.(d.host)||d;
        // Verify against the ID and label of the record actually selected, not a
        // potentially stale ID from another Salesforce org.
        const selectedId=String(FP.readValue(fresh)?.recordId||hit.id||'');
        if(lookupSelectionEvidence(fresh,hit.id||'',hit.label||expectedLabel))return{ok:true,selected:hit.label||expectedLabel||expectedId,selectedRecordId:selectedId,mode:usedFirstSuggestionFallback?'lookup-first-suggestion-fallback':(hit.id&&expectedId&&hit.id!==expectedId?'lookup-exact-label-org-id-fallback':(expectedId&&hit.id===expectedId?'lookup-exact-id':'lookup-exact-label'))};
        const currentInput=findComboInput(fresh);
        if(!currentInput&&FP.normalizeText(FP.readValue(fresh)?.displayValue||'')===FP.normalizeText(hit.label||expectedLabel))return{ok:true,selected:hit.label||expectedLabel||expectedId,selectedRecordId:selectedId,mode:usedFirstSuggestionFallback?'lookup-first-suggestion-fallback':'lookup-selected'};
      }
    }
    const bridged=await bridgeFallback();
    if(bridged)return bridged;
    if(hit)return{ok:false,reason:`Found the Salesforce lookup result "${hit.label}" but could not confirm selection. Try re-recording this lookup field.`};
    const shown=lastLookupOptions.slice(0,4).map(o=>o.label).filter(Boolean).join(', ');
    return{ok:false,reason:shown?`Lookup suggestion appeared, but no exact match for "${expectedLabel||expectedId}" was identified. Suggestions: ${shown}`:`Lookup result not found for ${expectedLabel||expectedId}`};
  }
  async function fillRandomLookup(d,searchTerm=''){
    const cleared=await clearLookupSelection(d);d=cleared.desc||d;let input=cleared.input||findComboInput(d);
    if(!input||input.readOnly||input.getAttribute?.('aria-readonly')==='true')return{ok:false,reason:'The lookup search input is not editable, so a random existing record cannot be selected.'};
    // Blank search results can be inconsistent across Salesforce lookup components.
    // Use a small set of broad, ordinary prefixes, but select only a real visible
    // Salesforce option; this never fabricates an ID or claims to search every record.
    const terms=String(searchTerm||'').trim()?[String(searchTerm).trim()]:['a','e','s','m'];
    let candidates=[];
    for(const term of terms){
      const typed=await typeLookupSearchInputFast(input,term);
      if(!typed)await typeLookupSearchInput(input,term);
      for(let attempt=0;attempt<6;attempt++){
        await wait(attempt===0?85:100);
        d=FP.refreshFieldDescriptor?.(d.host)||d;input=findComboInput(d)||input;
        candidates=lookupOptions(d);
        if(candidates.length)break;
      }
      if(candidates.length)break;
    }
    if(!candidates.length)return{ok:false,reason:'Salesforce did not return any selectable lookup suggestions. Try adding search text or use the recorded lookup value.'};
    const hit=candidates[Math.floor(Math.random()*candidates.length)];
    if(!hit||!(await activateLookupOption(d,hit,input)))return{ok:false,reason:'A real lookup suggestion was found, but Salesforce did not confirm its selection.'};
    for(let attempt=0;attempt<8;attempt++){
      await wait(60);const fresh=FP.refreshFieldDescriptor?.(d.host)||d;const live=FP.readValue(fresh)||{};
      if(lookupSelectionEvidence(fresh,hit.id||'',hit.label)||(!findComboInput(fresh)&&FP.normalizeText(live.displayValue||'')===FP.normalizeText(hit.label))){
        return{ok:true,selected:hit.label,selectedRecordId:String(live.recordId||hit.id||''),mode:'lookup-random-suggestion'};
      }
    }
    return{ok:false,reason:`Selected lookup suggestion “${hit.label}”, but the selected record could not be verified.`};
  }
  async function fillAddress(d,val){
    const aliases={street:['street','address','street1','addressline1','line1'],city:['city','town'],state:['state','province','stateprovince'],province:['province','state','stateprovince'],postalCode:['postalCode','postalcode','postal-code','postal','zip','zipcode'],postalcode:['postalcode','postal-code','postalCode','postal','zip','zipcode'],country:['country']};
    for(const [part,v] of Object.entries(val||{})){
      const names=[...new Set([part,...(aliases[part]||[])])];let input=null;
      for(const name of names){const escaped=CSS.escape(name);input=FP.deepQueryFirst(d.host,`[data-address-part="${escaped}"],[data-field-name="${escaped}"],[data-name="${escaped}"],input[name="${escaped}"],textarea[name="${escaped}"],[autocomplete*="${escaped}"]`);if(input)break;}
      if(!input&&v)return{ok:false,reason:`Address part ${part} could not be found`};if(input)setNative(input,String(v));
    }
    return true;
  }

  async function startRecording(opts={}){
    if(!FP.isSalesforceHost()){return{ok:false,code:'SALESFORCE_ONLY'}}
    const appendRecording=opts?.appendRecording||null;
    // Record must always snapshot the object from the current Salesforce page.
    // This prevents an SPA-navigated Agreement from inheriting the prior Opportunity.
    const currentContext=detectContext();
    state.lastContext={...currentContext};
    if(!opts.multiFrame && appendRecording?.context?.objectApiName&&currentContext.objectApiName&&appendRecording.context.objectApiName!==currentContext.objectApiName){
      
      return{ok:false,code:'RECORDING_OBJECT_MISMATCH',message:`This recording is for ${appendRecording.context.objectApiName}. Open a matching Salesforce record first.`};
    }
    const lock=await safeRuntimeSendMessage({type:'ACQUIRE_RECORDING_LOCK'});if(!lock?.ok){return lock}
    state.pendingRecording=null;state.lookupCreationCapture=null;state.replayScope='page';state.paused=false;state.lastContext=currentContext;state.targetCache.clear();state.recording=true;state.replaying=false;state.appendOnly=!!appendRecording;state.multiFrameRecording=!!opts.multiFrame;state.recordingId=opts.recordingId||appendRecording?.id||id();state.recordingDate=opts.recordingDate||appendRecording?.recordingDate||localDateISO();state.steps=appendRecording?.steps?JSON.parse(JSON.stringify(appendRecording.steps)):[];state.appendExistingKeys=new Set([...state.steps.map(s=>s?.target?.key),...(Array.isArray(opts.appendExistingKeys)?opts.appendExistingKeys:[])].filter(Boolean));state.currentStepIndex=-1;FP.invalidateFieldCaches();setBaseline();installListeners();window.addEventListener('beforeunload',recordingBeforeUnload);updatePresence();state.metadataPromise=FP.loadSalesforceMetadata(state.lastContext.objectApiName,state.lastContext.recordId).then(info=>{if(info?.label&&state.lastContext){state.lastContext.objectLabel=info.label;}if(!state.recording)return;FP.invalidateFieldCaches();for(const [k,oldDesc] of state.touchedDescriptors.entries()){const fresh=FP.describeField(oldDesc?.host||oldDesc?.element)||oldDesc;state.touchedDescriptors.set(k,fresh);const step=state.steps.find(x=>x.target.key===k);if(step){step.target={...step.target,key:fresh.key,label:FP.normalizeText(fresh.label).replace(/^\s*\*\s*/,''),apiName:fresh.apiName,name:fresh.name,kind:fresh.kind,sfDataType:fresh.sfDataType||step.target.sfDataType,salesforceType:fresh.sfDataType||step.target.salesforceType,multiSelect:fresh.multiSelect,length:fresh.length??step.target.length,maxLength:fresh.maxLength??step.target.maxLength,scale:fresh.scale??step.target.scale,precision:fresh.precision??step.target.precision,required:fresh.required??step.target.required,updateable:fresh.updateable??step.target.updateable,createable:fresh.createable??step.target.createable,reference:fresh.reference,referenceObject:fresh.referenceObject,objectApiName:fresh.objectApiName||step.target.objectApiName,targetSelectionName:fresh.targetSelectionName||step.target.targetSelectionName,fieldId:fresh.fieldId||step.target.fieldId,fieldPath:fresh.fieldPath||step.target.fieldPath,identitySource:fresh.identitySource||step.target.identitySource,identityConfidence:fresh.identityConfidence||step.target.identityConfidence,controllerName:fresh.controllerName||step.target.controllerName,controllingFields:Array.isArray(fresh.controllingFields)?fresh.controllingFields.slice():(step.target.controllingFields||[]),options:Array.isArray(fresh.options)?fresh.options.map(o=>({value:o.value,displayValue:o.displayValue,active:o.active,validFor:o.validFor})):step.target.options||[]};}}updatePresence()}).catch(()=>{});return{ok:true,context:state.lastContext,steps:state.steps}}
  function sanitizeRecordedSteps(steps){
    const out=[];
    for(const step of Array.isArray(steps)?steps:[]){
      if(!step||!step.target)continue;
      const raw=step.value;
      const kind=String(step.target.kind||'').toLowerCase();
      let empty=raw===null||raw===undefined;
      if(!empty&&kind==='picklist')empty=!!FP.isPicklistPlaceholder?.(raw);
      else if(!empty&&kind==='multi-picklist'){const vals=Array.isArray(raw)?raw:FP.parseMultiValues(raw);empty=vals.length===0||vals.every(x=>FP.isMultiPicklistPlaceholder?.(x));}
      else if(!empty&&kind==='lookup')empty=!raw?.displayValue&&!raw?.recordId;
      else if(!empty&&kind==='address')empty=Object.values(raw||{}).every(x=>FP.normalizeText(x)==='');
      else if(!empty&&Array.isArray(raw))empty=raw.length===0;
      else if(!empty&&typeof raw==='object')empty=Object.values(raw).every(x=>x==null||FP.normalizeText(x)==='');
      else if(!empty&&typeof raw==='string')empty=!raw.trim();
      if(empty)continue;
      out.push({...step,sequence:out.length+1});
    }
    return out;
  }

  async function stopRecording({deferSave=false}={}){
    if(!state.recording)return{ok:false,code:'NOT_RECORDING'};
    // Capture the latest user change immediately and stop listening at once.
    reconcile();
    finalizeLookupCreationCapture();
    removeListeners();
    window.removeEventListener('beforeunload',recordingBeforeUnload);
    state.recording=false;
    state.paused=false;
    // Recording stop must not wait on slow Salesforce metadata requests. Most
    // targets already have their descriptor cached while recording; give the
    // initial metadata request a short chance to settle, then save from the
    // live descriptors and let any remaining metadata warm the cache in the
    // background. This avoids a multi-second pause on pages with many frames.
    try{await Promise.race([Promise.resolve(state.metadataPromise||null),new Promise(resolve=>setTimeout(resolve,250))])}catch{}
    const metadataObjects=new Set();
    try{if(state.lastContext?.objectApiName&&state.lastContext.objectApiName!=='Salesforce')metadataObjects.add(String(state.lastContext.objectApiName));}catch{}
    for(const d of state.touchedDescriptors.values()){
      if(d?.objectApiName&&d.objectApiName!=='Salesforce')metadataObjects.add(String(d.objectApiName));
    }
    for(const step of state.steps||[]){
      const targets=[step?.target,...(Array.isArray(step?.meta?.createNewRecord?.fields)?step.meta.createNewRecord.fields.map(child=>child?.target):[])].filter(Boolean);
      for(const t of targets){
        if(t.objectApiName&&t.objectApiName!=='Salesforce')metadataObjects.add(String(t.objectApiName));
        const parsed=FP.parseTargetSelectionName?.(t.targetSelectionName);
        if(parsed?.objectApiName&&parsed.objectApiName!=='Salesforce')metadataObjects.add(String(parsed.objectApiName));
      }
    }
    if(metadataObjects.size){
      // Warm object metadata opportunistically; do not block the Stop action.
      Promise.all([...metadataObjects].map(obj=>FP.loadSalesforceMetadata(obj, obj===state.lastContext?.objectApiName?state.lastContext?.recordId||'':'').catch(()=>null))).catch(()=>{});
    }
    FP.invalidateFieldCaches();
    for(const [k,oldDesc] of state.touchedDescriptors.entries()){
      const fresh=FP.describeField(oldDesc?.host||oldDesc?.element)||oldDesc;
      state.touchedDescriptors.set(k,fresh);
    }
    const descriptors=new Map(state.touchedDescriptors);
    const steps=state.steps.map((original,i)=>{
      const s={...original,target:{...(original.target||{})}};
      const d=descriptors.get(s.target.key)||[...descriptors.values()].find(x=>sameFieldTarget(s.target,x));
      if(!d)return{...s,sequence:i+1};
      syncStepWithDescriptor(s,d);
      s.sequence=i+1;
      return s;
    });
    const context=detectContext();
    const existing=state.appendOnly?await FP.getRecordings():null;
    const previous=state.appendOnly?(existing?.[state.recordingId]||null):null;
    const cleanSteps=sanitizeRecordedSteps(steps);
    const recording={id:state.recordingId,name:previous?.name||FP.makeRecordingName(context),context:{...(previous?.context||{}),...context},version:5,recordingDate:previous?.recordingDate||state.recordingDate||localDateISO(),steps:cleanSteps,createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(state.appendOnly && !deferSave && !state.multiFrameRecording){
      const all=existing||await FP.getRecordings();
      all[recording.id]=recording;
      await FP.saveRecordings(all);
      await safeRuntimeSendMessage({type:'RELEASE_RECORDING_LOCK'});
      state.lastContext=context;state.appendOnly=false;state.appendExistingKeys.clear();updatePresence();
      return{ok:true,recording};
    }
    state.lastContext=context;
    state.pendingRecording=recording;
    state.appendOnly=false;
    state.appendExistingKeys.clear();
    updatePresence();
    return{ok:true,recording,pendingSave:true};
  }

  function setRecordingPaused(paused){if(!state.recording)return{ok:false,code:'NOT_RECORDING',message:'Recording is not active.'};state.paused=!!paused;updatePresence();return{ok:true,paused:state.paused,steps:state.steps};}
  function applyRecordedNumericSemantics(d,target){
    if(!d||!target)return d;
    const recordedType=String(target.sfDataType||target.salesforceType||target.fieldType||target.type||'').toLowerCase();
    const numericTypes=new Set(['currency','percent','double','int','integer','long','decimal','number']);
    if(!numericTypes.has(recordedType))return d;
    // Salesforce can expose Currency/Percent as a generic text input on the live DOM.
    // The recording metadata is authoritative for replay: force numeric semantics so
    // $1.00 / 1.00% is normalized to the same underlying value (1) during verification.
    if(d.kind!=='number'||String(d.sfDataType||'').toLowerCase()!==recordedType){
      return {...d,kind:'number',type:recordedType,sfDataType:recordedType,semanticSource:'recorded-target'};
    }
    return d;
  }
  function actionForKind(kind){
    if(kind==='boolean')return'set-boolean';
    if(kind==='picklist')return'select-option';
    if(kind==='multi-picklist')return'set-multi-option';
    if(kind==='lookup')return'select-lookup';
    if(kind==='address')return'set-address';
    return'set-value';
  }
  function repairStepForDescriptor(step,d){
    if(!step||!d)return step;
    const recordedKind=String(step?.target?.kind||'').toLowerCase();
    const actualKind=String(d.kind||'').toLowerCase();
    let next=step;
    if(recordedKind&&actualKind&&recordedKind!==actualKind){
      next={...next,action:actionForKind(actualKind),target:{...(step.target||{}),kind:actualKind,fieldType:FP.canonicalFieldType(d),sfDataType:d.sfDataType||FP.canonicalFieldType(d),salesforceType:d.sfDataType||FP.canonicalFieldType(d),reference:d.reference,referenceObject:d.referenceObject,referenceId:d.referenceId||step.target?.referenceId,multiSelect:d.multiSelect,objectApiName:d.objectApiName||step.target?.objectApiName}};
    }
    // Older recordings may have classified native Salesforce Setup dropdowns as
    // text and stored the option's internal value (sometimes a Salesforce-style ID).
    // Recover its visible label from the saved or current option catalog, then replay
    // against the current UI label. Keep the original value for same-org compatibility.
    if(actualKind==='picklist'){
      const raw=typeof next.value==='object'&&next.value?String(next.value.value??next.value.displayValue??''):String(next.value??'');
      const norm=FP.normalizeLabel;
      const saved=Array.isArray(next.target?.options)?next.target.options:[];
      const live=Array.isArray(d.options)?d.options:[];
      const savedHit=saved.find(o=>norm(o?.value)===norm(raw))||saved.find(o=>norm(o?.displayValue)===norm(raw));
      const liveHit=live.find(o=>norm(o?.value)===norm(raw))||live.find(o=>norm(o?.displayValue)===norm(raw));
      const label=String(liveHit?.displayValue||next.meta?.selectedDisplayValue||savedHit?.displayValue||'').trim();
      if(label&& !FP.isPicklistPlaceholder(label))next={...next,value:label,meta:{...(next.meta||{}),selectedDisplayValue:label}};
    }
    if(actualKind==='multi-picklist'){
      const rawValues=Array.isArray(next.value)?next.value:FP.parseMultiValues(next.value);
      const saved=Array.isArray(next.target?.options)?next.target.options:[];
      const live=Array.isArray(d.options)?d.options:[];
      const mapped=rawValues.map(value=>{
        const norm=FP.normalizeLabel,v=String(value??'');
        const existsLive=live.some(o=>norm(o?.value)===norm(v)||norm(o?.displayValue)===norm(v));
        if(existsLive)return v;
        const old=saved.find(o=>norm(o?.value)===norm(v));
        const label=String(old?.displayValue||'').trim();
        return label&&live.some(o=>norm(o?.value)===norm(label)||norm(o?.displayValue)===norm(label))?label:v;
      });
      next={...next,value:[...new Set(mapped)]};
    }
    if(actualKind==='lookup' && typeof next.value==='string' && /^\[object Object\]$/.test(next.value.trim())){
      const meta=next.meta||{};
      next={...next,value:{displayValue:String(meta.lookupDisplayValue||''),recordId:String(meta.lookupRecordId||next.target?.referenceId||'')}};
    }
    return next;
  }

  function candidateFieldsWithin(root){
    if(!root)return[];
    const selectors=['[data-target-selection-name^="sfdc:RecordField."]','[data-field-id]','record_flexipage-record-field','flexipage-field','lightning-input-field','lightning-input','lightning-lookup','lightning-combobox','lightning-textarea','lightning-record-picker','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-base-combobox','[data-sf-field]','[data-sf-address]','input:not([type=hidden])','textarea','select','[contenteditable="true"]'];
    const found=[],seenHosts=new Set();
    const add=element=>{
      if(!element)return;let d=null;try{const tag=String(element.tagName||'').toLowerCase();const host=/^(input|textarea|select)$/.test(tag)?(FP.logicalComponentHost(element)||element):element;d=FP.describeField(host)||FP.describeField(element)}catch{}
      if(!d||!d.label||!composedContains(root,d.host||d.element))return;
      const identity=d.host||d.element;if(identity&&seenHosts.has(identity))return;if(identity)seenHosts.add(identity);found.push(d);
    };
    // Start with the shared enumerator, then rescan the live modal roots directly.
    // The shared enumerator de-duplicates by field key globally; a modal may contain
    // a field with the same API name as the parent record, so scope before deduping.
    for(const d of FP.candidateFields())if(composedContains(root,d?.host||d?.element))add(d?.host||d?.element);
    for(const domRoot of FP.walkRoots())for(const selector of selectors){try{domRoot.querySelectorAll?.(selector)?.forEach(add)}catch{}}
    const byKey=new Map();
    for(const d of found){const k=key(d);const old=byKey.get(k);const score=x=>(x?.targetSelectionName?50:0)+(x?.apiName?25:0)+(x?.objectApiName?15:0)+(x?.fieldId?5:0)+(x?.kind&&x.kind!=='field'?2:0);if(!old||score(d)>score(old))byKey.set(k,d)}
    return [...byKey.values()];
  }
  function currentReplayModalRoot(){
    const stored=state.replayModalRoot;
    if(stored?.isConnected&&isVisible(stored))return stored;
    return activeSalesforceModals().find(root=>!composedContains(state.overlay,root))||null;
  }
  function resolveTarget(target){
    if(!target)return null;
    const cacheKeys=targetCacheKeys(target);
    for(const k of cacheKeys){const cached=state.targetCache.get(k);if((cached?.host?.isConnected||cached?.element?.isConnected)&&(state.replayScope!=='modal'||!!modalRootForDescriptor(cached)))return applyRecordedNumericSemantics(cached,target);}
    let candidates=FP.candidateFields();
    if(state.replayScope==='modal'){const modal=currentReplayModalRoot();candidates=candidateFieldsWithin(modal);}
    const targetObject=String(target.objectApiName||'').toLowerCase();
    const currentObject=String(state.lastContext?.objectApiName||detectContext().objectApiName||'').toLowerCase();
    const parsedSelection=FP.parseTargetSelectionName?.(target.targetSelectionName)||null;
    const apiCandidates=[target.apiName,target.fieldPath,!target.fieldPath?.includes('__r__')?parsedSelection?.apiName:''].map(v=>String(v||'').trim().toLowerCase()).filter(Boolean);
    const nameCandidates=[target.name].map(v=>String(v||'').trim().toLowerCase()).filter(Boolean);
    const label=FP.normalizeLabel(target.label||'');
    const objectMatches=x=>{const xo=String(x?.objectApiName||'').toLowerCase();return !targetObject||!xo||xo===targetObject;};
    const currentMatches=x=>currentObject&&String(x?.objectApiName||'').toLowerCase()===currentObject;
    let d=null;

    // 1) Exact Salesforce target-selection identity remains the strongest match.
    if(target.targetSelectionName)d=candidates.find(x=>x.targetSelectionName===target.targetSelectionName)||null;
    // 2) Exact stable key.
    if(!d&&target.key)d=candidates.find(x=>x.key===target.key)||null;
    // 3) Exact API/field path. Prefer the recorded object, but recover when the live
    // DOM omitted object metadata or rebuilt the wrapper around the same API field.
    if(!d&&apiCandidates.length){
      const exactApi=candidates.filter(x=>apiCandidates.includes(String(x?.apiName||x?.fieldPath||'').toLowerCase()));
      const preferred=exactApi.filter(x=>currentMatches(x)||objectMatches(x));
      if(preferred.length===1)d=preferred[0];
      else if(exactApi.length===1)d=exactApi[0];
    }
    // 4) Native control name. Same preference/recovery policy.
    if(!d&&nameCandidates.length){
      const exactName=candidates.filter(x=>nameCandidates.includes(String(x?.name||'').toLowerCase()));
      const preferred=exactName.filter(x=>currentMatches(x)||objectMatches(x));
      if(preferred.length===1)d=preferred[0];
      else if(exactName.length===1)d=exactName[0];
    }
    // 5) Exact label. First prefer the current object/recorded object. If the live
    // descriptor omitted object metadata, allow one unique exact-label match rather
    // than falsely reporting every newly recorded field as "not found".
    if(!d&&label){
      const exact=candidates.filter(x=>FP.normalizeLabel(x?.label)===label);
      const preferred=exact.filter(x=>currentMatches(x)||objectMatches(x));
      if(preferred.length===1)d=preferred[0];
      else if(exact.length===1)d=exact[0];
    }

    d=applyRecordedNumericSemantics(d,target);
    if(d&&Array.isArray(target.options)&&target.options.length&&!d.options?.length)d={...d,options:target.options};
    if(d&&target.dataTableColumnKey&&!d.dataTableColumnKey)d={...d,dataTableColumnKey:target.dataTableColumnKey,dataTableFieldApiName:target.dataTableFieldApiName};
    if(d)for(const k of [...cacheKeys,target.key,d.key].filter(Boolean))state.targetCache.set(k,d);
    return d;
  }

  function initialEmptyMap(recording){const map=new Map();for(const s of recording.steps||[]){if(map.has(s.target.key))continue;const d=resolveTarget(s.target);if(d)map.set(d.key,emptyValue(d,valueFor(d)))}return map}
  function salesforceDateInputValue(d,value){
    const iso=FP.normalizeDate(value);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return iso;
    // Preserve native HTML date controls, which require ISO values, while restoring the
    // Salesforce Lightning text-input behavior used by the original extension: MM/DD/YYYY.
    const el=d?.element||FP.controlForField?.(d?.host);
    if(String(el?.type||'').toLowerCase()==='date')return iso;
    const [,yyyy,mm,dd]=iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return `${mm}/${dd}/${yyyy}`;
  }
  function salesforceNumericInputValue(d,value){
    // Salesforce renders Currency and Percent as text inputs. Always send the raw
    // numeric value to the control; never send display formatting such as $, %, or
    // thousands separators. Salesforce can apply its own presentation formatting
    // after the value is accepted.
    const raw=FP.normalizeNumber(value);
    return raw==='-'?'':raw;
  }
  function setSalesforceNumericValue(d,value){
    const raw=salesforceNumericInputValue(d,value);
    if(raw==='')return false;
    const el=d?.element||FP.controlForField?.(d?.host);
    // IMPORTANT: write the raw numeric token to the real input first. Do not set
    // lightning-input.value first, because Salesforce may immediately rewrite the
    // control to a display-formatted value such as $1.00 or 2.00%.
    let nativeSet=false;
    try{
      if(el){
        const proto=Object.getPrototypeOf(el);
        const desc=Object.getOwnPropertyDescriptor(proto,'value');
        if(desc?.set)desc.set.call(el,raw);else el.value=raw;
        nativeSet=true;
        el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      }
    }catch{}

    // Notify the enclosing Lightning input only after the native value contains the
    // unformatted number. This lets Salesforce consume the numeric value while keeping
    // its own visual formatter responsible for presentation.
    let hostSet=false;
    for(const host of [FP.deepQueryFirst(d?.host,'lightning-input'),d?.host].filter(Boolean)){
      try{
        if('value' in host){
          host.value=raw;
          host.dispatchEvent?.(new Event('input',{bubbles:true,composed:true}));
          host.dispatchEvent?.(new Event('change',{bubbles:true,composed:true}));
          hostSet=true;
        }
      }catch{}
    }
    if(el)try{el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));}catch{}
    return nativeSet||hostSet;
  }
  function valueForStep(d,step){
    let v=step.value;
    if(d.kind==='number')v=FP.normalizeNumber(v);
    else if(d.kind==='date'){
      const meta=step?.meta||{};
      if(meta.dateMode==='relative'&&!meta.randomizedDate&&Number.isFinite(Number(meta.dateOffsetDays))){
        v=shiftLocalDateISO(localDateISO(),Number(meta.dateOffsetDays));
      }
      v=salesforceDateInputValue(d,v);
    }
    else if(d.kind==='datetime')v=FP.normalizeDateTime(v);
    else if(d.kind==='time')v=FP.normalizeTime(v);
    return v;
  }
  function allWorkflowSteps(steps){
    const out=[],queue=[...(Array.isArray(steps)?steps:[])],seen=new Set();
    while(queue.length){const step=queue.shift();if(!step||typeof step!=='object'||seen.has(step))continue;seen.add(step);out.push(step);const child=step?.meta?.createNewRecord?.fields;if(Array.isArray(child))queue.push(...child);}
    return out;
  }
  async function hydrateReplayPicklists(recording,replayContext){
    // Hydrate picklist values even when the recording already has a value catalog:
    // dependent picklists require the UI API's controllerValues + validFor mapping.
    for(const step of allWorkflowSteps(recording?.steps)){
      const target=step?.target;
      const targetTypes=[target?.kind,target?.fieldType,target?.sfDataType,target?.salesforceType].map(v=>String(v||'').toLowerCase());
      const picklistTarget=targetTypes.some(v=>['picklist','multipicklist','multi-picklist'].includes(v));
      if(!target?.apiName||!picklistTarget)continue;
      const objectApi=target.objectApiName||replayContext.objectApiName||'';
      if(!objectApi||objectApi==='Salesforce')continue;
      const recordId=objectApi===replayContext.objectApiName?replayContext.recordId:'';
      const info=await FP.loadSalesforceMetadata(objectApi,recordId).catch(()=>null);
      const rt=await FP.getRecordTypeId?.(objectApi,recordId)||info?.defaultRecordTypeId||'012000000000000AAA';
      const fieldMeta=FP.getFieldMetadata?.(target.apiName,objectApi)||null;
      const data=await FP.loadFieldPicklistData?.(objectApi,rt,target.apiName).catch(()=>null);
      const options=data?.values||await FP.loadFieldPicklistValues?.(objectApi,rt,target.apiName)||[];
      if(options.length)target.options=options.map(o=>({value:o.value,displayValue:o.displayValue||o.value,active:o.active!==false,validFor:o.validFor}));
      target.controllerName=fieldMeta?.controllerName||fieldMeta?.controllerField||target.controllerName||undefined;
      target.controllingFields=Array.isArray(fieldMeta?.controllingFields)?fieldMeta.controllingFields.slice():(target.controllingFields|| (target.controllerName?[target.controllerName]:[]));
      if(data?.controllerValues&&Object.keys(data.controllerValues).length)target.controllerValues={...data.controllerValues};
      target.defaultPicklistValue=data?.defaultValue?.value||data?.defaultValue||target.defaultPicklistValue;
      target.isDependentPicklist=!!(target.controllerName||target.controllingFields?.length||Object.keys(target.controllerValues||{}).length||options.some(o=>Array.isArray(o.validFor)?o.validFor.length>0:(typeof o.validFor==='string'&&o.validFor.length>0)));
    }
  }

  const normalizePickOptionKey=v=>FP.normalizeLabel(typeof v==='object'&&v?v.value??v.displayValue??v.label??'':v);
  function optionIsValidForController(option,index){
    const validFor=option?.validFor;
    if(Array.isArray(validFor))return validFor.map(Number).includes(Number(index));
    if(typeof validFor==='string'&&validFor){
      // REST Describe represents validFor as a base64 bitset; UI API uses indexes.
      try{const decoded=atob(validFor);const byte=Math.floor(Number(index)/8);return byte<decoded.length&&((decoded.charCodeAt(byte)&(0x80>>(Number(index)%8)))!==0)}catch{return false}
    }
    return true;
  }
  function filterDependentPicklistOptions(step,descriptor,options){
    const target=step?.target||{};
    const objectApi=target.objectApiName||descriptor?.objectApiName||state.lastContext?.objectApiName||detectContext().objectApiName||'';
    const fieldMeta=target.apiName?FP.getFieldMetadata?.(target.apiName,objectApi):null;
    const controllerName=target.controllerName||descriptor?.controllerName||fieldMeta?.controllerName||fieldMeta?.controllerField||target.controllingFields?.[0]||descriptor?.controllingFields?.[0]||fieldMeta?.controllingFields?.[0]||'';
    const controllerValues=target.controllerValues||descriptor?.controllerValues||{};
    const hasDependencyBits=Array.isArray(options)&&options.some(o=>Array.isArray(o?.validFor)?o.validFor.length>0:(typeof o?.validFor==='string'&&o.validFor.length>0));
    const dependent=!!(controllerName||Object.keys(controllerValues).length||target.isDependentPicklist||fieldMeta?.controllerName||fieldMeta?.controllingFields?.length||hasDependencyBits);
    if(!dependent)return{dependent:false,options};
    if(!Object.keys(controllerValues).length||!Array.isArray(options)||!options.some(o=>o?.validFor!==undefined))return{dependent:true,options:[],error:'Salesforce exposed the field, but not its dependency map. Reopen the record and retry after selecting the controlling value.'};

    const fields=FP.candidateFields?.()||[];
    const controller=fields.find(field=>{
      const api=String(field?.apiName||field?.name||'').toLowerCase();
      const object=String(field?.objectApiName||'').toLowerCase();
      return api===String(controllerName).toLowerCase()&&(!objectApi||!object||object===String(objectApi).toLowerCase());
    });
    if(!controller)return{dependent:true,options:[],error:`Select the controlling field (${controllerName}) before randomizing this picklist.`};

    const normalize=normalizePickOptionKey;
    const controlMeta=FP.getFieldMetadata?.(controller.apiName||controller.name,controller.objectApiName||objectApi)||{};
    const catalog=[...(Array.isArray(controller.options)?controller.options:[]),...(Array.isArray(controlMeta.picklistValues)?controlMeta.picklistValues.map(o=>({value:o.value,displayValue:o.displayValue||o.label||o.value,active:o.active!==false})):[])];
    const variants=new Set();
    const addVariant=v=>{const n=normalize(v);if(n)variants.add(n)};
    let current=FP.readValue?.(controller);
    if(controller.kind==='boolean')current=String(FP.normalizeBoolean(current));
    addVariant(current);
    for(const node of [controller.element,controller.host,findComboTrigger(controller),findComboInput(controller)].filter(Boolean)){
      for(const attr of ['data-value','value','aria-valuetext','title','data-label','aria-label']){try{addVariant(node.getAttribute?.(attr));}catch{}}
      try{addVariant(node.value);}catch{}
      if(node===findComboTrigger(controller))addVariant(FP.normalizeText(node.textContent||''));
    }
    const currentOption=catalog.find(o=>variants.has(normalize(o?.value))||variants.has(normalize(o?.displayValue??o?.label)));
    if(currentOption){addVariant(currentOption.value);addVariant(currentOption.displayValue??currentOption.label);}
    const entry=Object.entries(controllerValues).find(([mappedValue])=>{
      if(variants.has(normalize(mappedValue)))return true;
      const mappedOption=catalog.find(o=>normalize(o?.value)===normalize(mappedValue));
      return !!mappedOption&&variants.has(normalize(mappedOption.displayValue??mappedOption.label));
    });
    if(!entry)return{dependent:true,options:[],error:`The current ${controller.label||controllerName} value does not match Salesforce's dependency map. Select a valid controlling value first.`};
    const eligible=options.filter(o=>optionIsValidForController(o,entry[1]));
    return eligible.length?{dependent:true,options:eligible}:{dependent:true,options:[],error:`Salesforce has no dependent options for ${controller.label||controllerName}'s current value.`};
  }
  async function randomizationPicklistOptions(step,descriptor,{dependentOnly=false}={}){
    const target=step?.target||{};
    const cleanOptions=items=>(Array.isArray(items)?items:[]).filter(o=>o&&o.active!==false&&!FP.isPicklistPlaceholder(o.displayValue||o.label||o.value)).map(o=>({value:String(o.value??o.displayValue??o.label??'').trim(),displayValue:FP.normalizeText(o.displayValue??o.label??o.value),active:o.active!==false,validFor:o.validFor})).filter(o=>o.value&&o.displayValue);
    const nativeSelect=descriptor?.element?.tagName==='SELECT'?descriptor.element:FP.deepQueryFirst?.(descriptor?.host,'select');
    if(nativeSelect?.options){
      const opts=[...nativeSelect.options].filter(o=>!o.disabled&&!FP.isPicklistPlaceholder(o.textContent||o.value)).map(o=>({value:o.value||o.textContent.trim(),displayValue:FP.normalizeText(o.textContent)||o.value,active:true}));
      if(opts.length)return{options:opts,live:true};
    }
    // First use the actual currently rendered options. Salesforce has already applied
    // record-type and controlling-field rules to this list, so it is the most reliable
    // source for dependent picklists.
    let options=livePicklistOptions(descriptor).filter(o=>!o.el?.disabled&&o.el?.getAttribute?.('aria-disabled')!=='true');
    if(options.length)return{options:options.map(o=>({value:o.value,displayValue:o.displayValue,active:true})),live:true,dependent:dependentOnly,targetMetadata:dependentOnly?{isDependentPicklist:true}:undefined};
    const trigger=findComboTrigger(descriptor),wasExpanded=trigger?.getAttribute?.('aria-expanded')==='true';
    let opened=false;
    if(!wasExpanded)opened=await openCombobox(descriptor);
    // Some Salesforce comboboxes render their listbox in a portal and others inside
    // the field's own shadow root. Wait for the aria-controlled list first.
    for(let attempt=0;attempt<(dependentOnly?30:12);attempt++){
      // The controlling field can cause Lightning to replace the dependent field's
      // inner combobox after its outer field wrapper survives. Refresh the descriptor
      // before inspecting each newly rendered option list.
      try{
        const refreshed=descriptor?.host?FP.refreshFieldDescriptor?.(descriptor.host):null;
        if(refreshed)descriptor=refreshed;
        else if(descriptor?.host?.isConnected===false||descriptor?.element?.isConnected===false){
          const resolved=await resolveTargetWithRetry(target,500,65);if(resolved)descriptor=resolved;
        }
      }catch{}
      options=livePicklistOptions(descriptor).filter(o=>!o.el?.disabled&&o.el?.getAttribute?.('aria-disabled')!=='true');
      if(options.length)break;
      await wait(dependentOnly?80:70);
      const liveTrigger=findComboTrigger(descriptor);
      if(!dependentOnly&&!opened&&!wasExpanded&&liveTrigger?.getAttribute?.('aria-expanded')!=='true'&&attempt>=3)break;
    }
    if(options.length){
      const closeTrigger=findComboTrigger(descriptor)||trigger;
      // For an explicitly dependent picklist, keep this exact dropdown open. The
      // selected runtime option is immediately applied by fillPicklist; closing and
      // reopening here causes a visible flash and lets Lightning recalculate options
      // between discovery and selection.
      if(!dependentOnly&&opened&&!wasExpanded&&closeTrigger?.getAttribute?.('aria-expanded')==='true'){try{closeTrigger.click?.()}catch{} await wait(35)}
      return{options:options.map(o=>({value:o.value,displayValue:o.displayValue,active:true})),live:true,dependent:dependentOnly,targetMetadata:dependentOnly?{isDependentPicklist:true}:undefined};
    }
    const closeTrigger=findComboTrigger(descriptor)||trigger;
    if(opened&&!wasExpanded&&closeTrigger?.getAttribute?.('aria-expanded')==='true'){try{closeTrigger.click?.()}catch{} await wait(35)}

    // Fallback 1: inspect option nodes inside this field's own host/shadow root.
    // This intentionally does not scan a neighbouring or unrelated open combobox.
    const scoped=dependentOnly?[]:cleanOptions(FP.readOptions?.(descriptor?.host,descriptor?.element)||[]);
    if(scoped.length)return{options:scoped,live:true};

    // Fallback 2: re-hydrate record-type-aware UI API options at execution time. Some
    // recordings have no API name/catalogue because the Salesforce wrapper hid it at
    // capture time; resolve it from current field metadata rather than treating an
    // empty saved array as an empty picklist.
    const objectApi=target.objectApiName||descriptor?.objectApiName||state.lastContext?.objectApiName||detectContext().objectApiName||'';
    let apiName=target.apiName||descriptor?.apiName||target.fieldPath||descriptor?.fieldPath||'';
    let resolvedMeta=null;
    if(objectApi&&objectApi!=='Salesforce'){
      await FP.loadSalesforceMetadata?.(objectApi,objectApi===state.lastContext?.objectApiName?state.lastContext?.recordId||'':'').catch(()=>null);
      if(!apiName){
        resolvedMeta=FP.resolveFieldMetadata?.({objectApiName:objectApi,apiName:target.apiName,name:target.name,fieldPath:target.fieldPath,label:target.label||descriptor?.label,kind:'picklist',allowLabelFallback:true})||null;
        apiName=resolvedMeta?.apiName||'';
      }
      let fieldMeta=FP.getFieldMetadata?.(apiName,objectApi)||resolvedMeta?.meta||null;
      if(!fieldMeta){
        resolvedMeta=FP.resolveFieldMetadata?.({objectApiName:objectApi,apiName,name:target.name||descriptor?.name,fieldPath:target.fieldPath||descriptor?.fieldPath,label:target.label||descriptor?.label,kind:'picklist',allowLabelFallback:true})||null;
        if(resolvedMeta?.apiName)apiName=resolvedMeta.apiName;
        fieldMeta=resolvedMeta?.meta||FP.getFieldMetadata?.(apiName,objectApi)||null;
      }
      fieldMeta=fieldMeta||{};
      const recordId=objectApi===state.lastContext?.objectApiName?state.lastContext?.recordId||'':'';
      const recordTypeId=await FP.getRecordTypeId?.(objectApi,recordId)||'';
      const data=apiName?await FP.loadFieldPicklistData?.(objectApi,recordTypeId,apiName).catch(()=>null):null;
      const metadataOptions=cleanOptions(data?.values?.length?data.values:(fieldMeta?.picklistValues||[]));
      // Never use the recorded option list for explicitly dependent picklists. It
      // represents the controller value at recording time (e.g. Division = North),
      // not the choices for the value selected during this Autofill run (e.g. South).
      const fallback=metadataOptions.length?metadataOptions:(dependentOnly?[]:cleanOptions(target.options));
      const controllerName=data?.controllerName||fieldMeta?.controllerName||fieldMeta?.controllerField||target.controllerName||target.controllingFields?.[0]||fieldMeta?.controllingFields?.[0]||'';
      const controllingFields=Array.isArray(fieldMeta?.controllingFields)?fieldMeta.controllingFields.slice():(target.controllingFields|| (controllerName?[controllerName]:[]));
      const controllerValues=data?.controllerValues&&Object.keys(data.controllerValues).length?data.controllerValues:(target.controllerValues||{});
      const isDependent=!!(controllerName||controllingFields.length||Object.keys(controllerValues).length||fallback.some(o=>Array.isArray(o.validFor)?o.validFor.length>0:(typeof o.validFor==='string'&&o.validFor.length>0)));
      const targetMetadata={...(apiName?{apiName}:{}),objectApiName:objectApi,options:fallback,controllerName:controllerName||undefined,controllingFields,controllerValues,isDependentPicklist:isDependent};
      const enrichedStep={...step,target:{...target,...targetMetadata}};
      const filtered=filterDependentPicklistOptions(enrichedStep,descriptor,fallback);
      if(filtered.options?.length&&(!dependentOnly||filtered.dependent))return{options:filtered.options,live:false,dependent:filtered.dependent,targetMetadata};
      if(dependentOnly)return{options:[],live:false,dependent:true,error:filtered.error||'Salesforce did not expose valid options for the current controlling value. Confirm the controlling field is filled first, then retry.',targetMetadata};
      if(filtered.dependent)return{options:[],live:false,dependent:true,error:filtered.error||'No dependent options are currently available for the selected controlling value.',targetMetadata};
      if(fallback.length)return{options:fallback,live:false,dependent:false,targetMetadata};
    }
    if(dependentOnly)return{options:[],live:false,dependent:true,error:'Could not retrieve the options Salesforce makes available for the current controlling value. Confirm the controlling field is filled first and try again.'};
    const fallback=cleanOptions(target.options);
    const filtered=filterDependentPicklistOptions(step,descriptor,fallback);
    return{options:filtered.options||[],live:false,dependent:filtered.dependent,error:filtered.error,targetMetadata:undefined};
  }



  async function preflightRecording(recording){
    // Preflight is advisory only. It must never become a global execution gate because
    // Salesforce Lightning fields can be temporarily absent, disabled, or read-only
    // while the page is still rendering. executeStep() owns the authoritative per-field
    // recovery/validation path.
    const report={ok:true,checked:0,missing:[],invalid:[],warnings:[],objects:[]};
    const steps=Array.isArray(recording?.steps)?recording.steps.filter(s=>s?.enabled!==false):[];
    report.objects=[...new Set(steps.map(s=>s?.target?.objectApiName).filter(Boolean))];
    for(const step of steps){
      const index=Number.isFinite(Number(step?.sequence))?Number(step.sequence)-1:report.checked;
      report.checked++;
      const t=step?.target||{},d=resolveTarget(t),label=t.label||t.apiName||t.name||'Field';
      if(!d){
        report.missing.push({index,label,target:t,reason:'Target was not available during the advisory preflight snapshot; execution will retry resolution.'});
        continue;
      }
      const expected=String(t.kind||'').toLowerCase(),actual=String(d.kind||'').toLowerCase();
      // Kind mismatches are recoverable. The live Salesforce field component is the
      // source of truth; executeStep() will repair the action/value semantics to match it.
      if(expected&&actual&&expected!==actual){
        report.warnings.push({index,label,recordedKind:expected,currentKind:actual,reason:`Recorded as ${expected} but current control is ${actual}; replay will use the current control type.`,repaired:true});
      }
      if(d.readOnly||d.disabled){
        report.warnings.push({index,label,reason:'Field was temporarily unavailable during the advisory snapshot; replay will wait for Salesforce to make it interactive.',repaired:true});
      }
    }
    // Intentionally always true: advisory findings belong in diagnostics, while field
    // execution and the Stop on first failure setting decide what actually stops a run.
    report.ok=true;
    return report;
  }

  function explicitReadonly(d){return !!(d?.element?.readOnly||d?.element?.getAttribute?.('aria-readonly')==='true'||d?.host?.readOnly===true||d?.host?.getAttribute?.('aria-readonly')==='true'||(['picklist','multi-picklist'].includes(String(d?.kind||''))&&(findComboTrigger(d)?.readOnly===true||findComboTrigger(d)?.getAttribute?.('aria-readonly')==='true')));}
  function liveInteractiveDisabled(d){
    if(!d)return true;
    const kind=String(d.kind||'');
    if(['picklist','multi-picklist'].includes(kind)){
      const trigger=findComboTrigger(d)||findComboInput(d)||d.element;
      return !!(trigger?.disabled||trigger?.getAttribute?.('aria-disabled')==='true');
    }
    return !!d.disabled;
  }
  async function resolveTargetWithRetry(target,timeout=1800,interval=120){
    const deadline=Date.now()+timeout;
    let first=true;
    while(Date.now()<deadline){
      if(!first){
        FP.invalidateFieldCaches();
        for(const key of targetCacheKeys(target))state.targetCache.delete(key);
      }
      first=false;
      const d=resolveTarget(target);
      if(d)return d;
      await wait(Math.min(interval,Math.max(20,deadline-Date.now())));
    }
    FP.invalidateFieldCaches();
    for(const key of targetCacheKeys(target))state.targetCache.delete(key);
    return resolveTarget(target);
  }
  async function waitForEditableDescriptor(step,d,timeout=1500){
    const deadline=Date.now()+timeout;let current=d;
    while(Date.now()<deadline){
      if(current&&current.host?.isConnected===false&&current.element?.isConnected===false){
        const remaining=Math.max(300,deadline-Date.now());
        current=await resolveTargetWithRetry(step.target,Math.min(1200,remaining),120);
        if(!current)return null;
      }else{
        current=FP.refreshFieldDescriptor?.(current?.host)||current||d;
      }
      if(current&&(String(current.kind||'').toLowerCase()==='lookup'||(!explicitReadonly(current)&&!liveInteractiveDisabled(current))))return current;
      await wait(80);
    }
    return current;
  }
  async function executeStep(step,opts={}){
    let d=await resolveTargetWithRetry(step.target);
    if(!d)return{ok:false,status:'failed',code:'TARGET_NOT_FOUND',message:`${step.target.label||step.target.apiName||'Field'} could not be found after retrying.`};
    d=await waitForEditableDescriptor(step,d);
    if(!d)return{ok:false,status:'failed',code:'TARGET_NOT_FOUND',message:`${step.target.label||step.target.apiName||'Field'} could not be found after Salesforce rerendered the field.`};
    if((explicitReadonly(d)&&String(d.kind||'').toLowerCase()!=='lookup')||liveInteractiveDisabled(d))return{ok:false,status:'failed',code:'FIELD_NOT_EDITABLE',message:`${d.label} is not editable.`};
    let effectiveStep=repairStepForDescriptor(step,d);
    const before=valueFor(d),fillOnlyBlank=opts.fillOnlyBlank!==undefined?!!opts.fillOnlyBlank:state.replayFillOnly;
    if(fillOnlyBlank&&emptyValue(d,before)===false)return{ok:true,status:'skipped',code:'ALREADY_FILLED',message:'Field already has a value.',verified:false};
    let randomConfig=step?.randomization||effectiveStep?.randomization;
    let randomizationWarning='';
    const randomizerForValidation=window.ForcePilotRandomizer;
    if(randomConfig?.enabled){
      const configShape=!!(randomConfig&&typeof randomConfig==='object'&&!Array.isArray(randomConfig)&&(!('version' in randomConfig)||Number(randomConfig.version)===1)&&typeof randomConfig.enabled==='boolean'&&randomConfig.options&&typeof randomConfig.options==='object'&&!Array.isArray(randomConfig.options)&&JSON.stringify(randomConfig).length<=20000);
      const knownStrategy=configShape&&!!randomizerForValidation?.strategies?.(effectiveStep)?.some(item=>item.value===String(randomConfig.strategy||''));
      if(!configShape||!knownStrategy){randomConfig=null;randomizationWarning='Saved randomization settings were invalid; the recorded value was used.';}
    }
    let randomLookup=false,randomized=false,runState=state.randomizationRun,generatedStrategy='',generatedMetaPatch={};
    if(randomConfig?.enabled){
      if(!runState){runState={generatedByStep:new Map(),usedValues:new Set()};}
      if(!(runState.generatedByStep instanceof Map))runState.generatedByStep=new Map();
      if(!(runState.usedValues instanceof Set))runState.usedValues=new Set();
      const stepKey=String(step?.id||step?.meta?.recordedAt||step?.target?.key||`${step?.target?.label||d.label}:${step?.sequence||''}`);
      let generated=runState.generatedByStep.get(stepKey);
      if(!generated){
        const preferredNumericType=[d.sfDataType,d.salesforceType,effectiveStep.target?.sfDataType,effectiveStep.target?.salesforceType,effectiveStep.target?.fieldType].map(v=>String(v||'').toLowerCase()).find(v=>v==='currency'||v==='percent')||'';
        const liveTarget={...(effectiveStep.target||{}),kind:d.kind||effectiveStep.target?.kind,sfDataType:preferredNumericType||d.sfDataType||effectiveStep.target?.sfDataType,salesforceType:preferredNumericType||d.sfDataType||effectiveStep.target?.salesforceType,multiSelect:d.multiSelect??effectiveStep.target?.multiSelect,options:Array.isArray(d.options)&&d.options.length?d.options:(effectiveStep.target?.options||[]),controllerName:d.controllerName||effectiveStep.target?.controllerName,controllingFields:d.controllingFields||effectiveStep.target?.controllingFields,controllerValues:effectiveStep.target?.controllerValues||d.controllerValues,isDependentPicklist:d.isDependentPicklist??effectiveStep.target?.isDependentPicklist,length:d.length||effectiveStep.target?.length,scale:d.scale??effectiveStep.target?.scale,precision:d.precision??effectiveStep.target?.precision};
        const generator=window.ForcePilotRandomizer;
        if(!generator?.generate)return{ok:false,status:'failed',code:'RANDOMIZATION_UNAVAILABLE',message:'Randomization is enabled, but the generator is unavailable. Reload ForcePilot and try again.'};
        // The current DOM descriptor can be generically classified as `field` even
        // when the saved semantic type is a picklist. The configured strategy is the
        // reliable signal here: always resolve Salesforce options before generation.
        let effectiveRandomConfig=randomConfig;
        if(['picklist','dependentPicklist','multiPicklist'].includes(String(randomConfig.strategy||''))){
          // Use controller-aware option resolution only when Salesforce metadata or
          // the live option catalogue identifies a dependent picklist. The default
          // “Select a Random Option” strategy also applies to ordinary picklists, so
          // the strategy name alone must not force dependent-only resolution.
          const hasValidFor=Array.isArray(liveTarget.options)&&liveTarget.options.some(o=>Array.isArray(o?.validFor)?o.validFor.length>0:(typeof o?.validFor==='string'&&o.validFor.length>0));
          const metadataSaysDependent=!!(liveTarget.isDependentPicklist||liveTarget.controllerName||(Array.isArray(liveTarget.controllingFields)&&liveTarget.controllingFields.length)||Object.keys(liveTarget.controllerValues||{}).length||hasValidFor);
          const dependentOnly=metadataSaysDependent;
          const metadataOptions=dependentOnly?[]:(Array.isArray(effectiveStep.target?.options)&&effectiveStep.target.options.length?effectiveStep.target.options:liveTarget.options);
          const resolved=await randomizationPicklistOptions({...effectiveStep,target:{...liveTarget,options:metadataOptions}},d,{dependentOnly});
          if(resolved.targetMetadata)Object.assign(liveTarget,resolved.targetMetadata);
          if(resolved.options?.length){liveTarget.options=resolved.options;if(dependentOnly)effectiveRandomConfig={...randomConfig,strategy:'dependentPicklist',options:{...(randomConfig.options||{}),allowedValues:undefined}};}
          else if(resolved.dependent||dependentOnly)return{ok:false,status:'failed',code:'DEPENDENT_PICKLIST_OPTIONS_UNAVAILABLE',message:`Randomization: ${resolved.error||'No valid options are available for the current controlling value.'}`};
        }
        generated=generator.generate({...effectiveStep,target:liveTarget,randomization:effectiveRandomConfig},effectiveRandomConfig,runState);
        if(!generated?.ok)return{ok:false,status:'failed',code:'RANDOMIZATION_INVALID',message:`Randomization: ${generated?.error||'The configured value could not be generated.'}`};
        runState.generatedByStep.set(stepKey,generated);
      }
      generatedStrategy=generated.strategy||randomConfig.strategy||'';generatedMetaPatch=generated.metaPatch||{};
      if(generated.lookup){
        if(generated.lookupResolved){const meta={...(effectiveStep.meta||{})};if(generated.strategy==='lookupRandom')delete meta.createNewRecord;effectiveStep={...effectiveStep,value:generated.value,meta};}
        else randomLookup=true;
      }else if(!generated.preserveCreateWorkflow){
        const meta={...(effectiveStep.meta||{}),...(generated.metaPatch||{})};
        if(generated.strategy==='dateRange'){
          delete meta.dateMode;delete meta.dateOffsetDays;delete meta.dateExpression;delete meta.dateRecordedOn;
        }
        effectiveStep={...effectiveStep,value:generated.value,meta,randomization:randomConfig};
      }
      randomized=generated?.preserveCreateWorkflow ? false : true;
    }
    state.ignoreEvents=true;let result={ok:true};try{
      if(effectiveStep.action==='set-boolean'){const el=d.element||FP.controlForField(d.host);const want=!!effectiveStep.value;if(!!before!==want)el?.click?.();}
      else if(effectiveStep.action==='select-option')result=await fillPicklist(d,{value:effectiveStep.value,displayValue:effectiveStep.meta?.selectedDisplayValue||''});
      else if(effectiveStep.action==='set-multi-option')result=await fillMultiPicklist(d,effectiveStep.value);
      else if(effectiveStep.action==='select-lookup'){
        const savedLookup=effectiveStep.value;
        if(randomLookup){
          const generated=runState.generatedByStep.get(String(step?.id||step?.meta?.recordedAt||step?.target?.key||`${step?.target?.label||d.label}:${step?.sequence||''}`));
          result=await fillRandomLookup(d,generated?.searchTerm||'');
          if(result?.ok&&generated){generated.lookupResolved=true;generated.value={displayValue:result.selected||'',recordId:result.selectedRecordId||''};generated.selected=result.selected||'';generated.selectedRecordId=result.selectedRecordId||'';}
        }else{
          const lookupValue=savedLookup&&typeof savedLookup==='object'?savedLookup:{displayValue:String(savedLookup??(effectiveStep.meta?.lookupDisplayValue||'')),recordId:effectiveStep.meta?.lookupRecordId||effectiveStep.target?.referenceId||''};
          result=await fillLookup(d,lookupValue,effectiveStep.meta?.createNewRecord||null,{settings:opts.settings,fastOverwrite:!!opts.fastOverwrite});
        }
      }
      else if(effectiveStep.action==='set-address'){const ok=await fillAddress(d,effectiveStep.value);result={ok,reason:ok?'':'Could not fill address'};}
      else if(d.kind==='number'){result={ok:setSalesforceNumericValue(d,effectiveStep.value),value:salesforceNumericInputValue(d,effectiveStep.value)};if(!result.ok)result.reason='Numeric field control not found';}
      else{const el=d.element||FP.controlForField(d.host);if(!el)return{ok:false,reason:'Field control not found'};result={ok:setNative(el,valueForStep(d,effectiveStep))};}
    }finally{state.ignoreEvents=false}
    const runtimeGeneratedValue=()=>{if(!randomized)return undefined;if(effectiveStep.action==='select-lookup'){if(randomConfig?.strategy==='lookupRandom'&&randomLookup&&!result?.selected&&!result?.selectedRecordId)return undefined;return{displayValue:result?.selected||effectiveStep.value?.displayValue||'',recordId:result?.selectedRecordId||effectiveStep.value?.recordId||''};}return effectiveStep.value;};
    const randomResultDetails=()=>{const generatedValue=runtimeGeneratedValue();return{randomized:randomized&&generatedValue!==undefined,generatedValue,generationStrategy:generatedStrategy||randomConfig?.strategy||'',generationMetaPatch:generatedMetaPatch||{},...(randomizationWarning?{randomizationWarning}:{})};};
    if(!result?.ok)return{ok:false,status:'failed',code:'EXECUTION_FAILED',message:result?.reason||`Could not fill ${d.label}.`,workflowResults:result?.workflowResults||[],recordTypeLabel:result?.recordTypeLabel||'',...randomResultDetails()};
    await wait(opts.fastOverwrite?(d.kind==='multi-picklist'?220:55):(d.kind==='multi-picklist'?420:180));const fresh=FP.refreshFieldDescriptor?.(d.host)||d;const actual=valueFor(fresh);const settings=opts.settings||{verifyAfterReplay:true};let verified=true;
    if(settings.verifyAfterReplay){
      if(fresh.kind==='multi-picklist')verified=multiPicklistMatches(fresh,effectiveStep.value);
      else if(fresh.kind==='picklist')verified=pickMatches(fresh,{value:effectiveStep.value,displayValue:effectiveStep.meta?.selectedDisplayValue||result?.selected||''});
      else if(fresh.kind==='lookup'){const expectedLookupId=result?.mode==='lookup-create-new'?String(result?.selectedRecordId||''):(result?.selectedRecordId||effectiveStep.value?.recordId||effectiveStep.meta?.lookupRecordId||effectiveStep.target?.referenceId||'');verified=lookupSelectionEvidence(fresh,expectedLookupId,result?.selected||effectiveStep.value?.displayValue||effectiveStep.meta?.lookupDisplayValue||'');}
      else verified=FP.valuesEqual(fresh,actual,valueForStep(fresh,effectiveStep));
    }
    const verificationPending=!!result?.verificationSoft&&!verified;
    if(settings.verifyAfterReplay&&!verified&&!verificationPending)return{ok:false,status:'failed',code:'VERIFICATION_FAILED',message:`${fresh.label} did not show the ${randomized?'generated':'recorded'} value.`,...randomResultDetails()};
    return{ok:true,status:'filled',verified:!!verified,verification:verified?'verified':(verificationPending?'pending':'disabled'),verificationSoft:!!result?.verificationSoft,verificationPending,selected:result?.selected||'',workflowResults:result?.workflowResults||[],recordTypeLabel:result?.recordTypeLabel||'',...randomResultDetails()};
  }

  function selectedTruth(v){return!!v}

  async function replayRecording(recording,opts={}){
    if(!FP.isSalesforceHost())return{ok:false,code:'SALESFORCE_ONLY',executed:[]};
    const lock=await safeRuntimeSendMessage({type:'GET_RECORDING_LOCK'})||{recordingTabId:null};if(lock.recordingTabId)return{ok:false,code:'RECORDING_ACTIVE',message:'Stop recording before Autofill.',executed:[]};
    const replayContext=detectContext();
    const normalizedSteps=Array.isArray(recording?.steps)?recording.steps.map(step=>({...step,target:FP.normalizeTargetSchema?.(step?.target||{},recording?.context||replayContext)||step?.target||{}})):[];
    recording={...recording,context:{...(recording?.context||{}),objectApiName:recording?.context?.objectApiName||replayContext.objectApiName,objectLabel:recording?.context?.objectLabel||replayContext.objectLabel},steps:normalizedSteps};
    const recordingObject=String(recording.context?.objectApiName||'');if(!opts.multiFrame&&recordingObject&&recordingObject!=='Salesforce'&&replayContext.objectApiName&&replayContext.objectApiName!=='Salesforce'&&recordingObject.toLowerCase()!==String(replayContext.objectApiName).toLowerCase())return{ok:false,code:'RECORDING_OBJECT_MISMATCH',message:`This recording is for ${recordingObject}. Open a matching Salesforce record first.`,executed:[]};
    state.replaying=true;state.replayScope='page';state.replayModalRoot=null;state.recording=false;state.targetCache.clear();state.currentStepIndex=-1;state.randomizationRun={generatedByStep:new Map(),usedValues:new Set()};for(const key of (Array.isArray(opts.usedRandomizationValues)?opts.usedRandomizationValues:[])){if(typeof key==='string')state.randomizationRun.usedValues.add(key);}for(const [key,cached] of Object.entries(opts.reuseGeneratedValues||{})){if(key&&cached&&cached.ok)state.randomizationRun.generatedByStep.set(key,cached);}state.runId++;updatePresence();
    const executed=[];
    let preflight={ok:true,checked:0,missing:[],invalid:[],warnings:[],objects:[]};
    try{
      // Avoid a global metadata/picklist warm-up before the first field. It can
      // serialize many UI API requests and delay the first visible fill by tens of
      // seconds. Ordinary recorded values need no metadata fetch; randomized
      // picklists resolve current options just before their own field is executed.
      FP.invalidateFieldCaches();
      // The previous advisory preflight resolved every field before Autofill. It
      // was not a gate (report.ok is always true), but could hold the first field
      // behind dozens of synchronous DOM probes. Let executeStep resolve each field
      // on demand instead.
      preflight={ok:true,checked:0,missing:[],invalid:[],warnings:[],objects:[...new Set((recording.steps||[]).map(s=>s?.target?.objectApiName).filter(Boolean))]};
      const settings=await FP.getSettings();if(opts.stopOnFailure!==undefined)settings.stopOnFailure=!!opts.stopOnFailure;state.replayFillOnly=opts.fillOnlyBlank!==undefined?!!opts.fillOnlyBlank:settings.fillEmptyOnly!==false;state.replayInitial=new Map();
      const indexes=[];const only=Array.isArray(opts.onlyIndexes)?new Set(opts.onlyIndexes.map(Number)):null;const start=Math.max(0,Number(opts.startIndex||0));
      for(let i=0;i<(recording.steps||[]).length;i++){if(i<start)continue;if(only&&!only.has(i))continue;if(recording.steps[i].enabled===false)continue;indexes.push(i)}
      for(const i of indexes){
        const progressIndex=Number.isFinite(Number(recording.steps[i]?.sequence))?Math.max(0,Number(recording.steps[i].sequence)-1):i;
        state.currentStepIndex=progressIndex;
        updatePresence();
        // Keep the panel's progress accurate even when a chunk of fields is replayed
        // in one frame message rather than one round trip per field.
        void safeRuntimeSendMessage({type:'FORCEPILOT_REPLAY_PROGRESS',index:progressIndex});
        let r;
        try{
          r=await executeStep(recording.steps[i],{fillOnlyBlank:state.replayFillOnly,settings,fastOverwrite:!!opts.fastOverwrite});
        }catch(e){
          r={ok:false,status:'failed',code:'STEP_EXCEPTION',message:e?.message||'Unexpected error while filling this field.'};
        }
        executed.push({index:i,step:recording.steps[i],result:r});
        if(!r.ok&&settings.stopOnFailure)break;
      }
      return{ok:!executed.some(x=>!x.result.ok),failedAt:executed.find(x=>!x.result.ok)?.index,executed,fillOnlyBlank:state.replayFillOnly,preflight,usedRandomizationValues:[...(state.randomizationRun?.usedValues||[])]};
    }catch(e){
      return{ok:false,code:'AUTOFILL_RUNTIME_ERROR',message:e?.message||'Autofill could not be completed.',preflight,executed,fillOnlyBlank:state.replayFillOnly,usedRandomizationValues:[...(state.randomizationRun?.usedValues||[])]};
    }finally{
      state.replaying=false;
      state.randomizationRun=null;
      state.replayScope='page';
      state.replayModalRoot=null;
      state.currentStepIndex=-1;
      updatePresence();
    }
  }
  function updateRecordingStepRandomization(message){
    if(!state.recording)return{ok:false,code:'NOT_RECORDING',message:'Recording is not active.'};
    const stepId=String(message?.stepId||'').trim();
    let index=stepId?state.steps.findIndex(s=>String(s?.id||'')===stepId||String(s?.meta?.recordedAt||'')===stepId):-1;
    if(index<0&&!stepId)index=Number(message?.index);
    if(!Number.isInteger(index)||index<0||index>=state.steps.length)return{ok:false,code:'STEP_NOT_FOUND',message:'That recorded field is no longer in the active recording.'};
    const step=state.steps[index];
    const config=message?.randomization&&typeof message.randomization==='object'?JSON.parse(JSON.stringify(message.randomization)):null;
    if(message?.workflowChildIndex!==null&&message?.workflowChildIndex!==undefined&&Number.isInteger(Number(message.workflowChildIndex))){
      const children=step?.meta?.createNewRecord?.fields;
      const childIndex=Number(message.workflowChildIndex);
      if(!Array.isArray(children)||childIndex<0||childIndex>=children.length)return{ok:false,code:'WORKFLOW_CHILD_NOT_FOUND',message:'That related-record field is no longer in the captured workflow.'};
      if(config)children[childIndex].randomization=config;else delete children[childIndex].randomization;
    }else{
      if(config)step.randomization=config;else delete step.randomization;
    }
    updatePresence();
    return{ok:true,stepId:step.id||step.meta?.recordedAt||null,randomization:config};
  }

  async function removeRecordingStep(index,stepId=''){
    if(!state.recording)return{ok:false,code:'NOT_RECORDING',message:'Recording is not active.'};
    const identity=String(stepId||'').trim();
    // Multi-frame rows are globally sorted in the panel, so a visible row index is
    // not a reliable index in this frame. Prefer the immutable step ID/timestamp.
    let i=identity?state.steps.findIndex(s=>String(s?.id||'')===identity||String(s?.meta?.recordedAt||'')===identity):-1;
    if(i<0&&identity)return{ok:false,code:'STEP_NOT_FOUND',message:'That recorded field is no longer in this Salesforce frame.'};
    if(i<0)i=typeof index==='string'?state.steps.findIndex(s=>s?.id===index||s?.meta?.recordedAt===index):Number(index);
    if(!Number.isInteger(i)||i<0||i>=state.steps.length)return{ok:false,code:'INVALID_STEP',message:'That field is no longer in the recording.'};
    const removed=state.steps.splice(i,1)[0];
    const removedKey=removed?.target?.key;
    if(removedKey){state.touched.delete(removedKey);state.touchedDescriptors.delete(removedKey);state.baselines.delete(removedKey);state.lastCommitted.delete(removedKey);state.appendExistingKeys.delete(removedKey);state.targetCache.delete(removedKey)}
    state.steps.forEach((step,n)=>{step.sequence=n+1});
    updatePresence();
    return{ok:true,removedStepId:removed?.id||identity||null,steps:state.steps};
  }
  function syncHighlightTheme(){
    const overlay=document.getElementById('forcepilot-focus-highlight-overlay');
    if(!overlay)return;
    overlay.style.setProperty('--fp-highlight-color',state.darkMode?'#63b5ff':'#1976d2');
    overlay.style.setProperty('--fp-highlight-shadow',state.darkMode?'rgba(99,181,255,.24)':'rgba(25,118,210,.18)');
  }

  function highlightFieldTarget(d){
    if(!d)return;
    const raw=d.element||FP.controlForField(d.host)||d.host;
    let target=raw;
    try{
      target=raw?.closest?.('.slds-form-element,[data-target-selection-name],lightning-input-field,lightning-input,lightning-combobox,lightning-dual-listbox,lightning-lookup,lightning-record-picker')||d.host||raw;
    }catch{}
    if(!target)return;
    const overlayId='forcepilot-focus-highlight-overlay';
    const previous=document.getElementById(overlayId);
    if(previous){previous.remove();}
    try{
      const overlay=document.createElement('div');
      overlay.id=overlayId;
      overlay.setAttribute('aria-hidden','true');
      overlay.style.cssText='--fp-highlight-color:#1976d2;--fp-highlight-shadow:rgba(25,118,210,.18);position:fixed;pointer-events:none;z-index:2147483647;border:2px solid var(--fp-highlight-color);box-shadow:0 0 0 2px var(--fp-highlight-shadow);border-radius:6px;box-sizing:border-box;transition:top .12s ease,left .12s ease,width .12s ease,height .12s ease;';
      syncHighlightTheme();
      (document.body||document.documentElement).appendChild(overlay);
      const update=()=>{
        try{
          if(!target.isConnected){overlay.remove();return;}
          const r=target.getBoundingClientRect();
          if(!r||r.width<=0||r.height<=0){overlay.remove();return;}
          overlay.style.top=`${Math.max(0,r.top)}px`;
          overlay.style.left=`${Math.max(0,r.left)}px`;
          overlay.style.width=`${Math.max(0,r.width)}px`;
          overlay.style.height=`${Math.max(0,r.height)}px`;
        }catch{}
      };
      update();
      requestAnimationFrame(update);
      requestAnimationFrame(()=>requestAnimationFrame(update));
      const onScroll=()=>update();
      window.addEventListener('scroll',onScroll,true);
      window.addEventListener('resize',onScroll,true);
      clearTimeout(window.__forcePilotHighlightTimer);
      window.__forcePilotHighlightTimer=setTimeout(()=>{
        window.removeEventListener('scroll',onScroll,true);
        window.removeEventListener('resize',onScroll,true);
        overlay.remove();
      },2200);
    }catch{}
  }
  async function focusField(target){const d=resolveTarget(target);if(!d)return{ok:false};const el=d.element||FP.controlForField(d.host)||d.host;try{el?.scrollIntoView?.({behavior:'smooth',block:'center'})}catch{}try{el?.focus?.({preventScroll:true})}catch{}highlightFieldTarget(d);return{ok:true}}

  async function overwriteStep(recording,index,opts={}){
    const idx=Number(index);
    if(!recording||!Array.isArray(recording.steps)||!Number.isInteger(idx))return{ok:false,executed:[]};
    const step=recording.steps[idx];
    if(!step)return{ok:false,executed:[]};
    // Reuse the proven replay pipeline for a single field. This keeps all of the
    // required Salesforce metadata hydration, picklist hydration, target repair,
    // lookup handling, and verification behavior identical to normal Autofill.
    return replayRecording(recording,{onlyIndexes:[idx],fillOnlyBlank:false,fastOverwrite:true,multiFrame:!!opts.multiFrame});
  }
  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg?.type==='PREPARE_TEST_CAPTURE'){
      (async()=>{
        try{
          const root=state.overlay||document.getElementById('forcepilot-root');
          const highlight=document.getElementById('forcepilot-focus-highlight-overlay');
          const extra=[...document.querySelectorAll('[data-forcepilot-launcher], .forcepilot-launcher')].filter(el=>el!==root);
          state.captureHidden={
            elements:[root,highlight,...extra].filter(Boolean).map(el=>({el,visibility:el.style.visibility,display:el.style.display})),
            scrollbarStyle:null
          };
          state.captureHidden.elements.forEach(({el})=>{el.style.visibility='hidden';el.style.display='none';});
          const scrollbarStyle=document.createElement('style');
          scrollbarStyle.dataset.forcepilotCaptureStyle='true';
          scrollbarStyle.textContent='html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}';
          document.documentElement.appendChild(scrollbarStyle);
          state.captureHidden.scrollbarStyle=scrollbarStyle;
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          sendResponse({ok:true});
        }catch(error){sendResponse({ok:false,message:error?.message||'Could not hide ForcePilot overlays.'});}
      })();
      return true;
    }
    if(msg?.type==='RESTORE_TEST_CAPTURE'){
      try{
        const hidden=state.captureHidden;
        if(hidden?.scrollbarStyle?.isConnected) hidden.scrollbarStyle.remove();
        if(Array.isArray(hidden?.elements)) hidden.elements.forEach(({el,visibility,display})=>{if(el){el.style.visibility=visibility||'';el.style.display=display||'';}});
        state.captureHidden=null;
        sendResponse({ok:true});
      }catch(error){sendResponse({ok:false,message:error?.message||'Could not restore ForcePilot overlays.'});}
      return false;
    }
    if(msg?.type==='GET_CONTEXT'){
      const detected=detectContext();
      // Context is rebuilt from the current Salesforce URL/DOM on every request.
      // Do not merge the prior object back in; that is unsafe during SPA navigation.
      state.lastContext={...detected};
      sendResponse(state.lastContext);
      if(state.lastContext.objectApiName&&state.lastContext.objectApiName!=='Salesforce'){
        FP.loadSalesforceMetadata(state.lastContext.objectApiName,state.lastContext.recordId).then(info=>{
          if(info){
            state.lastContext={...state.lastContext,objectLabel:info.label||state.lastContext.objectLabel,objectLabelPlural:info.labelPlural||info.label||state.lastContext.objectLabel};
          }
        }).catch(()=>{});
      }
      return;
    }
    if(msg?.type==='REFRESH_CONTEXT'){
      (async()=>{
        const detected=detectContext();
        state.lastContext={...detected};
        if(detected.objectApiName&&detected.objectApiName!=='Salesforce'){
          const info=await FP.loadSalesforceMetadata(detected.objectApiName,detected.recordId).catch(()=>null);
          if(info){
            state.lastContext={...state.lastContext,objectLabel:info.label||detected.objectLabel,objectLabelPlural:info.labelPlural||info.label||detected.objectLabel};
          }
        }
        sendResponse(state.lastContext);
      })();
      return true;
    }if(msg?.type==='GET_FIELD_DESCRIPTORS'){
      (async()=>{try{
        const ctx=detectContext();
        await FP.loadSalesforceMetadata(ctx.objectApiName,ctx.recordId);
        const targets=Array.isArray(msg.targets)?msg.targets:[];
        const targetObjects=new Set(targets.map(t=>t?.objectApiName).filter(x=>x&&x!=='Salesforce'));
        await Promise.all([...targetObjects].filter(x=>x!==ctx.objectApiName).map(obj=>FP.loadSalesforceMetadata(obj,'').catch(()=>null)));
        const descriptors=targets.map(t=>({target:t,d:resolveTarget(t)})).filter(x=>x.d);
        const info=FP.loadSalesforceMetadata?await FP.loadSalesforceMetadata(ctx.objectApiName,ctx.recordId):null;
        await Promise.all(descriptors.filter(x=>['picklist','multi-picklist'].includes(x.d.kind)&&x.d.apiName).map(async x=>{
          const objectApi=x.d.objectApiName||ctx.objectApiName;const infoForObject=objectApi===ctx.objectApiName?info:await FP.loadSalesforceMetadata(objectApi,'').catch(()=>null);const recordIdForObject=objectApi===ctx.objectApiName?ctx.recordId:'';const rt=await FP.getRecordTypeId?.(objectApi,recordIdForObject)||infoForObject?.defaultRecordTypeId||'012000000000000AAA';
          const data=await FP.loadFieldPicklistData?.(objectApi,rt,x.d.apiName).catch(()=>null);const fieldMeta=FP.getFieldMetadata?.(x.d.apiName,objectApi)||null;
          if(data?.values?.length||data?.controllerValues||fieldMeta?.controllerName||fieldMeta?.controllingFields){x.d={...x.d,options:data?.values?.length?data.values:(x.d.options||[]),controllerValues:data?.controllerValues||x.d.controllerValues,controllerName:x.d.controllerName||fieldMeta?.controllerName||fieldMeta?.controllerField,controllingFields:Array.isArray(fieldMeta?.controllingFields)?fieldMeta.controllingFields:(x.d.controllingFields||[]),isDependentPicklist:!!(fieldMeta?.controllerName||fieldMeta?.controllingFields?.length||Object.keys(data?.controllerValues||{}).length)};}
        }));
        const out=await Promise.all(descriptors.map(async({target,d})=>{
          let enriched=d;
          // Generic final metadata enrichment. Some Salesforce Lightning controls
          // expose only a label target and put no API name on the live DOM control.
          // Since object metadata is already loaded above, resolve the field by
          // label + detected kind when the descriptor still lacks an API name.
          if(enriched){
            const objectApi=enriched.objectApiName||target?.objectApiName||ctx.objectApiName||'';
            const parsed=FP.parseTargetSelectionName?.(target?.targetSelectionName)||null;
            const label=enriched.label||target?.label||parsed?.labelHint||'';
            if(!enriched.apiName && objectApi && label){
              const m=FP.resolveFieldMetadata?.({objectApiName:objectApi,label,kind:enriched.kind||target?.kind,allowLabelFallback:true});
              if(m?.apiName){
                enriched={...enriched,apiName:m.apiName,fieldPath:enriched.fieldPath||m.apiName,objectApiName:objectApi,metadataBacked:true,sfDataType:enriched.sfDataType||m.meta?.dataType||'',fieldType:enriched.fieldType||FP.canonicalFieldType({sfDataType:m.meta?.dataType,kind:enriched.kind}),type:enriched.type||m.meta?.dataType||enriched.kind};
                enriched.key=FP.chooseStableFieldKey({objectApiName:objectApi,apiName:m.apiName,name:enriched.name,label:enriched.label,targetSelectionName:enriched.targetSelectionName,fieldPath:m.apiName});
              }
            }
          }
          // Resolve API name by label first, then fetch the record-type-aware option
          // catalog. Previously options were fetched before label fallback, so these
          // Lightning picklists stayed without choices in the Edit UI.
          if(enriched&&['picklist','multi-picklist'].includes(String(enriched.kind||'').toLowerCase())&&enriched.apiName){
            try{
              const objectApi=enriched.objectApiName||target?.objectApiName||ctx.objectApiName||'';
              if(objectApi&&objectApi!=='Salesforce'){
                const infoForObject=objectApi===ctx.objectApiName?info:await FP.loadSalesforceMetadata(objectApi,'').catch(()=>null);
                const recordIdForObject=objectApi===ctx.objectApiName?ctx.recordId:'';
                const rt=await FP.getRecordTypeId?.(objectApi,recordIdForObject)||infoForObject?.defaultRecordTypeId||'012000000000000AAA';
                const data=await FP.loadFieldPicklistData?.(objectApi,rt,enriched.apiName).catch(()=>null);
                const fieldMeta=FP.getFieldMetadata?.(enriched.apiName,objectApi)||null;
                if(data?.values?.length||data?.controllerValues||fieldMeta?.controllerName||fieldMeta?.controllingFields){enriched={...enriched,options:data?.values?.length?data.values:(enriched.options||[]),controllerValues:data?.controllerValues||enriched.controllerValues,controllerName:enriched.controllerName||fieldMeta?.controllerName||fieldMeta?.controllerField,controllingFields:Array.isArray(fieldMeta?.controllingFields)?fieldMeta.controllingFields:(enriched.controllingFields||[]),isDependentPicklist:!!(fieldMeta?.controllerName||fieldMeta?.controllingFields?.length||Object.keys(data?.controllerValues||{}).length)};}
              }
            }catch{}
          }
          return {
            targetKey:target?.key||'',
            resolvedTargetKey:enriched?.key||'',
            label:enriched?.label||target?.label||'',
            apiName:(enriched?.apiName&&!/^label:/i.test(String(enriched.apiName)))?enriched.apiName:'',
            name:enriched?.name,
            kind:enriched?.kind||target?.kind,
            fieldType:enriched?FP.canonicalFieldType(enriched):target?.fieldType||target?.kind,
            sfDataType:enriched?.sfDataType||'',
            salesforceType:enriched?.sfDataType||'',
            reference:enriched?.reference,
            referenceObject:enriched?.referenceObject,
            multiSelect:enriched?.multiSelect,
            objectApiName:enriched?.objectApiName||target?.objectApiName||ctx.objectApiName,
            targetSelectionName:enriched?.targetSelectionName||target?.targetSelectionName,
            fieldId:enriched?.fieldId||target?.fieldId,
            fieldPath:enriched?.fieldPath,
            identitySource:enriched?.identitySource,
            identityConfidence:enriched?.identityConfidence,
            dataTableColumnKey:enriched?.dataTableColumnKey,
            dataTableFieldApiName:enriched?.dataTableFieldApiName,
            controllerName:enriched?.controllerName||undefined,controllingFields:Array.isArray(enriched?.controllingFields)?enriched.controllingFields.slice():[],controllerValues:enriched?.controllerValues||undefined,isDependentPicklist:!!enriched?.isDependentPicklist,options:Array.isArray(enriched?.options)?enriched.options.map(o=>({value:o.value,displayValue:o.displayValue,active:o.active,validFor:o.validFor})):[]
          };
        }));
        sendResponse({ok:true,descriptors:out,context:ctx});
      }catch(e){sendResponse({ok:false,error:e?.message||'Could not resolve field metadata.'})}})();return true;
    }
    if(msg?.type==='GET_RECORDING_STATE'){const capture=state.lookupCreationCapture;const captureModal=capture?.modalRoot||null;const chooser=captureModal?recordTypeChooserState(captureModal):null;sendResponse({recording:state.recording,paused:state.paused,replaying:state.replaying,steps:state.steps,context:state.lastContext||detectContext(),currentStepIndex:state.currentStepIndex,pendingRecording:state.pendingRecording,lookupCreation:capture?{active:true,lookupLabel:capture.lookupLabel||capture.lookupTarget?.label||'Lookup',objectLabel:capture.objectLabel||'record',recordTypeLabel:capture.recordTypeLabel||'',fieldCount:capture.fields?.length||0,stage:!capture.modalSeen?'opening':chooser?'record-type':'fields'}:null});return}if(msg?.type==='RESOLVE_TARGET_FRAME'){sendResponse({ok:!!resolveTarget(msg.target)});return false}if(msg?.type==='START_RECORDING'){startRecording({appendRecording:msg.appendRecording||null,recordingId:msg.recordingId,recordingDate:msg.recordingDate,multiFrame:!!msg.multiFrame,appendExistingKeys:msg.appendExistingKeys||[]}).then(sendResponse).catch(e=>sendResponse({ok:false,message:e?.message||'Could not start recording.'}));return true}if(msg?.type==='PAUSE_RECORDING'){sendResponse(setRecordingPaused(true));return false}if(msg?.type==='RESUME_RECORDING'){sendResponse(setRecordingPaused(false));return false}if(msg?.type==='CLEAR_PENDING_RECORDING'){state.pendingRecording=null;sendResponse({ok:true});return false}if(msg?.type==='STOP_RECORDING'){stopRecording({deferSave:!!msg.multiFrame}).then(sendResponse).catch(e=>sendResponse({ok:false,message:e?.message||'Could not stop recording.'}));return true}if(msg?.type==='REPLAY_RECORDING'){replayRecording(msg.recording,msg).then(sendResponse).catch(e=>sendResponse({ok:false,executed:[],error:e?.message||'Autofill could not be completed.'}));return true}if(msg?.type==='OVERWRITE_STEP'){overwriteStep(msg.recording,msg.index,{multiFrame:!!msg.multiFrame}).then(sendResponse).catch(e=>sendResponse({ok:false,executed:[],error:e?.message||'Could not use the recorded value.'}));return true}if(msg?.type==='REMOVE_RECORDING_STEP'){removeRecordingStep(msg.index,msg.stepId||'').then(sendResponse).catch(e=>sendResponse({ok:false,error:e?.message||'Could not remove the field.'}));return true;}if(msg?.type==='UPDATE_RECORDING_STEP_RANDOMIZATION'){sendResponse(updateRecordingStepRandomization(msg));return false;}if(msg?.type==='FOCUS_FIELD'){focusField(msg.target).then(sendResponse);return true}return false});
  // Warm Salesforce metadata as soon as the content script is ready. This keeps type resolution
  // independent from the timing of the first Record/field-change event.
  try{const bootContext=detectContext();if(bootContext.objectApiName&&bootContext.objectApiName!=='Salesforce')FP.loadSalesforceMetadata(bootContext.objectApiName,bootContext.recordId).catch(()=>{});}catch{}
  let overlayEnabled=true;
  FP.getSettings().then(s=>{state.darkMode=s.darkMode===true;state.launcherMode=s.launcherMode==='current'?'bubble':(['edge','bubble','off'].includes(s.launcherMode)?s.launcherMode:'edge');overlayEnabled=s.showOverlay!==false&&state.launcherMode!=='off';if(overlayEnabled)ensureOverlay();}).catch(()=>{overlayEnabled=false;state.launcherMode='off';try{state.overlay?.remove();}catch{}state.overlay=null;});
  if(chrome.storage?.onChanged?.addListener) chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local'||!changes[FP.SETTINGS_KEY])return;const next=changes[FP.SETTINGS_KEY].newValue||{};state.darkMode=next.darkMode===true;state.launcherMode=next.launcherMode==='current'?'bubble':(['edge','bubble','off'].includes(next.launcherMode)?next.launcherMode:'edge');overlayEnabled=next.showOverlay!==false&&state.launcherMode!=='off';if(overlayEnabled){ensureOverlay();applyLauncherMode(state.launcherMode);updatePresence();syncHighlightTheme();}else{try{state.overlay?.remove();}catch{}state.overlay=null;syncHighlightTheme();}});
})();
