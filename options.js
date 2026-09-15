/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

const STORAGE_KEY='forcepilot.settings.v1',RECORDINGS_KEY='forcepilot.recordings.v1';
const DEFAULTS={stopOnFailure:false,verifyAfterReplay:true,fillEmptyOnly:true,showOverlay:true,dateRelativeToToday:true};
const app=document.getElementById('app');
let recordings={},selectedId=null,settings={...DEFAULTS},editing=false,draft=null,snapshot=null,activeSection='recordings',recordingSearch='',fieldSearch='';

const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clone=v=>JSON.parse(JSON.stringify(v));
const cleanNumber=v=>{const m=String(v??'').replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);return m?String(Number(m[0])):String(v??'').trim()};
const rawTypes=s=>[s?.target?.fieldType,s?.target?.sfDataType,s?.target?.salesforceType,s?.target?.type].map(v=>String(v||'').toLowerCase()).filter(Boolean);
const normalizeType=s=>{const r=rawTypes(s).find(v=>!['text','string','field','input'].includes(v))||String(s?.target?.kind||'').toLowerCase();if(r==='boolean'||r==='checkbox'||s?.target?.kind==='boolean')return'checkbox';if(r.includes('multi')||r==='multipicklist'||s?.target?.kind==='multi-picklist')return'multipicklist';if(r.includes('picklist')||r==='combobox'||s?.target?.kind==='picklist')return'picklist';if(r==='date'||s?.target?.kind==='date')return'date';if(r==='datetime'||r==='date/time'||s?.target?.kind==='datetime')return'datetime';if(r==='time'||s?.target?.kind==='time')return'time';if(r==='reference'||r==='lookup'||s?.target?.reference||s?.target?.kind==='lookup')return'lookup';if(['currency','percent','double','int','integer','long','decimal','number'].includes(r)||r.includes('number')||s?.target?.kind==='number')return'number';return'text'};
const typeLabel=s=>{const raws=rawTypes(s);if(raws.includes('currency'))return'Currency';if(raws.includes('percent'))return'Percent';const t=normalizeType(s);return({checkbox:'Checkbox',picklist:'Picklist',multipicklist:'Multipicklist',text:'Text',number:'Number',date:'Date',datetime:'Date/Time',time:'Time',lookup:'Lookup'}[t]||'Text')};
const display=v=>Array.isArray(v)?v.join('; '):v&&typeof v==='object'?(v.displayValue||'—'):String(v??'');
const cleanEditedValue=(s,v)=>['Currency','Percent','Number'].includes(typeLabel(s))?cleanNumber(v):v;
const optionList=s=>Array.isArray(s?.target?.options)?s.target.options:[];
const valuesArray=v=>Array.isArray(v)?v:String(v??'').split(/\s*;\s*|\s*,\s*/).map(x=>x.trim()).filter(Boolean);
const dateOffsetLabel=offset=>{const n=Number(offset);if(!Number.isFinite(n))return'';if(n===0)return'Today';return`Today ${n>0?'+':'-'} ${Math.abs(n)} day${Math.abs(n)===1?'':'s'}`};
const dateFieldDisplay=s=>{const m=s?.meta||{};if(m.dateMode==='relative'&&Number.isFinite(Number(m.dateOffsetDays)))return String(m.dateExpression||dateOffsetLabel(m.dateOffsetDays));return String(s?.value??'')};
const parseRelativeDate=v=>{const s=String(v??'').trim().toLowerCase().replace(/\s+/g,' ');if(s==='today')return 0;const m=s.match(/^today\s*([+-])\s*(\d+)\s*days?$/);return m?((m[1]==='-'?-1:1)*Number(m[2])):null};
const dateAtLocalMidnight=iso=>{const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));return Number.isNaN(d.getTime())?null:d};
const localDateISO=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const dateOffsetDays=(fromISO,toISO)=>{const from=dateAtLocalMidnight(fromISO),to=dateAtLocalMidnight(toISO);return from&&to?Math.round((to.getTime()-from.getTime())/86400000):null};
const shiftDateFrom=(baseISO,offset)=>{const d=dateAtLocalMidnight(baseISO)||new Date();d.setDate(d.getDate()+Number(offset));return localDateISO(d)};
const hasValue=s=>{const v=s?.value;if(Array.isArray(v))return v.length>0;if(v&&typeof v==='object')return !!String(v.displayValue||v.id||'').trim();return v!==null&&v!==undefined&&String(v).trim()!==''};
const fmtUpdated=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(d)};

async function load(){
  const d=await chrome.storage.local.get([STORAGE_KEY,RECORDINGS_KEY]);
  settings={...DEFAULTS,...(d[STORAGE_KEY]||{})};
  recordings=d[RECORDINGS_KEY]||{};
  const params=new URLSearchParams(location.search);
  selectedId=params.get('recording')||Object.keys(recordings)[0]||null;
  activeSection=params.get('section')==='settings'?'settings':'recordings';
  render();
}

function list(){
  const q=String(recordingSearch||'').trim().toLowerCase();
  return Object.values(recordings)
    .filter(r=>`${r.name} ${r.context?.objectLabel||''} ${r.context?.objectApiName||''} ${r.steps.map(s=>`${s.target.label} ${s.target.apiName||s.target.key||''}`).join(' ')}`.toLowerCase().includes(q))
    .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
}

function fieldMatches(s){
  const q=String(fieldSearch||'').trim().toLowerCase();
  if(!q)return true;
  return `${s.target?.label||''} ${s.target?.apiName||s.target?.key||''} ${display(s.value)} ${typeLabel(s)}`.toLowerCase().includes(q);
}

async function hydrateDraftPicklists(draftObj){
  const needs=(draftObj?.steps||[]).filter(s=>['picklist','multipicklist'].includes(normalizeType(s)) && (!optionList(s).length));
  if(!needs.length)return;
  const resp=await chrome.runtime.sendMessage({type:'GET_FIELD_DESCRIPTORS',targets:needs.map(s=>s.target)}).catch(()=>null); if(!resp?.ok)return;
  const byKey=new Map((resp.descriptors||[]).map(d=>[d.targetKey,d]));
  for(const s of draftObj.steps||[]){const d=byKey.get(s.target?.key)||byKey.get(`api:${s.target?.apiName}`);if(!d)continue;s.target={...s.target,kind:d.kind||s.target.kind,fieldType:d.fieldType||s.target.fieldType,sfDataType:d.sfDataType||s.target.sfDataType,salesforceType:d.salesforceType||s.target.salesforceType,options:d.options?.length?d.options:s.target.options};}
}

function editorField(s,i){
  const t=normalizeType(s),v=s.value,opts=optionList(s);
  if(t==='checkbox')return`<label class="edit-check"><input class="check" type="checkbox" data-edit-bool="${i}" ${v===true||String(v).toLowerCase()==='true'?'checked':''}><span>Checked</span></label>`;
  if(t==='picklist'&&opts.length)return`<select class="editor-select" data-edit-value="${i}">${opts.map(o=>`<option value="${esc(o.value)}" ${(String(v)===String(o.value)||String(v)===String(o.displayValue))?'selected':''}>${esc(o.displayValue||o.value)}</option>`).join('')}</select>`;
  if(t==='multipicklist'&&opts.length){
    const vals=valuesArray(v).map(x=>x.toLowerCase());
    return`<div class="multi-options">${opts.map(o=>{const label=o.displayValue||o.value,on=vals.includes(String(o.value).toLowerCase())||vals.includes(String(label).toLowerCase());return`<label><input type="checkbox" data-multi-index="${i}" data-multi-value="${esc(o.value)}" ${on?'checked':''}><span>${esc(label)}</span></label>`}).join('')}</div>`;
  }
  if(t==='date')return`<input class="edit-control" type="text" data-edit-value="${i}" value="${esc(dateFieldDisplay(s))}" placeholder="Today, Today + 3 days, Today - 2 days">`;
  return`<input class="edit-control" type="text" data-edit-value="${i}" value="${esc(display(v))}" placeholder="Recorded value">`;
}

function render(){
  const rows=list(),r=selectedId?recordings[selectedId]:null;
  app.innerHTML=`
    <div class="page-head">
      <div class="brandhead"><img class="mark" src="branding/forcepilot-icon.png" alt=""><img class="word" src="branding/forcepilot-wordmark.png" alt="ForcePilot"></div>
      <div class="toolbar">
        <button class="secondary" id="import">Import</button>
        <input id="importFile" type="file" accept="application/json,.json" hidden>
        <button class="secondary" id="export">Export</button>
        <details class="more-menu"><summary class="secondary more-trigger" aria-label="More actions">⋮</summary><div class="more-popover"><button id="deleteAll">Delete all recordings</button></div></details>
      </div>
    </div>
    <div class="page-title-row"><div><h1>Recordings &amp; Autofill</h1><p>Manage saved Salesforce field recordings and autofill behavior.</p></div></div>
    <nav class="top-tabs" aria-label="Options sections">
      <button class="tab ${activeSection==='recordings'?'active':''}" data-section="recordings">Recordings</button>
      <button class="tab ${activeSection==='settings'?'active':''}" data-section="settings">Settings</button>
    </nav>
    ${activeSection==='recordings'?renderRecordings(rows,r):renderSettings()}`;
  bind();
}

function renderRecordings(rows,r){
  return`<div class="manager">
    <section class="panel recording-panel">
      <div class="section-title-row"><div><h2>Saved recordings</h2><span>${rows.length} saved</span></div></div>
      ${rows.length?`<input class="search" id="search" value="${esc(recordingSearch)}" placeholder="Search recordings…" aria-label="Search recordings"><div class="recording-list">${rows.map(x=>`<button class="listitem ${x.id===selectedId?'active':''}" data-id="${esc(x.id)}"><span class="grow"><strong>${esc(x.name)}</strong><small>${x.steps.length} field${x.steps.length===1?'':'s'}</small></span><span class="chevron">›</span></button>`).join('')}</div>`:`<div class="empty-state"><strong>No recordings yet</strong><span>Record a Salesforce form and it will appear here.</span></div>`}
    </section>
    <section class="panel editor-panel">${r?renderEditor(r):'<div class="empty-editor"><strong>Select a recording</strong><span>Choose a recording to review or edit it.</span></div>'}</section>
  </div>`;
}

function renderSettings(){
  return`<section class="panel settings-panel settings-page">
    <div class="section-title-row"><div><h2>Autofill settings</h2><span>Defaults used when Autofill runs.</span></div><button class="secondary compact" id="reset">Reset defaults</button></div>
    <div class="setting-group"><h3>Autofill behavior</h3>${setting('fillEmptyOnly','Fill empty fields only',"Existing Salesforce values won't be changed.")}${setting('verifyAfterReplay','Verify filled values','Check Salesforce after each field is filled.')}${setting('stopOnFailure','Stop on first failure','Stop the run when a field cannot be filled.')}</div>
    <div class="setting-group"><h3>Salesforce integration</h3>${setting('showOverlay','Show ForcePilot on Salesforce','Keep the ForcePilot launcher available on Salesforce pages.')}</div><div class="setting-group"><h3>Date recording</h3>${setting('dateRelativeToToday','Save recorded dates relative to today','When enabled, dates are stored as Today ± days. When disabled, the actual recorded date is stored.')}</div>
  </section>`;
}

function setting(k,t,d){return`<div class="setting-row"><div><strong>${t}</strong><small>${d}</small></div><input class="check" type="checkbox" data-setting="${k}" ${settings[k]?'checked':''}></div>`}

function renderEditor(r){
  const x=editing?draft:r;
  const visible=x.steps.map((s,i)=>({s,i})).filter(({s})=>fieldMatches(s));
  const populated=x.steps.filter(hasValue).length,blank=x.steps.length-populated;
  const updated=fmtUpdated(x.updatedAt);
  return`<div class="editor-shell">
    <div class="editor-head">
      <div class="editor-heading">
        <div class="breadcrumb">Recordings / Saved recording</div>
        <h2>${esc(x.name)}</h2>
        <div class="editor-summary"><span>${x.steps.length} field${x.steps.length===1?'':'s'}</span>${x.context?.objectLabel?`<span>${esc(x.context.objectLabel)}</span>`:''}</div>
      </div>
      ${!editing?'<button class="primary" id="edit">Edit recording</button>':''}
    </div>
    ${editing?`<div class="name-editor"><label>Recording name<input class="input" id="name" value="${esc(x.name)}"></label><span class="edit-help">Change recorded values or disable fields you don't want to use.</span></div>`:''}
    <div class="recording-tools">
      <div class="field-count"><strong>${x.steps.length} fields</strong>${blank ? `<span>${blank} blank</span>` : ''}</div>
      <input class="search field-search" id="fieldSearch" value="${esc(fieldSearch)}" placeholder="Search fields…" aria-label="Search fields">
    </div>
    <div class="field-table" role="table" aria-label="Recorded fields">
      <div class="field-table-head" role="row"><span>#</span><span>Field</span><span>Value</span><span>Type</span>${editing?'<span aria-hidden="true"></span>':''}</div>
      <div class="editor-list">${visible.length?visible.map(({s,i})=>renderFieldRow(s,i)).join(''):`<div class="no-fields">No fields match “${esc(fieldSearch)}”.</div>`}</div>
    </div>
    ${editing?'<div class="actions editor-actions"><button class="secondary" id="cancelEdit">Cancel</button><button class="primary" id="saveEdit">Save changes</button></div>':'<div class="actions"><button class="secondary delete-one" id="deleteOne">Delete recording</button></div>'}
  </div>`;
}

function renderFieldRow(s,i){
  const t=normalizeType(s);
  return`<div class="editor-row" role="row">
    <span class="step-number">${i+1}</span>
    <div class="field-main"><strong>${esc(s.target.label)}</strong><span class="api">${esc(s.target.apiName||s.target.key||'')}</span></div>
    <div class="field-value">${editing?editorField(s,i):`<span class="value-text">${esc((t==='date'?dateFieldDisplay(s):display(s.value))||'—')}</span>`}</div>
    <div class="field-type"><span class="typepill">${typeLabel(s)}</span></div>
    ${editing?`<div class="row-tools"><label class="use-check" title="Use in Autofill"><input class="check" type="checkbox" data-enabled="${i}" ${s.enabled!==false?'checked':''}></label><button class="icon-delete" data-remove="${i}" title="Remove field" aria-label="Remove field"><svg viewBox="0 0 20 20"><path d="M7 3h6l1 2h3v2H3V5h3l1-2Zm-2 5h10l-.7 9H5.7L5 8Zm3 2v5h1v-5H8Zm3 0v5h1v-5h-1Z"/></svg></button></div>`:''}
  </div>`;
}

function bind(){
  document.querySelectorAll('.listitem[data-id]').forEach(b=>b.addEventListener('click',()=>{if(!leaveEdit())return;selectedId=b.dataset.id;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';render()}));
  document.querySelectorAll('[data-section]').forEach(b=>b.addEventListener('click',()=>{if(!leaveEdit())return;activeSection=b.dataset.section;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';const u=new URL(location.href);u.searchParams.set('section',activeSection);if(selectedId)u.searchParams.set('recording',selectedId);history.replaceState({},'',u);render()}));
  document.getElementById('search')?.addEventListener('input',e=>{recordingSearch=e.target.value;clearTimeout(window.fpSearchTimer);window.fpSearchTimer=setTimeout(()=>{const pos=recordingSearch.length;render();const el=document.getElementById('search');if(el){el.focus();el.setSelectionRange(pos,pos)}},100)});
  document.getElementById('fieldSearch')?.addEventListener('input',e=>{fieldSearch=e.target.value;render();const el=document.getElementById('fieldSearch');if(el){el.focus();el.setSelectionRange(fieldSearch.length,fieldSearch.length)}});
  document.querySelectorAll('[data-setting]').forEach(el=>el.addEventListener('change',async e=>{settings={...settings,[e.target.dataset.setting]:e.target.checked};await chrome.storage.local.set({[STORAGE_KEY]:settings})}));
  document.getElementById('reset')?.addEventListener('click',async()=>{if(!confirm('Reset settings to the defaults?'))return;settings={...DEFAULTS};await chrome.storage.local.set({[STORAGE_KEY]:settings});render()});
  document.getElementById('edit')?.addEventListener('click',async()=>{draft=clone(recordings[selectedId]);snapshot=clone(draft);editing=true;render();await hydrateDraftPicklists(draft);render()});
  document.getElementById('cancelEdit')?.addEventListener('click',()=>{editing=false;draft=snapshot=null;render()});
  document.getElementById('saveEdit')?.addEventListener('click',saveEdit);
  document.getElementById('deleteOne')?.addEventListener('click',deleteOne);
  document.getElementById('deleteAll')?.addEventListener('click',deleteAll);
  document.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',()=>{draft.steps.splice(Number(b.dataset.remove),1);draft.steps.forEach((s,i)=>s.sequence=i+1);render()}));
  document.getElementById('export')?.addEventListener('click',exportData);
  document.getElementById('import')?.addEventListener('click',()=>document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change',importData);
}

function leaveEdit(){return!editing||JSON.stringify(draft)===JSON.stringify(snapshot)||confirm('Discard unsaved changes?')}

async function saveEdit(){
  if(!draft)return;
  draft.name=document.getElementById('name')?.value.trim()||draft.name;
  draft.steps.forEach((s,i)=>{
    const b=document.querySelector(`[data-edit-bool="${i}"]`),v=document.querySelector(`[data-edit-value="${i}"]`);
    if(b)s.value=b.checked;
    else if(normalizeType(s)==='multipicklist'&&optionList(s).length)s.value=[...document.querySelectorAll(`[data-multi-index="${i}"]:checked`)].map(x=>x.dataset.multiValue).filter(Boolean);
    else if(v){
      if(normalizeType(s)==='date'){
        const input=String(v.value||'').trim();
        const recordingDate=s.meta?.dateRecordedOn||draft.recordingDate||localDateISO();
        const relativeOffset=parseRelativeDate(input);
        const relativeMode=settings.dateRelativeToToday!==false;
        if(relativeMode){
          if(relativeOffset!==null){
            s.value=shiftDateFrom(recordingDate,relativeOffset);
            s.meta={...(s.meta||{}),dateRecordedOn:recordingDate,dateOffsetDays:relativeOffset,dateExpression:dateOffsetLabel(relativeOffset),dateMode:'relative'};
          }else{
            const m=input.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
            const normalized=m?`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`:input;
            const offset=dateOffsetDays(recordingDate,normalized);
            if(offset!==null&&/^\d{4}-\d{2}-\d{2}$/.test(normalized)){s.value=normalized;s.meta={...(s.meta||{}),dateRecordedOn:recordingDate,dateOffsetDays:offset,dateExpression:dateOffsetLabel(offset),dateMode:'relative'};}
            else{s.value=input;}
          }
        }else{
          let normalized=input;
          const m=input.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
          if(m)normalized=`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
          if(relativeOffset!==null)normalized=shiftDateFrom(recordingDate,relativeOffset);
          s.value=normalized;
          if(s.meta){delete s.meta.dateExpression;delete s.meta.dateOffsetDays;delete s.meta.dateMode;}
        }
      }else s.value=cleanEditedValue(s,v.value);
    }
    s.enabled=document.querySelector(`[data-enabled="${i}"]`)?.checked!==false;
    s.sequence=i+1;
  });
  draft.updatedAt=new Date().toISOString();
  recordings[draft.id]=clone(draft);
  await chrome.storage.local.set({[RECORDINGS_KEY]:recordings});
  editing=false;draft=snapshot=null;render();show('Recording saved');
}

async function deleteOne(){const r=recordings[selectedId];if(!r||!confirm(`Delete “${r.name}”?`))return;delete recordings[selectedId];selectedId=Object.keys(recordings)[0]||null;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';await chrome.storage.local.set({[RECORDINGS_KEY]:recordings});render();show('Recording deleted')}
async function deleteAll(){if(!Object.keys(recordings).length)return;if(!confirm('Delete all recordings?'))return;recordings={};selectedId=null;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';await chrome.storage.local.set({[RECORDINGS_KEY]:{}});render();show('All recordings deleted')}
function exportData(){const blob=new Blob([JSON.stringify({schemaVersion:4,exportedAt:new Date().toISOString(),recordings,settings},null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='forcepilot-recordings.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
async function importData(e){
  try{
    const file=e.target.files?.[0];if(!file)return;if(file.size>5*1024*1024)throw Error('Recording file is too large.');
    const d=JSON.parse(await file.text());
    if(!d||typeof d!=='object'||!d.recordings||typeof d.recordings!=='object'||Array.isArray(d.recordings))throw Error('Invalid recording file.');
    const incoming=Object.values(d.recordings);if(incoming.length>1000)throw Error('Too many recordings in this file.');
    const allowedActions=new Set(['set-value','set-boolean','select-option','set-multi-option','select-lookup','set-address']);const accepted=[];
    for(const r of incoming){
      if(!r||typeof r!=='object'||typeof r.id!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(r.id)||!Array.isArray(r.steps)||r.steps.length>500)continue;
      const steps=r.steps.filter(s=>s&&typeof s==='object'&&allowedActions.has(s.action)&&s.target&&typeof s.target==='object'&&typeof s.target.label==='string'&&s.target.label.length<=500&&JSON.stringify(s.value??'').length<=10000);
      if(steps.length!==r.steps.length)continue;
      const clean={...r,steps,name:String(r.name||'Recording').slice(0,200),context:r.context&&typeof r.context==='object'?{objectApiName:String(r.context.objectApiName||'').slice(0,200),objectLabel:String(r.context.objectLabel||'').slice(0,200),mode:String(r.context.mode||'').slice(0,50)}:{}};accepted.push(clean);
    }
    if(!accepted.length)throw Error('No valid recordings were found.');
    for(const r of accepted)recordings[r.id]=r;
    if(d.settings&&typeof d.settings==='object')settings={...settings,...Object.fromEntries(Object.entries(d.settings).filter(([k,v])=>k in DEFAULTS&&typeof v==='boolean'))};
    const bytes=new TextEncoder().encode(JSON.stringify(recordings)).byteLength;if(bytes>5*1024*1024)throw Error('Saved recordings are too large. Remove some recordings and try again.');
    await chrome.storage.local.set({[RECORDINGS_KEY]:recordings,[STORAGE_KEY]:settings});render();show(`Imported ${accepted.length} recording${accepted.length===1?'':'s'}.`);
  }catch(err){show(err.message||'Import failed.',true)}finally{e.target.value=''}
}
function show(m,error=false){const el=document.getElementById('message');if(!el)return;el.textContent=m;el.className='message show'+(error?' error':'');clearTimeout(show.t);show.t=setTimeout(()=>el.className='message',2200)}
load().catch(err=>show(err.message||String(err),true));
