/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

import { icon } from './src/material-icons.js';
import { STORAGE_KEY as RECORDINGS_KEY, SETTINGS_KEY as STORAGE_KEY, getRecordings, getSettings, saveRecordings, saveSettings, SCHEMA_VERSION, normalizeStoredRecordings, DEFAULT_SETTINGS, escapeHtml } from './src/shared-module.js';
import { applyTheme, watchTheme } from './src/theme.js';
import { showToast } from './src/toast.js';
const DEFAULTS={...DEFAULT_SETTINGS};
const app=document.getElementById('app');
let recordings={},selectedId=null,settings={...DEFAULTS},editing=false,draft=null,snapshot=null,activeSection='recordings',recordingSearch='',fieldSearch='',pendingConfirmation=null,pendingImport=null,expandedRandomKey=null;

const clone=v=>JSON.parse(JSON.stringify(v));
const cleanNumber=v=>{const m=String(v??'').replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);return m?String(Number(m[0])):String(v??'').trim()};
const rawTypes=s=>[s?.target?.fieldType,s?.target?.sfDataType,s?.target?.salesforceType,s?.target?.type].map(v=>String(v||'').toLowerCase()).filter(Boolean);
const normalizeType=s=>{const raws=rawTypes(s),kind=String(s?.target?.kind||'').toLowerCase();const specific=raws.find(v=>!['text','string','field','input',''].includes(v));const r=specific||kind||raws[0]||'';if(r==='boolean'||r==='checkbox'||kind==='boolean')return'checkbox';if(r.includes('multi')||r==='multipicklist'||kind==='multi-picklist')return'multipicklist';if(r.includes('picklist')||r==='combobox'||kind==='picklist')return'picklist';if(r==='date'||kind==='date')return'date';if(['datetime','date/time','date-time'].includes(r)||kind==='datetime')return'datetime';if(r==='time'||kind==='time')return'time';if(r==='address'||kind==='address'||s?.target?.compoundType==='address')return'address';if(r==='email'||kind==='email')return'email';if(r==='phone'||kind==='phone')return'phone';if(r==='url'||kind==='url')return'url';if(r==='reference'||r==='lookup'||s?.target?.reference||kind==='lookup')return'lookup';if(['currency','percent','double','int','integer','long','decimal','number'].includes(r)||r.includes('number')||kind==='number')return'number';if(['longtext','longtextarea','textarea','richtext','richtextarea'].includes(r)||['longtext','textarea'].includes(kind))return'longtext';return'text'};
const typeLabel=s=>{const raws=rawTypes(s);if(raws.includes('currency'))return'Currency';if(raws.includes('percent'))return'Percent';const t=normalizeType(s);return({checkbox:'Checkbox',picklist:'Picklist',multipicklist:'Multi-select picklist',text:'Text',longtext:'Long text',number:'Number',date:'Date',datetime:'Date/Time',time:'Time',lookup:'Lookup',address:'Address',email:'Email',phone:'Phone',url:'URL'}[t]||'Text')};
const display=v=>Array.isArray(v)?v.join('; '):v&&typeof v==='object'?(v.displayValue||'—'):String(v??'');
const cleanEditedValue=(s,v)=>['Currency','Percent','Number'].includes(typeLabel(s))?cleanNumber(v):v;
const apiDisplayName=s=>{const raw=String(s?.target?.apiName||'').trim();if(!raw||/^label:/i.test(raw))return'';const path=String(s?.target?.fieldPath||'').trim();if(!raw&&(!path||/^label:/i.test(path)))return'';const source=raw||path;const parts=source.split('.').filter(Boolean);return parts[parts.length-1]||source};
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
  settings={...DEFAULTS,...await getSettings()};
  applyTheme(settings.darkMode);
  recordings=await getRecordings();
  const params=new URLSearchParams(location.search);
  selectedId=params.get('recording')||Object.keys(recordings)[0]||null;
  activeSection=params.get('section')==='settings'?'settings':'recordings';
  render();
  // Repair recordings that were captured before a field API name was available.
  // This is intentionally generic: it asks the live Salesforce page to resolve
  // every target that is missing a trustworthy API name, including picklists.
  if(selectedId&&recordings[selectedId]){
    await hydrateRecordingTargets(recordings[selectedId], {persist:true});
    render();
  }
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

async function hydrateRecordingTargets(recording,{persist=false}={}){
  if(!recording?.steps?.length)return false;
  const needs=(recording.steps||[]).filter(s=>{
    const api=String(s?.target?.apiName||'').trim();
    const path=String(s?.target?.fieldPath||'').trim();
    const bad=!api||/^label:/i.test(api)||!path&&!api;
    return bad || (['picklist','multipicklist'].includes(normalizeType(s))&&(!optionList(s).length||(!s.target?.isDependentPicklist&&!s.target?.controllerName&&!s.target?.controllerValues&&!s.target?.controllingFields?.length)));
  });
  if(!needs.length)return false;
  const resp=await chrome.runtime.sendMessage({type:'GET_FIELD_DESCRIPTORS',targets:needs.map(s=>s.target)}).catch(()=>null);
  if(!resp?.ok)return false;
  const descriptors=resp.descriptors||[];
  const byKey=new Map();
  const byResolvedKey=new Map();
  const bySelection=new Map();
  const byLabelType=new Map();
  const norm=v=>String(v??'').trim().toLowerCase();
  descriptors.forEach(d=>{
    if(d.targetKey)byKey.set(d.targetKey,d);
    if(d.resolvedTargetKey)byResolvedKey.set(d.resolvedTargetKey,d);
    if(d.targetSelectionName)bySelection.set(norm(d.targetSelectionName),d);
    const lk=`${norm(d.objectApiName)}|${norm(d.label)}|${norm(d.kind||d.fieldType)}`;
    if(lk!=='||'){const matches=byLabelType.get(lk)||[];matches.push(d);byLabelType.set(lk,matches);}
  });
  let changed=false;
  for(const s of recording.steps||[]){
    const key=s?.target?.key;
    const apiKey=s?.target?.apiName?`api:${s.target.apiName}`:'';
    const selectionKey=norm(s?.target?.targetSelectionName);
    const labelKey=`${norm(s?.target?.objectApiName||recording?.context?.objectApiName)}|${norm(s?.target?.label)}|${norm(normalizeType(s))}`;
    const labelMatches=byLabelType.get(labelKey)||[];
    const d=byKey.get(key)||byResolvedKey.get(key)||byKey.get(apiKey)||bySelection.get(selectionKey)||(labelMatches.length===1?labelMatches[0]:null);
    if(!d)continue;
    const nextTarget={...s.target,
      key:d.targetKey||s.target.key,
      label:d.label||s.target.label,
      apiName:(d.apiName&&!/^label:/i.test(String(d.apiName)))?d.apiName:s.target.apiName,
      name:d.name||s.target.name,
      kind:d.kind||s.target.kind,
      fieldType:d.fieldType||s.target.fieldType,
      sfDataType:d.sfDataType||s.target.sfDataType,
      salesforceType:d.salesforceType||s.target.salesforceType,
      reference:d.reference??s.target.reference,
      referenceObject:d.referenceObject||s.target.referenceObject,
      multiSelect:d.multiSelect??s.target.multiSelect,
      objectApiName:d.objectApiName||s.target.objectApiName,
      targetSelectionName:d.targetSelectionName||s.target.targetSelectionName,
      fieldId:d.fieldId||s.target.fieldId,
      fieldPath:d.fieldPath||s.target.fieldPath,
      identitySource:d.identitySource||s.target.identitySource,
      identityConfidence:d.identityConfidence??s.target.identityConfidence,
      options:d.options?.length?d.options:(s.target.options||[]),
      controllerName:d.controllerName||s.target.controllerName,
      controllingFields:Array.isArray(d.controllingFields)?d.controllingFields.slice():(s.target.controllingFields||[]),
      controllerValues:d.controllerValues||s.target.controllerValues,
      isDependentPicklist:d.isDependentPicklist??s.target.isDependentPicklist
    };
    if(JSON.stringify(nextTarget)!==JSON.stringify(s.target)){s.target=nextTarget;changed=true;}
  }
  if(changed&&persist){
    recordings[recording.id]=recording;
    await saveRecordings(recordings);
  }
  return changed;
}

async function hydrateDraftPicklists(draftObj){
  return hydrateRecordingTargets(draftObj,{persist:false});
}

function randomizer(){return window.ForcePilotRandomizer||null;}
function randomCfgFor(step){const core=randomizer();return step?.randomization&&typeof step.randomization==='object'?clone(step.randomization):(core?.defaults?.(step)||{version:1,enabled:false,strategy:'text',options:{}});}
function randInput(label,key,value,type='text',attrs=''){return`<label class="fp-opt-rand-field"><span>${label}</span><input class="edit-control fp-opt-rand-input" type="${type}" data-rand-opt="${key}" value="${escapeHtml(value??'')}" ${attrs}></label>`;}
function randSelect(label,key,value,items){return`<label class="fp-opt-rand-field"><span>${label}</span><select class="edit-control fp-opt-rand-input" data-rand-opt="${key}">${items.map(([v,l])=>`<option value="${v}" ${String(value??'')===v?'selected':''}>${l}</option>`).join('')}</select></label>`;}
function randCheck(label,key,value){return`<label class="fp-opt-rand-check"><input type="checkbox" class="fp-opt-rand-input" data-rand-opt="${key}" ${value?'checked':''}><span>${label}</span></label>`;}
function renderRandomFields(step,cfg){
 const o=cfg.options||{},st=cfg.strategy,f=[];
 if(st==='textPrefixUnique'){const fallback=randomizer().defaults(step,st).options;f.push(randInput('Custom Text','prefix',o.prefix??fallback.prefix,'text','maxlength="255"'));}
 else if(['text','paragraph'].includes(st)){f.push(randInput('Minimum length','minLength',o.minLength,'number','min="1" step="1"'));f.push(randInput('Maximum length','maxLength',o.maxLength,'number','min="1" step="1"'));}
 else if(['numberRange','numberRangeIncrement','currencyRange','percentRange'].includes(st)){f.push(randInput('Min','min',o.min??1,'number','step="any"'));f.push(randInput('Max','max',o.max,'number','step="any"'));if(st!=='numberRange')f.push(randInput('Increment','step',o.step,'number','min="0.0000001" step="any"'));f.push(randInput('Decimals','decimals',o.decimals,'number','min="0" max="10" step="1"'));}
 else if(st==='relativeDate'){const d=randomizer().defaults(step,st).options;f.push(`<div class="fp-opt-relative-date-row"><span class="fp-opt-relative-fixed">Today</span><select class="edit-control fp-opt-rand-input" data-rand-opt="sign" aria-label="Date direction"><option value="+" ${String(o.sign??d.sign)==='+'?'selected':''}>+</option><option value="-" ${String(o.sign??d.sign)==='-'?'selected':''}>−</option></select><input class="edit-control fp-opt-rand-input" type="number" data-rand-opt="days" min="0" max="36500" step="1" value="${escapeHtml(o.days??d.days)}" aria-label="Days"><span class="fp-opt-relative-days-label">days</span></div><p class="fp-opt-rand-hint">Days before or after the current date.</p>`);}
 else if(st==='dateRange'){const d=randomizer().defaults(step,st).options;f.push(randInput('From','startDate',o.startDate??d.startDate,'date'));f.push(randInput('To','endDate',o.endDate??d.endDate,'date'));}
 else if(st==='dateTimeRange'){const d=randomizer().defaults(step,st).options;f.push('<p class="fp-opt-rand-hint">Experimental: combined date/time inputs only. Split Lightning controls are not verified.</p>');f.push(randInput('From days','fromDays',o.fromDays??d.fromDays,'number','min="-36500" max="36500" step="1"'));f.push(randInput('To days','toDays',o.toDays??d.toDays,'number','min="-36500" max="36500" step="1"'));f.push(randSelect('Preset','direction',o.direction||'any',[['any','Any'],['past','Past only'],['future','Future only']]));f.push(randInput('From time','startTime',o.startTime??d.startTime,'time'));f.push(randInput('To time','endTime',o.endTime??d.endTime,'time'));f.push(randInput('Minute step','stepMinutes',o.stepMinutes??15,'number','min="1" max="1440" step="1"'));f.push(randCheck('Weekdays only','weekdaysOnly',o.weekdaysOnly));}
 else if(st==='timeRange'){f.push(randInput('Start time','startTime',o.startTime,'time'));f.push(randInput('End time','endTime',o.endTime,'time'));f.push(randInput('Minute interval','stepMinutes',o.stepMinutes,'number','min="1" max="1440" step="1"'));}
 else if(st==='email'||st==='url'){f.push(randInput('Domain','domain',o.domain||'example.com'));}
 else if(st==='phone'){f.push(randSelect('Country format','country',o.country||'US',[['US','United States'],['IN','India'],['UK','United Kingdom']]));}
 else if(st==='picklist'||st==='multiPicklist'){const opts=Array.isArray(step?.target?.options)?step.target.options:[];if(opts.length){const allowed=Array.isArray(o.allowedValues)?o.allowedValues:[];f.push(`<fieldset class="fp-opt-allowed"><legend>Allowed options</legend><div class="fp-opt-option-list">${opts.filter(x=>x.active!==false).map(x=>{const val=String(x.value??x.displayValue??''),label=String(x.displayValue??x.value??'');const on=!Array.isArray(o.allowedValues)||allowed.some(a=>String(a).toLowerCase()===val.toLowerCase()||String(a).toLowerCase()===label.toLowerCase());return `<label><input type="checkbox" data-rand-allowed value="${escapeHtml(val)}" ${on?'checked':''}><span>${escapeHtml(label)}</span></label>`}).join('')}</div></fieldset>`);}else f.push(`<p class="fp-opt-rand-hint">${st==='picklist'?'Selects from available recorded options. Do not use for dependent picklists.':'Salesforce options will be resolved during Autofill.'}</p>`);if(st==='multiPicklist'){f.push(randInput('Minimum selections','minSelections',o.minSelections??1,'number','min="1" step="1"'));f.push(randInput('Maximum selections','maxSelections',o.maxSelections??3,'number','min="1" step="1"'));}}
 else if(st==='dependentPicklist'){f.push('<p class="fp-opt-rand-hint">Selects any random available option</p>');}
 else if(st==='lookupRandom'){f.push(randInput('Search text (optional)','searchTerm',o.searchTerm||''));}
 else if(st==='lookupCreate'){f.push('<p class="fp-opt-rand-hint">This is a captured Create New workflow. Keep the parent lookup unchanged and randomize the new-record fields below.</p>');}
 else if(st==='address'){f.push(randSelect('Sample address region','country',o.country||'US',[['US','United States'],['UK','United Kingdom'],['IN','India']]));}
 return f.join('');}
function getRandomStep(key){const parts=String(key).split('.').map(Number);let step=draft?.steps?.[parts[0]];for(const n of parts.slice(1))step=step?.meta?.createNewRecord?.fields?.[n];return step||null;}
function renderNestedRandomizers(step,index){const children=step?.meta?.createNewRecord?.fields;if(!Array.isArray(children)||!children.length)return'';return `<div class="fp-opt-nested-randomizers"><div class="fp-opt-nested-title">New record fields</div>${children.map((child,j)=>`<div class="fp-opt-nested-field"><div><strong>${escapeHtml(child.target?.label||`Field ${j+1}`)}</strong><small>${escapeHtml(typeLabel(child))}</small></div>${renderRandomization(child,`${index}.${j}`)}</div>`).join('')}</div>`;}
function renderRandomization(step,index){const core=randomizer();if(!core)return'';const cfg=randomCfgFor(step);cfg.options=cfg.options||{};const today=localDateISO();
 if(cfg.strategy==='dateRange'&&(cfg.options.fromDays!==undefined||cfg.options.toDays!==undefined)){const from=Number(cfg.options.fromDays??-30),to=Number(cfg.options.toDays??30);cfg.options.startDate=shiftDateFrom(today,from);cfg.options.endDate=shiftDateFrom(today,to);delete cfg.options.fromDays;delete cfg.options.toDays;delete cfg.options.direction;delete cfg.options.weekdaysOnly;}
 if(cfg.strategy==='dateTimeRange'&&cfg.options.fromDays===undefined&&cfg.options.toDays===undefined&&cfg.options.startDateTime&&cfg.options.endDateTime){const from=dateOffsetDays(today,String(cfg.options.startDateTime).slice(0,10)),to=dateOffsetDays(today,String(cfg.options.endDateTime).slice(0,10));if(from!==null&&to!==null){cfg.options.fromDays=from;cfg.options.toDays=to;cfg.options.startTime=String(cfg.options.startDateTime).slice(11,16)||'09:00';cfg.options.endTime=String(cfg.options.endDateTime).slice(11,16)||'17:00';cfg.options.stepMinutes=Number(cfg.options.stepMinutes)||15;cfg.options.direction=cfg.options.direction||'any';cfg.options.weekdaysOnly=!!cfg.options.weekdaysOnly;delete cfg.options.startDateTime;delete cfg.options.endDateTime;}}
 const strategies=core.strategies(step)||[],on=!!cfg.enabled;if(on&&expandedRandomKey===null)expandedRandomKey=String(index);const expanded=on&&expandedRandomKey===String(index);const unique=['text','paragraph','company','email','url','phone','currencyRange','percentRange','multiPicklist','picklist','dependentPicklist','lookupRandom'].includes(cfg.strategy);let preview='—';if(on){const result=core.generate(step,cfg,{usedValues:new Set()});if(result?.ok)preview=Array.isArray(result.value)?result.value.join('; '):typeof result.value==='object'?JSON.stringify(result.value):String(result.value??'—');else preview='Configure settings';}
 return `<section class="fp-opt-randomization" data-opt-randomization="${index}"><div class="fp-opt-rand-head"><strong data-rand-heading="${index}" tabindex="0" role="button" aria-expanded="${expanded}">Randomize value</strong><label class="fp-opt-switch"><input type="checkbox" data-rand-enabled="${index}" ${on?'checked':''} aria-label="Randomize ${escapeHtml(step.target?.label||'field')}"><span></span></label></div>${expanded?`<div class="fp-opt-rand-body"><label class="fp-opt-rand-field fp-opt-rand-strategy"><span>Generate</span><select class="edit-control fp-opt-rand-input" data-rand-strategy="${index}">${strategies.map(x=>`<option value="${escapeHtml(x.value)}" ${cfg.strategy===x.value?'selected':''}>${escapeHtml(x.label)}</option>`).join('')}</select></label><div class="fp-opt-rand-grid ${['numberRange','numberRangeIncrement','currencyRange','percentRange'].includes(cfg.strategy)?`fp-opt-rand-grid-numeric-${cfg.strategy==='numberRange'?3:4}`:['dateRange','dateTimeRange'].includes(cfg.strategy)?'fp-opt-rand-grid-date':''}">${renderRandomFields(step,cfg)}</div>${unique?`<label class="fp-opt-rand-unique"><input type="checkbox" data-rand-unique="${index}" ${cfg.options?.unique?'checked':''}><span>Generate a unique value</span></label>`:''}${on&&cfg.strategy==='lookupRandom'?'<p class="fp-opt-rand-warning" role="note">May select a real Salesforce record.</p>':''}<div class="fp-opt-rand-preview"><span><small>Example</small><strong data-rand-preview="${index}">${escapeHtml(preview)}</strong></span><button type="button" class="secondary compact" data-rand-generate="${index}">Preview</button></div><p class="fp-opt-rand-error" data-rand-error="${index}" role="alert"></p></div>`:''}</section>`;}
function collectRandomization(step,index){const root=document.querySelector(`[data-opt-randomization="${index}"]`);if(!root)return randomCfgFor(step);const core=randomizer(),strategy=root.querySelector('[data-rand-strategy]')?.value||step.randomization?.strategy||core.guessStrategy(step);const cfg=step.randomization&&step.randomization.strategy===strategy?clone(step.randomization):core.defaults(step,strategy);cfg.version=1;cfg.enabled=!!root.querySelector('[data-rand-enabled]')?.checked;cfg.strategy=strategy;cfg.options=cfg.options||{};root.querySelectorAll('[data-rand-opt]').forEach(el=>{const key=el.dataset.randOpt;cfg.options[key]=el.type==='checkbox'?el.checked:el.type==='number'?(el.value===''?'':Number(el.value)):el.value;});if(strategy==='dateRange'&&cfg.options.startDate&&cfg.options.endDate){delete cfg.options.fromDays;delete cfg.options.toDays;delete cfg.options.direction;delete cfg.options.weekdaysOnly;}if(strategy==='boolean')cfg.options.mode='random';const allow=[...root.querySelectorAll('[data-rand-allowed]:checked')].map(el=>el.value);if(root.querySelector('[data-rand-allowed]'))cfg.options.allowedValues=allow;else if(strategy==='dependentPicklist')delete cfg.options.allowedValues;const unique=root.querySelector('[data-rand-unique]');if(unique)cfg.options.unique=unique.checked;return cfg;}
function rerenderRandomizationSections(){const roots=[...document.querySelectorAll('[data-opt-randomization]')];for(const root of roots){const key=String(root.dataset.optRandomization),step=getRandomStep(key);if(step)step.randomization=collectRandomization(step,key);}for(const root of roots){const key=String(root.dataset.optRandomization),step=getRandomStep(key);if(!step)continue;const tmp=document.createElement('div');tmp.innerHTML=renderRandomization(step,key);root.replaceWith(tmp.firstElementChild);}}
function updateRandomizer(index,rerender=true){const step=draft?.steps?.[Number(index)];if(!step)return;const cfg=collectRandomization(step,index);step.randomization=cfg;if(rerender){const row=document.querySelector(`.editor-row[data-row-index="${index}"]`);if(row){const temp=document.createElement('div');temp.innerHTML=renderRandomization(step,index);row.querySelector('.fp-opt-randomization')?.replaceWith(temp.firstElementChild);if(!row.querySelector('.fp-opt-randomization'))row.insertAdjacentHTML('beforeend',renderRandomization(step,index));}}}

function editorField(s,i){
  const t=normalizeType(s),v=s.value,opts=optionList(s);
  if(t==='checkbox')return`<label class="edit-check"><input class="check" type="checkbox" data-edit-bool="${i}" ${v===true||String(v).toLowerCase()==='true'?'checked':''}><span>Checked</span></label>`;
  if(t==='picklist'&&opts.length)return`<select class="editor-select" data-edit-value="${i}">${opts.map(o=>`<option value="${escapeHtml(o.value)}" ${(String(v)===String(o.value)||String(v)===String(o.displayValue))?'selected':''}>${escapeHtml(o.displayValue||o.value)}</option>`).join('')}</select>`;
  if(t==='multipicklist'&&opts.length){
    const vals=valuesArray(v).map(x=>x.toLowerCase());
    return`<div class="multi-options">${opts.map(o=>{const label=o.displayValue||o.value,on=vals.includes(String(o.value).toLowerCase())||vals.includes(String(label).toLowerCase());return`<label><input type="checkbox" data-multi-index="${i}" data-multi-value="${escapeHtml(o.value)}" ${on?'checked':''}><span>${escapeHtml(label)}</span></label>`}).join('')}</div>`;
  }
  if(t==='date'){const m=s?.meta||{};if(m.dateMode==='relative'&&Number.isFinite(Number(m.dateOffsetDays))){const off=Number(m.dateOffsetDays);const sign=off<0?'-':'+';return`<div class="relative-date-editor"><span class="relative-date-fixed">Today</span><select class="editor-select relative-date-sign" data-date-sign="${i}" aria-label="Relative date direction"><option value="+" ${sign==='+'?'selected':''}>+</option><option value="-" ${sign==='-'?'selected':''}>-</option></select><input class="edit-control relative-date-number" type="number" min="0" step="1" data-date-offset="${i}" value="${Math.abs(off)}" aria-label="Number of days"><span class="relative-date-fixed">days</span></div>`;}const exact=String(s.value||'').slice(0,10);return`<input class="edit-control" type="date" data-edit-value="${i}" value="${escapeHtml(exact)}">`; }
  if(t==='datetime')return`<input class="edit-control" type="datetime-local" data-edit-value="${i}" value="${escapeHtml(String(v||'').slice(0,16))}">`;
  if(t==='time')return`<input class="edit-control" type="time" data-edit-value="${i}" value="${escapeHtml(String(v||'').slice(0,5))}">`;
  if(t==='longtext')return`<textarea class="edit-control" data-edit-value="${i}" rows="2" placeholder="Recorded value">${escapeHtml(display(v))}</textarea>`;
  if(t==='address'){const a=v&&typeof v==='object'?v:{};return`<div class="fp-address-edit">${[['street','Street'],['city','City'],['province','State / Province'],['postalCode','Postal code'],['country','Country']].map(([k,l])=>`<label><span>${l}</span><input class="edit-control" data-address-part="${i}" data-part="${k}" value="${escapeHtml(a[k]??(k==='province'?a.state:'')??'')}"></label>`).join('')}</div>`;}
  const inputType=t==='number'?'number':t==='email'?'email':t==='url'?'url':'text';return`<input class="edit-control" type="${inputType}" data-edit-value="${i}" value="${escapeHtml(display(v))}" placeholder="Recorded value">`;
}

function render(){
  const rows=list(),r=selectedId?recordings[selectedId]:null;
  const isSettings=activeSection==='settings';
  document.documentElement.classList.toggle('settings-mode',isSettings);
  document.body.classList.toggle('settings-mode',isSettings);
  app.innerHTML=`
    <div class="page-head">
      <div class="page-brand-group">
        <div class="brandhead"><img class="mark" src="branding/forcepilot-icon.png" alt=""><img class="word" src="branding/forcepilot-wordmark.png" alt="ForcePilot"></div>
        <div class="page-heading-copy"><h1>Recordings &amp; Autofill</h1><p>Manage saved Salesforce field recordings and autofill behavior.</p></div>
      </div>
      <div class="toolbar">
        <button class="secondary button-with-icon" id="import">${icon('fileDownload')}<span>Import</span></button>
        <input id="importFile" type="file" accept="application/json,.json" hidden>
        <button class="secondary button-with-icon" id="export">${icon('fileUpload')}<span>Export</span></button>
        <details class="more-menu"><summary class="secondary more-trigger" aria-label="More actions">${icon('more')}</summary><div class="more-popover"><button class="more-danger button-with-icon" id="deleteAll">${icon('delete')}<span>Delete all recordings</span></button></div></details>
      </div>
    </div>
    <nav class="top-tabs" aria-label="Options sections">
      <button class="tab ${activeSection==='recordings'?'active':''}" data-section="recordings">Recordings</button>
      <button class="tab ${activeSection==='settings'?'active':''}" data-section="settings">Settings</button>
    </nav>
    ${pendingConfirmation?`<div class="confirm-overlay" id="confirmOverlay" role="presentation"><div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmMessage"><div class="confirm-dialog-body"><h2 id="confirmTitle">${escapeHtml(pendingConfirmation.title||'Confirm action')}</h2><p id="confirmMessage">${escapeHtml(pendingConfirmation.message)}</p></div><div class="confirm-dialog-actions"><button class="secondary" id="confirmCancel">Cancel</button><button class="primary confirm-danger" id="confirmProceed">${escapeHtml(pendingConfirmation.confirmLabel||'Confirm')}</button></div></div></div>`:''}
    ${pendingImport?renderImportPreview():''}
    ${activeSection==='recordings'?renderRecordings(rows,r):renderSettings()}`;
  bind();
}

function renderImportPreview(){
  const p=pendingImport, conflicts=p?.conflicts||0, count=p?.recordings?.length||0, savedCount=Object.keys(recordings).length;
  const newCount=Math.max(0,count-conflicts);
  const settingsCount=p.settings?Object.keys(p.settings).length:0;
  const note=conflicts
    ? 'Merge keeps your saved versions. Replace all uses only this file.'
    : 'These recordings will be added to your saved list.';
  return `<div class="confirm-overlay import-preview-overlay" id="importPreviewOverlay" role="presentation">
    <section class="confirm-dialog import-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="importPreviewTitle" aria-describedby="importPreviewDescription">
      <div class="confirm-dialog-body">
        <h2 id="importPreviewTitle">Import recordings</h2>
        <p id="importPreviewDescription">${escapeHtml(p.fileName)} · ${count} recording${count===1?'':'s'}${p.invalidCount?` · ${p.invalidCount} skipped`:''}</p>
        <dl class="import-preview-stats">
          <div><dt>Saved</dt><dd>${savedCount}</dd></div>
          <div><dt>New</dt><dd>${newCount}</dd></div>
          <div><dt>Conflicts</dt><dd>${conflicts}</dd></div>
          <div><dt>Settings</dt><dd>${settingsCount}</dd></div>
        </dl>
        <p class="import-preview-note">${note}</p>
      </div>
      <div class="confirm-dialog-actions import-preview-actions">
        <button class="secondary" id="cancelImport">Cancel</button>
        <button class="secondary" id="mergeImport">Merge</button>
        <button class="primary confirm-danger" id="replaceImport">Replace all</button>
      </div>
    </section>
  </div>`;
}

function renderRecordings(rows,r){
  return`<div class="manager">
    <section class="panel recording-panel">
      <div class="section-title-row"><div><h2>Saved recordings</h2><span>${rows.length} saved</span></div></div>
      ${Object.keys(recordings).length?`<input class="search" id="search" value="${escapeHtml(recordingSearch)}" placeholder="Search recordings…" aria-label="Search recordings">${rows.length?`<div class="recording-list">${rows.map(x=>`<button class="listitem ${x.id===selectedId?'active':''}" data-id="${escapeHtml(x.id)}"><span class="grow"><strong>${escapeHtml(x.name)}</strong><small>${x.steps.length} field${x.steps.length===1?'':'s'}</small></span>${icon('chevron')}</button>`).join('')}</div>`:`<div class="empty-state"><strong>No recordings match</strong><span>Try a different search term.</span></div>`}`:`<div class="empty-state"><strong>No recordings yet</strong><span>Record a Salesforce form and it will appear here.</span></div>`}
    </section>
    <section class="panel editor-panel">${r?renderEditor(r):'<div class="empty-editor"><strong>Select a recording</strong><span>Choose a recording to review or edit it.</span></div>'}</section>
  </div>`;
}

function renderSettings(){
  const exportQuality=Math.min(95,Math.max(70,Number(settings.exportImageQuality)||DEFAULTS.exportImageQuality||88));
  return`<div class="settings-shell">
    <div class="settings-head">
      <div class="settings-head-copy">
        <div class="settings-kicker">Preferences</div>
        <div class="settings-title-line"><h2>Settings</h2></div>
        <p>Control how ForcePilot records, tests, autofills, and appears on Salesforce pages.</p>
      </div>
      <button class="secondary compact button-with-icon" id="reset">${icon('refresh')}<span>Reset defaults</span></button>
    </div>

    <div class="settings-grid-premium">
      <div class="settings-column settings-column-primary">
        <section class="settings-section">
          <div class="settings-section-head">
            <div><h3>Autofill behavior</h3><p>Choose how ForcePilot fills and verifies Salesforce fields.</p></div>
          </div>
          <div class="settings-rows">
            ${setting('fillEmptyOnly','Fill empty fields only',"Existing Salesforce values won't be changed.")}
            ${setting('verifyAfterReplay','Verify filled values','Check Salesforce after each field is filled.')}
            ${setting('stopOnFailure','Stop on first failure','Stop the run when a field cannot be filled.')}
          </div>
        </section>

</div>

      <div class="settings-column settings-column-secondary">
        <section class="settings-section">
          <div class="settings-section-head">
            <div><h3>Testing</h3><p>Control how scenarios move into execution.</p></div>
          </div>
          <div class="settings-rows">
            ${setting('skipTestCaseReview','Skip scenario review','Start testing immediately after scenarios are parsed.')}
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-head">
            <div><h3>Salesforce integration</h3><p>Configure how ForcePilot appears and how evidence exports are sized.</p></div>
          </div>
          <div class="settings-rows">
            <div class="setting-row launcher-row">
              <div class="setting-copy"><strong>Launcher style</strong><small>Choose how ForcePilot appears on Salesforce pages.</small></div>
              <div class="launcher-choices" role="radiogroup" aria-label="Launcher style">
                ${launcherChoice('edge','Edge','Right-edge handle')}
                ${launcherChoice('bubble','Bubble','Small floating launcher')}
                ${launcherChoice('off','Off','Use toolbar only')}
              </div>
            </div>
            <div class="setting-row quality-row">
              <div class="setting-copy"><strong>Image quality</strong><small>Used for screenshots and Word/ZIP exports.</small></div>
              <div class="range-setting">
                <input id="exportImageQuality" class="quality-range" type="range" min="70" max="95" step="1" value="${exportQuality}" aria-label="Export image quality">
                <output id="exportImageQualityValue" for="exportImageQuality">${exportQuality}%</output>
              </div>
            </div>
            <div class="setting-row experience-cloud-domains">
              <div class="setting-copy"><strong>Custom domains</strong><small>Optional. Enter one hostname per line for branded Experience Cloud sites. Standard Salesforce domains work automatically.</small></div>
              <textarea id="experienceCloudDomains" rows="3" spellcheck="false" placeholder="portal.example.com">${escapeHtml((settings.experienceCloudDomains||[]).join('\n'))}</textarea>
            </div>
            ${setting('darkMode','Dark mode','Use the dark ForcePilot interface across Options, Popup, Side Panel, and Salesforce launcher states.')}
            <div class="setting-row intro-tour-row">
              <div class="setting-copy"><strong>First-run tour</strong><small>Replay the ForcePilot introduction on your next sidebar open and the Testing tour the next time you click Testing.</small></div>
              <button class="secondary compact" id="replayFirstRun" type="button">Show intro</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>`;
}

function launcherChoice(value,title,desc){
  const active=settings.launcherMode===value;
  return`<button type="button" class="launcher-choice ${active?'active':''}" data-launcher-mode="${value}" role="radio" aria-checked="${active}" title="${escapeHtml(desc)}"><span class="launcher-choice-indicator" aria-hidden="true"></span><span class="launcher-choice-copy"><strong>${title}</strong></span></button>`
}
function setting(k,t,d){
  return`<div class="setting-row"><div class="setting-copy"><strong>${t}</strong><small>${d}</small></div><label class="toggle" title="${escapeHtml(t)}"><input type="checkbox" data-setting="${k}" ${settings[k]?'checked':''}><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span></label></div>`
}

function renderEditor(r){
  const x=editing?draft:r;
  const visible=x.steps.map((s,i)=>({s,i})).filter(({s})=>fieldMatches(s));
  const populated=x.steps.filter(hasValue).length,blank=x.steps.length-populated;
  const updated=fmtUpdated(x.updatedAt);
  return`<div class="editor-shell">
    <div class="editor-head">
      <div class="editor-heading${editing?' is-editing':''}">
        <div class="breadcrumb">Recordings / Saved recording</div>
        ${editing?`<input class="editor-name-input" id="name" value="${escapeHtml(x.name)}" aria-label="Recording name" maxlength="200">`:`<h2>${escapeHtml(x.name)}</h2>`}
        <div class="editor-summary"><span>${x.steps.length} field${x.steps.length===1?'':'s'}</span>${x.context?.objectLabel?`<span>${escapeHtml(x.context.objectLabel)}</span>`:''}</div>
        
      </div>
      ${!editing?`<button class="primary button-with-icon" id="edit">${icon('edit')}<span>Edit recording</span></button>`:''}
    </div>
    <div class="recording-tools">
      <div class="field-count"><strong>${x.steps.length} fields</strong>${blank ? `<span>${blank} blank</span>` : ''}</div>
      <input class="search field-search" id="fieldSearch" value="${escapeHtml(fieldSearch)}" placeholder="Search fields…" aria-label="Search fields">
    </div>
    <div class="field-table ${editing?'is-editing':''}" role="table" aria-label="Recorded fields">
      <div class="field-table-head" role="row"><span>#</span><span>Field</span><span>Value</span><span>Type</span>${editing?'<span aria-hidden="true"></span>':''}</div>
      <div class="editor-list">${visible.length?visible.map(({s,i})=>renderFieldRow(s,i)).join(''):`<div class="no-fields">No fields match “${escapeHtml(fieldSearch)}”.</div>`}</div>
    </div>
    ${editing?`<div class="actions editor-actions"><button class="secondary button-with-icon" id="cancelEdit">${icon('close')}<span>Cancel</span></button><button class="primary button-with-icon" id="saveEdit">${icon('save')}<span>Save changes</span></button></div>`:`<div class="actions"><button class="secondary delete-one button-with-icon" id="deleteOne">${icon('delete')}<span>Delete recording</span></button></div>`}
  </div>`;
}

function renderFieldRow(s,i){
  const t=normalizeType(s);
  const locateAttrs=editing?'':' data-focus-step="'+i+'" tabindex="0" title="Locate field in Salesforce"';
  return`<div class="editor-row ${editing?'is-editing':'locatable'}" data-row-index="${i}" role="row"${locateAttrs}>
    <span class="step-number">${i+1}</span>
    <div class="field-main"><strong>${escapeHtml(s.target.label)}</strong><span class="api">${escapeHtml(apiDisplayName(s))}</span></div>
    <div class="field-value">${editing?editorField(s,i):`<span class="value-text ${s.randomization?.enabled?'is-randomized':''}">${escapeHtml(s.randomization?.enabled?'Randomized':((t==='date'?dateFieldDisplay(s):display(s.value))||'—'))}</span>`}</div>
    <div class="field-type"><span class="typepill">${typeLabel(s)}</span></div>
    ${editing?`<div class="row-tools"><button class="icon-delete" data-remove="${i}" title="Remove field" aria-label="Remove field">${icon('delete')}</button></div>${renderRandomization(s,i)}${renderNestedRandomizers(s,i)}`:''}
  </div>`;
}

function bind(){
  document.querySelectorAll('.listitem[data-id]').forEach(b=>b.addEventListener('click',()=>requestDiscardAnd(async()=>{selectedId=b.dataset.id;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';render();const r=recordings[selectedId];if(r){await hydrateRecordingTargets(r,{persist:true});render();}})));
  document.querySelectorAll('[data-section]').forEach(b=>b.addEventListener('click',()=>requestDiscardAnd(()=>{activeSection=b.dataset.section;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';const u=new URL(location.href);u.searchParams.set('section',activeSection);if(selectedId)u.searchParams.set('recording',selectedId);history.replaceState({},'',u);render()})));
  if(app.dataset.fpRandomizationBound!=='true'){app.dataset.fpRandomizationBound='true';
  app.addEventListener('change', async e=>{
    const en=e.target.closest('[data-rand-enabled]');const strat=e.target.closest('[data-rand-strategy]');const idx=en?.dataset.randEnabled??strat?.dataset.randStrategy;
    if(idx!==undefined){const key=String(idx),step=getRandomStep(key);if(!step)return;const root=document.querySelector(`[data-opt-randomization="${key}"]`);let oldCfg=collectRandomization(step,key);if(strat){const next=randomizer().defaults(step,strat.value);next.enabled=!!step.randomization?.enabled||oldCfg.enabled;step.randomization=next;expandedRandomKey=key;}else{oldCfg.enabled=en.checked;step.randomization=oldCfg;expandedRandomKey=en.checked?key:'';}if(root)rerenderRandomizationSections();return;}
    const randOpt=e.target.closest('[data-rand-opt],[data-rand-allowed],[data-rand-unique]');if(randOpt){const section=randOpt.closest('[data-opt-randomization]');if(!section)return;const key=String(section.dataset.optRandomization),step=getRandomStep(key);if(!step)return;
      if(randOpt.dataset.randOpt==='step')randOpt.dataset.fpStepTouched='true';
      if(randOpt.dataset.randOpt==='decimals' && (step.randomization?.strategy||section.querySelector('[data-rand-strategy]')?.value)==='percentRange'){
        const increment=section.querySelector('[data-rand-opt="step"]'),defaultStep=Number(randomizer().defaults(step,'percentRange').options.step);if(increment&&increment.dataset.fpStepTouched!=='true'&&Number.isFinite(defaultStep)&&Math.abs(Number(increment.value)-defaultStep)<1e-12&&Number(randOpt.value)>=0)increment.value=String(1/Math.pow(10,Math.min(10,Number(randOpt.value))));
      }
      step.randomization=collectRandomization(step,key);const verdict=randomizer().validate(step,step.randomization);const err=section.querySelector('[data-rand-error]');if(err)err.textContent=verdict.ok?'':verdict.error;}
  });
  app.addEventListener('click',e=>{const h=e.target.closest('[data-rand-heading]');if(!h)return;const key=String(h.dataset.randHeading),step=getRandomStep(key);if(!step?.randomization?.enabled)return;expandedRandomKey=expandedRandomKey===key?'':key;const root=h.closest('[data-opt-randomization]');if(root)rerenderRandomizationSections();});
  app.addEventListener('keydown',e=>{const h=e.target.closest('[data-rand-heading]');if(h&&(e.key==='Enter'||e.key===' ')){e.preventDefault();h.click();}});
  app.addEventListener('click',e=>{const b=e.target.closest('[data-rand-generate]');if(!b)return;const key=String(b.dataset.randGenerate),step=getRandomStep(key);if(!step)return;const cfg=collectRandomization(step,key),root=b.closest('[data-opt-randomization]'),out=root?.querySelector('[data-rand-preview]'),err=root?.querySelector('[data-rand-error]');
    if(out&&['numberRangeIncrement','currencyRange','percentRange'].includes(cfg.strategy)){
      const min=Number(cfg.options?.min),max=Number(cfg.options?.max),decimals=Math.max(0,Math.min(10,Number(cfg.options?.decimals)||0));let increment=Number(cfg.options?.step);if(cfg.strategy==='percentRange'){const scaleRaw=step?.target?.scale,targetScale=scaleRaw!==undefined&&scaleRaw!==null&&String(scaleRaw)!==''&&Number.isInteger(Number(scaleRaw))?Math.max(0,Math.min(10,Number(scaleRaw))):null,defaultStep=targetScale===null?1:1/Math.pow(10,targetScale),autoStep=targetScale===null?decimals>0:decimals!==targetScale;if(autoStep&&Math.abs(increment-defaultStep)<1e-12)increment=1/Math.pow(10,decimals);}
      const current=Number(String(out.textContent||'').replace(/[^0-9eE+.-]/g,''));let next=Number.isFinite(current)&&current>=min&&current<=max?current+increment:min;if(!Number.isFinite(next)||next>max+1e-9)next=min;if(Math.abs(next)<1e-9){next=min>0?min:increment;if(next>max)next=min;}out.textContent=Number(next.toFixed(decimals)).toString();if(err)err.textContent='';return;
    }
    const result=randomizer().generate(step,cfg,{usedValues:new Set()});if(out)out.textContent=result.ok?(Array.isArray(result.value)?result.value.join('; '):typeof result.value==='object'?JSON.stringify(result.value):String(result.value)):'—';if(err)err.textContent=result.ok?'':result.error;});
  }

  document.querySelectorAll('[data-launcher-mode]').forEach(b=>b.addEventListener('click',async()=>{const mode=['edge','bubble','off'].includes(b.dataset.launcherMode)?b.dataset.launcherMode:'edge';settings={...settings,launcherMode:mode,showOverlay:mode!=='off'};await saveSettings(settings);render()}));
  document.getElementById('search')?.addEventListener('input',e=>{recordingSearch=e.target.value;clearTimeout(window.fpSearchTimer);window.fpSearchTimer=setTimeout(()=>{const pos=recordingSearch.length;render();const el=document.getElementById('search');if(el){el.focus();el.setSelectionRange(pos,pos)}},100)});
  document.getElementById('fieldSearch')?.addEventListener('input',e=>{fieldSearch=e.target.value;render();const el=document.getElementById('fieldSearch');if(el){el.focus();el.setSelectionRange(fieldSearch.length,fieldSearch.length)}});
  document.getElementById('experienceCloudDomains')?.addEventListener('change',async e=>{
    const raw=String(e.target.value||'').split(/[\r\n,;]+/).map(v=>v.trim()).filter(Boolean);
    const parsed=[];const invalid=[];
    for(const item of raw){let host=item.toLowerCase().replace(/^https?:\/\//,'').split(/[\/?#]/)[0].replace(/^\*\./,'').replace(/:\d+$/,'').replace(/\.$/,'');if(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)){if(!parsed.includes(host))parsed.push(host);}else invalid.push(item);}
    if(invalid.length){show(`Invalid domain${invalid.length===1?'':'s'}: ${invalid.slice(0,3).join(', ')}`,true);e.target.value=(settings.experienceCloudDomains||[]).join('\n');return;}
    settings={...settings,experienceCloudDomains:parsed.slice(0,50)};await saveSettings(settings);e.target.value=settings.experienceCloudDomains.join('\n');show('Experience Cloud domains saved.');
  });
  document.querySelectorAll('[data-setting]').forEach(el=>el.addEventListener('change',async e=>{settings={...settings,[e.target.dataset.setting]:e.target.checked};if(e.target.dataset.setting==='darkMode')applyTheme(settings.darkMode);await saveSettings(settings);}));
  document.getElementById('replayFirstRun')?.addEventListener('click', async () => { try { await chrome.storage.local.set({ 'forcepilot.firstRunTour.seen.v1': false, 'forcepilot.testingFirstRunTour.seen.v1': false }); show('Welcome tour will appear when you next open ForcePilot. The Testing tour will appear when you open Testing.'); } catch { show('Could not reset the welcome tours', true); } });
  const qualityInput=document.getElementById('exportImageQuality');
  const qualityOutput=document.getElementById('exportImageQualityValue');
  qualityInput?.addEventListener('input',e=>{if(qualityOutput){qualityOutput.textContent=`${e.target.value}%`;qualityOutput.value=`${e.target.value}%`;}});
  qualityInput?.addEventListener('change',async e=>{
    const n=Math.min(95,Math.max(70,Math.round(Number(e.target.value)||88)));
    settings={...settings,exportImageQuality:n};
    e.target.value=String(n);
    if(qualityOutput) { qualityOutput.value=`${n}%`; qualityOutput.textContent=`${n}%`; }
    await saveSettings(settings);
    
  });
  document.getElementById('reset')?.addEventListener('click',()=>requestConfirmation('Reset settings','Reset all Autofill settings to their defaults?','Reset',async()=>{settings={...DEFAULTS};applyTheme(settings.darkMode);await saveSettings(settings);render();show('Settings reset')}));
  document.getElementById('edit')?.addEventListener('click',async()=>{draft=clone(recordings[selectedId]);snapshot=clone(draft);expandedRandomKey=null;editing=true;render();await hydrateDraftPicklists(draft);render()});
  document.getElementById('cancelEdit')?.addEventListener('click',()=>requestDiscardAnd(()=>{editing=false;draft=snapshot=null;render()}));
  document.getElementById('saveEdit')?.addEventListener('click',saveEdit);
  document.getElementById('deleteOne')?.addEventListener('click',deleteOne);
  document.getElementById('deleteAll')?.addEventListener('click',deleteAll);
  document.getElementById('confirmCancel')?.addEventListener('click',()=>{const target=pendingConfirmation?.returnFocus;pendingConfirmation=null;render();document.getElementById(target)?.focus()});
  document.getElementById('confirmOverlay')?.addEventListener('click',e=>{if(e.target.id==='confirmOverlay'){const target=pendingConfirmation?.returnFocus;pendingConfirmation=null;render();document.getElementById(target)?.focus()}});
  document.getElementById('confirmProceed')?.addEventListener('click',async()=>{const fn=pendingConfirmation?.action;pendingConfirmation=null;if(fn)await fn();render()});
  document.onkeydown=e=>{
    const dialog=document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
    if(dialog&&e.key==='Tab'){
      const focusable=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>el.offsetParent!==null);
      if(focusable.length){const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}
    }
    if(pendingConfirmation&&e.key==='Escape'){const target=pendingConfirmation.returnFocus;pendingConfirmation=null;render();document.getElementById(target)?.focus()}
    else if(pendingImport&&e.key==='Escape'){pendingImport=null;render();document.getElementById('import')?.focus()}
  };
  if(pendingConfirmation)requestAnimationFrame(()=>document.getElementById('confirmCancel')?.focus());
  document.querySelectorAll('[data-focus-step]').forEach(b=>{const handler=()=>focusSalesforceField(Number(b.dataset.focusStep));b.addEventListener('click',handler);b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();handler()}})});
  document.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',()=>{draft.steps.splice(Number(b.dataset.remove),1);draft.steps.forEach((s,i)=>s.sequence=i+1);render()}));
  document.getElementById('export')?.addEventListener('click',exportData);
  document.getElementById('import')?.addEventListener('click',()=>document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change',importData);
  document.getElementById('cancelImport')?.addEventListener('click',()=>{pendingImport=null;render();document.getElementById('import')?.focus()});
  document.getElementById('mergeImport')?.addEventListener('click',()=>applyImport('merge'));
  document.getElementById('replaceImport')?.addEventListener('click',()=>applyImport('replace'));
  document.getElementById('importPreviewOverlay')?.addEventListener('click',e=>{if(e.target.id==='importPreviewOverlay'){pendingImport=null;render();document.getElementById('import')?.focus()}});
  if(pendingImport)requestAnimationFrame(()=>document.getElementById('cancelImport')?.focus());
}

async function focusSalesforceField(index){
  const r=selectedId?recordings[selectedId]:null;
  const step=r?.steps?.[Number(index)];
  if(!step)return;
  const tabs=await chrome.tabs.query({active:true,currentWindow:true}).catch(()=>[]);
  const tab=tabs?.[0];
  if(!tab?.id)return;
  await chrome.runtime.sendMessage({type:'FORCEPILOT_MULTIFRAME_REQUEST',tabId:tab.id,message:{type:'FOCUS_FIELD',target:step.target,frame:step.frame}}).catch(()=>null);
}

function requestConfirmation(title,message,confirmLabel,action){pendingConfirmation={title,message,confirmLabel,action,returnFocus:document.activeElement?.id||''};render()}
function requestDiscardAnd(action){if(!editing||JSON.stringify(draft)===JSON.stringify(snapshot)){action();return;}requestConfirmation('Discard changes','You have unsaved changes to this recording. Discard them?','Discard',async()=>{editing=false;draft=snapshot=null;await action()})}

async function saveEdit(){
  if(!draft)return;
  // Validate every enabled randomizer before mutating or saving any recording data.
  for(const root of document.querySelectorAll('[data-opt-randomization]')){const key=String(root.dataset.optRandomization),step=getRandomStep(key);if(!step)continue;const cfg=collectRandomization(step,key);step.randomization=cfg;if(cfg.enabled&&cfg.strategy==='lookupCreate'){const err=root.querySelector('[data-rand-error]');if(err)err.textContent='The parent lookup cannot be randomized while using Create New. Randomize the child fields instead.';show(`Randomization for ${step.target?.label||'field'}: configure the new-record fields instead.`,true);root.scrollIntoView({block:'nearest',behavior:'smooth'});return;}if(cfg.enabled){const verdict=randomizer()?.validate?.(step,cfg)||{ok:true};if(!verdict.ok){const err=root.querySelector('[data-rand-error]');if(err)err.textContent=verdict.error;show(`Randomization for ${step.target?.label||'field'}: ${verdict.error}`,true);root.scrollIntoView({block:'nearest',behavior:'smooth'});return;}}}
  draft.name=document.getElementById('name')?.value.trim()||draft.name;
  draft.steps.forEach((s,i)=>{
    const b=document.querySelector(`[data-edit-bool="${i}"]`),v=document.querySelector(`[data-edit-value="${i}"]`);
    if(b)s.value=b.checked;
    else if(normalizeType(s)==='multipicklist'&&optionList(s).length)s.value=[...document.querySelectorAll(`[data-multi-index="${i}"]:checked`)].map(x=>x.dataset.multiValue).filter(Boolean);
    else if(normalizeType(s)==='address'){const parts=[...document.querySelectorAll(`[data-address-part="${i}"]`)];if(parts.length){const next={...(s.value&&typeof s.value==='object'?s.value:{})};parts.forEach(el=>next[el.dataset.part]=el.value.trim());s.value=next;}}
    else if(v){
      if(normalizeType(s)==='date'){
        const recordingDate=s.meta?.dateRecordedOn||draft.recordingDate||localDateISO();
        if(s.meta?.dateMode==='relative'&&Number.isFinite(Number(s.meta?.dateOffsetDays))){
          const sign=document.querySelector(`[data-date-sign="${i}"]`)?.value==='-'?-1:1;
          const days=Math.max(0,Number(document.querySelector(`[data-date-offset="${i}"]`)?.value||0));
          const relativeOffset=sign*days;
          s.value=shiftDateFrom(recordingDate,relativeOffset);
          s.meta={...(s.meta||{}),dateRecordedOn:recordingDate,dateOffsetDays:relativeOffset,dateExpression:dateOffsetLabel(relativeOffset),dateMode:'relative'};
        }else{
          const input=String(v.value||'').trim();
          const normalized=input.replace(/^([\d]{1,2})[\/.\-]([\d]{1,2})[\/.\-]([\d]{4})$/,(mm,month,day,year)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
          s.value=normalized;
          if(s.meta){delete s.meta.dateExpression;delete s.meta.dateOffsetDays;delete s.meta.dateMode;}
        }
      }else s.value=cleanEditedValue(s,v.value);
    }
    const enabled=document.querySelector(`[data-enabled="${i}"]`);
    if(enabled)s.enabled=enabled.checked;
    s.sequence=i+1;
  });
  draft.updatedAt=new Date().toISOString();
  recordings[draft.id]=clone(draft);
  await saveRecordings(recordings);
  editing=false;draft=snapshot=null;render();show('Recording saved');
}

async function deleteOne(){const r=recordings[selectedId];if(!r)return;requestConfirmation('Delete recording',`Delete “${r.name}” with ${r.steps.length} field${r.steps.length===1?'':'s'}? This cannot be undone.`,'Delete recording',async()=>{delete recordings[selectedId];selectedId=Object.keys(recordings)[0]||null;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';await saveRecordings(recordings);show('Recording deleted')})}
async function deleteAll(){const count=Object.keys(recordings).length;if(!count)return;requestConfirmation('Delete all recordings',`Delete all ${count} saved recordings? This cannot be undone.`,'Delete all recordings',async()=>{recordings={};selectedId=null;editing=false;draft=snapshot=null;recordingSearch='';fieldSearch='';await saveRecordings({});show('All recordings deleted')})}
function exportData(){const blob=new Blob([JSON.stringify({schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),recordings,settings},null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='forcepilot-recordings.json';a.click();setTimeout(()=>{URL.revokeObjectURL(u);show('Recordings exported')},1000)}
async function importData(e){
  try{
    const file=e.target.files?.[0];if(!file)return;if(file.size>50*1024*1024)throw Error('Recording file is too large.');
    const d=JSON.parse(await file.text());
    if(!d||typeof d!=='object'||!d.recordings||typeof d.recordings!=='object'||Array.isArray(d.recordings))throw Error('Invalid recording file.');
    const incoming=Object.values(normalizeStoredRecordings(d.recordings).recordings);if(incoming.length>1000)throw Error('Too many recordings in this file.');
    const allowedActions=new Set(['set-value','set-boolean','select-option','set-multi-option','select-lookup','set-address']);const accepted=[];let invalidRandomizationCount=0;
    const sanitizeRandomization=(step)=>{
      if(!step||typeof step!=='object')return step;
      const clean=clone(step),cfg=clean.randomization,core=randomizer();
      if(cfg){
        const known=!!(cfg&&typeof cfg==='object'&&!Array.isArray(cfg)&&core?.strategies?.(clean)?.some(x=>x.value===String(cfg.strategy||'')));
        const shape=known&&(!('version'in cfg)||Number(cfg.version)===1)&&typeof cfg.enabled==='boolean'&&cfg.options&&typeof cfg.options==='object'&&!Array.isArray(cfg.options)&&JSON.stringify(cfg).length<=20000;
        const verdict=shape&&cfg.enabled?core.validate(clean,cfg):{ok:shape};
        // Unknown or malformed imported settings must never break a previously valid
        // recording. Remove only the unsupported randomization metadata; retain value.
        if(!shape||!verdict?.ok||(cfg.enabled&&cfg.strategy==='lookupCreate')){delete clean.randomization;invalidRandomizationCount++;}
      }
      const children=clean.meta?.createNewRecord?.fields;
      if(Array.isArray(children))clean.meta={...clean.meta,createNewRecord:{...clean.meta.createNewRecord,fields:children.map(sanitizeRandomization)}};
      return clean;
    };
    for(const r of incoming){
      if(!r||typeof r!=='object'||typeof r.id!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(r.id)||!Array.isArray(r.steps)||r.steps.length>500)continue;
      const steps=r.steps.filter(s=>s&&typeof s==='object'&&allowedActions.has(s.action)&&s.target&&typeof s.target==='object'&&typeof s.target.label==='string'&&s.target.label.length<=500&&JSON.stringify(s.value??'').length<=10000).map(sanitizeRandomization);
      if(steps.length!==r.steps.length)continue;
      const clean={...r,steps,name:String(r.name||'Recording').slice(0,200),context:r.context&&typeof r.context==='object'?{objectApiName:String(r.context.objectApiName||'').slice(0,200),objectLabel:String(r.context.objectLabel||'').slice(0,200),mode:String(r.context.mode||'').slice(0,50)}:{}};accepted.push(clean);
    }
    if(!accepted.length)throw Error('No valid recordings were found.');
    const cleanSettings=d.settings&&typeof d.settings==='object'?Object.fromEntries(Object.entries(d.settings).filter(([k,v])=>k in DEFAULTS&&(['exportImageQuality'].includes(k)?Number.isFinite(Number(v)):k==='launcherMode'?['edge','bubble','off'].includes(String(v)):typeof v==='boolean')).map(([k,v])=>[k,k==='exportImageQuality'?Math.min(95,Math.max(70,Math.round(Number(v)))):k==='launcherMode'?(String(v)==='current'?'bubble':(['edge','bubble','off'].includes(String(v))?String(v):'edge')):v])):null;
    const conflicts=accepted.filter(r=>!!recordings[r.id]).length;
    pendingImport={recordings:accepted,settings:cleanSettings,fileName:file.name||'Import file',invalidCount:incoming.length-accepted.length,invalidRandomizationCount,conflicts};
    render();
  }catch(err){show(err.message||'Import failed.',true)}finally{e.target.value=''}
}
async function applyImport(mode){
  const staged=pendingImport;if(!staged)return;
  if(mode==='replace')recordings=Object.fromEntries(staged.recordings.map(r=>[r.id,r]));
  else for(const r of staged.recordings)if(!recordings[r.id])recordings[r.id]=r;
  if(staged.settings)settings={...settings,...staged.settings};
  recordings=normalizeStoredRecordings(recordings).recordings;
  selectedId=selectedId&&recordings[selectedId]?selectedId:Object.keys(recordings)[0]||null;
  editing=false;draft=snapshot=null;pendingImport=null;
  await saveRecordings(recordings);if(staged.settings)await saveSettings(settings);
  applyTheme(settings.darkMode);render();
  const message=mode==='replace'?`Replaced saved recordings with ${staged.recordings.length} imported.`:`Imported ${staged.recordings.length-staged.conflicts} new recording${staged.recordings.length-staged.conflicts===1?'':'s'}; kept ${staged.conflicts} existing ID conflict${staged.conflicts===1?'':'s'}.`;
  show(staged.invalidRandomizationCount?`${message} Removed ${staged.invalidRandomizationCount} invalid randomization setting${staged.invalidRandomizationCount===1?'':'s'}; original recorded values were preserved.`:message,!!staged.invalidRandomizationCount);
}
function show(m,error=false){showToast(m,{type:error?'error':'success',duration:error?3400:2200})}
load().catch(err=>show(err.message||String(err),true));
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!changes[RECORDINGS_KEY])return;
  getRecordings().then(next=>{
    recordings=next;
    if(selectedId&&!recordings[selectedId]){
      selectedId=Object.keys(recordings)[0]||null;
      editing=false;draft=snapshot=null;
    }
    render();
  }).catch(()=>{});
});
watchTheme((dark)=>{ settings={...settings,darkMode:dark}; if(activeSection==='settings') render(); });
