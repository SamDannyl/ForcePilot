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
  FP.STORAGE_KEY='forcepilot.recordings.v1';
  FP.SETTINGS_KEY='forcepilot.settings.v1';
  const metadataState={version:null,versionAt:0,objectCache:new Map(),recordCache:new Map(),fieldMetadata:new Map(),metadataLabelMap:new Map(),objectApiName:null,recordId:null};
  let rootsCache=null, rootsCacheAt=0, candidatesCache=null, candidatesCacheAt=0, fieldRevision=0;
  const descriptorCache=new WeakMap();

  FP.normalizeText=v=>String(v??'').replace(/\s+/g,' ').trim();
  FP.normalizeLabel=v=>FP.normalizeText(v).toLowerCase().replace(/[\u200b\u00a0]/g,' ');
  FP.normalizeNumber=v=>{if(v===null||v===undefined)return '';const raw=String(v).trim();if(!raw)return '';const negative=/^\s*\(.*\)\s*$/.test(raw)||/^\s*-/.test(raw);const m=raw.replace(/,/g,'').match(/\d+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);if(!Number.isFinite(n))return '';const out=Number.isInteger(n)?String(Math.trunc(n)):String(n);return negative&&n!==0?`-${out}`:out};
  FP.normalizeBoolean=v=>typeof v==='boolean'?v:['true','1','yes','y','on','checked'].includes(String(v??'').trim().toLowerCase());
  FP.normalizeDate=v=>{const s=String(v??'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;const m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);return m?`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`:s.slice(0,10)};
  FP.normalizeDateTime=v=>{const s=String(v??'').trim();if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(s))return s.slice(0,16);const d=new Date(s);return Number.isNaN(d.getTime())?s:new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
  FP.normalizeTime=v=>{const s=String(v??'').trim(),m=s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);if(!m)return s;let h=+m[1];if(m[4]?.toUpperCase()==='PM'&&h<12)h+=12;if(m[4]?.toUpperCase()==='AM'&&h===12)h=0;return `${String(h).padStart(2,'0')}:${m[2]}:${m[3]||'00'}`};
  FP.parseMultiValues=v=>[...new Set(String(v??'').split(/\s*;\s*|\s*,\s*/).map(FP.normalizeText).filter(Boolean))];

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
  FP.logicalComponentHost=node=>{const hosts=FP.collectComponentHosts(node);const tags=new Set(['lightning-input-field','lightning-input','lightning-combobox','lightning-textarea','lightning-record-picker','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-base-combobox']);const field=hosts.find(h=>String(h.tagName||'').toLowerCase()==='lightning-input-field');if(field)return field;return hosts.find(h=>tags.has(String(h.tagName||'').toLowerCase())||h.matches?.('[data-sf-field],[data-sf-address]'))||null};
  FP.fieldRoot=node=>{if(!node)return null;const hosts=FP.collectComponentHosts(node);const directField=hosts.find(h=>String(h.tagName||'').toLowerCase()==='lightning-input-field');if(directField)return directField;const tags=new Set(['lightning-input','lightning-combobox','lightning-textarea','lightning-record-picker','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-base-combobox']);return hosts.find(h=>tags.has(String(h.tagName||'').toLowerCase())||h.matches?.('[data-sf-field],[data-sf-address]'))||node};
  FP.isRedundantNativeControl=node=>!!node&&/^(input|textarea|select|button)$/i.test(String(node.tagName||''))&&!!FP.logicalComponentHost(node);

  FP.resolveFieldLabel=(host,element)=>{const explicit=[host?.getAttribute?.('field-label'),host?.getAttribute?.('label'),host?.getAttribute?.('data-label'),host?.getAttribute?.('data-sf-label'),element?.getAttribute?.('aria-label')?.split(',')[0],element?.getAttribute?.('title')].find(v=>v&&String(v).trim());if(explicit)return FP.normalizeText(explicit).replace(/\s*\*\s*$/,'');const id=element?.id;if(id){for(const root of FP.walkRoots()){try{const l=root.querySelector?.(`label[for="${CSS.escape(id)}"]`);if(l?.textContent?.trim())return FP.normalizeText(l.textContent)}catch{}}}for(const base of [element?.parentElement,host,host?.parentElement].filter(Boolean)){try{const c=base.matches?.('.slds-form-element,.form-element,[data-field],[data-sf-field],[data-sf-address]')?base:base.closest?.('.slds-form-element,.form-element,[data-field],[data-sf-field],[data-sf-address]');const l=c?.querySelector?.(':scope > .slds-form-element__label,label,.labelCol');if(l?.textContent?.trim())return FP.normalizeText(l.textContent)}catch{}}const deep=FP.deepQueryFirst(host,'label,.slds-form-element__label,.labelCol,[data-label]');if(deep?.textContent?.trim())return FP.normalizeText(deep.textContent);const ph=element?.getAttribute?.('placeholder');return ph?FP.normalizeText(ph).replace(/\s*\*\s*$/,''):''};
  FP.controlForField=host=>{if(!host)return null;const tag=String(host.tagName||'').toLowerCase();if(/^(input|textarea|select)$/i.test(tag))return host;for(const s of ['button[role="combobox"]','input[role="combobox"]','input:not([type=hidden])','textarea','select','[contenteditable="true"]','[role="spinbutton"]','[role="textbox"]','button[role="checkbox"]','[role="checkbox"]']){const f=FP.deepQueryFirst(host,s);if(f)return f}return null};
  FP.semanticKindFromSalesforceType=t=>{t=String(t||'').toLowerCase();if(t==='multipicklist'||t==='multi-picklist')return'multi-picklist';if(t==='picklist')return'picklist';if(t==='boolean')return'boolean';if(['currency','percent','double','int','integer','long','decimal','number'].includes(t))return'number';if(t==='date')return'date';if(t==='datetime')return'datetime';if(t==='time')return'time';if(t==='email')return'email';if(t==='phone')return'phone';if(t==='url')return'url';if(['textarea','longtextarea','richtext'].includes(t))return'longText';if(t==='reference')return'lookup';return''};
  FP.canonicalFieldType=d=>{const exact=String(d?.sfDataType||'').toLowerCase();if(exact&&!['text','string','field','input'].includes(exact))return exact;const k=String(d?.kind||'').toLowerCase();return({'multi-picklist':'multipicklist','picklist':'picklist','boolean':'boolean','number':'number','date':'date','datetime':'datetime','time':'time','lookup':'reference','longtext':'textarea','email':'email','phone':'phone','url':'url','address':'address'}[k]||'text')};
  FP.isLikelyLookupField=(host,el)=>{if(!host&&!el)return false;const h=String(host?.tagName||'').toLowerCase(),api=String(host?.getAttribute?.('field-name')||host?.getAttribute?.('data-field-name')||host?.getAttribute?.('name')||'');const explicit=[host?.getAttribute?.('data-field-type'),host?.getAttribute?.('field-type'),host?.getAttribute?.('data-sf-type'),el?.getAttribute?.('data-field-type'),el?.getAttribute?.('field-type'),el?.getAttribute?.('data-sf-type')].filter(Boolean).join(' ').toLowerCase();if(h==='lightning-record-picker'||/lookup|reference|record-picker/.test(explicit))return true;const nestedTags=FP.deepQueryFirst(host,'lightning-record-picker,lightning-lookup,records-record-picker,force-record-lookup');if(nestedTags)return true;const role=String(el?.getAttribute?.('role')||'').toLowerCase();const auto=String(el?.getAttribute?.('aria-autocomplete')||'').toLowerCase();if((role==='combobox'||el?.getAttribute?.('aria-haspopup')==='listbox')&&auto==='list'&&/(?:^|_)id$/i.test(api))return true;return false};
  FP.controlKind=(host,el)=>{const tag=String(host?.tagName||'').toLowerCase(),role=String(el?.getAttribute?.('role')||host?.getAttribute?.('role')||'').toLowerCase();if(FP.isLikelyLookupField(host,el))return'lookup';if(tag==='lightning-record-picker')return'lookup';if(tag==='lightning-dual-listbox')return'multi-picklist';if(/^(lightning-combobox|lightning-base-combobox)$/.test(tag))return'picklist';if(tag==='lightning-input-address'||host?.hasAttribute?.('data-sf-address'))return'address';if(tag==='lightning-input-field'&&(FP.deepQueryFirst(host,'lightning-dual-listbox')||FP.deepQueryFirst(host,'select[multiple]')||FP.deepQueryFirst(host,'[aria-multiselectable="true"]')))return'multi-picklist';if(tag==='lightning-input-field'&&(FP.deepQueryFirst(host,'button[role="combobox"]')||FP.deepQueryFirst(host,'input[role="combobox"]')||FP.deepQueryFirst(host,'lightning-combobox')||FP.deepQueryFirst(host,'lightning-base-combobox')))return'picklist';if(role==='combobox'||el?.getAttribute?.('aria-haspopup')==='listbox')return'picklist';if(el?.type==='checkbox'||role==='checkbox')return'boolean';if(el?.type==='date')return'date';if(el?.type==='datetime-local')return'datetime';if(el?.type==='time')return'time';if(el?.multiple===true)return'multi-picklist';if(el?.type==='number')return'number';if(el?.type==='email')return'email';if(el?.type==='tel')return'phone';return'field'};
  FP.isDisabled=(h,e)=>!!(e?.disabled||e?.getAttribute?.('aria-disabled')==='true'||h?.disabled===true||h?.getAttribute?.('aria-disabled')==='true');
  FP.isReadOnly=(h,e)=>!!(e?.readOnly||e?.getAttribute?.('aria-readonly')==='true'||h?.readOnly===true||h?.getAttribute?.('aria-readonly')==='true');
  FP.isNoiseField=f=>/^(search|search this list|quick find|global search|password|token|secret|verification code|security code)$/i.test(FP.normalizeText(f?.label));
  FP.chooseStableFieldKey=({apiName,name,label})=>apiName&&!/(^|[-_])(?:input|combobox|button|field|textbox)[-_]?[a-z0-9]{8,}$/i.test(apiName)&&!/^[0-9a-z]{20,}$/i.test(apiName)?`api:${apiName}`:name&&!/^[0-9a-z]{20,}$/i.test(name)?`name:${name}`:`label:${FP.normalizeLabel(label)}`;

  async function getApiVersion(){if(metadataState.version&&Date.now()-metadataState.versionAt<1800000)return metadataState.version;try{const r=await fetch('/services/data/',{credentials:'include',cache:'no-store'});if(r.ok){const arr=await r.json();const nums=Array.isArray(arr)?arr.map(v=>Number(v.version)).filter(Number.isFinite):[];if(nums.length){metadataState.version=Math.max(...nums).toFixed(1);metadataState.versionAt=Date.now();return metadataState.version}}}catch{}return null}
  function normalizeDescribeField(f){if(!f)return null;const type=String(f.type||'').toLowerCase();return{...f,apiName:f.name,label:f.label,dataType:type==='multipicklist'?'multipicklist':type==='datetime'?'datetime':type==='currency'?'currency':type==='percent'?'percent':type,referenceTo:Array.isArray(f.referenceTo)?f.referenceTo:[],picklistValues:Array.isArray(f.picklistValues)?f.picklistValues.filter(x=>x?.active!==false).map(x=>({value:x.value, label:x.label||x.value, validFor:x.validFor})):[]};}
  FP.loadSalesforceMetadata=async(objectApiName,recordId='')=>{if(!FP.isSalesforceHost()||!objectApiName||objectApiName==='Salesforce')return null;const k=String(objectApiName);const cached=metadataState.objectCache.get(k);if(cached&&Date.now()-cached.at<600000){metadataState.fieldMetadata=new Map(Object.entries(cached.objectInfo?.fields||{}));metadataState.objectApiName=objectApiName;metadataState.recordId=recordId;return cached.objectInfo}const v=await getApiVersion();const attempts=[];if(v){attempts.push(`/services/data/v${v}/ui-api/object-info/${encodeURIComponent(objectApiName)}`);attempts.push(`/services/data/v${v}/sobjects/${encodeURIComponent(objectApiName)}/describe`);}attempts.push(`/services/data/latest/ui-api/object-info/${encodeURIComponent(objectApiName)}`);attempts.push(`/services/data/latest/sobjects/${encodeURIComponent(objectApiName)}/describe`);for(const url of attempts){try{const r=await fetch(url,{credentials:'include',cache:'no-store'});if(!r.ok)continue;const raw=await r.json();let objectInfo=raw;if(raw?.fields&&typeof raw.fields==='object'&&!Array.isArray(raw.fields)){objectInfo=raw}else if(Array.isArray(raw?.fields)){const fields={};for(const f of raw.fields){const n=normalizeDescribeField(f);if(n?.name)fields[n.name]=n}objectInfo={...raw,apiName:raw.name||objectApiName,label:raw.label||objectApiName,fields}}if(!objectInfo?.fields||typeof objectInfo.fields!=='object')continue;metadataState.objectCache.set(k,{at:Date.now(),objectInfo});metadataState.fieldMetadata=new Map(Object.entries(objectInfo.fields));metadataState.objectApiName=objectApiName;metadataState.recordId=recordId;FP.invalidateFieldCaches();return objectInfo}catch{}}return null};
  FP.loadFieldPicklistValues=async(objectApiName,recordTypeId,fieldApiName)=>{if(!FP.isSalesforceHost()||!objectApiName||!fieldApiName)return[];const v=await getApiVersion();const rt=recordTypeId||'012000000000000AAA';const urls=[];if(v)urls.push(`/services/data/v${v}/ui-api/object-info/${encodeURIComponent(objectApiName)}/picklist-values/${encodeURIComponent(rt)}/${encodeURIComponent(fieldApiName)}`);urls.push(`/services/data/latest/ui-api/object-info/${encodeURIComponent(objectApiName)}/picklist-values/${encodeURIComponent(rt)}/${encodeURIComponent(fieldApiName)}`);for(const url of urls){try{const r=await fetch(url,{credentials:'include',cache:'no-store'});if(!r.ok)continue;const data=await r.json();if(Array.isArray(data?.values))return data.values.filter(x=>x?.active!==false).map(x=>({value:x.value,displayValue:x.label||x.value,validFor:x.validFor}));}catch{}}return[]};
  FP.getFieldMetadata=api=>metadataState.fieldMetadata.get(api)||null;
  FP.resolveFieldMetadata=({apiName,name,label})=>{if(apiName&&metadataState.fieldMetadata.has(apiName))return{apiName,meta:metadataState.fieldMetadata.get(apiName)};if(name&&metadataState.fieldMetadata.has(name))return{apiName:name,meta:metadataState.fieldMetadata.get(name)};const n=FP.normalizeLabel(label);const matches=[];for(const [api,meta] of metadataState.fieldMetadata){if(FP.normalizeLabel(meta?.label)===n)matches.push({apiName:api,meta})}return matches.length===1?matches[0]:null};

  FP.readLookupId=(host,el)=>{for(const node of [host,el].filter(Boolean)){for(const a of ['data-record-id','data-recordid','data-record-id-value','data-id','record-id','data-lookup-id','data-selection-id','data-value','value']){try{const v=node.getAttribute?.(a);if(v&&/^[A-Za-z0-9]{15,18}$/.test(String(v).trim()))return String(v).trim()}catch{}}for(const prop of ['recordId','recordID','lookupId','selectedRecordId','value']){try{const v=node?.[prop];if(v&&typeof v==='string'&&/^[A-Za-z0-9]{15,18}$/.test(v.trim()))return v.trim()}catch{}}try{const nested=node.querySelector?.('[data-record-id],[data-recordid],[data-record-id-value],[data-id],[record-id],[data-lookup-id],[data-selection-id],[data-value],[aria-selected="true"] a,[aria-selected="true"]');if(nested){const x=FP.readLookupId(nested,nested);if(x)return x}}catch{}}return''};
  FP.readAddressParts=host=>{if(String(host?.tagName||'').toLowerCase()!=='lightning-input-address'&&!host?.hasAttribute?.('data-sf-address'))return null;const out={};const aliases={street:['street'],city:['city'],province:['province','state'],country:['country'],postalCode:['postalcode','postal-code','zip']};for(const [k,names] of Object.entries(aliases)){let found=null;for(const root of [host,host?.shadowRoot].filter(Boolean)){for(const n of names){for(const s of [`input[name="${n}"]`,`textarea[name="${n}"]`,`[data-field-name="${n}"]`,`[data-name="${n}"]`,`[data-address-part="${k}"]`,`[autocomplete*="${n}"]`]){try{found=root.querySelector?.(s);if(found)break}catch{}}if(found)break}if(found)break}if(found){const v=FP.normalizeText(found.value??found.textContent);if(v)out[k]=v}}return Object.keys(out).length?out:null};
  FP.readMultiSelectValue=d=>{
    const host=d?.host||d,el=d?.element||FP.controlForField(host);
    const clean=arr=>[...new Set((arr||[]).map(FP.normalizeText).filter(v=>v&&!FP.isMultiPicklistPlaceholder(v)))];
    if(el?.tagName?.toLowerCase()==='select'&&el.multiple)return clean([...el.selectedOptions].map(o=>o.value||o.textContent)).join('; ');
    const dual=host?.tagName?.toLowerCase()==='lightning-dual-listbox'?host:FP.deepQueryFirst(host,'lightning-dual-listbox');
    if(dual){
      const lists=[];
      for(const root of [dual,...FP.walkRoots()]){try{root.querySelectorAll?.('[role=\"listbox\"],.slds-dueling-list__options,[aria-multiselectable=\"true\"],ul.slds-listbox')?.forEach(x=>lists.push(x));}catch{}}
      const unique=[...new Set(lists)];
      const describe=list=>{let hints='';try{hints=[list.getAttribute?.('aria-label'),list.getAttribute?.('title'),list.parentElement?.getAttribute?.('aria-label'),list.parentElement?.getAttribute?.('title')].filter(Boolean).join(' ').toLowerCase();list.parentElement?.querySelectorAll?.('label,.slds-dueling-list__label,.slds-form-element__label,.slds-listbox__label,[class*=label]')?.forEach(x=>{const t=FP.normalizeText(x.textContent);if(t&&t.length<80)hints+=' '+t.toLowerCase();});}catch{}return hints};
      const candidates=unique.map(list=>({list,hints:describe(list),options:FP.deepQueryAll(list,'[role=\"option\"],option,[data-value]',240).map(o=>{const value=FP.normalizeText(o.getAttribute?.('data-value')||o.getAttribute?.('value')||o.value||o.textContent||'');const label=FP.normalizeText(o.getAttribute?.('data-label')||o.getAttribute?.('label')||o.getAttribute?.('title')||o.textContent||'');if(!value&&!label||FP.isMultiPicklistPlaceholder(value)||FP.isMultiPicklistPlaceholder(label))return null;return{value:value||label,label:label||value,el:o};}).filter(Boolean)})).filter(x=>/\bselected\b|\bchosen\b|\bcurrent\b/.test(x.hints)||/\bavailable\b|\bsource\b/.test(x.hints)||x.options.length);
      let selectedList=candidates.find(x=>/\bselected\b|\bchosen\b|\bcurrent\b/.test(x.hints));
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
  FP.readValue=d=>{const host=d?.host||d,el=d?.element||FP.controlForField(host),kind=d?.kind||FP.controlKind(host,el);if(kind==='address')return FP.readAddressParts(host)||{};if(kind==='boolean'){if(el?.type==='checkbox')return!!el.checked;return(el?.getAttribute?.('aria-checked')||host?.getAttribute?.('aria-checked'))==='true'}if(kind==='multi-picklist')return FP.readMultiSelectValue(d);if(kind==='lookup')return{displayValue:FP.normalizeText(el?.dataset?.lookupLabel||el?.value||el?.textContent||host?.value||''),recordId:FP.readLookupId(host,el)||el?.dataset?.lookupId||''};if(kind==='picklist'){const raw=el?.value!==undefined&&el.value!==''?el.value:(el?.getAttribute?.('data-value')||host?.getAttribute?.('data-value')||'');if(raw)return FP.isPicklistPlaceholder(raw)?'':raw;const sel=FP.deepQueryFirst(host,'[role="option"][aria-selected="true"],option:checked');if(sel){const v=sel.value||FP.normalizeText(sel.textContent);return FP.isPicklistPlaceholder(v)?'':v}const text=FP.normalizeText(el?.textContent||host?.textContent);return FP.isPicklistPlaceholder(text)?'':text}if(el?.value!==undefined)return el.value;if(host?.value!==undefined&&host.value!==null&&typeof host.value!=='object')return host.value;return FP.normalizeText(el?.textContent||host?.textContent)};
  FP.isPicklistPlaceholder=v=>{const s=FP.normalizeLabel(v).replace(/[–—]/g,'-').replace(/\s+/g,' ');return !s||['-none-','--none--','select','select an option','choose','choose an option','select option','--select--'].includes(s)}; FP.isMultiPicklistPlaceholder=v=>{const s=FP.normalizeLabel(v).replace(/[–—]/g,'-').replace(/\s+/g,' ');return !s||['-none-','--none--','no selection','select','select an option','choose','choose an option','select option','--select--'].includes(s)};
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

  FP.describeField=host0=>{
    if(!host0)return null;
    const host=FP.fieldRoot(host0)||host0;
    const cached=descriptorCache.get(host);
    if(cached?.revision===fieldRevision)return cached.descriptor;
    const el=FP.controlForField(host),label=FP.resolveFieldLabel(host,el);if(!label)return null;
    const tag=String(host.tagName||'').toLowerCase();const rawApi=host.getAttribute?.('field-name')||host.getAttribute?.('fieldName')||host.getAttribute?.('data-field-name')||host.getAttribute?.('data-field')||host.getAttribute?.('data-sf-field')||el?.getAttribute?.('data-field-name')||el?.getAttribute?.('data-sf-field')||el?.name||null;const name=el?.getAttribute?.('name')||host.getAttribute?.('name')||null;const resolved=FP.resolveFieldMetadata({apiName:rawApi,name,label});const meta=resolved?.meta||null,apiName=resolved?.apiName||rawApi||name||null;const explicitFieldType=String(host.getAttribute?.('data-field-type')||host.getAttribute?.('field-type')||el?.getAttribute?.('data-field-type')||el?.getAttribute?.('field-type')||host.getAttribute?.('data-sf-type')||el?.getAttribute?.('data-sf-type')||'').toLowerCase();const formatterCandidates=[];for(const n of [host,el,...FP.collectComponentHosts(host)]){for(const a of ['formatter','data-formatter','data-field-formatter','data-sf-type']){try{const v=n?.getAttribute?.(a);if(v)formatterCandidates.push(String(v).toLowerCase())}catch{} }for(const p of ['formatter','fieldType','dataType','type']){try{const v=n?.[p];if(typeof v==='string')formatterCandidates.push(v.toLowerCase())}catch{}}}const formatter=formatterCandidates.find(v=>['currency','percent','date','datetime','time','number','double','integer','int','long','picklist','multipicklist','boolean'].includes(v))||'';let visualType='';try{const addon=FP.deepQueryFirst(host,'.slds-form-element__addon,[data-formatter],span[title*="percent" i],span[title*="currency" i]');const txt=FP.normalizeText(addon?.textContent||addon?.getAttribute?.('title')||'');if(/percent|%/.test(txt))visualType='percent';else if(/currency|[$€£¥₹]/.test(txt))visualType='currency';const dateButton=FP.deepQueryFirst(host,'button[title*="date" i],[aria-label*="select a date" i]');if(dateButton)visualType='date';}catch{}const behavioralType=FP.inferFormattedNumericType(host,el);const inferredDomType=visualType||formatter||behavioralType||((el?.type||'').toLowerCase()!=='text'?String(el?.type||'').toLowerCase():'');const metadataReference=Array.isArray(meta?.referenceTo)&&meta.referenceTo.length>0;const domReference=FP.isLikelyLookupField(host,el)||tag==='lightning-record-picker'||/reference|lookup|record-picker/.test(explicitFieldType);const authoritativeType=String(meta?.dataType||explicitFieldType||inferredDomType||'').toLowerCase();const referenceSemantic=authoritativeType==='reference'||metadataReference||domReference;const semantic=FP.semanticKindFromSalesforceType(authoritativeType),dom=FP.controlKind(host,el),kind=referenceSemantic?'lookup':(semantic||dom);const reference=referenceSemantic||kind==='lookup';const multi=!reference&&(kind==='multi-picklist'||authoritativeType==='multipicklist'||el?.multiple===true||tag==='lightning-dual-listbox');let options=[];if(kind==='picklist'||multi||el?.tagName==='SELECT'){const live=FP.readOptions(host,el);options=live.length?live:(Array.isArray(meta?.picklistValues)?meta.picklistValues.filter(o=>o?.active!==false).map(o=>({value:o.value,displayValue:o.label||o.value})):[])}const exactType=authoritativeType||({date:'date',datetime:'datetime',time:'time',number:'number',boolean:'boolean','multi-picklist':'multipicklist',picklist:'picklist',lookup:'reference'}[kind]||'');const d={key:FP.chooseStableFieldKey({apiName,name,label}),label:FP.normalizeText(meta?.label||label),apiName:apiName||undefined,name:name||undefined,type:exactType||kind,kind:reference?'lookup':kind,reference,multiSelect:multi,referenceObject:meta?.referenceTo?.[0],referenceId:FP.readLookupId(host,el)||undefined,host,element:el,options,readOnly:FP.isReadOnly(host,el),disabled:FP.isDisabled(host,el),sfDataType:exactType||undefined,metadataBacked:!!meta,updateable:meta?.updateable!==false,createable:meta?.createable!==false,required:meta?.required===true,addressParts:FP.readAddressParts(host)||undefined,scale:meta?.scale,length:meta?.length};
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
    const wrappers=['lightning-input-field','lightning-input','lightning-combobox','lightning-textarea','lightning-record-picker','lightning-dual-listbox','lightning-input-address','lightning-timepicker','lightning-base-combobox','[data-sf-field]','[data-sf-address]'];const natives=['input:not([type=hidden])','textarea','select','[contenteditable="true"]'];const out=[],seen=new Set();const add=h=>{if(!h||FP.isRedundantNativeControl(h))return;const d=FP.describeField(h);if(!d||!d.label||FP.isNoiseField(d)||seen.has(d.key))return;seen.add(d.key);out.push(d)};for(const root of FP.walkRoots()){for(const s of wrappers)try{root.querySelectorAll?.(s)?.forEach(add)}catch{}}for(const root of FP.walkRoots()){for(const s of natives)try{root.querySelectorAll?.(s)?.forEach(add)}catch{}}candidatesCache=out;candidatesCacheAt=now;return out;
  };
  FP.findDescriptorFromEvent=e=>{const path=typeof e?.composedPath==='function'?e.composedPath():[e?.target];for(const n of path){if(!n||n.nodeType!==1||n.id==='forcepilot-root')continue;const tag=String(n.tagName||'').toLowerCase();if(n.matches?.('lightning-input-field,[data-sf-field],[data-sf-address]')){const d=FP.describeField(n);if(d)return d}if(/^(input|textarea|select)$/.test(tag)||n.isContentEditable||n.matches?.('lightning-input,lightning-combobox,lightning-dual-listbox,lightning-record-picker,lightning-textarea,lightning-timepicker,lightning-base-combobox')){const h=/^(input|textarea|select)$/.test(tag)?(FP.logicalComponentHost(n)||n):n;const d=FP.describeField(h);if(d)return d}}return null};
  FP.normalizeRecordedValue=(d,v)=>{const k=d?.kind;if(k==='boolean')return FP.normalizeBoolean(v);if(k==='number')return FP.normalizeNumber(v);if(k==='date')return FP.normalizeDate(v);if(k==='datetime')return FP.normalizeDateTime(v);if(k==='time')return FP.normalizeTime(v);if(k==='multi-picklist')return Array.isArray(v)?v.map(FP.normalizeText).filter(Boolean):FP.parseMultiValues(v);if(k==='lookup'){const x=v&&typeof v==='object'?v:{displayValue:String(v??''),recordId:''};return{displayValue:FP.normalizeText(x.displayValue),recordId:String(x.recordId||'')}}if(k==='address')return v&&typeof v==='object'?{...v}:{};return v==null?'':String(v)};
  FP.valuesEqual=(d,a,b)=>{const k=d?.kind;if(k==='multi-picklist')return FP.normalizeRecordedValue(d,a).slice().sort().join('|')===FP.normalizeRecordedValue(d,b).slice().sort().join('|');if(k==='number'){const aa=Number(FP.normalizeNumber(a)),bb=Number(FP.normalizeNumber(b));if(Number.isFinite(aa)&&Number.isFinite(bb))return Math.abs(aa-bb)<1e-9;}return JSON.stringify(FP.normalizeRecordedValue(d,a))===JSON.stringify(FP.normalizeRecordedValue(d,b))};
  FP.getRecordings=async()=>{const d=await chrome.storage.local.get(FP.STORAGE_KEY);return d[FP.STORAGE_KEY]||{}};
  const MAX_RECORDINGS=1000,MAX_STEPS=500,MAX_VALUE_CHARS=10000,MAX_STORAGE_BYTES=5*1024*1024;
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
    const values=Object.values(sanitized);
    if(values.length>MAX_RECORDINGS||!values.every(x=>x&&typeof x==='object'&&typeof x.id==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(x.id)&&Array.isArray(x.steps)&&x.steps.length<=MAX_STEPS))throw new Error('Recording data is too large or invalid.');
    const bytes=new TextEncoder().encode(JSON.stringify(sanitized)).byteLength;if(bytes>MAX_STORAGE_BYTES)throw new Error('Saved recordings are too large. Remove some recordings and try again.');
    return chrome.storage.local.set({[FP.STORAGE_KEY]:sanitized});
  };
  FP.getSettings=async()=>{const d=await chrome.storage.local.get(FP.SETTINGS_KEY);return{stopOnFailure:false,verifyAfterReplay:true,fillEmptyOnly:true,showOverlay:true,...(d[FP.SETTINGS_KEY]||{})}};
  FP.saveSettings=async s=>chrome.storage.local.set({[FP.SETTINGS_KEY]:s});
  FP.makeRecordingName=c=>c?.objectApiName||'Salesforce recording';
  self.ForcePilotShared=FP;
})();
