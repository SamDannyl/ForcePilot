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
  window.__FORCEPILOT_CONTENT_READY__=true;
  const FP=window.ForcePilotShared;
  if(!FP||!FP.isSalesforceHost()) return;

  const BRIDGE_BUILD='1.5';
  const state={
    recording:false,paused:false,replaying:false,recordingId:null,recordingDate:null,dateRelativeToToday:true,steps:[],currentStepIndex:-1,lastContext:null,
    baselines:new Map(),lastCommitted:new Map(),touched:new Set(),touchedDescriptors:new Map(),inputTimers:new Map(),reconcileTimer:0,
    replayInitial:new Map(),replayFillOnly:true,ignoreEvents:false,overlay:null,observer:null,bridgeToken:id(),
    runId:0,metadataPromise:null,targetCache:new Map(),appendOnly:false,appendExistingKeys:new Set(),pendingRecording:null
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
  const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  function inferObjectLabel(objectApiName){
    const api=String(objectApiName||'');
    const selectors=['one-app-nav-bar-item-root[aria-current="true"]','a[aria-current="page"]','button[aria-current="page"]','lightning-breadcrumbs [aria-current="page"]','lightning-breadcrumb a'];
    for(const sel of selectors){try{const el=document.querySelector(sel);const t=FP.normalizeText(el?.textContent||'');if(t&&t.length<80&&!/^home$/i.test(t))return t}catch{}}
    try{const title=FP.normalizeText(document.title);const m=title.match(/\|\s*([^|]+)$/);if(m&&m[1]&&!/salesforce|edit|new record/i.test(m[1]))return m[1]}catch{}
    const core=api.replace(/^.*__/,'').replace(/__c$/i,'').replace(/^APTS_/i,'').replace(/_/g,' ').trim();
    return core || api;
  }

  function detectContext(){
    const path=location.pathname;
    const rec=path.match(/\/lightning\/r\/([^/]+)\/([A-Za-z0-9]{15,18})(?:\/|$)/i),obj=path.match(/\/lightning\/o\/([^/]+)(?:\/|$)/i);
    const objectApiName=document.documentElement.dataset.sfObject||document.querySelector('[data-sf-object]')?.getAttribute('data-sf-object')||rec?.[1]||obj?.[1]||'';
    const objectLabel=document.documentElement.dataset.sfObjectLabel||document.querySelector('[data-sf-object-label]')?.getAttribute('data-sf-object-label')||inferObjectLabel(objectApiName)||objectApiName||'Salesforce';
    const recordId=document.documentElement.dataset.sfRecordId||rec?.[2]||'';
    const mode=/\/new(?:\/|$)|\/edit(?:\/|$)|\/e\//i.test(path)?'edit':recordId?'view':'new';
    return{objectApiName:objectApiName||'Salesforce',objectLabel,recordId,stage:'',mode,origin:location.origin,url:location.href};
  }

  // Floating ForcePilot launcher. Fixed bottom-right, no drag, no expanded hover state.
  const LAUNCHER_SIZE=48;
  const LAUNCHER_RIGHT=18;
  const LAUNCHER_BOTTOM_GAP=28;

  function ensureOverlay(){
    if(state.overlay)return;
    const root=document.createElement('button');
    root.id='forcepilot-root';
    root.type='button';
    root.setAttribute('aria-label','Open ForcePilot');
    root.title='Open ForcePilot';
    root.innerHTML='<span class="fp-beacon-logo"><img src="'+chrome.runtime.getURL('branding/forcepilot-icon.png')+'" alt=""/><span class="fp-status-badge" aria-hidden="true"></span></span>';
    const style=document.createElement('style');
    style.textContent=`
#forcepilot-root{position:fixed!important;right:${LAUNCHER_RIGHT}px!important;left:auto!important;top:auto!important;bottom:${LAUNCHER_BOTTOM_GAP}px!important;width:${LAUNCHER_SIZE}px!important;height:${LAUNCHER_SIZE}px!important;box-sizing:border-box!important;margin:0!important;padding:2px!important;z-index:2147483646!important;border:0!important;border-radius:0!important;background:transparent!important;display:grid!important;place-items:center!important;overflow:visible!important;pointer-events:auto!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;-webkit-user-drag:none!important;appearance:none!important;outline:none!important;transition:transform .14s ease,filter .14s ease!important}
#forcepilot-root:hover{transform:translateY(-1px) scale(1.03)!important;filter:drop-shadow(0 3px 6px rgba(15,35,60,.18))!important}
#forcepilot-root:focus-visible{outline:2px solid rgba(11,120,208,.34)!important;outline-offset:3px!important;border-radius:8px!important}
#forcepilot-root .fp-beacon-logo{position:relative;width:42px;height:42px;display:grid;place-items:center;pointer-events:none}
#forcepilot-root .fp-beacon-logo img{width:42px;height:42px;object-fit:contain;display:block;filter:drop-shadow(0 2px 5px rgba(15,35,60,.16))}
#forcepilot-root .fp-status-badge{position:absolute;right:-1px;bottom:-1px;width:7px;height:7px;border-radius:50%;background:#2e844a;border:2px solid rgba(255,255,255,.96);box-sizing:content-box;box-shadow:0 1px 3px rgba(15,35,60,.16);pointer-events:none}
#forcepilot-root.recording .fp-status-badge,#forcepilot-root.replaying .fp-status-badge{background:#0b78d0}
#forcepilot-root.recording .fp-status-badge{animation:fp-status-pulse 1.4s ease-in-out infinite}
@keyframes fp-status-pulse{0%,100%{box-shadow:0 1px 3px rgba(15,35,60,.16),0 0 0 0 rgba(11,120,208,0)}50%{box-shadow:0 1px 3px rgba(15,35,60,.16),0 0 0 3px rgba(11,120,208,.10)}}
@media(max-width:500px){#forcepilot-root{right:12px!important}}
@media(prefers-reduced-motion:reduce){#forcepilot-root{transition:none!important}.fp-status-badge{animation:none!important}}
`;
    root.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      root.disabled = true;
      safeRuntimeSendMessage({type:'OPEN_SIDE_PANEL'}).finally(() => { root.disabled = false; });
    });
    document.documentElement.append(style,root);
    state.overlay=root;
    updatePresence();
  }
  function updatePresence(){
    const b=state.overlay;if(!b)return;
    b.classList.toggle('recording',state.recording);
    b.classList.toggle('replaying',state.replaying);
    b.classList.toggle('paused',state.paused);
    b.setAttribute('aria-label',state.recording?(state.paused?`Recording paused, ${state.steps.length} fields`:`Recording ${state.steps.length} fields`):state.replaying?`Autofill, field ${state.currentStepIndex+1}`:'Open ForcePilot');
  }
  function safeRuntimeSendMessage(message){
    try{if(!chrome?.runtime?.id)return Promise.resolve(null);const r=chrome.runtime.sendMessage(message);return r?.catch?.(()=>null)||Promise.resolve(r);}catch{return Promise.resolve(null);}
  }
  function recordingBeforeUnload(e){if(!state.recording)return;e.preventDefault();e.returnValue='';return '';}

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
  function valueFor(d){return FP.readValue(d)}
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
  function markTouched(e){
    if(!state.recording||state.ignoreEvents)return null;
    const d=FP.findDescriptorFromEvent(e);if(!d||d.disabled||d.readOnly)return null;
    const k=key(d);state.touched.add(k);state.touchedDescriptors.set(k,d);return d;
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
      state.touchedDescriptors.set(key(fresh),fresh);
      return fresh;
    }
    // Salesforce applies Currency/Percent formatting asynchronously on blur.
    // Re-read the same control a few times without changing the user's value.
    for(const delay of [80,160,280]){
      await wait(delay);
      fresh=FP.refreshFieldDescriptor?.(target)||fresh;
      const ft=String(fresh?.sfDataType||'').toLowerCase();
      if(['currency','percent','number','double','int','integer','long','decimal'].includes(ft)){
        state.touchedDescriptors.set(key(fresh),fresh);
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
    if(state.dateRelativeToToday!==false){
      const offsetDays=dateOffsetDays(recordedDate,recordedValue);
      return /^\d{4}-\d{2}-\d{2}$/.test(recordedValue)&&offsetDays!==null
        ? {dateRecordedOn:recordedDate,dateOffsetDays:offsetDays,dateMode:'relative'}
        : {};
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(recordedValue) ? {dateRecordedOn:recordedDate,dateMode:'absolute'} : {};
  }
  function selectedPicklistDisplayValue(d,value){if(d?.kind!=='picklist')return undefined;const n=FP.normalizeLabel(value);const hit=(d.options||[]).find(o=>FP.normalizeLabel(o?.value)===n||FP.normalizeLabel(o?.displayValue)===n);if(hit?.displayValue)return hit.displayValue;const trigger=findComboTrigger?.(d);const live=FP.normalizeText(trigger?.getAttribute?.('data-value')||trigger?.textContent||'');return live&&!FP.isPicklistPlaceholder(live)?live:undefined;}
  function makeStep(d,value,before,source,sequence){
    const normalizedValue=FP.normalizeRecordedValue(d,value);
    return{ id:id(),sequence,action:d.kind==='boolean'?'set-boolean':d.kind==='picklist'?'select-option':d.kind==='multi-picklist'?'set-multi-option':d.kind==='lookup'?'select-lookup':d.kind==='address'?'set-address':'set-value',
      target:{key:d.key,label:FP.normalizeText(d.label).replace(/^\s*\*\s*/,''),apiName:d.apiName,name:d.name,kind:d.kind,fieldType:FP.canonicalFieldType(d),sfDataType:d.sfDataType||'',salesforceType:d.sfDataType||'',reference:d.reference,referenceObject:d.referenceObject,referenceId:d.referenceId||undefined,multiSelect:d.multiSelect,objectApiName:d.objectApiName,targetSelectionName:d.targetSelectionName,fieldId:d.fieldId,fieldPath:d.fieldPath,identitySource:d.identitySource,identityConfidence:d.identityConfidence,options:Array.isArray(d.options)?d.options.map(o=>({value:o.value,displayValue:o.displayValue})):[],dataTableColumnKey:d.dataTableColumnKey||undefined,dataTableFieldApiName:d.dataTableFieldApiName||undefined},value:normalizedValue,before:FP.normalizeRecordedValue(d,before),meta:{source,recordedAt:new Date().toISOString(),...dateMetaForStep(d,value),selectedDisplayValue:d.kind==='picklist'?selectedPicklistDisplayValue(d,value):undefined,lookupDisplayValue:d.kind==='lookup'&&normalizedValue?.displayValue?normalizedValue.displayValue:undefined,lookupRecordId:d.kind==='lookup'&&normalizedValue?.recordId?normalizedValue.recordId:undefined}}
  }

  // Keep persisted values canonical when Salesforce upgrades a generic text control
  // to a Currency/Percent descriptor. The DOM may display $1.00 / 1.00%, but the
  // recording must retain only the underlying numeric value (1).
  function syncStepWithDescriptor(step,d){
    if(!step||!d)return step;
    const target={...(step.target||{})};
    step.value=FP.normalizeRecordedValue(d,step.value);
    if(step.before!==undefined)step.before=FP.normalizeRecordedValue(d,step.before);
    step.target={...target,
      key:d.key,label:d.label,apiName:d.apiName,name:d.name,kind:d.kind,
      fieldType:FP.canonicalFieldType(d),
      sfDataType:d.sfDataType||target.sfDataType||'',
      salesforceType:d.sfDataType||target.salesforceType||'',
      reference:d.reference,referenceObject:d.referenceObject,referenceId:d.referenceId||target.referenceId||undefined,
      multiSelect:d.multiSelect,objectApiName:d.objectApiName||target.objectApiName,
      targetSelectionName:d.targetSelectionName||target.targetSelectionName,fieldId:d.fieldId||target.fieldId,fieldPath:d.fieldPath||target.fieldPath,
      identitySource:d.identitySource||target.identitySource,identityConfidence:d.identityConfidence||target.identityConfidence,
      options:Array.isArray(d.options)?d.options.map(o=>({value:o.value,displayValue:o.displayValue})):target.options||[],
      dataTableColumnKey:d.dataTableColumnKey||target.dataTableColumnKey,dataTableFieldApiName:d.dataTableFieldApiName||target.dataTableFieldApiName
    };
    if(d.kind==='picklist'){const label=selectedPicklistDisplayValue(d,step.value);if(label)step.meta={...(step.meta||{}),selectedDisplayValue:label};}
    if(d.kind==='lookup'&&step.value&&typeof step.value==='object'){step.meta={...(step.meta||{}),lookupDisplayValue:step.value.displayValue||'',lookupRecordId:step.value.recordId||''};}
    return step;
  }

  function recordingValueIsEmpty(d,v){
    if(v===null||v===undefined)return true;
    const kind=String(d?.kind||'').toLowerCase();
    if(kind==='boolean')return v===false||String(v).trim().toLowerCase()==='false'; // unchecked/false is empty for recording capture; true remains a real value.
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

  function commitDescriptor(d,source){
    if(!state.recording||state.ignoreEvents||!d||d.disabled||d.readOnly||!state.touched.has(key(d)))return;
    const current=valueFor(d), normalized=FP.normalizeRecordedValue(d,current), last=lastFor(d), baseline=baselineFor(d);
    const existing=state.steps.find(s=>sameFieldTarget(s?.target,d));

    // Click/blur/focus events can reach a Salesforce field before the user actually
    // enters or selects anything. Never create a recording step for an empty value.
    if(recordingValueIsEmpty(d,normalized)){
      if(existing&&!state.appendOnly)removeRecordedStepForTarget(d);
      state.lastCommitted.set(key(d),normalized);
      updatePresence();
      return;
    }

    // Returning a field to its original value means there is no net change to record.
    if(baseline!==undefined&&FP.valuesEqual(d,baseline,normalized)){
      if(existing&&!state.appendOnly)removeRecordedStepForTarget(d);
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
    if(e.composedPath?.().some(n=>n===state.overlay||n?.id==='forcepilot-root'))return;
    const d=markTouched(e);if(!d)return;
    const target=d.host||d.element;
    if(e.type==='input'){
      clearTimeout(state.inputTimers.get(target));
      state.inputTimers.set(target,setTimeout(()=>{state.inputTimers.delete(target);commitDescriptor(d,'input')},300));return;
    }
    if(e.type==='change'||e.type==='blur'){
      if(d.kind==='multi-picklist'){
        const target=d.host||d.element;
        clearTimeout(state.inputTimers.get(target));
        state.inputTimers.set(target,setTimeout(()=>{state.inputTimers.delete(target);commitDescriptor(d,'selection-settled')},650));
      }else if(d.kind==='number' && ['','text','string','field','input','number'].includes(String(d?.sfDataType||'').toLowerCase())){
        const target=d.host||d.element;
        clearTimeout(state.inputTimers.get(target));
        state.inputTimers.set(target,setTimeout(async()=>{state.inputTimers.delete(target);const fresh=await refreshForCommit(d);commitDescriptor(fresh,e.type)},90));
      }else commitDescriptor(d,e.type);
    }
    if(e.type==='click'&&(d.kind==='picklist'||d.kind==='multi-picklist')){
      const target=d.host||d.element;
      const delay=d.kind==='multi-picklist'?650:220;
      clearTimeout(state.inputTimers.get(target));
      state.inputTimers.set(target,setTimeout(()=>{
        state.inputTimers.delete(target);
        commitDescriptor(d,d.kind==='multi-picklist'?'selection-settled':'selection');
      },delay));
    }
  }
  function reconcile(){if(!state.recording||state.paused||state.replaying)return;for(const d of state.touchedDescriptors.values())commitDescriptor(d,'reconcile')}
  function installListeners(){
    if(state.observer)return;
    for(const type of ['input','change','blur','click','pointerup'])document.addEventListener(type,onInteraction,true);
    state.reconcileTimer=setInterval(reconcile,1200);
    let cacheInvalidationQueued=false;
    state.observer=new MutationObserver(()=>{
      if(cacheInvalidationQueued)return;
      cacheInvalidationQueued=true;
      queueMicrotask(()=>{cacheInvalidationQueued=false;if(state.recording)FP.invalidateFieldCaches();});
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
      window.dispatchEvent(new CustomEvent('forcepilot-bridge-init',{detail:{version:BRIDGE_BUILD,requestId,token:nonce,id:targetId,action,expiresAt:Date.now()+2500}}));
      window.dispatchEvent(new CustomEvent('forcepilot-page-action',{detail:{id:targetId,action,value,requestId,token:nonce,version:BRIDGE_BUILD}}));
    });
  }

  function findComboInput(desc){for(const s of ['input[role="combobox"][data-value="lookup"]','input[role="combobox"].slds-combobox__input','input[role="combobox"]','input.slds-combobox__input','input.slds-input','input:not([type=hidden])']){const f=FP.deepQueryFirst(desc.host,s);if(f)return f}return desc.element?.matches?.('input')?desc.element:null}
  function findComboTrigger(desc){return desc.element?.getAttribute?.('role')==='combobox'?desc.element:FP.deepQueryFirst(desc.host,'button[role="combobox"],[role="combobox"]')}
  function optionRoots(desc){
    const roots=[desc.host,desc.element?.getRootNode?.()];
    const input=findComboInput(desc)||findComboTrigger(desc);
    const ids=[input?.getAttribute?.('aria-controls'),findComboTrigger(desc)?.getAttribute?.('aria-controls')].filter(Boolean);
    for(const id of ids){
      for(const root of FP.walkRoots()){try{const x=root.querySelector?.(`#${CSS.escape(id)}`);if(x)roots.unshift(x)}catch{}}
      try{const x=document.getElementById(id);if(x)roots.unshift(x)}catch{}
    }
    return[...new Set(roots.filter(Boolean))];
  }
  function optionMeta(el){if(!el)return null;const value=String(el.getAttribute?.('data-value')||el.getAttribute?.('value')||el.value||'').trim();const display=FP.normalizeText(el.getAttribute?.('data-label')||el.getAttribute?.('label')||el.getAttribute?.('title')||el.textContent||'');return{el,value:value||display,displayValue:display||value}}
  function isVisible(el){try{const r=el.getBoundingClientRect?.(),cs=getComputedStyle(el);return !!r&&r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'}catch{return false}}
  function livePicklistOptions(desc){const out=[],seen=new Set();for(const root of optionRoots(desc)){FP.deepQueryAll(root,'[role="option"],lightning-base-combobox-item,.slds-listbox__option,.slds-listbox__item,.slds-dropdown__item,[data-option-index]',300).forEach(el=>{if(seen.has(el)||!isVisible(el))return;const m=optionMeta(el);if(!m||!m.value||!m.displayValue||FP.isPicklistPlaceholder(m.displayValue))return;seen.add(el);out.push(m)})}return out}
  function pickMatches(desc,wanted){const expected=typeof wanted==='object'&&wanted?wanted:{value:String(wanted??''),displayValue:''};const values=[expected.value,expected.displayValue].map(FP.normalizeLabel).filter(Boolean);if(!values.length)return false;const trigger=findComboTrigger(desc);const triggerValues=[trigger?.getAttribute?.('data-value'),trigger?.getAttribute?.('value')].map(FP.normalizeLabel).filter(Boolean);if(triggerValues.some(v=>values.includes(v)))return true;const triggerText=FP.normalizeLabel(trigger?.textContent||'');if(triggerText&&!FP.isPicklistPlaceholder(triggerText)&&values.includes(triggerText))return true;const sel=FP.deepQueryFirst(desc.host,'[role="option"][aria-selected="true"],lightning-base-combobox-item[aria-selected="true"]');const m=optionMeta(sel);if(m&&(values.includes(FP.normalizeLabel(m.value))||values.includes(FP.normalizeLabel(m.displayValue))))return true;const actual=FP.normalizeLabel(FP.readValue(desc));return!!actual&&!FP.isPicklistPlaceholder(actual)&&values.includes(actual)}
  async function openCombobox(desc){
    const trigger=findComboTrigger(desc)||desc.element||desc.host;
    if(!trigger)return false;
    try{trigger.focus?.({preventScroll:true})}catch{}
    for(let i=0;i<4;i++){
      try{trigger.click?.()}catch{}
      await wait(90+i*50);
      if(livePicklistOptions(desc).length||trigger.getAttribute?.('aria-expanded')==='true')return true;
      // Searchable comboboxes sometimes expose the input only after the first click.
      const input=findComboInput(desc);
      if(input&&input!==trigger){try{input.focus?.({preventScroll:true});input.click?.()}catch{}await wait(70)}
    }
    return false;
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
    if(el)return[...el.selectedOptions].map(o=>({value:String(o.value||o.textContent).trim(),label:FP.normalizeText(o.textContent||o.value)})).filter(x=>!FP.isMultiPicklistPlaceholder?.(x.value)&&!FP.isMultiPicklistPlaceholder?.(x.label));
    return[];
  }
  function multiPicklistMatches(desc,value){
    const wanted=[...new Set((Array.isArray(value)?value:FP.parseMultiValues(value)).map(FP.normalizeLabel).filter(v=>v&&!FP.isMultiPicklistPlaceholder?.(v)))];
    const evidence=[...new Set(multiEvidence(desc).map(x=>FP.normalizeLabel(x.value||x.label)).filter(v=>v&&!FP.isMultiPicklistPlaceholder?.(v)))];
    return sameSet(evidence,wanted);
  }
  function multiHosts(desc){
    const host=desc?.host;
    return[host,FP.deepQueryFirst(host,'lightning-dual-listbox'),FP.deepQueryFirst(host,'select[multiple]'),FP.deepQueryFirst(host,'[aria-multiselectable="true"]')].filter((x,i,a)=>x&&a.indexOf(x)===i);
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
    const requested=values.map(FP.normalizeLabel);
    let matched=0;
    for(const option of [...el.options]){
      const ok=requested.includes(FP.normalizeLabel(option.value))||requested.includes(FP.normalizeLabel(option.textContent));
      option.selected=ok;if(ok)matched++;
    }
    if(matched!==requested.length)return false;
    el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    await wait(120);
    return sameSet([...el.selectedOptions].map(o=>o.value||o.textContent),values);
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
  function lookupRecordId(el){if(!el)return'';for(const a of ['data-record-id','data-recordid','data-record-id-value','data-id','record-id','data-lookup-id','data-selection-id']){try{const v=el.getAttribute?.(a);if(v&&/^[A-Za-z0-9]{15,18}$/.test(String(v).trim()))return String(v).trim()}catch{}}try{const href=el.getAttribute?.('href')||el.querySelector?.('a[href*="/lightning/r/"]')?.getAttribute?.('href')||'';const m=String(href).match(/\/lightning\/r\/[^/]+\/([A-Za-z0-9]{15,18})(?:\/|$)/i);return m?.[1]||''}catch{return''}}
  function lookupSelectionEvidence(d,expectedId,expectedLabel){const actual=FP.readValue(d);if(expectedId&&String(actual?.recordId||'')===String(expectedId))return true;const trigger=findComboTrigger(d),expanded=trigger?.getAttribute?.('aria-expanded')==='true';const expected=exactLookupText(expectedLabel);if(!expected||expanded)return false;const candidates=[actual?.displayValue,d?.element?.value,findComboInput(d)?.value,trigger?.getAttribute?.('data-value'),trigger?.textContent].map(exactLookupText).filter(Boolean);return candidates.some(label=>label===expected)}
  function lookupOptions(desc){
    const out=[],seen=new Set(),input=findComboInput(desc),roots=[];
    const addRoot=x=>{if(x&&!roots.includes(x))roots.push(x)};
    for(const r of optionRoots(desc))addRoot(r);
    const id=input?.getAttribute?.('aria-controls');
    if(id){try{addRoot(document.getElementById(id))}catch{}for(const r of FP.walkRoots()){try{addRoot(r.querySelector?.(`#${CSS.escape(id)}`))}catch{}}}
    const add=el=>{if(!el||seen.has(el)||!isVisible(el))return;const label=exactLookupText(el.getAttribute?.('data-label')||el.getAttribute?.('label')||el.getAttribute?.('title')||el.textContent||'');if(!label||/^(show all results|create new|recent records|search all)$/i.test(label))return;seen.add(el);out.push({el,label,id:lookupRecordId(el)})};
    for(const root of roots){FP.deepQueryAll(root,'[role="option"],lightning-base-combobox-item,.slds-listbox__option,.slds-listbox__item,[data-option-index]',300).forEach(add)}
    // The aria-controls target is authoritative for this lookup. Only fall back to
    // the document-wide live list when the controlled container yielded nothing.
    if(!out.length)FP.deepQueryAll(document,'[role="listbox"] [role="option"],lightning-base-combobox-item[role="option"],lightning-base-combobox-item[data-value],.slds-listbox__option,.slds-listbox__item',500).forEach(add);
    return out;
  }
  function lookupClickCandidates(el){const out=[];const add=x=>{if(x&&!out.includes(x))out.push(x)};add(el);try{el.querySelectorAll?.('[role="option"],lightning-base-combobox-item,button,a,.slds-listbox__option,.slds-listbox__item,.slds-truncate').forEach(add)}catch{}return out.filter(isVisible)}
  async function typeLookupSearchInput(input,text){if(!input)return false;const value=String(text||'');try{input.focus?.({preventScroll:true});input.click?.()}catch{}const proto=Object.getPrototypeOf(input),desc=Object.getOwnPropertyDescriptor(proto,'value'),setValue=v=>{try{desc?.set?desc.set.call(input,v):input.value=v;return true}catch{return false}};const dispatch=(type,key,mods={})=>{try{input.dispatchEvent(new KeyboardEvent(type,{key,code:key.length===1?'Key'+key.toUpperCase():key,bubbles:true,composed:true,ctrlKey:!!mods.ctrl,metaKey:!!mods.meta,cancelable:true}))}catch{}};dispatch('keydown','Control',{ctrl:true});dispatch('keydown','a',{ctrl:true});dispatch('keyup','a',{ctrl:true});dispatch('keyup','Control',{ctrl:true});setValue('');try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}))}catch{}for(const ch of value){dispatch('keydown',ch);const next=String(input.value||'')+ch;setValue(next);try{input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,composed:true,inputType:'insertText',data:ch}))}catch{}try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:ch}))}catch{}dispatch('keyup',ch);await wait(12)}try{input.dispatchEvent(new Event('change',{bubbles:true,composed:true}))}catch{}return true}
  async function activateLookupOption(d,hit,input){if(!hit?.el)return false;for(const candidate of lookupClickCandidates(hit.el)){try{candidate.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}try{candidate.focus?.({preventScroll:true})}catch{}try{candidate.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,composed:true,cancelable:true,button:0,buttons:1,view:window}))}catch{}try{candidate.click?.()}catch{}try{candidate.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,composed:true,cancelable:true,button:0,buttons:0,view:window}))}catch{}await wait(90);if(!input?.isConnected||findComboTrigger(d)?.getAttribute?.('aria-expanded')==='false'||lookupSelectionEvidence(d,hit.id,hit.label))return true}try{input?.focus?.({preventScroll:true});input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,composed:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,composed:true}));await wait(100);return !input?.isConnected||findComboTrigger(d)?.getAttribute?.('aria-expanded')==='false'}catch{return false}}
  async function fillLookup(d,wanted){
    const expected=wanted&&typeof wanted==='object'?wanted:{displayValue:String(wanted??''),recordId:''};
    const expectedId=String(expected.recordId||'').trim(),expectedLabel=FP.normalizeText(expected.displayValue||expected.label||expected.name||'');
    if(!expectedId&&!expectedLabel)return{ok:false,reason:'Recorded lookup has no selectable value'};
    if(lookupSelectionEvidence(d,expectedId,expectedLabel))return{ok:true,selected:expectedLabel||expectedId,alreadySelected:true};
    const input=findComboInput(d);if(!input)return{ok:false,reason:'Lookup input control not found'};
    await typeLookupSearchInput(input,expectedLabel||expectedId);
    for(let attempt=0;attempt<14;attempt++){
      await wait(Math.min(70+attempt*20,210));
      const options=lookupOptions(d);
      const ids=expectedId?options.filter(o=>o.id===expectedId):[];
      const labels=expectedLabel?options.filter(o=>o.label===exactLookupText(expectedLabel)):[];
      const hits=ids.length?ids:labels;
      if(hits.length>1)return{ok:false,reason:`Multiple lookup results matched ${expectedLabel||expectedId}`};
      const hit=hits[0];if(!hit)continue;
      if(await activateLookupOption(d,hit,input)){for(let i=0;i<10;i++){await wait(60);const fresh=FP.refreshFieldDescriptor?.(d.host)||d;if(lookupSelectionEvidence(fresh,expectedId,expectedLabel))return{ok:true,selected:expectedLabel||expectedId,mode:expectedId?'lookup-exact-id':'lookup-exact-label'};if(!input.isConnected||findComboInput(fresh)===null)return{ok:true,selected:expectedLabel||expectedId,mode:'lookup-selected'}}}
    }
    const hostTarget=d.host?.tagName?.toLowerCase()==='lightning-input-field'?(FP.deepQueryFirst(d.host,'lightning-lookup,lightning-record-picker,lightning-base-combobox[data-lookup]')||d.host):d.element||d.host;
    const bridge=await ssPageAction(hostTarget,'set-lookup',{displayValue:expectedLabel,recordId:expectedId});
    if(bridge?.ok)return{ok:true,selected:expectedLabel||expectedId,mode:bridge.mode||'lookup-bridge-fallback'};
    return{ok:false,reason:`Lookup result not found for ${expectedLabel||expectedId}`};
  }
  async function fillAddress(d,val){for(const [part,v] of Object.entries(val||{})){const input=FP.deepQueryFirst(d.host,`[data-address-part="${CSS.escape(part)}"],[data-field-name="${CSS.escape(part)}"],input[name="${CSS.escape(part)}"],textarea[name="${CSS.escape(part)}"]`);if(!input&&v)return{ok:false,reason:`Address part ${part} could not be found`};if(input)setNative(input,String(v))}return true}

  async function startRecording(opts={}){
    if(!FP.isSalesforceHost()){return{ok:false,code:'SALESFORCE_ONLY'}}
    const appendRecording=opts?.appendRecording||null;
    const currentContext=detectContext();
    if(appendRecording?.context?.objectApiName&&currentContext.objectApiName&&appendRecording.context.objectApiName!==currentContext.objectApiName){
      
      return{ok:false,code:'RECORDING_OBJECT_MISMATCH',message:`This recording is for ${appendRecording.context.objectApiName}. Open a matching Salesforce record first.`};
    }
    const lock=await safeRuntimeSendMessage({type:'ACQUIRE_RECORDING_LOCK'});if(!lock?.ok){return lock}
    try{const settings=await FP.getSettings();state.dateRelativeToToday=settings.dateRelativeToToday!==false;}catch{state.dateRelativeToToday=true;}
    state.pendingRecording=null;state.paused=false;state.lastContext=currentContext;state.targetCache.clear();state.recording=true;state.replaying=false;state.appendOnly=!!appendRecording;state.recordingId=appendRecording?.id||id();state.recordingDate=appendRecording?.recordingDate||localDateISO();state.steps=appendRecording?.steps?JSON.parse(JSON.stringify(appendRecording.steps)):[];state.appendExistingKeys=new Set(state.steps.map(s=>s?.target?.key).filter(Boolean));state.currentStepIndex=-1;FP.invalidateFieldCaches();setBaseline();installListeners();window.addEventListener('beforeunload',recordingBeforeUnload);updatePresence();state.metadataPromise=FP.loadSalesforceMetadata(state.lastContext.objectApiName,state.lastContext.recordId).then(info=>{if(info?.label&&state.lastContext){state.lastContext.objectLabel=info.label;}if(!state.recording)return;FP.invalidateFieldCaches();for(const [k,oldDesc] of state.touchedDescriptors.entries()){const fresh=FP.describeField(oldDesc?.host||oldDesc?.element)||oldDesc;state.touchedDescriptors.set(k,fresh);const step=state.steps.find(x=>x.target.key===k);if(step){step.target={...step.target,key:fresh.key,label:FP.normalizeText(fresh.label).replace(/^\s*\*\s*/,''),apiName:fresh.apiName,name:fresh.name,kind:fresh.kind,sfDataType:fresh.sfDataType||step.target.sfDataType,salesforceType:fresh.sfDataType||step.target.salesforceType,multiSelect:fresh.multiSelect,reference:fresh.reference,referenceObject:fresh.referenceObject,objectApiName:fresh.objectApiName||step.target.objectApiName,targetSelectionName:fresh.targetSelectionName||step.target.targetSelectionName,fieldId:fresh.fieldId||step.target.fieldId,fieldPath:fresh.fieldPath||step.target.fieldPath,identitySource:fresh.identitySource||step.target.identitySource,identityConfidence:fresh.identityConfidence||step.target.identityConfidence,options:Array.isArray(fresh.options)?fresh.options.map(o=>({value:o.value,displayValue:o.displayValue})):step.target.options||[]};}}updatePresence()}).catch(()=>{});return{ok:true,context:state.lastContext,steps:state.steps}}
  function sanitizeRecordedSteps(steps){
    const out=[];
    for(const step of Array.isArray(steps)?steps:[]){
      if(!step||!step.target)continue;
      const raw=step.value;
      const kind=String(step.target.kind||'').toLowerCase();
      let empty=raw===null||raw===undefined;
      if(!empty&&kind==='boolean')empty=raw===false||String(raw).trim().toLowerCase()==='false';
      else if(!empty&&kind==='picklist')empty=!!FP.isPicklistPlaceholder?.(raw);
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

  async function stopRecording(){
    if(!state.recording)return{ok:false,code:'NOT_RECORDING'};
    // Capture the latest user change immediately and stop listening at once.
    reconcile();
    removeListeners();
    window.removeEventListener('beforeunload',recordingBeforeUnload);
    state.recording=false;
    state.paused=false;
    // Give already-resolved metadata a very small chance to enrich the snapshot,
    // but never make the user wait on Salesforce network work.
    try{await (state.metadataPromise||Promise.resolve())}catch{}
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
    if(state.appendOnly){
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
    if(actualKind==='lookup' && typeof next.value==='string' && /^\[object Object\]$/.test(next.value.trim())){
      const meta=next.meta||{};
      next={...next,value:{displayValue:String(meta.lookupDisplayValue||''),recordId:String(meta.lookupRecordId||next.target?.referenceId||'')}};
    }
    return next;
  }

  function resolveTarget(target){
    if(!target)return null;
    const cacheKeys=targetCacheKeys(target);
    for(const k of cacheKeys){const cached=state.targetCache.get(k);if(cached?.host?.isConnected||cached?.element?.isConnected)return applyRecordedNumericSemantics(cached,target);}
    const candidates=FP.candidateFields();
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
      if(meta.dateMode==='relative'&&Number.isFinite(Number(meta.dateOffsetDays))){
        v=shiftLocalDateISO(localDateISO(),Number(meta.dateOffsetDays));
      }
      v=salesforceDateInputValue(d,v);
    }
    else if(d.kind==='datetime')v=FP.normalizeDateTime(v);
    else if(d.kind==='time')v=FP.normalizeTime(v);
    return v;
  }
  async function hydrateReplayPicklists(recording,replayContext){
    for(const step of Array.isArray(recording?.steps)?recording.steps:[]){if(!step?.target?.apiName||!['picklist','multi-picklist'].includes(String(step.target.kind||'').toLowerCase()))continue;if(Array.isArray(step.target.options)&&step.target.options.length)continue;const objectApi=step.target.objectApiName||replayContext.objectApiName||'';if(!objectApi||objectApi==='Salesforce')continue;const recordId=objectApi===replayContext.objectApiName?replayContext.recordId:'';const info=await FP.loadSalesforceMetadata(objectApi,recordId).catch(()=>null);const rt=await FP.getRecordTypeId?.(objectApi,recordId)||info?.defaultRecordTypeId||'012000000000000AAA';const opts=await FP.loadFieldPicklistValues?.(objectApi,rt,step.target.apiName)||[];if(opts.length)step.target.options=opts.map(o=>({value:o.value,displayValue:o.displayValue||o.value}));}}

  async function preflightRecording(recording){
    const report={ok:true,checked:0,missing:[],invalid:[],warnings:[],objects:[]};
    const steps=Array.isArray(recording?.steps)?recording.steps.filter(s=>s?.enabled!==false):[];
    report.objects=[...new Set(steps.map(s=>s?.target?.objectApiName).filter(Boolean))];
    for(const step of steps){
      const index=Number.isFinite(Number(step?.sequence))?Number(step.sequence)-1:report.checked;
      report.checked++;
      const t=step?.target||{},d=resolveTarget(t),label=t.label||t.apiName||t.name||'Field';
      if(!d){report.missing.push({index,label,target:t});continue;}
      const expected=String(t.kind||'').toLowerCase(),actual=String(d.kind||'').toLowerCase();
      // Kind mismatches are recoverable. The live Salesforce field component is the
      // source of truth; executeStep() will repair the action/value semantics to match it.
      if(expected&&actual&&expected!==actual){
        report.warnings.push({index,label,recordedKind:expected,currentKind:actual,reason:`Recorded as ${expected} but current control is ${actual}; replay will use the current control type.`,repaired:true});
      }
      if(d.readOnly && !['picklist','multi-picklist'].includes(String(d.kind||'')))report.invalid.push({index,label,reason:'Field is read-only.'});
      else if(d.disabled && !['picklist','multi-picklist'].includes(String(d.kind||'')))report.invalid.push({index,label,reason:'Field is disabled.'});
      else if(d.disabled||d.readOnly)report.warnings.push({index,label,reason:'Field is temporarily unavailable; replay will wait for Salesforce to enable it.',repaired:true});
    }
    report.ok=!report.missing.length&&!report.invalid.length;
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
  async function waitForEditableDescriptor(step,d,timeout=3500){
    const deadline=Date.now()+timeout;let current=d;
    while(Date.now()<deadline){
      current=FP.refreshFieldDescriptor?.(current.host)||current||d;
      if(!explicitReadonly(current)&&!liveInteractiveDisabled(current))return current;
      await wait(120);
    }
    return current;
  }
  async function executeStep(step,opts={}){
    let d=resolveTarget(step.target);if(!d)return{ok:false,status:'failed',code:'TARGET_NOT_FOUND',message:`${step.target.label||step.target.apiName||'Field'} could not be found.`};
    d=await waitForEditableDescriptor(step,d);
    if(explicitReadonly(d)||liveInteractiveDisabled(d))return{ok:false,status:'failed',code:'FIELD_NOT_EDITABLE',message:`${d.label} is not editable.`};
    const effectiveStep=repairStepForDescriptor(step,d);
    const before=valueFor(d),fillOnlyBlank=opts.fillOnlyBlank!==undefined?!!opts.fillOnlyBlank:state.replayFillOnly;
    if(fillOnlyBlank&&emptyValue(d,before)===false)return{ok:true,status:'skipped',code:'ALREADY_FILLED',message:'Field already has a value.',verified:false};
    state.ignoreEvents=true;let result={ok:true};try{
      if(effectiveStep.action==='set-boolean'){const el=d.element||FP.controlForField(d.host);const want=!!effectiveStep.value;if(!!before!==want)el?.click?.();}
      else if(effectiveStep.action==='select-option')result=await fillPicklist(d,{value:effectiveStep.value,displayValue:effectiveStep.meta?.selectedDisplayValue||''});
      else if(effectiveStep.action==='set-multi-option')result=await fillMultiPicklist(d,effectiveStep.value);
      else if(effectiveStep.action==='select-lookup')result=await fillLookup(d,effectiveStep.value||{displayValue:effectiveStep.meta?.lookupDisplayValue||'',recordId:effectiveStep.meta?.lookupRecordId||effectiveStep.target?.referenceId||''});
      else if(effectiveStep.action==='set-address'){const ok=await fillAddress(d,step.value);result={ok,reason:ok?'':'Could not fill address'};}
      else if(d.kind==='number'){result={ok:setSalesforceNumericValue(d,effectiveStep.value),value:salesforceNumericInputValue(d,effectiveStep.value)};if(!result.ok)result.reason='Numeric field control not found';}
      else{const el=d.element||FP.controlForField(d.host);if(!el)return{ok:false,reason:'Field control not found'};result={ok:setNative(el,valueForStep(d,effectiveStep))};}
    }finally{state.ignoreEvents=false}
    if(!result?.ok)return{ok:false,status:'failed',code:'EXECUTION_FAILED',message:result?.reason||`Could not fill ${d.label}.`};
    await wait(opts.fastOverwrite?(d.kind==='multi-picklist'?220:55):(d.kind==='multi-picklist'?420:180));const fresh=FP.refreshFieldDescriptor?.(d.host)||d;const actual=valueFor(fresh);const settings=opts.settings||{verifyAfterReplay:true};let verified=true;if(settings.verifyAfterReplay){if(fresh.kind==='multi-picklist')verified=multiPicklistMatches(fresh,effectiveStep.value);else if(fresh.kind==='picklist')verified=pickMatches(fresh,{value:effectiveStep.value,displayValue:effectiveStep.meta?.selectedDisplayValue||''});else if(fresh.kind==='lookup')verified=lookupSelectionEvidence(fresh,effectiveStep.value?.recordId||effectiveStep.meta?.lookupRecordId||effectiveStep.target?.referenceId||'',effectiveStep.value?.displayValue||effectiveStep.meta?.lookupDisplayValue||'');else verified=FP.valuesEqual(fresh,actual,valueForStep(fresh,effectiveStep));}const verificationPending=!!result?.verificationSoft&&!verified;if(settings.verifyAfterReplay&&!verified&&!verificationPending)return{ok:false,status:'failed',code:'VERIFICATION_FAILED',message:`${fresh.label} did not show the recorded value.`};return{ok:true,status:'filled',verified:!!verified,verification:verified?'verified':(verificationPending?'pending':'disabled'),verificationSoft:!!result?.verificationSoft,verificationPending};
  }
  function selectedTruth(v){return!!v}

  async function replayRecording(recording,opts={}){
    if(!FP.isSalesforceHost())return{ok:false,code:'SALESFORCE_ONLY',executed:[]};
    const lock=await safeRuntimeSendMessage({type:'GET_RECORDING_LOCK'})||{recordingTabId:null};if(lock.recordingTabId)return{ok:false,code:'RECORDING_ACTIVE',message:'Stop recording before Autofill.',executed:[]};
    const replayContext=detectContext();
    const normalizedSteps=Array.isArray(recording?.steps)?recording.steps.map(step=>({...step,target:FP.normalizeTargetSchema?.(step?.target||{},recording?.context||replayContext)||step?.target||{}})):[];
    recording={...recording,context:{...(recording?.context||{}),objectApiName:recording?.context?.objectApiName||replayContext.objectApiName,objectLabel:recording?.context?.objectLabel||replayContext.objectLabel},steps:normalizedSteps};
    const recordingObject=String(recording.context?.objectApiName||'');if(recordingObject&&recordingObject!=='Salesforce'&&replayContext.objectApiName&&replayContext.objectApiName!=='Salesforce'&&recordingObject.toLowerCase()!==String(replayContext.objectApiName).toLowerCase())return{ok:false,code:'RECORDING_OBJECT_MISMATCH',message:`This recording is for ${recordingObject}. Open a matching Salesforce record first.`,executed:[]};
    state.replaying=true;state.recording=false;state.targetCache.clear();state.currentStepIndex=-1;state.runId++;updatePresence();
    const replayObjects=new Set([detectContext().objectApiName,...(recording.steps||[]).map(s=>s?.target?.objectApiName).filter(Boolean)].filter(x=>x&&x!=='Salesforce'));
    await Promise.all([...replayObjects].map(obj=>FP.loadSalesforceMetadata(obj,obj===replayContext.objectApiName?replayContext.recordId:'').catch(()=>null)));
    await hydrateReplayPicklists(recording,replayContext);
    FP.invalidateFieldCaches();
    const preflight=await preflightRecording(recording);
    if(!preflight.ok){state.replaying=false;updatePresence();return{ok:false,code:'PREFLIGHT_FAILED',message:`Autofill preflight found ${preflight.missing.length+preflight.invalid.length} issue(s).`,preflight,executed:[],fillOnlyBlank:false};}
    const settings=await FP.getSettings();state.replayFillOnly=opts.fillOnlyBlank!==undefined?!!opts.fillOnlyBlank:settings.fillEmptyOnly!==false;state.replayInitial=initialEmptyMap(recording);
    const indexes=[];const only=Array.isArray(opts.onlyIndexes)?new Set(opts.onlyIndexes.map(Number)):null;const start=Math.max(0,Number(opts.startIndex||0));
    for(let i=0;i<(recording.steps||[]).length;i++){if(i<start)continue;if(only&&!only.has(i))continue;if(recording.steps[i].enabled===false)continue;indexes.push(i)}
    const executed=[];
    for(const i of indexes){state.currentStepIndex=i;updatePresence();const r=await executeStep(recording.steps[i],{fillOnlyBlank:state.replayFillOnly,settings,fastOverwrite:!!opts.fastOverwrite});executed.push({index:i,step:recording.steps[i],result:r});if(!r.ok&&settings.stopOnFailure)break}
    state.replaying=false;updatePresence();return{ok:!executed.some(x=>!x.result.ok),failedAt:executed.find(x=>!x.result.ok)?.index,executed,fillOnlyBlank:state.replayFillOnly};
  }
  async function removeRecordingStep(index){
    if(!state.recording)return{ok:false,code:'NOT_RECORDING',message:'Recording is not active.'};
    const i=Number(index);
    if(!Number.isInteger(i)||i<0||i>=state.steps.length)return{ok:false,code:'INVALID_STEP',message:'That field is no longer in the recording.'};
    const removed=state.steps.splice(i,1)[0];
    const removedKey=removed?.target?.key;
    if(removedKey){state.touched.delete(removedKey);state.touchedDescriptors.delete(removedKey);state.baselines.delete(removedKey);state.lastCommitted.delete(removedKey);state.appendExistingKeys.delete(removedKey);state.targetCache.delete(removedKey)}
    state.steps.forEach((step,n)=>{step.sequence=n+1});
    updatePresence();
    return{ok:true,steps:state.steps};
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
      overlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #1976d2;box-shadow:0 0 0 2px rgba(25,118,210,.18);border-radius:6px;box-sizing:border-box;transition:top .12s ease,left .12s ease,width .12s ease,height .12s ease;';
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

  async function overwriteStep(recording,index){
    const idx=Number(index);
    if(!recording||!Array.isArray(recording.steps)||!Number.isInteger(idx))return{ok:false,executed:[]};
    const step=recording.steps[idx];
    if(!step)return{ok:false,executed:[]};
    // Reuse the proven replay pipeline for a single field. This keeps all of the
    // required Salesforce metadata hydration, picklist hydration, target repair,
    // lookup handling, and verification behavior identical to normal Autofill.
    return replayRecording(recording,{onlyIndexes:[idx],fillOnlyBlank:false,fastOverwrite:true});
  }
  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{if(msg?.type==='GET_CONTEXT'){const ctx=state.lastContext||detectContext();if(ctx.objectApiName&&!ctx.objectLabel||/^[A-Za-z0-9_]+__c$/.test(ctx.objectLabel)){FP.loadSalesforceMetadata(ctx.objectApiName,ctx.recordId).then(info=>{if(info?.label)ctx.objectLabel=info.label;sendResponse(ctx)}).catch(()=>sendResponse(ctx));return true;}sendResponse(ctx);return}if(msg?.type==='GET_FIELD_DESCRIPTORS'){
      (async()=>{try{
        const ctx=detectContext();
        await FP.loadSalesforceMetadata(ctx.objectApiName,ctx.recordId);
        const targets=Array.isArray(msg.targets)?msg.targets:[];
        const targetObjects=new Set(targets.map(t=>t?.objectApiName).filter(x=>x&&x!=='Salesforce'));
        await Promise.all([...targetObjects].filter(x=>x!==ctx.objectApiName).map(obj=>FP.loadSalesforceMetadata(obj,'').catch(()=>null)));
        const descriptors=targets.map(t=>({target:t,d:resolveTarget(t)})).filter(x=>x.d);
        const info=FP.loadSalesforceMetadata?await FP.loadSalesforceMetadata(ctx.objectApiName,ctx.recordId):null;
        await Promise.all(descriptors.filter(x=>['picklist','multi-picklist'].includes(x.d.kind)&&(!x.d.options||!x.d.options.length)&&x.d.apiName).map(async x=>{
          const objectApi=x.d.objectApiName||ctx.objectApiName;const infoForObject=objectApi===ctx.objectApiName?info:await FP.loadSalesforceMetadata(objectApi,'').catch(()=>null);const recordIdForObject=objectApi===ctx.objectApiName?ctx.recordId:'';const rt=await FP.getRecordTypeId?.(objectApi,recordIdForObject)||infoForObject?.defaultRecordTypeId||'012000000000000AAA';const opts=await FP.loadFieldPicklistValues?.(objectApi,rt,x.d.apiName)||[];
          if(opts.length)x.d={...x.d,options:opts};
        }));
        const out=descriptors.map(({d})=>({targetKey:d.key,label:d.label,apiName:d.apiName,name:d.name,kind:d.kind,fieldType:FP.canonicalFieldType(d),sfDataType:d.sfDataType||'',salesforceType:d.sfDataType||'',reference:d.reference,referenceObject:d.referenceObject,multiSelect:d.multiSelect,objectApiName:d.objectApiName,targetSelectionName:d.targetSelectionName,fieldId:d.fieldId,fieldPath:d.fieldPath,identitySource:d.identitySource,identityConfidence:d.identityConfidence,dataTableColumnKey:d.dataTableColumnKey,dataTableFieldApiName:d.dataTableFieldApiName,options:Array.isArray(d.options)?d.options.map(o=>({value:o.value,displayValue:o.displayValue})):[]}));
        sendResponse({ok:true,descriptors:out,context:ctx});
      }catch(e){sendResponse({ok:false,error:e?.message||'Could not resolve field metadata.'})}})();return true;
    }
    if(msg?.type==='GET_RECORDING_STATE'){sendResponse({recording:state.recording,paused:state.paused,replaying:state.replaying,steps:state.steps,context:state.lastContext||detectContext(),currentStepIndex:state.currentStepIndex,pendingRecording:state.pendingRecording});return}if(msg?.type==='START_RECORDING'){startRecording({appendRecording:msg.appendRecording||null}).then(sendResponse);return true}if(msg?.type==='PAUSE_RECORDING'){sendResponse(setRecordingPaused(true));return false}if(msg?.type==='RESUME_RECORDING'){sendResponse(setRecordingPaused(false));return false}if(msg?.type==='CLEAR_PENDING_RECORDING'){state.pendingRecording=null;sendResponse({ok:true});return false}if(msg?.type==='STOP_RECORDING'){stopRecording().then(sendResponse);return true}if(msg?.type==='REPLAY_RECORDING'){replayRecording(msg.recording,msg).then(sendResponse).catch(e=>sendResponse({ok:false,executed:[],error:e?.message||'Autofill could not be completed.'}));return true}if(msg?.type==='OVERWRITE_STEP'){overwriteStep(msg.recording,msg.index).then(sendResponse).catch(e=>sendResponse({ok:false,executed:[],error:e?.message||'Could not use the recorded value.'}));return true}if(msg?.type==='REMOVE_RECORDING_STEP'){removeRecordingStep(msg.index).then(sendResponse).catch(e=>sendResponse({ok:false,error:e?.message||'Could not remove the field.'}));return true;}if(msg?.type==='FOCUS_FIELD'){focusField(msg.target).then(sendResponse);return true}return false});
  // Warm Salesforce metadata as soon as the content script is ready. This keeps type resolution
  // independent from the timing of the first Record/field-change event.
  try{const bootContext=detectContext();if(bootContext.objectApiName&&bootContext.objectApiName!=='Salesforce')FP.loadSalesforceMetadata(bootContext.objectApiName,bootContext.recordId).catch(()=>{});}catch{}
  let overlayEnabled=true;
  FP.getSettings().then(s=>{overlayEnabled=s.showOverlay!==false;if(overlayEnabled)ensureOverlay();}).catch(()=>ensureOverlay());
  if(chrome.storage?.onChanged?.addListener) chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local'||!changes[FP.SETTINGS_KEY])return;const next=changes[FP.SETTINGS_KEY].newValue||{};overlayEnabled=next.showOverlay!==false;state.dateRelativeToToday=next.dateRelativeToToday!==false;if(overlayEnabled)ensureOverlay();else{try{state.overlay?.remove();}catch{}state.overlay=null;}});
})();
