/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

(()=>{
  'use strict';
  if(window.__FORCEPILOT_BRIDGE_READY__) return;
  window.__FORCEPILOT_BRIDGE_READY__=true;
  const HOST_RE=/^(?:[^.]+\.)*(?:salesforce\.com|visualforce\.com|vf\.force\.com|lightning\.force\.com|my\.salesforce\.com)$/i;
  if(!HOST_RE.test(location.hostname)) return;
  const BUILD='2.0';
  const capabilityChallenges=new Map();
  const requests=new Set();
  const targetIds=new WeakMap();
  const targetById=new Map();
  const MAX_TARGETS=160;
  const MAX_TEXT=2000;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const norm=v=>String(v??'').trim().toLowerCase();
  const validId=v=>typeof v==='string'&&(/^(?:forcepilot|sensei)-[a-z0-9-]{8,80}$/i.test(v));
  const validRequest=v=>typeof v==='string'&&/^req-[a-z0-9-]{8,120}$/.test(v);
  const validValues=v=>Array.isArray(v)&&v.length>0&&v.length<=100&&v.every(x=>typeof x==='string'&&x.trim()&&x.length<=MAX_TEXT);
  const readable=el=>{try{return String(el?.textContent||'').replace(/\s+/g,' ').trim().slice(0,MAX_TEXT)}catch{return''}};

  const pruneTargets=()=>{
    for(const [id,el] of targetById){if(!el?.isConnected)targetById.delete(id);}
    while(targetById.size>MAX_TARGETS){const id=targetById.keys().next().value;if(id===undefined)break;targetById.delete(id);}
  };
  const register=(el,id)=>{if(!el||!validId(id))return false;pruneTargets();targetIds.set(el,id);targetById.set(id,el);return true;};

  function rootsFor(el){
    const roots=[],seen=new Set(),queue=[el];
    while(queue.length){
      const root=queue.shift();
      if(!root||seen.has(root))continue;
      seen.add(root);roots.push(root);
      try{root.querySelectorAll?.('*')?.forEach(n=>{if(n.shadowRoot&&!seen.has(n.shadowRoot))queue.push(n.shadowRoot);});}catch{}
    }
    return roots;
  }

  function findTarget(id){
    const cached=targetById.get(id);
    if(cached?.isConnected)return cached;
    targetById.delete(id);
    const escaped=String(id).replace(/([#.;?+*~':"^$[\]()=>|\\])/g,'\\$1');
    for(const root of [document,...rootsFor(document).slice(1)]){
      try{const el=root.querySelector?.(`[data-forcepilot-target-id="${escaped}"],[data-ss-target-id="${escaped}"]`);if(el?.isConnected){register(el,id);return el;}}catch{}
    }
    return null;
  }

  function allowedTarget(el){
    if(!el)return false;
    const tag=String(el.tagName||'').toLowerCase();
    if(/^(lightning-dual-listbox|lightning:dualListbox|lightning-combobox|lightning-base-combobox|lightning-input-field|lightning-lookup|lightning-record-picker)$/.test(tag))return true;
    try{
      if(el.closest?.('lightning-dual-listbox,lightning-combobox,lightning-base-combobox,lightning-input-field,lightning\\:dualListbox'))return true;
      if(el.querySelector?.('lightning-combobox,lightning-base-combobox,lightning-dual-listbox,lightning-lookup,lightning-record-picker'))return true;
    }catch{return false;}
    return false;
  }

  function optionMeta(el){
    if(!el)return null;
    let value='',label='';
    try{value=String(el.getAttribute?.('data-value')||el.getAttribute?.('value')||el.value||'').trim();}catch{}
    try{label=String(el.getAttribute?.('data-label')||el.getAttribute?.('label')||el.getAttribute?.('title')||el.getAttribute?.('aria-label')||'').replace(/\s+/g,' ').trim();}catch{}
    if(!label)label=readable(el);
    if(!value)value=label;
    if(!value||!label)return null;
    return {el,value,label};
  }

  function listLabel(list){
    const parts=[];
    for(const el of [list,list?.parentElement,list?.parentElement?.parentElement]){
      if(!el)continue;
      for(const attr of ['aria-label','title','data-label','name']){try{const v=el.getAttribute?.(attr);if(v)parts.push(v);}catch{}}
    }
    try{list.parentElement?.querySelectorAll?.('label,.slds-dueling-list__label,.slds-form-element__label,.slds-listbox__label,[class*=label]')?.forEach(el=>{const t=readable(el);if(t&&t.length<100)parts.push(t);});}catch{}
    return parts.join(' ').toLowerCase();
  }

  function listBoxes(dual){
    const raw=[],seen=new Set();
    const add=list=>{
      if(!list||seen.has(list)||!list.querySelectorAll)return;
      let optionCount=0;try{optionCount=list.querySelectorAll('[role="option"],option,[data-value]').length;}catch{}
      const hint=listLabel(list);
      if(!optionCount&&!/\b(available|source|selected|chosen|current)\b/.test(hint))return;
      if(raw.some(parent=>{try{return parent.contains?.(list);}catch{return false;}}))return;
      for(let i=raw.length-1;i>=0;i--){try{if(list.contains?.(raw[i]))raw.splice(i,1);}catch{}}
      seen.add(list);raw.push(list);
    };
    for(const root of rootsFor(dual)){
      try{root.querySelectorAll?.('[data-source-list],[data-selected-list],[role="listbox"],.slds-dueling-list__options,[aria-multiselectable="true"],ul.slds-listbox').forEach(add);}catch{}
    }
    const items=raw.map((list,index)=>{
      let rect={left:index,top:0,width:0,height:0};try{rect=list.getBoundingClientRect?.()||rect;}catch{}
      return {list,index,label:listLabel(list),rect,options:Array.from(list.querySelectorAll?.('[role="option"],option,[data-value]')||[]).map(optionMeta).filter(Boolean).filter(o=>!['none','--none--','-none-','select','select an option'].includes(norm(o.value)))};
    }).filter(x=>x.options.length);
    return items;
  }

  function classifyLists(dual){
    const items=listBoxes(dual);if(!items.length)return {source:null,selected:null};
    const sourceAttr=items.find(x=>x.list?.hasAttribute?.('data-source-list'))||null;
    const selectedAttr=items.find(x=>x.list?.hasAttribute?.('data-selected-list'))||null;
    const ordered=[...items].sort((a,b)=>(a.rect.left||0)-(b.rect.left||0));
    let source=sourceAttr||items.find(x=>/\b(?:available|source)\b/.test(x.label))||null;
    let selected=selectedAttr||items.find(x=>/\b(?:selected|chosen|current)\b/.test(x.label)&&x!==source)||null;
    if(!source&&!selected&&items.length===1){const only=items[0];if(/\b(?:selected|chosen|current)\b/.test(only.label))selected=only;else source=only;}
    if(!source&&!selected&&items.length>1){source=ordered[0]||null;selected=ordered[1]||null;}
    if(source&&selected&&(source.rect.left||0)>(selected.rect.left||0)){const t=source;source=selected;selected=t;}
    return {source,selected};
  }

  const isMultiPlaceholder=v=>{const s=norm(v).replace(/[–—]/g,'-').replace(/\s+/g,' ');return !s||['-none-','--none--','none','no selection','select','select an option','choose','choose an option','select option','--select--'].includes(s)};

  const selectedSet=dual=>{
    const out=[];
    const add=v=>{const z=String(v??'').trim();if(!z||isMultiPlaceholder(z)||out.some(y=>norm(y)===norm(z)))return;out.push(z);};
    try{const v=dual?.value;if(Array.isArray(v))for(const x of v)add(x);else if(typeof v==='string'&&v.trim())for(const x of v.split(/\s*;\s*|\s*,\s*/))add(x);}catch{}
    if(out.length)return out;
    const {selected}=classifyLists(dual);
    if(selected){for(const item of selected.options){add(item.value||item.label);}}
    return out;
  };
  const sameSet=(a,b)=>{const aa=a.map(norm).sort(),bb=b.map(norm).sort();return aa.length===bb.length&&aa.every((v,i)=>v===bb[i]);};

  function findMoveButton(dual,right=true){
    const re=right?/move\s+selection\s+to\s+(?:selected|chosen)|move.*to\s+(?:selected|chosen)/i:/move\s+selection\s+to\s+(?:source|available)|move.*to\s+(?:source|available)/i;
    const buttons=[];
    for(const root of rootsFor(dual)){try{root.querySelectorAll?.('button,[role="button"],lightning-button-icon,lightning-button')?.forEach(b=>buttons.push(b));}catch{}}
    return buttons.find(b=>{if(b.matches?.(':disabled,[aria-disabled="true"]'))return false;const hint=[b.getAttribute?.('aria-label'),b.getAttribute?.('title'),b.getAttribute?.('name'),readable(b)].filter(Boolean).join(' ');return re.test(hint);})||null;
  }

  function fireClickSequence(el, options={}){
    if(!el) return false;
    if(options.scroll!==false){try{el.scrollIntoView?.({block:'nearest',inline:'nearest'});}catch{}}
    try{el.focus?.({preventScroll:true});}catch{}
    try{
      const base={bubbles:true,composed:true,button:0,buttons:1,view:window,cancelable:true};
      el.dispatchEvent(new PointerEvent('pointerdown',{...base,pointerId:1,pointerType:'mouse',isPrimary:true}));
      el.dispatchEvent(new MouseEvent('mousedown',base));
      el.dispatchEvent(new PointerEvent('pointerup',{...base,pointerId:1,pointerType:'mouse',isPrimary:true,buttons:0}));
      el.dispatchEvent(new MouseEvent('mouseup',{...base,buttons:0}));
    }catch{}
    try{el.click?.();}catch{}
    return true;
  }

  function optionClickCandidates(el){
    const out=[]; const add=x=>{if(x&&!out.includes(x))out.push(x);};
    try{add(el.querySelector?.('[role="option"]'));}catch{}
    try{add(el.querySelector?.('.slds-listbox__option'));}catch{}
    try{add(el.querySelector?.('[data-value]'));}catch{}
    try{add(el.querySelector?.('.slds-truncate'));}catch{}
    add(el);
    try{add(el.closest?.('lightning-base-combobox-item,[role="option"],li.slds-listbox__item,[data-value]'));}catch{}
    try{add(el.querySelector?.('button'));}catch{}
    try{add(el.querySelector?.('a'));}catch{}
    return out;
  }

  async function selectOption(option,multi=true){
    if(!option)return false;
    const isSelected=()=>option.getAttribute?.('aria-selected')==='true'||option.getAttribute?.('data-selected')==='true' || option.closest?.('[role="option"]')?.getAttribute?.('aria-selected')==='true';
    if(isSelected())return true;
    // Salesforce documents click as the primary selection gesture for dual-listbox
    // options. Start with the actual option/list-item rather than synthetic pointer
    // dispatches, then try its rendered child if the framework attached its handler there.
    for(const candidate of optionClickCandidates(option)){
      fireClickSequence(candidate);
      await sleep(90);
      if(isSelected())return true;
    }
    // Keyboard activation is a fallback, but do not focus the option: focus can
    // trigger browser/Lightning auto-scroll during a dual-listbox rerender.
    const mac=/Mac|iPhone|iPad/i.test(String(navigator.platform||navigator.userAgent||''));
    const mod=mac?'metaKey':'ctrlKey';
    try{const init={key:' ',code:'Space',bubbles:true,composed:true};init[mod]=true;option.dispatchEvent(new KeyboardEvent('keydown',init));option.dispatchEvent(new KeyboardEvent('keyup',init));}catch{}
    await sleep(110);
    return isSelected();
  }

  function clickMoveButton(dual,right=true){
    const button=findMoveButton(dual,right); if(!button)return false;
    const candidates=[]; const add=x=>{if(x&&!candidates.includes(x))candidates.push(x);};
    add(button);
    try{add(button.querySelector?.('button'));}catch{}
    try{add(button.querySelector?.('[role="button"]'));}catch{}
    try{add(button.closest?.('button,[role="button"]'));}catch{}
    for(const candidate of candidates){
      if(candidate.matches?.(':disabled,[aria-disabled="true"]')) continue;
      fireClickSequence(candidate);
      try{candidate.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,composed:true}));candidate.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,composed:true}));}catch{}
      return true;
    }
    return false;
  }

  function comboTrigger(root){
    if(!root)return null;
    const roots=rootsFor(root);
    for(const r of roots){
      try{
        const x=r.querySelector?.('button[role="combobox"],input[role="combobox"],[role="combobox"]');
        if(x)return x;
      }catch{}
    }
    return null;
  }

  function comboOpen(root){
    const t=comboTrigger(root);
    if(t?.getAttribute?.('aria-expanded')==='true')return true;
    const id=t?.getAttribute?.('aria-controls');
    if(id){
      for(const r of rootsFor(root)){
        try{const x=r.querySelector?.(`#${CSS.escape(id)}`);if(x&&x.getBoundingClientRect?.().width>0&&x.getBoundingClientRect?.().height>0)return true;}catch{}
      }
    }
    return comboOptions(root).length>0;
  }

  function comboOptions(root){
    const out=[]; const seen=new Set();
    for(const r of rootsFor(root)){
      try{
        r.querySelectorAll?.('lightning-base-combobox-item[role="option"],lightning-base-combobox-item[data-value],[role="option"],.slds-listbox__item[data-value],.slds-listbox__option[data-value]')?.forEach(el=>{
          if(seen.has(el))return;
          const meta=optionMeta(el); if(!meta)return;
          const rect=el.getBoundingClientRect?.();
          if(!rect||rect.width<=0||rect.height<=0)return;
          seen.add(el); out.push(meta);
        });
      }catch{}
    }
    try{
      document.querySelectorAll?.('[role="listbox"],.slds-listbox,.slds-dropdown,.slds-combobox__dropdown').forEach(container=>{
        const cr=container.getBoundingClientRect?.(); if(!cr||cr.width<=0||cr.height<=0)return;
        container.querySelectorAll?.('lightning-base-combobox-item[role="option"],lightning-base-combobox-item[data-value],[role="option"],.slds-listbox__item[data-value],.slds-listbox__option[data-value]')?.forEach(el=>{
          if(out.some(o=>o.el===el))return; const meta=optionMeta(el); if(!meta)return; const r=el.getBoundingClientRect?.(); if(!r||r.width<=0||r.height<=0)return; out.push(meta);
        });
      });
    }catch{}
    return out;
  }

  async function setPickByIndex(root,index){
    if(!Number.isFinite(Number(index))||Number(index)<1)return{ok:false,reason:'Invalid picklist option index'};
    if(!(await openCombo(root)))return{ok:false,reason:'Combobox could not be opened'};
    const sorted=()=>comboOptions(root).map((o,i)=>{let r={top:i,left:0};try{const z=o.el.getBoundingClientRect?.();if(z)r={top:Number(z.top||0),left:Number(z.left||0)};}catch{}return {...o,_i:i,_top:r.top,_left:r.left};}).sort((a,b)=>a._top-b._top||a._left-b._left);
    const target=sorted()[Number(index)-1]; if(!target)return{ok:false,reason:'Recorded picklist option index is not available'};
    for(const candidate of optionClickCandidates(target.el)){
      fireClickSequence(candidate); await sleep(100);
      const closed=!comboOpen(root);
      if(closed)return{ok:true,mode:'index-click',selected:target.label,index:Number(index)};
    }
    const trigger=comboTrigger(root);
    if(trigger){
      try{trigger.focus?.();}catch{}
      const key=k=>{try{const init={key:k,code:k===' ' ? 'Space':k,bubbles:true,composed:true,cancelable:true};trigger.dispatchEvent(new KeyboardEvent('keydown',init));trigger.dispatchEvent(new KeyboardEvent('keyup',init));}catch{}};
      key('Home'); for(let i=1;i<Number(index);i++)key('ArrowDown'); key('Enter'); await sleep(130);
      if(!comboOpen(root))return{ok:true,mode:'index-keyboard',selected:target.label,index:Number(index)};
    }
    return{ok:false,reason:'Picklist option index could not be activated'};
  }

  function findExactComboOption(root,value){
    const wanted=norm(value);
    const options=comboOptions(root);
    return options.find(o=>norm(o.value)===wanted || norm(o.label)===wanted) ||
           options.find(o=>norm(o.label).includes(wanted)) || null;
  }

  async function openCombo(root){
    if(comboOpen(root))return true;
    const trigger=comboTrigger(root); if(!trigger)return false;
    for(let attempt=0;attempt<4;attempt++){
      fireClickSequence(trigger);
      await sleep(110+attempt*60);
      if(await (async()=>{for(let i=0;i<10;i++){if(comboOpen(root))return true;await sleep(50);}return false;})())return true;
      const input=(()=>{for(const r of rootsFor(root)){try{const x=r.querySelector?.('input[role="combobox"],input.slds-input');if(x)return x;}catch{}}return null;})();
      if(input&&input!==trigger){try{input.focus?.();}catch{}try{input.click?.();}catch{}await sleep(80);}
    }
    return false;
  }

  async function setPick(root,value){
    const wanted=norm(value); if(!wanted)return{ok:false,reason:'Empty picklist value'};
    if(!(await openCombo(root)))return{ok:false,reason:'Combobox could not be opened'};
    for(let attempt=0;attempt<5;attempt++){
      const hit=findExactComboOption(root,value);
      if(hit){
        // Do not scroll the option itself. The dropdown is an internal overlay; scrolling
        // it here can move the Salesforce record page and create a visible jump.
        // For lightning-combobox, the rendered option is
        // lightning-base-combobox-item[role=option].click().
        for(const candidate of optionClickCandidates(hit.el)){
          fireClickSequence(candidate,{scroll:false});
          await sleep(90);
          const trigger=comboTrigger(root);
          const triggerText=norm(trigger?.getAttribute?.('data-value')||readable(trigger));
          const selected=comboOptions(root).find(o=>o.el.getAttribute?.('aria-selected')==='true');
          if(triggerText===wanted || triggerText.includes(wanted) || (norm(hit.value)===norm(value) && (selected?.value===hit.value || selected?.label===hit.label))){
            return{ok:true,mode:'native-click',selected:hit.label||hit.value};
          }
          if(!comboOpen(root)){
            const t=norm(trigger?.getAttribute?.('data-value')||readable(trigger));
            if(t===wanted || t.includes(wanted) || norm(hit.label)===wanted || norm(hit.value)===wanted){
              return{ok:true,mode:'native-click',selected:hit.label||hit.value};
            }
          }
        }
      }
      if(!comboOpen(root))await openCombo(root);
      await sleep(80+attempt*60);
    }
    return{ok:false,reason:'Requested picklist option could not be activated'};
  }

  function lookupInput(root){
    for(const r of rootsFor(root)){
      try{
        const x=r.querySelector?.('input[role="combobox"][data-value="lookup"],input[role="combobox"].slds-combobox__input, input[role="combobox"], input.slds-combobox__input[autocomplete="off"]');
        if(x)return x;
      }catch{}
    }
    return null;
  }
  function lookupRecordId(el){
    if(!el)return '';
    for(const a of ['data-record-id','data-recordid','data-record-id-value','data-id','record-id','data-lookup-id','data-selection-id']){
      try{const v=el.getAttribute?.(a);if(v&&/^[A-Za-z0-9]{15,18}$/.test(String(v).trim()))return String(v).trim();}catch{}
    }
    try{
      const href=el.getAttribute?.('href')||el.querySelector?.('a[href*="/lightning/r/"]')?.getAttribute?.('href')||'';
      const m=String(href).match(/\/lightning\/r\/[^/]+\/([A-Za-z0-9]{15,18})(?:\/|$)/i);
      return m?.[1]||'';
    }catch{return ''}
  }
  function lookupOptions(root){
    const out=[],seen=new Set();
    const input=lookupInput(root);
    const roots=[];
    const addRoot=x=>{if(x&& !roots.includes(x))roots.push(x)};
    for(const r of rootsFor(root))addRoot(r);
    const id=input?.getAttribute?.('aria-controls');
    if(id){try{addRoot(document.getElementById(id));}catch{}for(const r of rootsFor(root)){try{addRoot(r.querySelector?.(`#${CSS.escape(id)}`));}catch{}}}
    addRoot(document);
    const add=el=>{if(!el||seen.has(el))return;const rect=el.getBoundingClientRect?.();if(!rect||rect.width<=0||rect.height<=0)return;const label=norm(el.getAttribute?.('data-label')||el.getAttribute?.('label')||el.getAttribute?.('title')||readable(el));if(!label||/^(show all results|create new|recent records|search all)$/i.test(label))return;seen.add(el);out.push({el,label,id:lookupRecordId(el)});};
    for(const r of roots){try{r.querySelectorAll?.('[role="option"],lightning-base-combobox-item,.slds-listbox__option,.slds-listbox__item,[data-option-index]').forEach(add);}catch{}}
    return out;
  }
  async function setInputValue(input,value){
    if(!input)return false;
    const text=String(value||'');
    try{input.focus?.();input.click?.();}catch{}
    const proto=Object.getPrototypeOf(input),desc=Object.getOwnPropertyDescriptor(proto,'value');
    const set=v=>{try{desc?.set?desc.set.call(input,v):input.value=v;return true}catch{return false}};
    const key=(type,k,mods={})=>{try{input.dispatchEvent(new KeyboardEvent(type,{key:k,code:k.length===1?'Key'+k.toUpperCase():k,bubbles:true,composed:true,ctrlKey:!!mods.ctrl,metaKey:!!mods.meta}));}catch{}};
    key('keydown','Control',{ctrl:true});key('keydown','a',{ctrl:true});key('keyup','a',{ctrl:true});key('keyup','Control',{ctrl:true});
    set('');try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}));}catch{}
    for(const ch of text){
      key('keydown',ch);set(String(input.value||'')+ch);
      try{input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,composed:true,inputType:'insertText',data:ch}));}catch{}
      try{input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:ch}));}catch{try{input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));}catch{}}
      key('keyup',ch);await sleep(18);
    }
    try{input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));}catch{}
    return true;
  }
  function lookupLabelMatches(actual,expected){
    const a=norm(actual||''),e=norm(expected||'');
    return !!a&&!!e&&a===e;
  }
  async function activateLookupOption(root,hit,input,index,expectedLabel){
    if(!hit?.el)return false;
    const candidates=[hit.el];
    try{hit.el.querySelectorAll?.('button,a,[role=option],lightning-base-combobox-item,.slds-listbox__option,.slds-listbox__item,.slds-truncate').forEach(x=>{if(!candidates.includes(x))candidates.push(x);});}catch{}
    for(const candidate of candidates){
      fireClickSequence(candidate,{scroll:false});
      await sleep(150);
      const trigger=comboTrigger(root);
      const live=norm(trigger?.getAttribute?.('data-value')||readable(trigger||''));
      if(live===norm(expectedLabel)||live.includes(norm(expectedLabel))||!lookupInput(root))return true;
      if(trigger?.getAttribute?.('aria-expanded')==='false')return true;
    }
    try{
      input?.focus?.({preventScroll:true});
      const n=Math.max(0,Number(index)||0);
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',code:'Home',bubbles:true,composed:true}));
      input.dispatchEvent(new KeyboardEvent('keyup',{key:'Home',code:'Home',bubbles:true,composed:true}));
      for(let i=0;i<=n;i++){
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true}));
        input.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true}));
        await sleep(25);
      }
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,composed:true}));
      input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,composed:true}));
      await sleep(160);
      const trigger=comboTrigger(root);
      const live=norm(trigger?.getAttribute?.('data-value')||readable(trigger||''));
      return !lookupInput(root)||live===norm(expectedLabel)||live.includes(norm(expectedLabel))||trigger?.getAttribute?.('aria-expanded')==='false';
    }catch{return false;}
  }

  async function setLookup(root,payload){
    const wanted=typeof payload==='object'&&payload?payload:{displayValue:String(payload??''),recordId:''};
    const label=norm(wanted.displayValue||wanted.label||wanted.name||'');
    const expectedId=String(wanted.recordId||'').trim();
    if(!label&&!expectedId)return{ok:false,reason:'Empty lookup value'};
    const input=lookupInput(root);if(!input)return{ok:false,reason:'Lookup search input could not be found'};
    try{input.focus?.({preventScroll:true});input.click?.()}catch{}
    if(!(await setInputValue(input,label||expectedId)))return{ok:false,reason:'Lookup search input could not be updated'};
    for(let attempt=0;attempt<16;attempt++){
      await sleep(Math.min(70+attempt*20,210));
      const options=lookupOptions(root);
      const idHits=expectedId?options.filter(o=>o.id===expectedId):[];
      const labelHits=label?options.filter(o=>lookupLabelMatches(o.label,label)):[];
      const hits=idHits.length?idHits:labelHits;
      if(hits.length>1)return{ok:false,reason:`Multiple lookup results matched ${wanted.displayValue||wanted.recordId}`};
      const hit=hits[0];
      if(!hit)continue;
      const candidates=[hit.el];try{hit.el.querySelectorAll?.('[role="option"],lightning-base-combobox-item,button,a,.slds-listbox__option,.slds-listbox__item,.slds-truncate').forEach(x=>{if(!candidates.includes(x))candidates.push(x);});}catch{}
      let clicked=false;
      for(const candidate of candidates){fireClickSequence(candidate,{scroll:false});await sleep(80);clicked=true;const trigger=comboTrigger(root);const actualId=lookupRecordId(trigger)||lookupRecordId(root);if(!input.isConnected||trigger?.getAttribute?.('aria-expanded')==='false'||(expectedId&&actualId===expectedId))return{ok:true,mode:expectedId?'lookup-id-click':'lookup-label-click',selected:hit.label};}
      if(!clicked)continue;
      try{input.focus?.({preventScroll:true});input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true,composed:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,composed:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,composed:true}));}catch{}
      await sleep(100);const trigger=comboTrigger(root);const actualId=lookupRecordId(trigger)||lookupRecordId(root);if(!input.isConnected||trigger?.getAttribute?.('aria-expanded')==='false'||(expectedId&&actualId===expectedId))return{ok:true,mode:expectedId?'lookup-id-keyboard':'lookup-label-keyboard',selected:hit.label};
    }
    return{ok:false,reason:`Lookup result not found for ${wanted.displayValue||wanted.recordId}`};
  }
  async function setMulti(dual,values){
    const wanted=[...new Set(values.map(v=>String(v).trim()).filter(Boolean))];
    if(!validValues(wanted))return{ok:false,reason:'Invalid multi-select values'};
    let lists=classifyLists(dual);
    if(!lists.source||!lists.selected)return{ok:false,reason:'Salesforce dual-listbox lists could not be resolved'};

    const catalog=[...lists.source.options,...lists.selected.options];
    const byValue=new Map(catalog.map(o=>[norm(o.value),o]));
    const byLabel=new Map(catalog.map(o=>[norm(o.label),o]));
    const resolved=wanted.map(v=>byValue.get(norm(v))||byLabel.get(norm(v))).filter(Boolean);
    if(resolved.length!==wanted.length)return{ok:false,reason:'One or more recorded multi-select values are unavailable'};

    const wantedSet=new Set(wanted.map(norm));
    const currentSelected=lists.selected.options;
    const extras=currentSelected.filter(o=>!isMultiPlaceholder(o.value)&&!isMultiPlaceholder(o.label)&&!wantedSet.has(norm(o.value))&&!wantedSet.has(norm(o.label)));
    for(const extra of extras){
      lists=classifyLists(dual);
      const fresh=lists.selected?.options.find(o=>norm(o.value)===norm(extra.value)||norm(o.label)===norm(extra.label));
      if(!fresh)continue;
      if(!(await selectOption(fresh.el,false)))return{ok:false,reason:'Could not select existing multi-select value for removal'};
      if(!clickMoveButton(dual,false))return{ok:false,reason:'Could not move selected value back to Available'};
      await sleep(180);
    }

    for(const target of resolved){
      lists=classifyLists(dual);
      if(!lists.source||!lists.selected)return{ok:false,reason:'Dual-listbox rerendered before selection completed'};
      const already=lists.selected.options.some(o=>norm(o.value)===norm(target.value)||norm(o.label)===norm(target.label));
      if(already)continue;
      const fresh=lists.source.options.find(o=>norm(o.value)===norm(target.value)||norm(o.label)===norm(target.label)||norm(o.value)===norm(target.label)||norm(o.label)===norm(target.value));
      if(!fresh)return{ok:false,reason:`Recorded multi-select value is not available: ${target.label||target.value}`};
      if(!(await selectOption(fresh.el,false)))return{ok:false,reason:`Salesforce did not select Available option: ${target.label||target.value}`};
      // Lightning enables the move button asynchronously after the Available
      // option becomes selected. Wait for that state instead of clicking while
      // the button is still disabled/stale.
      let moved=false;
      for(let i=0;i<8;i++){
        await sleep(55);
        const button=findMoveButton(dual,true);
        if(button && !button.matches?.(':disabled,[aria-disabled="true"]')){
          moved=clickMoveButton(dual,true);
          if(moved)break;
        }
      }
      if(!moved)return{ok:false,reason:'Could not activate Move selection to Selected'};
      await sleep(260);
      // Confirm the option actually left Available before continuing. This
      // prevents a selected-but-unmoved option from being treated as preserved.
      for(let i=0;i<6;i++){
        lists=classifyLists(dual);
        const stillAvailable=lists.source?.options?.some(o=>norm(o.value)===norm(target.value)||norm(o.label)===norm(target.label));
        const nowSelected=lists.selected?.options?.some(o=>norm(o.value)===norm(target.value)||norm(o.label)===norm(target.label));
        if(nowSelected&&!stillAvailable)break;
        await sleep(60);
      }
    }

    for(let i=0;i<18;i++){
      const actual=selectedSet(dual);
      if(sameSet(actual,wanted))return{ok:true,mode:'native-click',selected:actual};
      await sleep(80+i*15);
      lists=classifyLists(dual);
    }
    return{ok:false,reason:'Salesforce did not confirm the selected multi-select values'};
  }

  // MAIN-world CustomEvents are observable by page scripts. This short-lived nonce is only a replay guard/capability check, never authentication.
  window.addEventListener('forcepilot-bridge-init',event=>{
    const d=event.detail||{};
    if(d.version!==BUILD||!validRequest(d.requestId)||!validId(d.id)||!['set-pick','set-multi','set-pick-index','set-lookup'].includes(d.action))return;
    if(typeof d.nonce!=='string'||d.nonce.length<16||d.nonce.length>200)return;
    capabilityChallenges.set(d.requestId,{nonce:d.nonce,id:d.id,action:d.action,expiresAt:Number(d.expiresAt||Date.now()+2500)});
    for(const [k,v] of capabilityChallenges){if(v.expiresAt<Date.now())capabilityChallenges.delete(k)}
  },{capture:true});

  window.addEventListener('forcepilot-page-action',/** @param {CustomEvent<any>} event */async event=>{
    const d=event.detail||{};
    const challenge=capabilityChallenges.get(d.requestId);
    if(!challenge||challenge.expiresAt<Date.now()||challenge.nonce!==d.nonce||challenge.id!==d.id||challenge.action!==d.action||d.version!==BUILD||!validRequest(d.requestId)||requests.has(d.requestId)||!validId(d.id))return;
    capabilityChallenges.delete(d.requestId);
    if(d.action==='set-multi' && !validValues(d.value))return;
    if(d.action==='set-pick' && !(typeof d.value==='string'&&d.value.trim()&&d.value.length<=MAX_TEXT))return;
    if(d.action==='set-pick-index' && !(Number.isInteger(Number(d.value))&&Number(d.value)>=1&&Number(d.value)<=100))return;
    if(d.action==='set-lookup' && !(d.value&&typeof d.value==='object'&&String(d.value.displayValue||d.value.label||d.value.name||d.value.recordId||'').trim()))return;
    if(d.action!=='set-multi'&&d.action!=='set-pick'&&d.action!=='set-pick-index'&&d.action!=='set-lookup')return;
    requests.add(d.requestId);pruneTargets();
    /** @type {any} */ let result={ok:false,reason:'Bridge request rejected'};
    try{
      const target=findTarget(d.id);
      if(target&&target.isConnected&&allowedTarget(target)){
        result=d.action==='set-multi' ? await setMulti(target,d.value) : d.action==='set-pick-index' ? await setPickByIndex(target,Number(d.value)) : d.action==='set-lookup' ? await setLookup(target,d.value) : await setPick(target,d.value);
      } else if(!target)result={ok:false,reason:'Bridge target unavailable'};
      else result={ok:false,reason:'Bridge target is not a supported Salesforce Lightning control'};
    }catch(e){result={ok:false,reason:String(e?.message||'Bridge error').slice(0,200)};}
    finally{
      requests.delete(d.requestId);
      window.dispatchEvent(new CustomEvent('forcepilot-page-result',{detail:{requestId:d.requestId,version:BUILD,result}}));
    }
  },{capture:true});
})();
