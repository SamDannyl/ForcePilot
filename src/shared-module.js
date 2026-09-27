/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

export const VERSION='1.5';
export const SCHEMA_VERSION=5;
export const STORAGE_KEY='forcepilot.recordings.v1';
export const SETTINGS_KEY='forcepilot.settings.v1';
export const normalizeText=v=>String(v??'').replace(/\s+/g,' ').trim();
export const normalizeLabel=v=>normalizeText(v).toLowerCase().replace(/[\u200b\u00a0]/g,' ');
export const normalizeNumber=v=>{if(v===null||v===undefined)return '';const raw=String(v).trim();if(!raw)return '';const negative=/^\s*\(.*\)\s*$/.test(raw)||/^\s*-/.test(raw)||/^\s*−/.test(raw);const cleaned=raw.replace(/,/g,'').replace(/−/g,'-');const m=cleaned.match(/(?:\d+(?:\.\d+)?|\.\d+)/);if(!m)return '';const n=Number(m[0]);if(!Number.isFinite(n))return '';const out=Number.isInteger(n)?String(Math.trunc(n)):String(n);return negative&&n!==0?`-${out}`:out};
export const normalizeBoolean=v=>typeof v==='boolean'?v:['true','1','yes','y','on','checked'].includes(String(v).trim().toLowerCase());
export const normalizeDate=v=>{const s=String(v??'').trim();const m=s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:s.slice(0,10)};
export const makeRecordingName=c=>c?.objectApiName||'Salesforce recording';

export const parseTargetSelectionName=v=>{const raw=normalizeText(v);if(!raw)return null;const m=raw.match(/^sfdc:RecordField\.([^.]*)\.(.+)$/i);if(!m)return{raw};const objectApiName=normalizeText(m[1]),fieldPath=normalizeText(m[2]);let apiName=fieldPath;if(fieldPath.includes('__r__')){const last=fieldPath.split('__r__').pop();apiName=last||fieldPath}return{raw,objectApiName,fieldPath,apiName}};
export const chooseStableFieldKey=({objectApiName,apiName,name,label,targetSelectionName,fieldPath}={})=>{const obj=normalizeText(objectApiName);if(targetSelectionName){const p=parseTargetSelectionName(targetSelectionName);if(p?.raw)return`field:${obj||p.objectApiName||''}:${p.fieldPath||p.apiName||normalizeLabel(label)}`;}const a=normalizeText(apiName);if(a&&!/(^|[-_])(?:input|combobox|button|field|textbox)[-_]?[a-z0-9]{8,}$/i.test(a)&&!/^[0-9a-z]{20,}$/i.test(a))return obj?`field:${obj}:${a}`:`api:${a}`;const n=normalizeText(name);if(n&&!/^[0-9a-z]{20,}$/i.test(n))return obj?`field:${obj}:${n}`:`name:${n}`;return obj?`field:${obj}:label:${normalizeLabel(label)}`:`label:${normalizeLabel(label)}`};
function normalizeTargetForSchema(target,context){
  if(!target||typeof target!=='object')return target;
  const out={...target};
  const parsed=parseTargetSelectionName(out.targetSelectionName);
  if(!out.objectApiName)out.objectApiName=parsed?.objectApiName||context?.objectApiName||undefined;
  if(!out.fieldPath)out.fieldPath=parsed?.fieldPath||undefined;
  if(!out.apiName&&!out.fieldPath?.includes('__r__'))out.apiName=parsed?.apiName||undefined;
  if(out.label)out.label=normalizeText(out.label).replace(/^\s*\*\s*/, '');
  if(!out.key)out.key=chooseStableFieldKey(out);
  else if(String(out.key).startsWith('api:')&&out.objectApiName&&out.apiName)out.key=chooseStableFieldKey(out);
  if(out.kind==='multipicklist')out.kind='multi-picklist';
  if(out.kind==='reference')out.kind='lookup';
  // Keep the persisted field type consistent with the semantic kind. This repairs old
  // recordings produced by the bug where unrelated controls were all saved as picklists.
  const k=String(out.kind||'').toLowerCase();
  if(k==='lookup'){out.fieldType='reference';out.sfDataType='reference';out.type='reference';}
  else if(k==='multi-picklist'){out.fieldType='multipicklist';out.sfDataType='multipicklist';out.type='multipicklist';}
  else if(k==='picklist'){out.fieldType='picklist';out.sfDataType='picklist';out.type='picklist';}
  else if(k==='boolean'){out.fieldType='boolean';out.sfDataType='boolean';out.type='boolean';}
  else if(k==='number'){const exact=String(out.sfDataType||out.type||'').toLowerCase();const n=['currency','percent'].includes(exact)?exact:'number';out.fieldType=n;out.sfDataType=n;out.type=n;}
  else if(['date','datetime','time','email','phone','url','longtext'].includes(k)){const t=k==='longtext'?'textarea':k;out.fieldType=t;out.sfDataType=t;out.type=t;}
  else if(!out.fieldType||['picklist','multipicklist','reference','boolean'].includes(String(out.fieldType).toLowerCase())){out.fieldType='text';out.type='text';}
  return out;
}
export const normalizeRecordingSchema=(recording)=>{
  if(!recording||typeof recording!=='object')return recording;
  const context=recording.context&&typeof recording.context==='object'?{...recording.context}:{ };
  const steps=Array.isArray(recording.steps)?recording.steps.map((step,i)=>{
    if(!step||typeof step!=='object')return step;
    const normalizedTarget=normalizeTargetForSchema(step.target,context);
    const next={...step,target:normalizedTarget,sequence:step.sequence??i+1};
    if(next.target?.label)next.target.label=normalizeText(next.target.label).replace(/^\s*\*\s*/, '');
    if(next.target?.kind==='multi-picklist'&&!Array.isArray(next.value))next.value=String(next.value??'').split(/\s*;\s*|\s*,\s*/).map(x=>x.trim()).filter(Boolean);
    return next;
  }):recording.steps;
  return {...recording,schemaVersion:SCHEMA_VERSION,context,steps};
};
function typeFor(f){const r=String(f?.sfDataType||f?.type||f?.kind||f?.strategy||'').toLowerCase();if(r==='boolean'||r==='checkbox')return'boolean';if(r.includes('multi')||r==='multipicklist'||f?.multiSelect)return'multi-picklist';if(r.includes('picklist')||r==='combobox')return'picklist';if(r==='reference'||r==='lookup'||f?.reference)return'lookup';if(r==='date')return'date';if(r==='datetime')return'datetime';if(r==='time')return'time';if(['currency','percent','double','int','integer','long','decimal','number'].includes(r)||r.includes('number'))return'number';return'text'}
function migrateLegacyProfiles(d){const source=d.ss_workflows_v79?.objects?d.ss_workflows_v79: null;const profiles={};if(source){for(const obj of Object.values(source.objects||{})){for(const p of Object.values(obj.stages||{})){if(p?.objectApiName)profiles[`${p.objectApiName}::${p.mode||'Salesforce'}::${p.stage||'Not detected'}`]=p;}}}else{for(const k of ['ss_profiles_v78','ss_profiles_v77','ss_profiles_v7','ss_profiles_v6','ss_profiles_v5','ss_profiles_v4','ss_profiles_v3'])Object.assign(profiles,d[k]||{})}const out={};for(const p of Object.values(profiles)){if(!p?.objectApiName)continue;const fields=Object.values(p.fields||{}).sort((a,b)=>Number(a.sequence||99999)-Number(b.sequence||99999));const steps=fields.filter(f=>f?.label).map((f,i)=>{const kind=typeFor(f);let action='set-value';if(kind==='boolean')action='set-boolean';else if(kind==='picklist')action='select-option';else if(kind==='multi-picklist')action='set-multi-option';else if(kind==='lookup')action='select-lookup';else if(kind==='date'||kind==='datetime'||kind==='time'||kind==='number')action='set-value';const value=f.lastValue??f.lastDisplayValue??'';return{id:crypto.randomUUID?.()||`m-${Date.now()}-${i}`,sequence:i+1,action,target:{key:f.key||f.apiName||f.name||`label:${normalizeLabel(f.label)}`,label:f.label,apiName:f.apiName,name:f.name,kind,sfDataType:f.sfDataType||f.type,multiSelect:f.multiSelect,reference:f.reference},value:kind==='multi-picklist'?(Array.isArray(value)?value:String(value).split(/\s*;\s*|\s*,\s*/).filter(Boolean)):value,before:null,meta:{source:'legacy-import'}}});if(!steps.length)continue;const rec={id:crypto.randomUUID?.()||`legacy-${Date.now()}-${Math.random()}`,name:makeRecordingName({objectLabel:p.objectLabel,objectApiName:p.objectApiName,stage:p.stage}),context:{objectApiName:p.objectApiName,objectLabel:p.objectLabel||p.objectApiName,stage:p.stage||'',mode:p.mode||'edit'},version:3,steps,createdAt:new Date(Number(p.createdAt||Date.now())).toISOString?.()||new Date().toISOString(),updatedAt:new Date(Number(p.updatedAt||Date.now())).toISOString?.()||new Date().toISOString()};out[rec.id]=rec}return out}
function normalizeRecordedStep(step){
  if(!step||typeof step!=='object')return step;
  const target=step.target&&typeof step.target==='object'?step.target:{};
  const type=String(target.sfDataType||target.salesforceType||target.fieldType||target.type||target.kind||'').toLowerCase();
  const numericTypes=new Set(['currency','percent','double','int','integer','long','decimal','number']);
  const out={...step};
  if(numericTypes.has(type)){
    if(out.value!==undefined)out.value=normalizeNumber(out.value);
    if(out.before!==undefined)out.before=normalizeNumber(out.before);
  }
  if((type==='reference'||type==='lookup'||target.kind==='lookup') && typeof out.value==='string' && /^\[object Object\]$/.test(out.value.trim())){
    const meta=out.meta&&typeof out.meta==='object'?out.meta:{};
    out.value={displayValue:String(meta.lookupDisplayValue||''),recordId:String(meta.lookupRecordId||target.referenceId||'')};
  }
  if((type==='multipicklist'||type==='multi-picklist') && !Array.isArray(out.value))out.value=String(out.value??'').split(/\s*;\s*|\s*,\s*/).map(x=>normalizeText(x)).filter(Boolean);
  return out;
}
function normalizeStoredRecordingValue(recording){
  const normalized=normalizeRecordingSchema(recording);
  if(!normalized||typeof normalized!=='object'||!Array.isArray(normalized.steps))return normalized;
  return {...normalized,steps:normalized.steps.map(normalizeRecordedStep)};
}
export const normalizeStoredRecordings=recordings=>{
  const out={};let changed=false;
  for(const [id,recording] of Object.entries(recordings||{})){
    const next=normalizeStoredRecordingValue(recording);
    if(JSON.stringify(next)!==JSON.stringify(recording))changed=true;
    out[id]=next;
  }
  return{recordings:out,changed};
};
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
const MAX_RECORDINGS=1000; const MAX_STEPS=500; const MAX_VALUE_CHARS=10000;
function validRecording(r){return !!r&&typeof r==='object'&&typeof r.id==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(r.id)&&Array.isArray(r.steps)&&r.steps.length<=MAX_STEPS&&r.steps.every(s=>s&&typeof s==='object'&&typeof s.action==='string'&&typeof s.target==='object'&&s.target&&String(s.target.label||'').length<=500&&JSON.stringify(s.value??'').length<=MAX_VALUE_CHARS)}
export const saveRecordings=async r=>{if(!r||typeof r!=='object')throw new Error('Invalid recordings');const normalized=normalizeStoredRecordings(r).recordings;const values=Object.values(normalized);if(values.length>MAX_RECORDINGS||!values.every(validRecording))throw new Error('Recording data is too large or invalid.');const raw=JSON.stringify(normalized);await chrome.storage.local.set({[STORAGE_KEY]:normalized});};
export const getSettings=async()=>{const d=await chrome.storage.local.get([SETTINGS_KEY,'ss_settings_v78','ss_settings_v77']);const raw={...(d.ss_settings_v77||{}),...(d.ss_settings_v78||{}),...(d[SETTINGS_KEY]||{})};return{stopOnFailure:false,verifyAfterReplay:true,fillEmptyOnly:true,showOverlay:true,dateRelativeToToday:true,...Object.fromEntries(['stopOnFailure','verifyAfterReplay','fillEmptyOnly','showOverlay','dateRelativeToToday'].filter(k=>k in raw).map(k=>[k,Boolean(raw[k])]))}};
export const saveSettings=async s=>chrome.storage.local.set({[SETTINGS_KEY]:s});
