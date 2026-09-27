/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

(function(){
  'use strict';
  const FP={};
  FP.VERSION='1.5';
  FP.SCHEMA_VERSION=5;
  FP.STORAGE_KEY='forcepilot.recordings.v1';
  FP.SETTINGS_KEY='forcepilot.settings.v1';
  const metadataState={version:null,versionAt:0,objectCache:new Map(),recordCache:new Map(),objectFieldMetadata:new Map(),objectApiName:null,recordId:null,fieldMetadata:new Map(),metadataLabelMap:new Map()};
  let rootsCache=null, rootsCacheAt=0, candidatesCache=null, candidatesCacheAt=0, fieldRevision=0;
  const descriptorCache=new WeakMap();

  FP.normalizeText=v=>String(v??'').replace(/\s+/g,' ').trim();
  FP.normalizeLabel=v=>FP.normalizeText(v).toLowerCase().replace(/[\u200b\u00a0]/g,' ');
  FP.normalizeNumber=v=>{if(v===null||v===undefined)return '';const raw=String(v).trim();if(!raw)return '';const negative=/^\s*\(.*\)\s*$/.test(raw)||/^\s*-/.test(raw)||/^\s*−/.test(raw);const cleaned=raw.replace(/,/g,'').replace(/−/g,'-');const m=cleaned.match(/(?:\d+(?:\.\d+)?|\.\d+)/);if(!m)return '';const n=Number(m[0]);if(!Number.isFinite(n))return '';const out=Number.isInteger(n)?String(Math.trunc(n)):String(n);return negative&&n!==0?`-${out}`:out};
  FP.normalizeBoolean=v=>typeof v==='boolean'?v:['true','1','yes','y','on','checked'].includes(String(v??'').trim().toLowerCase());
  FP.normalizeDate=v=>{const s=String(v??'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;const m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:s.slice(0,10)};
  FP.normalizeDateTime=v=>{const s=String(v??'').trim();if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(s))return s.slice(0,16);const d=new Date(s);return Number.isNaN(d.getTime())?s:new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
  FP.normalizeTime=v=>{const s=String(v??'').trim(),m=s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);if(!m)return s;let h=+m[1];if(m[4]?.toUpperCase()==='PM'&&h<12)h+=12;if(m[4]?.toUpperCase()==='AM'&&h===12)h=0;return `${String(h).padStart(2,'0')}:${m[2]}:${m[3]||'00'}`};
  FP.parseMultiValues=v=>[...new Set(String(v??'').split(/\s*;\s*|\s*,\s*/).map(FP.normalizeText).filter(Boolean))];

  FP.parseTargetSelectionName=v=>{const raw=FP.normalizeText(v);if(!raw)return null;const m=raw.match(/^sfdc:RecordField\.([^.]*)\.(.+)$/i);if(!m)return{raw};const objectApiName=FP.normalizeText(m[1]),fieldPath=FP.normalizeText(m[2]);const apiName=fieldPath.includes('__r__')?(fieldPath.split('__r__').pop()||fieldPath):fieldPath;return{raw,objectApiName,fieldPath,apiName}};
  FP.schemaVersion=5;
  FP.normalizeTargetSchema=(target,context={})=>{if(!target||typeof target!=='object')return target;const out={...target},p=FP.parseTargetSelectionName(out.targetSelectionName);if(!out.objectApiName)out.objectApiName=p?.objectApiName||context?.objectApiName||undefined;if(!out.fieldPath)out.fieldPath=p?.fieldPath||undefined;if(!out.apiName&&!out.fieldPath?.includes('__r__'))out.apiName=p?.apiName||undefined;if(out.label)out.label=FP.normalizeText(out.label).replace(/^\s*\*\s*/, '');if(!out.key)out.key=FP.chooseStableFieldKey({objectApiName:out.objectApiName,apiName:out.apiName,name:out.name,label:out.label,targetSelectionName:out.targetSelectionName,fieldPath:out.fieldPath});else if(String(out.key).startsWith('api:')&&out.objectApiName&&out.apiName)out.key=FP.chooseStableFieldKey({objectApiName:out.objectApiName,apiName:out.apiName,name:out.name,label:out.label,targetSelectionName:out.targetSelectionName,fieldPath:out.fieldPath});if(out.kind==='multipicklist')out.kind='multi-picklist';if(out.kind==='reference')out.kind='lookup';if(!out.fieldType&&out.sfDataType)out.fieldType=out.sfDataType;return out};
  FP.normalizeRecordingSchema=recording=>{if(!recording||typeof recording!=='object')return recording;const context=recording.context&&typeof recording.context==='object'?{...recording.context}:{};const steps=Array.isArray(recording.steps)?recording.steps.map((step,i)=>{if(!step||typeof step!=='object')return step;const next={...step,target:FP.normalizeTargetSchema(step.target,context),sequence:step.sequence??i+1};if(next.target?.kind==='multi-picklist'&&!Array.isArray(next.value))next.value=FP.parseMultiValues(next.value);return next}):recording.steps;return{...recording,schemaVersion:5,context,steps}};

  FP.isSalesforceHost=()=>{try{const h=location.hostname.toLowerCase();return location.protocol==='https:'&&(h.endsWith('.salesforce.com')||h.endsWith('.lightning.force.com')||h.endsWith('.my.salesforce.com')||h.endsWith('.visualforce.com')||h.endsWith('.vf.force.com'))}catch{return false}};
  FP.invalidateFieldCaches=()=>{rootsCache=null;rootsCacheAt=0;candidatesCache=null;candidatesCacheAt=0;fieldRevision++};
  FP.walkRoots=()=>{
    const now=Date.now();
    if(rootsCache&&now-rootsCacheAt<1500)return rootsCache;
    const roots=[document],seen=new Set([document]),queue=[document];
    while(queue.length){const root=queue.shift();try{root.querySelectorAll?.('*')?.forEach(el=>{if(el.shadowRoot&&!seen.has(el.shadowRoot)){seen.add(el.shadowRoot);roots.push(el.shadowRoot);queue.push(el.shadowRoot)}})}catch{}}
    rootsCache=roots;rootsCacheAt=now;return roots;
  };
  FP.deepQueryFirst=(root,selector)=>{if(!root)return null;if(root.matches?.(selector))return root;try{const d=root.querySelector?.(selector);if(d)return d}catch{}const queue=[];try{if(root.shadowRoot)queue.push(root.shadowRoot);root.querySelectorAll?.('*')?.forEach(el=>{if(el.shadowRoot)queue.push(el.shadowRoot)})}catch{}const seen=new Set();while(queue.length){const r=queue.shift();if(!r||seen.has(r))continue;seen.add(r);try{const f=r.querySelector?.(selector);if(f)return f;if(r.shadowRoot)queue.push(r.shadowRoot);r.querySelectorAll?.('*')?.forEach(el=>{if(el.shadowRoot)queue.push(el.shadowRoot)})}catch{}}return null};
  FP.deepQueryAll=(root,selector,limit=300)=>{const out=[],found=new Set(),seen=new Set(),queue=[root];if(root?.shadowRoot)queue.push(root.shadowRoot);while(queue.length&&out.length<limit){const r=queue.shift();if(!r||seen.has(r))continue;seen.add(r);try{if(r.matches?.(selector)&&!found.has(r)){found.add(r);out.push(r)}r.querySelectorAll?.(selector)?.forEach(el=>{if(out.length<limit&&!found.has(el)){found.add(el);out.push(el)}});if(r.shadowRoot)queue.push(r.shadowRoot);r.querySelectorAll?.('*')?.forEach(el=>{if(el.shadowRoot)queue.push(el.shadowRoot)})}catch{}}return out};

  FP.collectComponentHosts=node=>{const hosts=[],seen=new Set();let cur=node;while(cur&&!seen.has(cur)){seen.add(cur);if(cur.nodeType===1)hosts.push(cur);let next=null;try{const root=cur.getRootNode?.();if(root?.host&&root.host!==cur)next=root.host}catch{}if(!next)next=cur.parentElement||null;cur=next;}return hosts};
  const FIELD_CONTAINER_SELECTOR='[data-target-selection-name^="sfdc:RecordField."],[data-field-id],record_flexipage-record-field,flexipage-field';
  const DATATABLE_SELECTOR='lightning-datatable,[role="grid"],[role="treegrid"]';
  const COMPONENT_TAGS=new Set(['lightning-input-field','lightning-input','lightning-combobox','lightning-textarea','lightning-record-picker','lightning-lookup','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-base-combobox']);
  FP.logicalComponentHost=node=>{const hosts=FP.collectComponentHosts(node);const semantic=hosts.find(h=>h.matches?.(FIELD_CONTAINER_SELECTOR));if(semantic)return semantic;const inputField=hosts.find(h=>String(h.tagName||'').toLowerCase()==='lightning-input-field');if(inputField)return inputField;return hosts.find(h=>COMPONENT_TAGS.has(String(h.tagName||'').toLowerCase())||h.matches?.('[data-sf-field],[data-sf-address]'))||null};
  FP.fieldRoot=node=>{if(!node)return null;try{const nested=FP.deepQueryFirst(node,'[data-target-selection-name^="sfdc:RecordField."]');if(nested)return nested}catch{}const hosts=FP.collectComponentHosts(node);const semantic=hosts.find(h=>h.matches?.(FIELD_CONTAINER_SELECTOR));if(semantic)return semantic;const directField=hosts.find(h=>String(h.tagName||'').toLowerCase()==='lightning-input-field');if(directField)return directField;return hosts.find(h=>COMPONENT_TAGS.has(String(h.tagName||'').toLowerCase())||h.matches?.('[data-sf-field],[data-sf-address]'))||node};
  FP.isRedundantNativeControl=node=>!!node&&/^(input|textarea|select|button)$/i.test(String(node.tagName||''))&&!!FP.logicalComponentHost(node);

  FP.resolveFieldLabel=(host,element)=>{const clean=v=>FP.normalizeText(v).replace(/^\s*\*\s*/,'').replace(/\s*\*\s*$/,'');const explicit=[host?.getAttribute?.('field-label'),host?.getAttribute?.('label'),host?.getAttribute?.('data-label'),host?.getAttribute?.('data-sf-label'),element?.getAttribute?.('aria-label')?.split(',')[0],element?.getAttribute?.('title')].find(v=>v&&String(v).trim());if(explicit)return clean(explicit);const id=element?.id;if(id){for(const root of FP.walkRoots()){try{const l=root.querySelector?.(`label[for="${CSS.escape(id)}"]`);if(l?.textContent?.trim())return clean(l.textContent)}catch{}}}for(const base of [element?.parentElement,host,host?.parentElement].filter(Boolean)){try{const c=base.matches?.('.slds-form-element,.form-element,[data-field],[data-sf-field],[data-sf-address]')?base:base.closest?.('.slds-form-element,.form-element,[data-field],[data-sf-field],[data-sf-address]');const l=c?.querySelector?.(':scope > .slds-form-element__label,label,.labelCol');if(l?.textContent?.trim())return clean(l.textContent)}catch{}}const deep=FP.deepQueryFirst(host,'label,.slds-form-element__label,.labelCol,[data-label]');if(deep?.textContent?.trim())return FP.normalizeText(deep.textContent);const ph=element?.getAttribute?.('placeholder');return ph?FP.normalizeText(ph).replace(/\s*\*\s*$/,''):''};
  FP.controlForField=host=>{
    if(!host)return null;
    const tag=String(host.tagName||'').toLowerCase();
    if(/^(input|textarea|select)$/i.test(tag))return host;
    if(tag==='lightning-input')return FP.deepQueryFirst(host,'input:not([type="hidden"]),textarea')||host;
    if(tag==='lightning-textarea')return FP.deepQueryFirst(host,'textarea')||host;
    if(tag==='lightning-base-combobox')return FP.deepQueryFirst(host,'button[role="combobox"],input[role="combobox"]')||host;
    if(/^(lightning-dual-listbox|lightning-lookup|lightning-record-picker|lightning-combobox|lightning-picklist|lightning-input-address|lightning-timepicker)$/.test(tag))return host;

    // For a Salesforce record-field container, prefer the most specific compound
    // control. A plain lightning-input must be reduced to its native input so
    // type/role/value semantics are available to the detector and replayer.
    if(tag==='lightning-datepicker')return FP.deepQueryFirst(host,'input[type="date"],input[role="textbox"],input:not([type="hidden"])')||host;
    const compound=FP.deepQueryFirst(host,
      'lightning-dual-listbox,lightning-lookup,lightning-record-picker,'+
      'lightning-base-combobox[data-lookup],lightning-combobox,lightning-picklist,'+
      'lightning-input-address,lightning-timepicker');
    if(compound)return compound;
    const li=FP.deepQueryFirst(host,'lightning-input');
    if(li)return FP.deepQueryFirst(li,'input:not([type="hidden"]),textarea')||li;
    const ta=FP.deepQueryFirst(host,'lightning-textarea');
    if(ta)return FP.deepQueryFirst(ta,'textarea')||ta;
    for(const s of ['input[type=checkbox]','button[role="checkbox"]','[role="checkbox"]','input[type=date]','input[type=datetime-local]','input[type=time]','input[role="spinbutton"]','[role="spinbutton"]','input[role="combobox"]','button[role="combobox"]','input:not([type=hidden])','textarea','select','[contenteditable="true"]','[role="textbox"]']){
      const f=FP.deepQueryFirst(host,s);if(f)return f;
    }
    return null;
  };
  FP.semanticKindFromSalesforceType=t=>{t=String(t||'').toLowerCase();if(t==='multipicklist'||t==='multi-picklist')return'multi-picklist';if(t==='picklist')return'picklist';if(t==='boolean')return'boolean';if(t==='string'||t==='text')return'text';if(['currency','percent','double','int','integer','long','decimal','number'].includes(t))return'number';if(t==='date')return'date';if(t==='datetime')return'datetime';if(t==='time')return'time';if(t==='email')return'email';if(t==='phone')return'phone';if(t==='url')return'url';if(['textarea','longtextarea','richtext'].includes(t))return'longText';if(t==='reference')return'lookup';return''};
  FP.canonicalFieldType=d=>{
    const exact=String(d?.sfDataType||'').toLowerCase();
    const k=String(d?.kind||'').toLowerCase();
    // The detected control kind is authoritative for the UI interaction model.
    // Currency/Percent remain special numeric subtypes, but stale picklist/reference/
    // boolean metadata must never turn an actual text/number/checkbox control into
    // a picklist during recording or replay.
    if(k==='number' && ['currency','percent'].includes(exact))return exact;
    const byKind={'multi-picklist':'multipicklist','picklist':'picklist','boolean':'boolean','number':'number','date':'date','datetime':'datetime','time':'time','lookup':'reference','longtext':'textarea','email':'email','phone':'phone','url':'url','address':'address'};
    if(byKind[k])return byKind[k];
    if(['currency','percent'].includes(exact))return exact;
    if(['double','int','integer','long','decimal','number'].includes(exact))return 'number';
    if(['date','datetime','time','email','phone','url','textarea','longtextarea','richtext'].includes(exact))return exact;
    return 'text';
  };
  FP.isLikelyLookupField=(host,el)=>{if(!host&&!el)return false;const h=String(host?.tagName||'').toLowerCase(),api=String(host?.getAttribute?.('field-name')||host?.getAttribute?.('data-field-name')||host?.getAttribute?.('name')||el?.getAttribute?.('name')||'');const explicit=[host?.getAttribute?.('data-field-type'),host?.getAttribute?.('field-type'),host?.getAttribute?.('data-sf-type'),el?.getAttribute?.('data-field-type'),el?.getAttribute?.('field-type'),el?.getAttribute?.('data-sf-type')].filter(Boolean).join(' ').toLowerCase();if(h==='lightning-record-picker'||h==='lightning-lookup'||/lookup|reference|record-picker/.test(explicit))return true;const nested=FP.deepQueryFirst(host,'lightning-record-picker,lightning-lookup,records-record-picker,force-record-lookup,lightning-base-combobox[data-lookup]');if(nested)return true;for(const n of FP.collectComponentHosts(el||host)){try{const tag=String(n.tagName||'').toLowerCase();if(tag==='lightning-lookup'||tag==='lightning-record-picker'||n.hasAttribute?.('data-lookup'))return true;}catch{}}const role=String(el?.getAttribute?.('role')||'').toLowerCase();const auto=String(el?.getAttribute?.('aria-autocomplete')||'').toLowerCase();if((role==='combobox'||el?.getAttribute?.('aria-haspopup')==='listbox')&&auto==='list'&&/(?:^|_)id$/i.test(api))return true;return false};
  FP.controlKind=(host,el)=>{
    const tag=String(host?.tagName||'').toLowerCase();
    const controlTag=String(el?.tagName||'').toLowerCase();
    const role=String(el?.getAttribute?.('role')||host?.getAttribute?.('role')||'').toLowerCase();

    // 1) Strong structural signals from the actual Salesforce component.
    const directTags=new Set([tag,controlTag]);
    if(directTags.has('lightning-dual-listbox') || FP.deepQueryFirst(host,'lightning-dual-listbox'))return'multi-picklist';
    if(tag==='records-record-layout-lookup'||directTags.has('lightning-record-picker')||directTags.has('lightning-lookup'))return'lookup';
    if(directTags.has('lightning-base-combobox') && (host?.hasAttribute?.('data-lookup')||el?.hasAttribute?.('data-lookup')))return'lookup';
    if(FP.deepQueryFirst(host,'lightning-lookup,lightning-record-picker,lightning-base-combobox[data-lookup]'))return'lookup';
    if(directTags.has('lightning-combobox') || directTags.has('lightning-picklist') || FP.deepQueryFirst(host,'lightning-picklist,lightning-combobox'))return'picklist';
    if(directTags.has('lightning-input-address') || FP.deepQueryFirst(host,'lightning-input-address'))return'address';
    if(directTags.has('lightning-datepicker') || FP.deepQueryFirst(host,'lightning-datepicker'))return'date';
    if(directTags.has('lightning-textarea') || FP.deepQueryFirst(host,'lightning-textarea'))return'longText';
    if(directTags.has('lightning-timepicker') || FP.deepQueryFirst(host,'lightning-timepicker'))return'time';

    // 2) Native control signals.
    const inputType=String(el?.type||host?.getAttribute?.('type')||'').toLowerCase();
    if(inputType==='checkbox'||role==='checkbox')return'boolean';
    if(inputType==='date')return'date';
    if(inputType==='datetime-local')return'datetime';
    if(inputType==='time')return'time';
    if(inputType==='number'||role==='spinbutton')return'number';
    if(inputType==='email')return'email';
    if(inputType==='tel')return'phone';
    if(inputType==='url')return'url';
    if(el?.multiple===true || el?.getAttribute?.('aria-multiselectable')==='true')return'multi-picklist';
    if(role==='combobox'||el?.getAttribute?.('aria-haspopup')==='listbox')return'picklist';
    if(/^(input|textarea)$/.test(controlTag)||el?.isContentEditable)return'text';

    // 3) If we only have a generic field container, keep it generic. Salesforce
    // metadata can refine numeric/date/email/etc. later, but must not manufacture a
    // picklist merely because some unrelated descendant exposes a combobox-like node.
    return'field';
  };
  FP.isDisabled=(h,e)=>{const controls=[e,FP.controlForField?.(h)];for(const c of controls.filter(Boolean)){if(c.disabled===true||c.getAttribute?.('aria-disabled')==='true')return true;}return false};
  FP.isReadOnly=(h,e)=>{for(const c of [e,FP.controlForField?.(h)].filter(Boolean)){if(c.readOnly===true||c.getAttribute?.('aria-readonly')==='true')return true;}try{return !!(h?.matches?.('records-formula-output,lightning-output-field,.test-id__output-root')||FP.deepQueryFirst(h,'records-formula-output,lightning-output-field,.test-id__output-root'))}catch{return false}};
  FP.isNoiseField=f=>{const s=FP.normalizeText(f?.label).replace(/[.。…:]+$/g,'').trim();return /^(search|search this list|quick find|global search|password|token|secret|verification code|security code)$/i.test(s)};
  FP.chooseStableFieldKey=({objectApiName,apiName,name,label,targetSelectionName,fieldPath})=>{const obj=FP.normalizeText(objectApiName);if(targetSelectionName){const parsed=FP.parseTargetSelectionName(targetSelectionName);if(parsed?.raw){if(obj||parsed.objectApiName)return`field:${obj||parsed.objectApiName}:${parsed.fieldPath}`;return`target:${parsed.raw}`;}}if(apiName&&!/(^|[-_])(?:input|combobox|button|field|textbox)[-_]?[a-z0-9]{8,}$/i.test(apiName)&&!/^[0-9a-z]{20,}$/i.test(apiName))return obj?`field:${obj}:${apiName}`:`api:${apiName}`;if(name&&!/^[0-9a-z]{20,}$/i.test(name))return obj?`field:${obj}:${name}`:`name:${name}`;return obj?`field:${obj}:label:${FP.normalizeLabel(label)}`:`label:${FP.normalizeLabel(label)}`};

  async function getApiVersion(){if(metadataState.version&&Date.now()-metadataState.versionAt<1800000)return metadataState.version;try{const r=await fetch('/services/data/',{credentials:'include',cache:'no-store'});if(r.ok){const arr=await r.json();const nums=Array.isArray(arr)?arr.map(v=>Number(v.version)).filter(Number.isFinite):[];if(nums.length){metadataState.version=Math.max(...nums).toFixed(1);metadataState.versionAt=Date.now();return metadataState.version}}}catch{}return null}
  function normalizeDescribeField(f){if(!f)return null;const type=String(f.type||'').toLowerCase();return{...f,apiName:f.name,label:f.label,dataType:type==='multipicklist'?'multipicklist':type==='datetime'?'datetime':type==='currency'?'currency':type==='percent'?'percent':type,referenceTo:Array.isArray(f.referenceTo)?f.referenceTo:[],picklistValues:Array.isArray(f.picklistValues)?f.picklistValues.filter(x=>x?.active!==false).map(x=>({value:x.value, label:x.label||x.value, validFor:x.validFor})):[]};}
  FP.loadSalesforceMetadata=async(objectApiName,recordId='')=>{if(!FP.isSalesforceHost()||!objectApiName||objectApiName==='Salesforce')return null;const k=String(objectApiName);const cached=metadataState.objectCache.get(k);if(cached&&Date.now()-cached.at<600000){const fields=new Map(Object.entries(cached.objectInfo?.fields||{}));metadataState.objectFieldMetadata.set(k,fields);metadataState.fieldMetadata=fields;metadataState.objectApiName=objectApiName;metadataState.recordId=recordId;FP.invalidateFieldCaches();return cached.objectInfo}const v=await getApiVersion();const attempts=[];if(v){attempts.push(`/services/data/v${v}/ui-api/object-info/${encodeURIComponent(objectApiName)}`);attempts.push(`/services/data/v${v}/sobjects/${encodeURIComponent(objectApiName)}/describe`);}attempts.push(`/services/data/latest/ui-api/object-info/${encodeURIComponent(objectApiName)}`);attempts.push(`/services/data/latest/sobjects/${encodeURIComponent(objectApiName)}/describe`);for(const url of attempts){try{const r=await fetch(url,{credentials:'include',cache:'no-store'});if(!r.ok)continue;const raw=await r.json();let objectInfo=raw;if(raw?.fields&&typeof raw.fields==='object'&&!Array.isArray(raw.fields)){objectInfo=raw}else if(Array.isArray(raw?.fields)){const fields={};for(const f of raw.fields){const n=normalizeDescribeField(f);if(n?.name)fields[n.name]=n}objectInfo={...raw,apiName:raw.name||objectApiName,label:raw.label||objectApiName,fields}}if(!objectInfo?.fields||typeof objectInfo.fields!=='object')continue;metadataState.objectCache.set(k,{at:Date.now(),objectInfo});const fields=new Map(Object.entries(objectInfo.fields));metadataState.objectFieldMetadata.set(k,fields);metadataState.fieldMetadata=fields;metadataState.objectApiName=objectApiName;metadataState.recordId=recordId;FP.invalidateFieldCaches();return objectInfo}catch{}}return null};
  FP.getRecordTypeId=async(objectApiName,recordId='')=>{
    const obj=String(objectApiName||''),rec=String(recordId||'');
    if(!obj||obj==='Salesforce')return '';
    if(rec){const cached=metadataState.recordCache.get(rec);if(cached&&cached.expiresAt>Date.now()&&cached.objectApiName===obj)return cached.recordTypeId||'';
      const v=await getApiVersion();const urls=[];if(v)urls.push(`/services/data/v${v}/ui-api/records/${encodeURIComponent(rec)}`);urls.push(`/services/data/latest/ui-api/records/${encodeURIComponent(rec)}`);
      for(const url of urls){try{const r=await fetch(url,{credentials:'include',cache:'no-store'});if(!r.ok)continue;const data=await r.json();const rt=data?.fields?.RecordTypeId?.value||data?.fields?.RecordTypeId?.displayValue||'';if(rt){metadataState.recordCache.set(rec,{recordTypeId:String(rt),objectApiName:obj,expiresAt:Date.now()+600000});return String(rt)}}catch{}}
      const restUrls=[];if(v)restUrls.push(`/services/data/v${v}/sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(rec)}?fields=RecordTypeId`);restUrls.push(`/services/data/latest/sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(rec)}?fields=RecordTypeId`);
      for(const url of restUrls){try{const r=await fetch(url,{credentials:'include',cache:'no-store'});if(!r.ok)continue;const data=await r.json();const rt=data?.RecordTypeId||'';if(rt){metadataState.recordCache.set(rec,{recordTypeId:String(rt),objectApiName:obj,expiresAt:Date.now()+600000});return String(rt)}}catch{}}}
    const info=metadataState.objectCache.get(obj)?.objectInfo,infos=info?.recordTypeInfos;if(info?.defaultRecordTypeId)return String(info.defaultRecordTypeId);if(infos&&typeof infos==='object'){const x=Object.values(infos).find(v=>v?.defaultRecordTypeMapping||v?.isDefaultMapping);if(x?.recordTypeId)return String(x.recordTypeId);const y=Object.values(infos).find(v=>v?.recordTypeId);if(y?.recordTypeId)return String(y.recordTypeId)}return'012000000000000AAA';
  };
  FP.getPicklistOptions=async(objectApiName,fieldApiName,recordId='')=>{if(!objectApiName||!fieldApiName)return[];await FP.loadSalesforceMetadata(objectApiName,recordId).catch(()=>null);const rt=await FP.getRecordTypeId(objectApiName,recordId);return FP.loadFieldPicklistValues(objectApiName,rt,fieldApiName)};
  FP.loadFieldPicklistValues=async(objectApiName,recordTypeId,fieldApiName)=>{if(!FP.isSalesforceHost()||!objectApiName||!fieldApiName)return[];const v=await getApiVersion();const rt=recordTypeId||'012000000000000AAA';const urls=[];if(v)urls.push(`/services/data/v${v}/ui-api/object-info/${encodeURIComponent(objectApiName)}/picklist-values/${encodeURIComponent(rt)}/${encodeURIComponent(fieldApiName)}`);urls.push(`/services/data/latest/ui-api/object-info/${encodeURIComponent(objectApiName)}/picklist-values/${encodeURIComponent(rt)}/${encodeURIComponent(fieldApiName)}`);for(const url of urls){try{const r=await fetch(url,{credentials:'include',cache:'no-store'});if(!r.ok)continue;const data=await r.json();if(Array.isArray(data?.values))return data.values.filter(x=>x?.active!==false).map(x=>({value:x.value,displayValue:x.label||x.value,validFor:x.validFor}));}catch{}}return[]};
  FP.getFieldMetadata=(api,objectApiName)=>{const fields=objectApiName?metadataState.objectFieldMetadata.get(String(objectApiName)):metadataState.fieldMetadata;return fields?.get(api)||null};
  FP.resolveFieldMetadata=({objectApiName,apiName,name,label,fieldPath})=>{const fields=objectApiName?metadataState.objectFieldMetadata.get(String(objectApiName)):metadataState.fieldMetadata;if(!fields)return null;for(const candidate of [apiName,name,fieldPath]){if(candidate&&fields.has(candidate))return{apiName:candidate,meta:fields.get(candidate)}}const n=FP.normalizeLabel(label);if(!n)return null;const matches=[];for(const [api,meta] of fields){if(FP.normalizeLabel(meta?.label)===n)matches.push({apiName:api,meta})}return matches.length===1?matches[0]:null};
  FP.resolveDatatableContext=node=>{
    if(!node)return null;
    const hosts=FP.collectComponentHosts(node);
    const grid=hosts.find(h=>h.matches?.(DATATABLE_SELECTOR));
    let cell=null;try{cell=node.closest?.('[role=\"gridcell\"],td')||null}catch{}
    if(!grid&&!cell)return null;
    let columnKey='',fieldApiName='',label='',colIndex='';
    for(const n of [cell,...FP.collectComponentHosts(cell||node)].filter(Boolean)){
      for(const a of ['data-col-key-value','data-column-key','data-field-name','data-field','data-name']){try{const v=n.getAttribute?.(a);if(v&&!columnKey)columnKey=FP.normalizeText(v)}catch{}}
      try{if(!colIndex){const v=n.getAttribute?.('aria-colindex');if(v)colIndex=String(v)}}catch{}
    }
    if(!columnKey&&colIndex){
      for(const root of [grid,...FP.walkRoots()].filter(Boolean)){try{for(const h of root.querySelectorAll?.('[role=\"columnheader\"],th,[data-col-key-value]')||[]){if(String(h.getAttribute?.('aria-colindex')||'')===colIndex){columnKey=FP.normalizeText(h.getAttribute?.('data-col-key-value')||h.getAttribute?.('data-column-key')||'');if(columnKey)break}}}catch{}if(columnKey)break}
    }
    if(columnKey){const i=columnKey.indexOf('-');fieldApiName=i>0?columnKey.slice(0,i):columnKey;try{for(const root of [grid,...FP.walkRoots()].filter(Boolean)){const h=root.querySelector?.(`[data-col-key-value=\"${CSS.escape(columnKey)}\"],[data-column-key=\"${CSS.escape(columnKey)}\"]`);if(h){label=FP.normalizeText(h.textContent||h.getAttribute?.('aria-label')||'');break}}}catch{}}
    return(fieldApiName||columnKey)?{grid,columnKey,fieldApiName:fieldApiName||undefined,label:label||undefined,colIndex:colIndex||undefined}:null;
  };

  FP.readLookupId=(host,el)=>{for(const node of [host,el].filter(Boolean)){for(const a of ['data-record-id','data-recordid','data-record-id-value','data-id','record-id','data-lookup-id','data-selection-id','data-value','value']){try{const v=node.getAttribute?.(a);if(v&&/^[A-Za-z0-9]{15,18}$/.test(String(v).trim()))return String(v).trim()}catch{}}for(const prop of ['recordId','recordID','lookupId','selectedRecordId','value']){try{const v=node?.[prop];if(v&&typeof v==='string'&&/^[A-Za-z0-9]{15,18}$/.test(v.trim()))return v.trim()}catch{}}try{const nested=node.querySelector?.('[data-record-id],[data-recordid],[data-record-id-value],[data-id],[record-id],[data-lookup-id],[data-selection-id],[data-value],[aria-selected="true"] a,[aria-selected="true"]');if(nested){const x=FP.readLookupId(nested,nested);if(x)return x}}catch{}}return''};
  FP.readAddressParts=host=>{if(String(host?.tagName||'').toLowerCase()!=='lightning-input-address'&&!host?.hasAttribute?.('data-sf-address'))return null;const out={};const aliases={street:['street'],city:['city'],province:['province','state'],country:['country'],postalCode:['postalcode','postal-code','zip']};for(const [k,names] of Object.entries(aliases)){let found=null;for(const root of [host,host?.shadowRoot].filter(Boolean)){for(const n of names){for(const s of [`input[name="${n}"]`,`textarea[name="${n}"]`,`[data-field-name="${n}"]`,`[data-name="${n}"]`,`[data-address-part="${k}"]`,`[autocomplete*="${n}"]`]){try{found=root.querySelector?.(s);if(found)break}catch{}}if(found)break}if(found)break}if(found){const v=FP.normalizeText(found.value??found.textContent);if(v)out[k]=v}}return Object.keys(out).length?out:null};
  FP.readMultiSelectValue=d=>{
    const host=d?.host||d,el=d?.element||FP.controlForField(host);
    const clean=arr=>[...new Set((arr||[]).map(FP.normalizeText).filter(v=>v&&!FP.isMultiPicklistPlaceholder(v)))];
    if(el?.tagName?.toLowerCase()==='select'&&el.multiple)return clean([...el.selectedOptions].map(o=>o.value||o.textContent)).join('; ');
    const dual=host?.tagName?.toLowerCase()==='lightning-dual-listbox'?host:FP.deepQueryFirst(host,'lightning-dual-listbox');
    if(dual){
      const lists=[];
      try{FP.deepQueryAll(dual,'[data-source-list],[data-selected-list],[role=\"listbox\"],.slds-dueling-list__options,[aria-multiselectable=\"true\"],ul.slds-listbox',80).forEach(x=>lists.push(x));}catch{}
      const unique=[...new Set(lists)];
      const describe=list=>{let hints='';try{hints=[list.getAttribute?.('aria-label'),list.getAttribute?.('title'),list.getAttribute?.('data-label'),list.parentElement?.getAttribute?.('aria-label'),list.parentElement?.getAttribute?.('title')].filter(Boolean).join(' ').toLowerCase();list.parentElement?.querySelectorAll?.('label,.slds-dueling-list__label,.slds-form-element__label,.slds-listbox__label,[class*=label]')?.forEach(x=>{const t=FP.normalizeText(x.textContent);if(t&&t.length<80)hints+=' '+t.toLowerCase();});}catch{}return hints};
      const candidates=unique.map(list=>({list,hints:describe(list),options:FP.deepQueryAll(list,'[role=\"option\"],option,[data-value]',240).map(o=>{const value=FP.normalizeText(o.getAttribute?.('data-value')||o.getAttribute?.('value')||o.value||o.textContent||'');const label=FP.normalizeText(o.getAttribute?.('data-label')||o.getAttribute?.('label')||o.getAttribute?.('title')||o.textContent||'');if(!value&&!label||FP.isMultiPicklistPlaceholder(value)||FP.isMultiPicklistPlaceholder(label))return null;return{value:value||label,label:label||value,el:o};}).filter(Boolean)})).filter(x=>/\bselected\b|\bchosen\b|\bcurrent\b/.test(x.hints)||/\bavailable\b|\bsource\b/.test(x.hints)||x.options.length);
      let selectedList=candidates.find(x=>x.list?.hasAttribute?.('data-selected-list'))||candidates.find(x=>/\bselected\b|\bchosen\b|\bcurrent\b/.test(x.hints));
      if(!selectedList){const ordered=candidates.map(x=>{let left=0;try{left=x.list.getBoundingClientRect?.().left||0}catch{}return {...x,left}}).sort((a,b)=>a.left-b.left);selectedList=ordered.length>1?ordered[1]:null;}
      const fromDom=clean((selectedList?.options||[]).map(o=>o.value||o.label));
      if(fromDom.length)return fromDom.join('; ');
      try{const v=dual.value;if(Array.isArray(v))return clean(v).join('; ');if(typeof v==='string'&&v.trim())return clean(FP.parseMultiValues(v)).join('; ');}catch{}
      const marked=clean(FP.deepQueryAll(dual,'[aria-selected=\"true\"][data-value],[data-selected=\"true\"][data-value],option:checked',240).map(o=>o.getAttribute?.('data-value')||o.value||o.textContent));
      return marked.join('; ');
    }
    try{const v=host?.value;if(Array.isArray(v))return clean(v).join('; ');if(typeof v==='string'&&v.trim())return clean(FP.parseMultiValues(v)).join('; ');}catch{}
    return '';
  };
  FP.readValue=d=>{
    const host=d?.host||d,el=d?.element||FP.controlForField(host),kind=d?.kind||FP.controlKind(host,el);
    if(kind==='address')return FP.readAddressParts(host)||{};
    if(kind==='boolean'){if(el?.type==='checkbox')return!!el.checked;return(el?.getAttribute?.('aria-checked')||host?.getAttribute?.('aria-checked'))==='true'}
    if(kind==='multi-picklist')return FP.readMultiSelectValue(d);
    if(kind==='date'){
      const dateInput=FP.deepQueryFirst(host,'input[type="date"],input[role="textbox"],input:not([type="hidden"])')||el;
      const raw=dateInput?.value!==undefined&&typeof dateInput.value!=='object'?dateInput.value:(host?.value!==undefined&&typeof host.value!=='object'?host.value:'');
      if(raw)return FP.normalizeDate(raw);
      const text=FP.normalizeText(dateInput?.getAttribute?.('aria-label')||dateInput?.getAttribute?.('value')||dateInput?.textContent||'');
      return FP.normalizeDate(text);
    }
    if(kind==='lookup'){
      let display='',recordId=FP.readLookupId(host,el)||'';
      const objects=[host,el].filter(Boolean);
      for(const node of objects){
        for(const prop of ['displayValue','lookupLabel','recordName','selectedLabel','label']){try{const v=node?.[prop];if(v!=null&&typeof v!=='object'&&FP.normalizeText(v)){display=FP.normalizeText(v);break}}catch{}}
        if(!display){try{const v=node?.value;if(v&&typeof v==='object'){display=FP.normalizeText(v.displayValue||v.label||v.name||v.title||'');recordId=recordId||String(v.recordId||v.id||'').trim()}}catch{}}
        if(!display){try{const v=node?.getAttribute?.('data-value');if(v&&!/^[A-Za-z0-9]{15,18}$/.test(String(v).trim()))display=FP.normalizeText(v)}catch{}}
      }
      if(!display){try{const input=FP.deepQueryFirst(host,'input[role="combobox"]');display=FP.normalizeText(input?.dataset?.lookupLabel||input?.value||'');recordId=recordId||FP.readLookupId(input,input)||''}catch{}}
      if(!display){try{const pill=FP.deepQueryFirst(host,'lightning-pill,[data-selection-index],[data-selected-record]');display=FP.normalizeText(pill?.textContent||pill?.getAttribute?.('title')||'')}catch{}}
      return{displayValue:display,recordId};
    }
    if(kind==='picklist'){
      const nativeSelect=/^select$/i.test(String(el?.tagName||''))?el:null;
      const trigger=nativeSelect||FP.deepQueryFirst(host,'button[role="combobox"],input[role="combobox"],[role="combobox"]');
      const raw=trigger?.value!==undefined&&typeof trigger.value!=='object'&&trigger.value!==''?trigger.value:(trigger?.getAttribute?.('data-value')||el?.getAttribute?.('data-value')||host?.getAttribute?.('data-value')||'');
      if(raw)return FP.isPicklistPlaceholder(raw)?'':String(raw);
      const sel=FP.deepQueryFirst(host,'[role="option"][aria-selected="true"],option:checked');
      if(sel){const v=sel.value||FP.normalizeText(sel.textContent);return FP.isPicklistPlaceholder(v)?'':v}
      if(trigger){
        const triggerText=FP.normalizeText(trigger?.getAttribute?.('aria-label')||trigger?.getAttribute?.('title')||trigger?.textContent||'');
        return FP.isPicklistPlaceholder(triggerText)?'':triggerText;
      }
      // Some Salesforce picklist wrappers expose only their selected label. Accept it
      // only when it exactly matches a known option; never treat the whole field
      // container (label + help text + placeholder) as a field value.
      const hostText=FP.normalizeText(host?.textContent||'');
      if(hostText&&Array.isArray(d?.options)&&d.options.some(o=>{const n=FP.normalizeLabel(hostText);return n===FP.normalizeLabel(o?.value)||n===FP.normalizeLabel(o?.displayValue)||n===FP.normalizeLabel(o?.label)}))return hostText;
      return '';
    }
    if(el?.value!==undefined&&typeof el.value!=='object')return el.value;
    if(host?.value!==undefined&&host.value!==null&&typeof host.value!=='object')return host.value;
    // Never treat a field container's rendered label/help text as its current field value.
    // If Salesforce exposes neither a value property nor an editable content surface, the
    // safest replay interpretation is blank rather than incorrectly skipping the field.
    if(el?.isContentEditable)return FP.normalizeText(el.textContent);
    return '';
  };
  FP.isPicklistPlaceholder=v=>{const s=FP.normalizeLabel(v).replace(/[–—]/g,'-').replace(/\s+/g,' ');return !s||['-none-','--none--','no selection','select','select an option','choose','choose an option','select option','--select--'].includes(s)}; FP.isMultiPicklistPlaceholder=v=>{const s=FP.normalizeLabel(v).replace(/[–—]/g,'-').replace(/\s+/g,' ');return !s||['-none-','--none--','no selection','select','select an option','choose','choose an option','select option','--select--'].includes(s)};
  FP.isValueEmpty=(d,v)=>{
    if(v===null||v===undefined)return true;
    const kind=String(d?.kind||'');
    if(kind==='lookup')return !v?.displayValue&&!v?.recordId;
    if(kind==='address')return !v||Object.values(v).every(x=>FP.normalizeText(x)==='');
    if(kind==='multi-picklist'){const vals=Array.isArray(v)?v:FP.parseMultiValues(v);return vals.length===0||vals.every(x=>FP.isMultiPicklistPlaceholder(x));}
    if(kind==='picklist')return FP.isPicklistPlaceholder(v);
    // Under Fill empty fields only, an unchecked checkbox is treated as empty so a recorded TRUE value can populate it.
    // A recorded FALSE value remains a real value; this only controls skip/empty detection.
    if(kind==='boolean')return v===false || String(v).trim().toLowerCase()==='false';
    // Numeric zero is an empty/default value for Fill empty fields only. This applies
    // to Number, Currency and Percent controls, including formatted values such as
    // 0.00, $0.00 and %0.00. Recording capture has separate semantics and still keeps
    // an explicitly entered zero as a valid recorded value.
    if(kind==='number'&&FP.normalizeNumber(v)==='0')return true;
    const type=String(d?.sfDataType||d?.type||'').toLowerCase();
    if((type==='currency'||type==='percent'||d?.fieldType==='currency'||d?.fieldType==='percent')&&FP.normalizeNumber(v)==='0')return true;
    if(Array.isArray(v))return v.length===0;
    if(typeof v==='string')return !v.trim();
    return false;
  };
  FP.readOptions=(host,el)=>{const out=[],seen=new Set();const add=o=>{if(!o||seen.has(o))return;const value=o.getAttribute?.('data-value')??o.getAttribute?.('value')??o.value;const text=FP.normalizeText(o.getAttribute?.('data-label')||o.textContent||o.getAttribute?.('title')||'');const v=value!=null&&String(value).trim()?String(value).trim():text;const normalized=FP.normalizeLabel(text).replace(/[–—]/g,'-').replace(/\s+/g,' ');const placeholder=['-none-','--none--','select','select an option','choose','choose an option','select option','--select--'].includes(normalized);if(!v||!text||placeholder)return;const k=`${v}::${text}`;if(!seen.has(k)){seen.add(k);out.push({value:v,displayValue:text})}};if(el?.tagName==='SELECT')Array.from(el.options).forEach(add);for(const r of [host,host?.shadowRoot].filter(Boolean))FP.deepQueryAll(r,'option,[role="option"],lightning-base-combobox-item,.slds-listbox__option',300).forEach(add);return out};
  FP.inferFormattedNumericType=(host,el)=>{
    try{
      if(!host&&!el)return '';
      const parts=[];
      const addNode=n=>{
        if(!n)return;
        try{
          const tag=String(n.tagName||'').toLowerCase();
          if(tag==='label'||n.closest?.('label'))return;
          for(const a of ['aria-label','title','data-format','data-formatter','data-field-formatter']){
            const v=n.getAttribute?.(a); if(v)parts.push(String(v));
          }
          const cls=String(n.className||'');
          if(/currency|percent|formatter/i.test(cls))parts.push(cls);
          const txt=FP.normalizeText(n.textContent||'');
          if(txt&&txt.length<=120)parts.push(txt);
          if(typeof n.value==='string'&&n.value.trim())parts.push(n.value);
        }catch{}
      };
      addNode(el);
      let n=el;
      for(let i=0;i<4&&n;i++,n=n.parentElement)addNode(n);
      // Inspect the small control subtree rather than the whole field so a label such as
      // "Discount (%)" cannot falsely classify a text field as Percent.
      for(const root of [el?.parentElement,el?.parentElement?.parentElement,host].filter(Boolean)){
        try{
          FP.deepQueryAll(root,'[data-formatter],[formatter],span,[class*=formatter],[class*=currency],[class*=percent],abbr',80).slice(0,80).forEach(addNode);
        }catch{}
      }
      // Salesforce can render both Currency and Percent as <input type="text">.
      // Prefer the actual formatted value / accessibility value when Salesforce has
      // already applied its formatter, then fall back to component-local formatter text.
      const liveValues = [
        el?.value,
        el?.getAttribute?.('aria-valuetext'),
        el?.getAttribute?.('data-value'),
        host?.value,
        host?.getAttribute?.('aria-valuetext')
      ].map(v=>String(v??'').trim()).filter(Boolean);
      const liveText = liveValues.join(' ');
      if(/%/.test(liveText))return 'percent';
      if(/(?:[$€£¥₹]|\b(?:USD|CAD|AUD|EUR|GBP|JPY|INR)\b)/i.test(liveText))return 'currency';
      if(/(?:^|[^\w])%(?:$|[^\w])/.test(text)||/percent(?:-fixed)?/i.test(text))return 'percent';
      // Symbols/codes are checked only in the control-local text gathered above.
      if(/(?:[$€£¥₹]|\b(?:USD|CAD|AUD|EUR|GBP|JPY|INR)\b)/i.test(text)||/currency/i.test(text))return 'currency';
    }catch{}
    return '';
  };

  FP.resolveFieldContext=node=>{
    if(!node)return null;
    const hosts=FP.collectComponentHosts(node);
    let targetSelectionName='',fieldId='',objectApiName='',fieldPath='',apiName;
    for(const n of hosts){
      try{
        if(!targetSelectionName){const v=n.getAttribute?.('data-target-selection-name');if(v&&/^sfdc:RecordField\./i.test(String(v)))targetSelectionName=FP.normalizeText(v)}
        if(!fieldId){const v=n.getAttribute?.('data-field-id');if(v)fieldId=FP.normalizeText(v)}
      }catch{}
      if(targetSelectionName)break;
    }
    const parsed=FP.parseTargetSelectionName(targetSelectionName);
    if(parsed){objectApiName=parsed.objectApiName;fieldPath=parsed.fieldPath;apiName=parsed.apiName}
    if(!objectApiName){
      for(const n of hosts){try{const v=n.getAttribute?.('data-sf-object');if(v){objectApiName=FP.normalizeText(v);break}}catch{}}
    }
    if(!objectApiName){try{objectApiName=document.documentElement.dataset.sfObject||document.querySelector?.('[data-sf-object]')?.getAttribute?.('data-sf-object')||''}catch{}}
    if(!apiName&&fieldPath&&!fieldPath.includes('__r__'))apiName=fieldPath;
    const datatable=FP.resolveDatatableContext(node);if(!apiName&&datatable?.fieldApiName)apiName=datatable.fieldApiName;
    return{targetSelectionName:targetSelectionName||undefined,fieldId:fieldId||undefined,objectApiName:objectApiName||undefined,fieldPath:fieldPath||undefined,apiName:apiName||undefined,datatable};
  };
  FP.describeField=host0=>{
    if(!host0)return null;
    const host=FP.fieldRoot(host0)||host0;
    const cached=descriptorCache.get(host);
    if(cached?.revision===fieldRevision)return cached.descriptor;

    const el=FP.controlForField(host),label=FP.resolveFieldLabel(host,el);if(!label)return null;
    const ctx=FP.resolveFieldContext(host);
    const tag=String(host.tagName||'').toLowerCase();
    const rawApi=ctx?.apiName||host.getAttribute?.('field-name')||host.getAttribute?.('fieldName')||host.getAttribute?.('data-field-name')||host.getAttribute?.('data-field')||host.getAttribute?.('data-sf-field')||el?.getAttribute?.('data-field-name')||el?.getAttribute?.('data-sf-field')||el?.name||null;
    const name=el?.getAttribute?.('name')||host.getAttribute?.('name')||null;
    const resolved=FP.resolveFieldMetadata({objectApiName:ctx?.objectApiName,apiName:rawApi,name,label,fieldPath:ctx?.fieldPath});
    const meta=resolved?.meta||null,apiName=resolved?.apiName||rawApi||name||undefined;

    const explicitFieldType=String(host.getAttribute?.('data-field-type')||host.getAttribute?.('field-type')||el?.getAttribute?.('data-field-type')||el?.getAttribute?.('field-type')||host.getAttribute?.('data-sf-type')||el?.getAttribute?.('data-sf-type')||'').toLowerCase();
    const formatterCandidates=[];
    for(const n of [host,el,...FP.collectComponentHosts(host)]){for(const a of ['formatter','data-formatter','data-field-formatter','data-sf-type']){try{const v=n?.getAttribute?.(a);if(v)formatterCandidates.push(String(v).toLowerCase())}catch{}}for(const p of ['formatter','fieldType','dataType','type']){try{const v=n?.[p];if(typeof v==='string')formatterCandidates.push(v.toLowerCase())}catch{}}}
    const formatter=formatterCandidates.find(v=>['currency','percent','date','datetime','time','number','double','picklist','multipicklist','boolean','reference'].includes(v))||'';

    const domKind=FP.controlKind(host,el);
    const metaType=String(meta?.dataType||'').toLowerCase();
    const explicitKind=FP.semanticKindFromSalesforceType(explicitFieldType);
    const metaKind=FP.semanticKindFromSalesforceType(metaType);
    const behavioralType=FP.inferFormattedNumericType(host,el);
    const numericSemantic=domKind==='number' || ['currency','percent','double','int','integer','long','decimal','number'].includes(metaType) || ['currency','percent'].includes(behavioralType);

    // Structural DOM classification wins over stale/ambiguous metadata. Metadata can
    // refine a generic number control to Currency/Percent, but a metadata 'picklist'
    // value cannot convert a text control into a picklist without picklist structure.
    let kind=domKind;
    if(kind==='field'){
      if(explicitKind)kind=explicitKind;
      else if(metaKind && !['picklist','multi-picklist','boolean','lookup'].includes(metaKind))kind=metaKind;
      else if(numericSemantic)kind='number';
      else if(metaType==='textarea'||metaType==='longtextarea'||metaType==='richtext')kind='longText';
    }
    if(kind==='multi-picklist' || tag==='lightning-dual-listbox' || FP.deepQueryFirst(host,'lightning-dual-listbox,[aria-multiselectable="true"]'))kind='multi-picklist';
    if(kind==='lookup' || FP.isLikelyLookupField(host,el))kind='lookup';

    const reference=kind==='lookup';
    const multi=kind==='multi-picklist';
    let exactType='';
    if(kind==='number')exactType=['currency','percent'].includes(metaType)?metaType:(['currency','percent'].includes(explicitFieldType)?explicitFieldType:'number');
    else if(kind==='picklist')exactType='picklist';
    else if(kind==='multi-picklist')exactType='multipicklist';
    else if(kind==='lookup')exactType='reference';
    else if(kind==='boolean')exactType='boolean';
    else if(kind==='date')exactType='date';
    else if(kind==='datetime')exactType='datetime';
    else if(kind==='time')exactType='time';
    else if(kind==='email')exactType='email';
    else if(kind==='phone')exactType='phone';
    else if(kind==='url')exactType='url';
    else if(kind==='longText')exactType='textarea';
    else if(['string','text','textarea','longtextarea','richtext'].includes(metaType))exactType=metaType==='string'?'string':metaType;

    let options=[];
    if(kind==='picklist'||multi||el?.tagName==='SELECT'){
      const live=FP.readOptions(host,el);
      options=live.length?live:(Array.isArray(meta?.picklistValues)?meta.picklistValues.filter(o=>o?.active!==false).map(o=>({value:o.value,displayValue:o.label||o.value})):[]);
    }

    const identitySource=ctx?.targetSelectionName?'target-selection':apiName?'field-api':name?'native-name':label?'label':'';
    const key=FP.chooseStableFieldKey({objectApiName:ctx?.objectApiName,apiName,name,label,targetSelectionName:ctx?.targetSelectionName,fieldPath:ctx?.fieldPath});
    const d={
      key,label:FP.normalizeText(meta?.label||label),apiName,name:name||undefined,
      type:exactType||kind,kind,fieldType:exactType||kind,reference,multiSelect:multi,
      referenceObject:meta?.referenceTo?.[0],referenceId:FP.readLookupId(host,el)||undefined,
      host,element:el,options,readOnly:FP.isReadOnly(host,el),disabled:FP.isDisabled(host,el),
      sfDataType:exactType||undefined,metadataBacked:!!meta,updateable:meta?.updateable!==false,
      createable:meta?.createable!==false,required:meta?.required===true,
      addressParts:FP.readAddressParts(host)||undefined,scale:meta?.scale,length:meta?.length,
      objectApiName:ctx?.objectApiName,fieldPath:ctx?.fieldPath,targetSelectionName:ctx?.targetSelectionName,fieldId:ctx?.fieldId,
      identitySource,identityConfidence:ctx?.targetSelectionName||apiName||name?1:label?.trim()?0.75:0.4,
      referenceFieldPath:ctx?.fieldPath?.includes('__r__')?ctx.fieldPath:undefined,datatable:ctx?.datatable||undefined,
      dataTableColumnKey:ctx?.datatable?.columnKey||undefined,dataTableFieldApiName:ctx?.datatable?.fieldApiName||undefined
    };
    descriptorCache.set(host,{revision:fieldRevision,descriptor:d});return d;
  };
  FP.refreshFieldDescriptor=node=>{
    try{
      const host=FP.fieldRoot(node)||node;
      descriptorCache.delete(host);
      return FP.describeField(host);
    }catch{return null}
  };
  FP.candidateFields=()=>{
    const now=Date.now();if(candidatesCache&&now-candidatesCacheAt<1500)return candidatesCache;
    const wrappers=['[data-target-selection-name^="sfdc:RecordField."]','[data-field-id]','record_flexipage-record-field','flexipage-field','lightning-input-field','lightning-input','lightning-lookup','lightning-combobox','lightning-textarea','lightning-record-picker','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-base-combobox','[data-sf-field]','[data-sf-address]'];const natives=['input:not([type=hidden])','textarea','select','[contenteditable="true"]'];const out=[],seen=new Map();const score=d=>(d?.targetSelectionName?50:0)+(d?.apiName?25:0)+(d?.objectApiName?15:0)+(d?.fieldId?5:0)+(d?.kind&&d.kind!=='field'?2:0);const add=h=>{
      if(!h||FP.isRedundantNativeControl(h))return;
      const tag=String(h.tagName||'').toLowerCase();
      const type=String(h.getAttribute?.('type')||'').toLowerCase();
      if(type==='range')return;
      const fieldContainer=FP.collectComponentHosts(h).some(n=>n?.matches?.('[data-target-selection-name^=\"sfdc:RecordField.\"],[data-field-id],record_flexipage-record-field,flexipage-field,lightning-input-field,[data-sf-field],[data-sf-address]'));
      const rawTS=String(h.getAttribute?.('data-target-selection-name')||'');
      if(rawTS && !/^sfdc:RecordField\./i.test(rawTS) && !fieldContainer)return;
      if(!fieldContainer && !['lightning-input-field','lightning-input','lightning-lookup','lightning-record-picker','lightning-combobox','lightning-textarea','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-date-picker','lightning-datepicker'].includes(tag))return;
      const d=FP.describeField(h);
      if(!d||!d.label||FP.isNoiseField(d))return;
      const idx=seen.get(d.key);
      if(idx==null){seen.set(d.key,out.length);out.push(d);}else if(score(d)>score(out[idx]))out[idx]=d;
    };for(const root of FP.walkRoots()){for(const s of wrappers)try{root.querySelectorAll?.(s)?.forEach(add)}catch{}}for(const root of FP.walkRoots()){for(const s of natives)try{root.querySelectorAll?.(s)?.forEach(add)}catch{}}candidatesCache=out;candidatesCacheAt=now;return out;
  };
  FP.findDescriptorFromEvent=e=>{const path=typeof e?.composedPath==='function'?e.composedPath():[e?.target];for(const n of path){if(!n||n.nodeType!==1||n.id==='forcepilot-root')continue;const tag=String(n.tagName||'').toLowerCase();if(n.matches?.('[data-target-selection-name^="sfdc:RecordField."],[data-field-id],record_flexipage-record-field,flexipage-field,lightning-input-field,[data-sf-field],[data-sf-address]')){const d=FP.describeField(n);if(d)return d}if(/^(input|textarea|select)$/.test(tag)||n.isContentEditable||n.matches?.('lightning-input,lightning-lookup,lightning-combobox,lightning-dual-listbox,lightning-record-picker,lightning-textarea,lightning-timepicker,lightning-base-combobox')){const h=/^(input|textarea|select)$/.test(tag)?(FP.logicalComponentHost(n)||n):n;const d=FP.describeField(h);if(d)return d}}return null};
  FP.normalizeRecordedValue=(d,v)=>{const k=d?.kind;if(k==='boolean')return FP.normalizeBoolean(v);if(k==='number')return FP.normalizeNumber(v);if(k==='date')return FP.normalizeDate(v);if(k==='datetime')return FP.normalizeDateTime(v);if(k==='time')return FP.normalizeTime(v);if(k==='multi-picklist')return Array.isArray(v)?v.map(FP.normalizeText).filter(Boolean):FP.parseMultiValues(v);if(k==='lookup'){const x=v&&typeof v==='object'?v:{displayValue:String(v??''),recordId:''};const display=x.displayValue??x.lookupLabel??x.label??x.name??x.title??'';const recordId=x.recordId??x.id??'';return{displayValue:FP.normalizeText(display),recordId:String(recordId||'')}}if(k==='address')return v&&typeof v==='object'?{...v}:{};return v==null?'':String(v)};
  FP.valuesEqual=(d,a,b)=>{const k=d?.kind;if(k==='multi-picklist')return FP.normalizeRecordedValue(d,a).slice().sort().join('|')===FP.normalizeRecordedValue(d,b).slice().sort().join('|');if(k==='number'){const aa=Number(FP.normalizeNumber(a)),bb=Number(FP.normalizeNumber(b));if(Number.isFinite(aa)&&Number.isFinite(bb))return Math.abs(aa-bb)<1e-9;}return JSON.stringify(FP.normalizeRecordedValue(d,a))===JSON.stringify(FP.normalizeRecordedValue(d,b))};
  FP.getRecordings=async()=>{const d=await chrome.storage.local.get(FP.STORAGE_KEY);const raw=d[FP.STORAGE_KEY]||{};const out={};let changed=false;for(const [id,r] of Object.entries(raw)){const next=FP.normalizeRecordingSchema(r);if(JSON.stringify(next)!==JSON.stringify(r))changed=true;out[id]=next}if(changed)await chrome.storage.local.set({[FP.STORAGE_KEY]:out});return out};
  const MAX_RECORDINGS=1000,MAX_STEPS=500,MAX_VALUE_CHARS=10000;
  FP.saveRecordings=async r=>{
    if(!r||typeof r!=='object')throw new Error('Invalid recordings');
    // Storage guard: Currency/Percent controls can have been recorded while their
    // HTML input looked like text. Once the target metadata says Currency/Percent,
    // never persist display formatting ($1.00 / 1.00%); store only the numeric token.
    const sanitized={};
    for(const [id,recording] of Object.entries(r)){
      const copy=recording&&typeof recording==='object'?JSON.parse(JSON.stringify(recording)):recording;
      if(Array.isArray(copy?.steps)){
        copy.steps=copy.steps.map(step=>{
          if(!step||typeof step!=='object')return step;
          const target=step.target||{};
          const type=String(target.sfDataType||target.salesforceType||target.fieldType||'').toLowerCase();
          if(['currency','percent','double','int','integer','long','decimal','number'].includes(type)){
            if(step.value!==undefined)step.value=FP.normalizeNumber(step.value);
            if(step.before!==undefined)step.before=FP.normalizeNumber(step.before);
          }
          return step;
        });
      }
      sanitized[id]=copy;
    }
    for(const [id,recording] of Object.entries(sanitized)){sanitized[id]=FP.normalizeRecordingSchema(recording)}
    const values=Object.values(sanitized);
    if(values.length>MAX_RECORDINGS||!values.every(x=>x&&typeof x==='object'&&typeof x.id==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(x.id)&&Array.isArray(x.steps)&&x.steps.length<=MAX_STEPS))throw new Error('Recording data is too large or invalid.');
    return chrome.storage.local.set({[FP.STORAGE_KEY]:sanitized});
  };
  FP.getSettings=async()=>{const d=await chrome.storage.local.get(FP.SETTINGS_KEY);return{stopOnFailure:false,verifyAfterReplay:true,fillEmptyOnly:true,showOverlay:true,...(d[FP.SETTINGS_KEY]||{})}};
  FP.saveSettings=async s=>chrome.storage.local.set({[FP.SETTINGS_KEY]:s});
  FP.makeRecordingName=c=>c?.objectApiName||'Salesforce recording';
  self.ForcePilotShared=FP;
})();
