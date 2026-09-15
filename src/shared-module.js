/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

export const VERSION='1.3';
export const STORAGE_KEY='forcepilot.recordings.v1';
export const SETTINGS_KEY='forcepilot.settings.v1';
export const normalizeText=v=>String(v??'').replace(/\s+/g,' ').trim();
export const normalizeLabel=v=>normalizeText(v).toLowerCase().replace(/[\u200b\u00a0]/g,' ');
export const normalizeNumber=v=>String(v??'').trim().replace(/\(([^)]+)\)/,'-$1').replace(/[^0-9+\-.]/g,'');
export const normalizeBoolean=v=>typeof v==='boolean'?v:['true','1','yes','y','on','checked'].includes(String(v).trim().toLowerCase());
export const normalizeDate=v=>{const s=String(v??'').trim();const m=s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:s.slice(0,10)};
export const makeRecordingName=c=>c?.objectApiName||'Salesforce recording';
function typeFor(f){const r=String(f?.sfDataType||f?.type||f?.kind||f?.strategy||'').toLowerCase();if(r==='boolean'||r==='checkbox')return'boolean';if(r.includes('multi')||r==='multipicklist'||f?.multiSelect)return'multi-picklist';if(r.includes('picklist')||r==='combobox')return'picklist';if(r==='reference'||r==='lookup'||f?.reference)return'lookup';if(r==='date')return'date';if(r==='datetime')return'datetime';if(r==='time')return'time';if(['currency','percent','double','int','integer','long','decimal','number'].includes(r)||r.includes('number'))return'number';return'text'}
function migrateLegacyProfiles(d){const source=d.ss_workflows_v79?.objects?d.ss_workflows_v79: null;const profiles={};if(source){for(const obj of Object.values(source.objects||{})){for(const p of Object.values(obj.stages||{})){if(p?.objectApiName)profiles[`${p.objectApiName}::${p.mode||'Salesforce'}::${p.stage||'Not detected'}`]=p;}}}else{for(const k of ['ss_profiles_v78','ss_profiles_v77','ss_profiles_v7','ss_profiles_v6','ss_profiles_v5','ss_profiles_v4','ss_profiles_v3'])Object.assign(profiles,d[k]||{})}const out={};for(const p of Object.values(profiles)){if(!p?.objectApiName)continue;const fields=Object.values(p.fields||{}).sort((a,b)=>Number(a.sequence||99999)-Number(b.sequence||99999));const steps=fields.filter(f=>f?.label).map((f,i)=>{const kind=typeFor(f);let action='set-value';if(kind==='boolean')action='set-boolean';else if(kind==='picklist')action='select-option';else if(kind==='multi-picklist')action='set-multi-option';else if(kind==='lookup')action='select-lookup';else if(kind==='date'||kind==='datetime'||kind==='time'||kind==='number')action='set-value';const value=f.lastValue??f.lastDisplayValue??'';return{id:crypto.randomUUID?.()||`m-${Date.now()}-${i}`,sequence:i+1,action,target:{key:f.key||f.apiName||f.name||`label:${normalizeLabel(f.label)}`,label:f.label,apiName:f.apiName,name:f.name,kind,sfDataType:f.sfDataType||f.type,multiSelect:f.multiSelect,reference:f.reference},value:kind==='multi-picklist'?(Array.isArray(value)?value:String(value).split(/\s*;\s*|\s*,\s*/).filter(Boolean)):value,before:null,meta:{source:'legacy-import'}}});if(!steps.length)continue;const rec={id:crypto.randomUUID?.()||`legacy-${Date.now()}-${Math.random()}`,name:makeRecordingName({objectLabel:p.objectLabel,objectApiName:p.objectApiName,stage:p.stage}),context:{objectApiName:p.objectApiName,objectLabel:p.objectLabel||p.objectApiName,stage:p.stage||'',mode:p.mode||'edit'},version:3,steps,createdAt:new Date(Number(p.createdAt||Date.now())).toISOString?.()||new Date().toISOString(),updatedAt:new Date(Number(p.updatedAt||Date.now())).toISOString?.()||new Date().toISOString()};out[rec.id]=rec}return out}
function normalizeRecordedStep(step){
  if(!step||typeof step!=='object')return step;
  const target=step.target&&typeof step.target==='object'?step.target:{};
  const type=String(target.sfDataType||target.salesforceType||target.fieldType||target.type||'').toLowerCase();
  const numericTypes=new Set(['currency','percent','double','int','integer','long','decimal','number']);
  if(numericTypes.has(type)){
    const out={...step};
    if(out.value!==undefined)out.value=normalizeNumber(out.value);
    if(out.before!==undefined)out.before=normalizeNumber(out.before);
    return out;
  }
  return step;
}
function normalizeStoredRecordings(recordings){
  const out={};
  let changed=false;
  for(const [id,recording] of Object.entries(recordings||{})){
    if(!recording||typeof recording!=='object'){out[id]=recording;continue;}
    const steps=Array.isArray(recording.steps)?recording.steps.map((step,i)=>{
      const next=normalizeRecordedStep(step);
      const fixed=next&&typeof next==='object' ? {...next,sequence:next.sequence??i+1} : next;
      if(JSON.stringify(fixed)!==JSON.stringify(step))changed=true;
      return fixed;
    }):recording.steps;
    out[id]={...recording,steps};
  }
  return {recordings:out,changed};
}
export const getRecordings=async()=>{
  const d=await chrome.storage.local.get([STORAGE_KEY,'ss_workflows_v79','ss_profiles_v78','ss_profiles_v77','ss_profiles_v7','ss_profiles_v6','ss_profiles_v5','ss_profiles_v4','ss_profiles_v3']);
  let recordings={};
  if(d[STORAGE_KEY]&&Object.keys(d[STORAGE_KEY]).length)recordings=d[STORAGE_KEY];
  else{
    recordings=migrateLegacyProfiles(d);
    if(Object.keys(recordings).length)await chrome.storage.local.set({[STORAGE_KEY]:recordings});
  }
  const normalized=normalizeStoredRecordings(recordings);
  if(normalized.changed)await chrome.storage.local.set({[STORAGE_KEY]:normalized.recordings});
  return normalized.recordings;
};
const MAX_RECORDINGS=1000; const MAX_STEPS=500; const MAX_VALUE_CHARS=10000; const MAX_STORAGE_BYTES=5*1024*1024;
function validRecording(r){return !!r&&typeof r==='object'&&typeof r.id==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(r.id)&&Array.isArray(r.steps)&&r.steps.length<=MAX_STEPS&&r.steps.every(s=>s&&typeof s==='object'&&typeof s.action==='string'&&typeof s.target==='object'&&s.target&&String(s.target.label||'').length<=500&&JSON.stringify(s.value??'').length<=MAX_VALUE_CHARS)}
export const saveRecordings=async r=>{if(!r||typeof r!=='object')throw new Error('Invalid recordings');const normalized=normalizeStoredRecordings(r).recordings;const values=Object.values(normalized);if(values.length>MAX_RECORDINGS||!values.every(validRecording))throw new Error('Recording data is too large or invalid.');const raw=JSON.stringify(normalized);if(new TextEncoder().encode(raw).byteLength>MAX_STORAGE_BYTES)throw new Error('Saved recordings are too large. Remove some recordings and try again.');await chrome.storage.local.set({[STORAGE_KEY]:normalized});};
export const getSettings=async()=>{const d=await chrome.storage.local.get([SETTINGS_KEY,'ss_settings_v78','ss_settings_v77']);const raw={...(d.ss_settings_v77||{}),...(d.ss_settings_v78||{}),...(d[SETTINGS_KEY]||{})};return{stopOnFailure:false,verifyAfterReplay:true,fillEmptyOnly:true,showOverlay:true,dateRelativeToToday:true,...Object.fromEntries(['stopOnFailure','verifyAfterReplay','fillEmptyOnly','showOverlay','dateRelativeToToday'].filter(k=>k in raw).map(k=>[k,Boolean(raw[k])]))}};
export const saveSettings=async s=>chrome.storage.local.set({[SETTINGS_KEY]:s});
