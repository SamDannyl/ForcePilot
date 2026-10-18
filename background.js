/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

const LOCK_KEY = 'forcepilot.recording.locks.v2';
const PANEL_STATE_KEY = 'forcepilot.sidepanel.open.v1';
const injectionFlights = new Map();
const injectedFrameSignatures = new Map();
const multiFrameProgressByTab = new Map();
const openPanelTabs = new Set();
const forcePilotPanelPorts = new Map();
let lockMutation = Promise.resolve();
const withLockMutation = fn => {
  const run = lockMutation.then(fn, fn);
  lockMutation = run.catch(() => {});
  return run;
};

const FP_SETTINGS_KEY='forcepilot.settings.v1';
const FP_SF_SUFFIXES=['salesforce.com','lightning.force.com','my.salesforce.com','visualforce.com','vf.force.com','force.com','site.com','salesforce-sites.com','salesforce-communities.com','salesforce-setup.com','salesforce-experience.com','salesforce.app','forceusercontent.com','force-user-content.com','salesforce-scrt.com'];
let customExperienceDomains=new Set();
let customDomainsLoaded=false,customDomainsLoadPromise=null;
function cleanCustomDomain(value){
  let host=String(value||'').trim().toLowerCase();
  host=host.replace(/^https?:\/\//,'').split(/[\/?#]/)[0].replace(/^\*\./,'').replace(/:\d+$/,'').replace(/\.$/,'');
  if(!host||host.length>253||!host.includes('.')||!host.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))return'';
  return host;
}
async function refreshCustomExperienceDomains(force=false){
  if(customDomainsLoaded&&!force)return customExperienceDomains;
  if(customDomainsLoadPromise&&!force)return customDomainsLoadPromise;
  customDomainsLoadPromise=(async()=>{
    try{
      const d=await chrome.storage.local.get(FP_SETTINGS_KEY);const raw=d?.[FP_SETTINGS_KEY]?.experienceCloudDomains;
      const list=Array.isArray(raw)?raw:(typeof raw==='string'?raw.split(/[\r\n,;]+/):[]);
      customExperienceDomains=new Set(list.map(cleanCustomDomain).filter(Boolean));
    }catch{}
    customDomainsLoaded=true;customDomainsLoadPromise=null;return customExperienceDomains;
  })();
  return customDomainsLoadPromise;
}
void refreshCustomExperienceDomains();
chrome.storage?.onChanged?.addListener?.((changes,area)=>{if(area==='local'&&changes?.[FP_SETTINGS_KEY])void refreshCustomExperienceDomains(true);});
function isSalesforceHostName(host){
  const h=String(host||'').toLowerCase();
  if(FP_SF_SUFFIXES.some(s=>h===s||h.endsWith('.'+s)))return true;
  for(const custom of customExperienceDomains){if(h===custom||h.endsWith('.'+custom))return true;}
  return false;
}
function isSalesforceUrl(url=''){
  try{const u=new URL(url);return u.protocol==='https:'&&isSalesforceHostName(u.hostname)}catch{return false;}
}
function isRelatedFrameUrl(url='') { return /^(?:about:blank|about:srcdoc|blob:|data:|filesystem:)/i.test(String(url||'')); }
function normalizedFrameUrl(url='', inheritedOrigin=''){
  try{const u=new URL(url);if(u.origin&&u.origin!=='null')return{origin:u.origin,pathname:u.pathname||'/',host:u.hostname||''};}catch{}
  if(inheritedOrigin){try{const u=new URL(inheritedOrigin);return{origin:u.origin,pathname:'/',host:u.hostname||''}}catch{}}
  return{origin:'',pathname:'/',host:''};
}
function buildFramePath(frame,byId,seen=new Set()){
  if(!frame||seen.has(frame.frameId))return[];
  seen.add(frame.frameId);
  const parent=byId.get(frame.parentFrameId);
  const prefix=parent?buildFramePath(parent,byId,seen):[];
  const parsed=normalizedFrameUrl(frame.url, parent?.url?normalizedFrameUrl(parent.url).origin:'');
  const piece=`${parsed.origin||parsed.host||'related'}${isRelatedFrameUrl(frame.url)?':'+String(frame.url).split(':')[0]:parsed.pathname}`;
  return [...prefix,piece];
}
async function getSalesforceFrames(tabId){
  await refreshCustomExperienceDomains();
  const tab=await chrome.tabs.get(tabId).catch(()=>null);if(!tab?.id)return[];
  let frames=[];
  try{frames=await chrome.webNavigation.getAllFrames({tabId})||[]}catch{}
  if(!frames.length)frames=[{frameId:0,parentFrameId:-1,url:tab.url||'',documentId:''}];
  const byId=new Map(frames.map(f=>[f.frameId,f]));
  const cache=new Map();
  const eligible=f=>{
    if(cache.has(f.frameId))return cache.get(f.frameId);
    let ok=isSalesforceUrl(f.url||'');
    if(!ok&&isRelatedFrameUrl(f.url||'')){
      const parent=byId.get(f.parentFrameId);
      ok=!!parent&&(isSalesforceUrl(parent.url||'')||eligible(parent));
    }
    cache.set(f.frameId,ok);return ok;
  };
  for(const f of frames)eligible(f);
  const result=frames.filter(f=>cache.get(f.frameId)).map(f=>{
    const parent=byId.get(f.parentFrameId);const p=normalizedFrameUrl(f.url,parent?.url?normalizedFrameUrl(parent.url).origin:'');
    return{frameId:Number(f.frameId||0),parentFrameId:Number(f.parentFrameId??-1),documentId:String(f.documentId||''),url:String(f.url||''),origin:p.origin,pathname:p.pathname,host:p.host,framePath:buildFramePath(f,byId).join(' > '),customExperienceFrame:!!p.host&&!FP_SF_SUFFIXES.some(s=>p.host===s||p.host.endsWith('.'+s))};
  });
  if(!result.some(f=>f.frameId===0)&&isSalesforceUrl(tab.url||'')){
    const p=normalizedFrameUrl(tab.url);result.unshift({frameId:0,parentFrameId:-1,documentId:'',url:tab.url,origin:p.origin,pathname:p.pathname,host:p.host,framePath:`${p.origin}${p.pathname}`,customExperienceFrame:!FP_SF_SUFFIXES.some(s=>p.host===s||p.host.endsWith('.'+s))});
  }
  return result;
}
function frameMetadata(frame){return{frameId:frame.frameId,parentFrameId:frame.parentFrameId,url:frame.url,origin:frame.origin,pathname:frame.pathname,framePath:frame.framePath};}
async function injectIntoFrame(tabId,frame){
  const target={tabId,frameIds:[frame.frameId]};
  const ping=await chrome.tabs.sendMessage(tabId,{type:'GET_CONTEXT'},{frameId:frame.frameId}).catch(()=>null);
  if(ping)return{ok:true,context:ping,injected:false,frame};
  try{
    if(frame.customExperienceFrame||isRelatedFrameUrl(frame.url)){
      const marker=()=>{window.__FORCEPILOT_CUSTOM_EXPERIENCE_DOMAIN__=true;};
      await chrome.scripting.executeScript({target,func:marker,world:'MAIN'}).catch(()=>{});
      await chrome.scripting.executeScript({target,func:marker,world:'ISOLATED'}).catch(()=>{});
    }
    await chrome.scripting.executeScript({target,files:['page_bridge.js'],world:'MAIN'});
    await chrome.scripting.executeScript({target,files:['src/shared.js','src/content.js'],world:'ISOLATED'});
  }catch(e){return{ok:false,code:'INJECT_FAILED',message:String(e?.message||'Could not inject ForcePilot into this Salesforce frame.'),frame};}
  const ctx=await chrome.tabs.sendMessage(tabId,{type:'GET_CONTEXT'},{frameId:frame.frameId}).catch(()=>null);
  return ctx?{ok:true,context:ctx,injected:true,frame}:{ok:false,code:'NO_RECEIVER',message:'ForcePilot could not connect to this Salesforce frame.',frame};
}
async function ensureContentScripts(tabId){
  if(injectionFlights.has(tabId)) return injectionFlights.get(tabId);
  const flight=(async()=>{
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(!tab?.id || !(isSalesforceUrl(tab.url||'')|| (await getSalesforceFrames(tabId)).length)) return {ok:false,code:'SALESFORCE_ONLY'};
    const frames=await getSalesforceFrames(tabId);
    if(!frames.length)return{ok:false,code:'SALESFORCE_ONLY'};
    const signature=frames.map(f=>`${f.frameId}:${f.documentId}:${f.url}`).join('\n');
    const cached=injectedFrameSignatures.get(tabId);
    if(cached?.signature===signature){
      return{ok:true,context:cached.context||null,injected:false,cached:true,frames:[]};
    }
    const results=await Promise.all(frames.map(frame=>injectIntoFrame(tabId,frame)));
    const top=results.find(x=>x.frame?.frameId===0&&x.ok)||results.find(x=>x.ok);
    if(top&&results.every(x=>x.ok))injectedFrameSignatures.set(tabId,{signature,context:top.context,at:Date.now()});
    else injectedFrameSignatures.delete(tabId);
    return top?{ok:true,context:top.context,injected:results.some(x=>x.injected),frames:results}:{ok:false,code:'NO_RECEIVER',message:results.find(x=>x.message)?.message||'ForcePilot could not connect to this Salesforce page. Refresh the page and try again.',frames:results};
  })();
  injectionFlights.set(tabId,flight);
  try{return await flight;}finally{if(injectionFlights.get(tabId)===flight)injectionFlights.delete(tabId);}
}
async function sendFrameMessage(tabId,frameId,message){
  return chrome.tabs.sendMessage(tabId,message,{frameId}).catch(()=>null);
}
async function resolveRecordedFrame(tabId,step,frames){
  const meta=step?.frame||step?.meta?.frame||null;
  if(meta){
    const normalizePath=value=>String(value||'/').replace(/\/[A-Za-z0-9]{15,18}(?=\/|$)/g,'/:recordId').replace(/\/+$/,'')||'/';
    const sameOrigin=f=>!meta.origin||f.origin===meta.origin;
    const normalizedPath=normalizePath(meta.pathname);
    const normalizedFramePath=normalizePath(meta.framePath);
    const exactPathMatch=frames.filter(f=>sameOrigin(f)&&normalizePath(f.pathname)===normalizedPath);
    if(exactPathMatch.length===1)return exactPathMatch[0];
    const pathMatch=frames.filter(f=>sameOrigin(f)&&f.framePath===meta.framePath);
    if(pathMatch.length===1)return pathMatch[0];
    const normalizedTreeMatch=frames.filter(f=>sameOrigin(f)&&normalizePath(f.framePath)===normalizedFramePath);
    if(normalizedTreeMatch.length===1)return normalizedTreeMatch[0];
    const byId=frames.find(f=>f.frameId===Number(meta.frameId));
    if(byId&&sameOrigin(byId)){
      const sameOriginFrames=frames.filter(sameOrigin);
      if(sameOriginFrames.length===1||(!meta.pathname||normalizePath(byId.pathname)===normalizedPath))return byId;
    }
    return null;
  }
  const target=step?.target;
  if(target){
    const matches=[];
    for(const f of frames){const r=await sendFrameMessage(tabId,f.frameId,{type:'RESOLVE_TARGET_FRAME',target});if(r?.ok)matches.push(f);}
    if(matches.length===1)return matches[0];
  }
  return frames.find(f=>f.frameId===0)||null;
}

function annotateFrameSteps(steps,frame,{live=false}={}){
  return(Array.isArray(steps)?steps:[]).map((step,index)=>{
    const next={...step,frame:step?.frame||frameMetadata(frame)};
    if(live){next.__fpFrameStepIndex=index;next.__fpStorageFrameId=frame.frameId;}else{delete next.__fpFrameStepIndex;delete next.__fpStorageFrameId;}
    return next;
  });
}
function stepMergeKey(step,index){
  const target=step?.target?.key||step?.target?.apiName||step?.target?.name||step?.target?.label||'';
  const frame=step?.frame?.framePath||step?.frame?.origin||'';
  // Each interaction already has a unique ID. Prefer it to a timestamp-based
  // key so rapid repeated changes to the same field are never collapsed.
  if(step?.id)return`${frame}|id:${step.id}`;
  const time=step?.meta?.recordedAt||'';
  return time?`${frame}|${target}|${time}`:`${frame}|${target}|legacy-${index}`;
}
function mergeFrameStepLists(parts,{live=false}={}){
  const all=[];const seen=new Set();
  for(const part of parts){for(let i=0;i<(part.steps||[]).length;i++){
    const step=part.steps[i];const key=stepMergeKey(step,i);
    if(seen.has(key))continue;seen.add(key);all.push({...step,__fpSortAt:Date.parse(step?.meta?.recordedAt||'')||0});
  }}
  all.sort((a,b)=>a.__fpSortAt-b.__fpSortAt||Number(a.sequence||0)-Number(b.sequence||0));
  return all.map((step,index)=>{const out={...step,sequence:index+1};delete out.__fpSortAt;if(!live)delete out.__fpFrameStepIndex;return out;});
}
const MULTIFRAME_TYPES=new Set(['GET_RECORDING_STATE','START_RECORDING','STOP_RECORDING','PAUSE_RECORDING','RESUME_RECORDING','CLEAR_PENDING_RECORDING','REMOVE_RECORDING_STEP','UPDATE_RECORDING_STEP_RANDOMIZATION','REPLAY_RECORDING','OVERWRITE_STEP','FOCUS_FIELD','GET_FIELD_DESCRIPTORS']);
async function dispatchMultiFrameRequest(tabId,message){
  await ensureContentScripts(tabId);
  const frames=await getSalesforceFrames(tabId);
  if(!frames.length)return{ok:false,code:'SALESFORCE_ONLY',message:'Open a supported Salesforce page first.'};
  const type=message?.type;
  const currentState=async()=>{
    const responses=await Promise.all(frames.map(async frame=>({frame,response:await sendFrameMessage(tabId,frame.frameId,{type:'GET_RECORDING_STATE'})})));
    const active=responses.filter(x=>x.response?.recording||x.response?.steps?.length);
    const parts=responses.filter(x=>x.response).map(x=>({steps:annotateFrameSteps(x.response.steps,x.frame,{live:true}),response:x.response,frame:x.frame}));
    const steps=mergeFrameStepLists(parts,{live:true});
    const base=responses.find(x=>x.frame.frameId===0&&x.response)||responses.find(x=>x.response);
    const routeProgress=multiFrameProgressByTab.get(tabId);
    const lookupCreation=responses.find(x=>x.response?.lookupCreation?.active)?.response?.lookupCreation||null;
    return{recording:responses.some(x=>x.response?.recording),paused:active.length>0&&active.every(x=>x.response?.paused),replaying:!!routeProgress||responses.some(x=>x.response?.replaying),steps,context:base?.response?.context||null,currentStepIndex:routeProgress?.index??Math.max(-1,...responses.map(x=>Number(x.response?.currentStepIndex??-1))),pendingRecording:base?.response?.pendingRecording||null,lookupCreation};
  };
  if(type==='GET_RECORDING_STATE')return currentState();
  if(type==='START_RECORDING'){
    const append=message.appendRecording||null;const allKeys=[...new Set((append?.steps||[]).map(s=>s?.target?.key).filter(Boolean))];
    const sharedRecordingId=message.recordingId||append?.id||`rec_${crypto.randomUUID?.()||`${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
    const sharedRecordingDate=message.recordingDate||append?.recordingDate||new Date().toISOString().slice(0,10);
    const result=await Promise.all(frames.map(async frame=>{
      // Keep only newly recorded fields in each frame's local state. The shared
      // existing recording is merged once by the coordinator at Stop.
      const frameAppend=append?{...append,steps:[]}:null;
      const payload={...message,appendRecording:frameAppend,recordingId:sharedRecordingId,recordingDate:sharedRecordingDate,multiFrame:true,appendExistingKeys:allKeys};
      const response=await sendFrameMessage(tabId,frame.frameId,payload);
      return{frame,response};
    }));
    const fails=result.filter(x=>!x.response?.ok);
    const top=result.find(x=>x.frame.frameId===0&&x.response?.ok)||result.find(x=>x.response?.ok);
    if(!top)return result.find(x=>x.response)?.response||{ok:false,message:'Could not start recording in any Salesforce frame.'};
    const steps=mergeFrameStepLists(result.filter(x=>x.response?.ok).map(x=>({steps:annotateFrameSteps(x.response.steps,x.frame,{live:true})})),{live:true});
    return{...top.response,steps,multiFrame:true,frameCount:result.filter(x=>x.response?.ok).length,frameWarnings:fails.map(x=>x.response?.message).filter(Boolean)};
  }
  if(type==='STOP_RECORDING'){
    const result=await Promise.all(frames.map(async frame=>({frame,response:await sendFrameMessage(tabId,frame.frameId,{...message,multiFrame:true})})));
    const active=result.filter(x=>x.response?.recording?.steps);
    if(!active.length)return result.find(x=>x.response?.code!=='NOT_RECORDING')?.response||{ok:false,code:'NOT_RECORDING'};
    const top=active.find(x=>x.frame.frameId===0)||active[0];
    const parts=[];
    const base=message.appendRecording&&typeof message.appendRecording==='object'?message.appendRecording:null;
    if(base){
      const topFrame=frames.find(f=>f.frameId===0)||frames[0];
      parts.push({steps:(base.steps||[]).map(step=>({...step,frame:step?.frame||frameMetadata(topFrame)}))});
    }
    for(const x of active)parts.push({steps:annotateFrameSteps(x.response.recording.steps,x.frame)});
    const merged={...(base||{}),...top.response.recording,id:base?.id||top.response.recording.id,name:base?.name||top.response.recording.name,context:{...(base?.context||{}),...(top.response.recording.context||{})},createdAt:base?.createdAt||top.response.recording.createdAt,recordingDate:base?.recordingDate||top.response.recording.recordingDate,steps:mergeFrameStepLists(parts),updatedAt:new Date().toISOString()};
    return{ok:true,recording:merged,pendingSave:true,multiFrame:true,framesRecorded:active.length};
  }
  if(type==='PAUSE_RECORDING'||type==='RESUME_RECORDING'){
    const result=await Promise.all(frames.map(async frame=>({frame,response:await sendFrameMessage(tabId,frame.frameId,message)})));
    const found=result.filter(x=>x.response?.ok);
    return found.length?{...found.find(x=>x.frame.frameId===0)?.response||found[0].response,frameCount:found.length}:{ok:false,message:'Recording is not active in any Salesforce frame.'};
  }
  if(type==='CLEAR_PENDING_RECORDING'){
    await Promise.all(frames.map(f=>sendFrameMessage(tabId,f.frameId,message)));return{ok:true};
  }
  if(type==='UPDATE_RECORDING_STEP_RANDOMIZATION'){
    const meta=message.frame||null;
    const hintedId=message.storageFrameId??message.frameId??meta?.frameId;
    const preferred=hintedId==null?null:frames.find(f=>f.frameId===Number(hintedId));
    const payload={...message,index:Number(message.localIndex??message.index),stepId:String(message.stepId||'')};
    if(preferred){const r=await sendFrameMessage(tabId,preferred.frameId,payload);if(r?.ok)return r;}
    if(payload.stepId){const fallbacks=await Promise.all(frames.filter(f=>!preferred||f.frameId!==preferred.frameId).map(async frame=>({frame,response:await sendFrameMessage(tabId,frame.frameId,payload)})));const success=fallbacks.find(x=>x.response?.ok);if(success)return success.response;}
    return{ok:false,message:'Could not find this field in the active Salesforce recording. Refresh the recording and try again.'};
  }
  if(type==='REMOVE_RECORDING_STEP'){
    const meta=message.frame||null;
    const hintedId=message.storageFrameId??message.frameId??meta?.frameId;
    const preferred=hintedId==null?null:frames.find(f=>f.frameId===Number(hintedId));
    const payload={...message,index:Number(message.localIndex??message.index),stepId:String(message.stepId||'')};
    // Unique step identity is authoritative. Try the hinted frame first, then other
    // frames; a frame only removes a step when its own local recording contains that ID.
    if(payload.stepId){
      if(preferred){const r=await sendFrameMessage(tabId,preferred.frameId,payload);if(r?.ok)return{ok:true,removedStepId:r.removedStepId||payload.stepId};}
      const fallbacks=await Promise.all(frames.filter(f=>!preferred||f.frameId!==preferred.frameId).map(async frame=>({frame,response:await sendFrameMessage(tabId,frame.frameId,payload)})));
      const success=fallbacks.find(x=>x.response?.ok);
      if(success)return{ok:true,removedStepId:success.response.removedStepId||payload.stepId};
      return{ok:false,message:'Could not find this recorded field in its original Salesforce frame. Refresh the recording and try again.'};
    }
    const frame=preferred||frames.find(f=>f.frameId===0);
    if(!frame)return{ok:false,message:'The original Salesforce frame is no longer available.'};
    const response=await sendFrameMessage(tabId,frame.frameId,payload);
    if(!response?.ok)return response||{ok:false,message:'Could not remove this recorded field.'};
    return{ok:true,removedStepId:null};
  }
  if(type==='FOCUS_FIELD'){
    const step={target:message.target,frame:message.frame||null};let frame=await resolveRecordedFrame(tabId,step,frames);
    if(frame){const r=await sendFrameMessage(tabId,frame.frameId,message);if(r?.ok)return r;if(step.frame)return{ok:false,message:'The recorded field frame is no longer available.'};}
    const results=await Promise.all(frames.map(async f=>({frame:f,response:await sendFrameMessage(tabId,f.frameId,message)})));
    return results.find(x=>x.response?.ok)?.response||{ok:false,message:'Could not locate this field in the open Salesforce frames.'};
  }
  if(type==='GET_FIELD_DESCRIPTORS'){
    const result=await Promise.all(frames.map(async frame=>({frame,response:await sendFrameMessage(tabId,frame.frameId,message)})));
    const good=result.filter(x=>x.response?.ok);
    const map=new Map();for(const x of good)for(const d of x.response.descriptors||[]){const key=`${d.resolvedTargetKey||d.targetKey||d.apiName||d.label}|${x.frame.framePath}`;if(!map.has(key))map.set(key,{...d,frame:frameMetadata(x.frame)});}
    const top=good.find(x=>x.frame.frameId===0)||good[0];return top?{...top.response,descriptors:[...map.values()]}:{ok:false,error:'Could not resolve field metadata in any Salesforce frame.'};
  }
  if(type==='OVERWRITE_STEP'){
    const recording=message.recording;const index=Number(message.index);const step=recording?.steps?.[index];if(!step)return{ok:false,executed:[]};
    const frame=await resolveRecordedFrame(tabId,step,frames);
    if(!frame)return{ok:false,code:'RECORDED_FRAME_UNAVAILABLE',message:`Could not find the Salesforce frame for ${step.target?.label||'this field'}.`,executed:[{index,step,result:{ok:false,reason:'Recorded Salesforce frame is no longer available.'}}]};
    const response=await sendFrameMessage(tabId,frame.frameId,{type:'OVERWRITE_STEP',recording:{...recording,steps:[step]},index:0,multiFrame:true});
    const executed=(response?.executed||[]).map(x=>({...x,index,step,frame:frameMetadata(frame)}));return{...response,executed,failedAt:executed.find(x=>!x.result?.ok)?.index};
  }
  if(type==='REPLAY_RECORDING'){
    const recording=message.recording;if(!recording||!Array.isArray(recording.steps))return{ok:false,executed:[],message:'Invalid recording.'};
    const only=Array.isArray(message.onlyIndexes)?new Set(message.onlyIndexes.map(Number)):null;
    const selected=recording.steps.map((step,index)=>({step,index})).filter(x=>!only||only.has(x.index)).filter(x=>x.step?.enabled!==false).sort((a,b)=>a.index-b.index);
    const settingsData=await chrome.storage.local.get(FP_SETTINGS_KEY);const settings=settingsData?.[FP_SETTINGS_KEY]||{};const stopOnFailure=message.stopOnFailure!==undefined?!!message.stopOnFailure:!!settings.stopOnFailure;
    const executed=[];const usedRandomizationValues=new Set((Array.isArray(message.usedRandomizationValues)?message.usedRandomizationValues:[]).filter(value=>typeof value==='string'));let preflight={ok:true,checked:0,missing:[],invalid:[],warnings:[],objects:[]};
    multiFrameProgressByTab.set(tabId,{index:selected[0]?.index??-1,total:selected.length,startedAt:Date.now()});
    try{
      // Resolve the frame once per field, then coalesce adjacent fields that belong
      // to the same frame. This preserves the original cross-frame execution order
      // while avoiding a full metadata/preflight/replay initialization per field.
      const chunks=[];
      // Resolve the selected fields' frames concurrently. The previous sequential
      // loop waited for a frame probe for every field before the first fill could
      // begin; older recordings without frame metadata could multiply that delay.
      // Results are consumed in selected order, so actual field execution order is
      // unchanged and adjacent fields still coalesce into frame-local chunks.
      const resolvedItems=await Promise.all(selected.map(async item=>({item,frame:await resolveRecordedFrame(tabId,item.step,frames)})));
      for(const {item,frame} of resolvedItems){
        if(!frame){
          const missing={type:'missing-frame',items:[item]};
          const prev=chunks[chunks.length-1];
          if(prev?.type==='missing-frame')prev.items.push(item);else chunks.push(missing);
          if(stopOnFailure)break;
          continue;
        }
        const prev=chunks[chunks.length-1];
        if(prev?.type==='frame'&&prev.frame.frameId===frame.frameId)prev.items.push(item);
        else chunks.push({type:'frame',frame,items:[item]});
      }
      for(const chunk of chunks){
        if(chunk.type==='missing-frame'){
          for(const item of chunk.items){
            const result={ok:false,reason:'The recorded Salesforce frame could not be found. Open the matching Setup, Visualforce, or Experience Cloud page and try again.'};
            executed.push({index:item.index,step:item.step,result});
            if(stopOnFailure)break;
          }
          if(stopOnFailure&&chunk.items.length)break;
          continue;
        }
        multiFrameProgressByTab.set(tabId,{index:chunk.items[0].index,total:selected.length,startedAt:Date.now()});
        const localSteps=chunk.items.map(x=>({...x.step,sequence:Number.isFinite(Number(x.step?.sequence))?x.step.sequence:x.index+1}));
        const localRecording={...recording,steps:localSteps};
        const response=await sendFrameMessage(tabId,chunk.frame.frameId,{
          type:'REPLAY_RECORDING',recording:localRecording,onlyIndexes:localSteps.map((_,i)=>i),startIndex:0,
          fillOnlyBlank:message.fillOnlyBlank,settings:message.settings,stopOnFailure,multiFrame:true,
          reuseGeneratedValues:message.reuseGeneratedValues,usedRandomizationValues:[...usedRandomizationValues]
        });
        for(const value of (Array.isArray(response?.usedRandomizationValues)?response.usedRandomizationValues:[]))if(typeof value==='string')usedRandomizationValues.add(value);
        const localResults=Array.isArray(response?.executed)?response.executed:[];
        const resultsByLocalIndex=new Map(localResults.map(x=>[Number(x.index),x]));
        for(let localIndex=0;localIndex<chunk.items.length;localIndex++){
          const item=chunk.items[localIndex];const entry=resultsByLocalIndex.get(localIndex);
          if(entry)executed.push({...entry,index:item.index,step:item.step,frame:frameMetadata(chunk.frame)});
          else if(localResults.length===0)executed.push({index:item.index,step:item.step,frame:frameMetadata(chunk.frame),result:{ok:false,reason:response?.message||response?.error||'No execution result was returned.'}});
          else if(localIndex<localResults.length)executed.push({index:item.index,step:item.step,frame:frameMetadata(chunk.frame),result:{ok:false,reason:response?.message||response?.error||'No execution result was returned.'}});
          // With Stop on failure enabled, a frame may intentionally omit fields after
          // the first failure. Do not label those unattempted fields as failures.
        }
        if(response?.preflight){
          const pf=response.preflight;
          preflight={...preflight,objects:[...new Set([...(preflight.objects||[]),...(pf.objects||[])])],checked:(preflight.checked||0)+(pf.checked||0),missing:[...(preflight.missing||[]),...(pf.missing||[])],invalid:[...(preflight.invalid||[]),...(pf.invalid||[])],warnings:[...(preflight.warnings||[]),...(pf.warnings||[])]};
        }
        if(localResults.some(x=>!x.result?.ok)&&stopOnFailure)break;
      }
    } finally {multiFrameProgressByTab.delete(tabId);}
    executed.sort((a,b)=>a.index-b.index);
    return{ok:!executed.some(x=>!x.result?.ok),failedAt:executed.find(x=>!x.result?.ok)?.index,executed,preflight,fillOnlyBlank:message.fillOnlyBlank,usedRandomizationValues:[...usedRandomizationValues]};
  }
  return{ok:false,message:'Unsupported multi-frame request.'};
}

async function getLocks(){try{const d=await chrome.storage.session.get(LOCK_KEY);return d[LOCK_KEY]&&typeof d[LOCK_KEY]==='object'?d[LOCK_KEY]:{};}catch{return{}}}
async function setLocks(locks){try{await chrome.storage.session.set({[LOCK_KEY]:locks});}catch{}}
const lockScope=(windowId,incognito)=>`${Number(windowId||0)}:${incognito?'incognito':'normal'}`;
async function lockOwnerIsValid(lock){if(!lock?.tabId)return false;const tab=await chrome.tabs.get(lock.tabId).catch(()=>null);return !!tab?.id&&isSalesforceUrl(tab.url||'')&&Number(tab.windowId)===Number(lock.windowId)&&!!tab.incognito===!!lock.incognito;}
async function mutateLocks(mutator){
  return withLockMutation(async()=>{
    const locks=await getLocks();
    const result=await mutator(locks);
    if(result?.changed)await setLocks(locks);
    return result?.value;
  });
}

async function getOpenPanelState(){
  try{
    const d=await chrome.storage.session.get(PANEL_STATE_KEY);
    const raw=d[PANEL_STATE_KEY];
    return raw&&typeof raw==='object'?raw:{};
  }catch{return{}}
}

async function setOpenPanelState(next){
  try{await chrome.storage.session.set({[PANEL_STATE_KEY]:next});}catch{}
}

function panelStateKey(tabId){return String(Number(tabId||0));}

async function markPanelState(tabId,isOpen){
  const id=Number(tabId||0);
  if(!id)return;
  if(isOpen) openPanelTabs.add(id);
  else openPanelTabs.delete(id);
  const state=await getOpenPanelState();
  const key=panelStateKey(id);
  if(isOpen) state[key]=Date.now();
  else delete state[key];
  await setOpenPanelState(state);
}

async function hydrateOpenPanelState(){
  const state=await getOpenPanelState();
  for(const key of Object.keys(state)){
    const id=Number(key);
    if(id>0) openPanelTabs.add(id);
  }
}
void hydrateOpenPanelState().catch(()=>{});

// The side panel owns its own close operation. A live runtime.Port tells the
// service worker that the ForcePilot panel document is actually present, without
// requiring an async "is it open?" query immediately before a keyboard command.
chrome.runtime.onConnect.addListener(port=>{
  if(port?.name!=='forcepilot-sidepanel') return;
  const presence={windowId:null};

  port.onMessage.addListener(message=>{
    if(message?.type!=='FORCEPILOT_PANEL_READY') return;
    const windowId=Number(message.windowId||0);
    if(!windowId) return;

    presence.windowId=windowId;
    const previous=forcePilotPanelPorts.get(windowId);
    if(previous && previous!==port){
      try{previous.disconnect();}catch{}
    }
    forcePilotPanelPorts.set(windowId,port);
  });

  port.onDisconnect.addListener(()=>{
    if(presence.windowId && forcePilotPanelPorts.get(presence.windowId)===port){
      forcePilotPanelPorts.delete(presence.windowId);
    }
  });
});

const TESTING_SESSIONS_KEY = 'forcepilot.testing.sessions.v2';
const TESTING_SESSIONS_INDEX_KEY = 'forcepilot.testing.sessions.index.v1';
const TESTING_UI_STATE_KEY = 'forcepilot.testing.ui-state.v1';
const TESTING_DB_NAME = 'forcepilot.testing.v1';
const TESTING_DB_VERSION = 1;
const TESTING_EVIDENCE_STORE = 'evidence';
const lastScreenshotCommandByWindow = new Map();

function openTestingEvidenceDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(TESTING_DB_NAME,TESTING_DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(TESTING_EVIDENCE_STORE)) db.createObjectStore(TESTING_EVIDENCE_STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Could not open evidence storage.'));
  });
}

function testingEvidenceStampLabels(date){
  const hour24=date.getHours();
  const hour12=String(hour24%12||12);
  const minute=String(date.getMinutes()).padStart(2,'0');
  const period=hour24>=12?'PM':'AM';
  return {dateLabel:date.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}),timeLabel:`${hour12}:${minute} ${period}`};
}

async function stampTestingScreenshotBlob(blob,capturedAt){
  if(!blob || typeof OffscreenCanvas!=='function' || typeof createImageBitmap!=='function') return {blob,applied:false};
  let bitmap=null;
  try{
    const stamp=testingEvidenceStampLabels(capturedAt);
    bitmap=await createImageBitmap(blob);
    const width=Math.max(1,bitmap.width||1),height=Math.max(1,bitmap.height||1);
    const canvas=new OffscreenCanvas(width,height);
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx) return {blob,applied:false};
    ctx.drawImage(bitmap,0,0,width,height);
    const timeFontSize=11,dateFontSize=10,timeLineHeight=13,dateLineHeight=12,padX=8,padY=5,gap=1,margin=10;
    ctx.textBaseline='middle';ctx.textAlign='left';
    ctx.font=`600 ${timeFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    const timeWidth=ctx.measureText(stamp.timeLabel).width;
    ctx.font=`500 ${dateFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    const dateWidth=ctx.measureText(stamp.dateLabel).width;
    const boxWidth=Math.ceil(Math.max(dateWidth,timeWidth)+padX*2);
    const boxHeight=Math.ceil(timeLineHeight+gap+dateLineHeight+padY*2);
    const boxX=Math.max(0,width-margin-boxWidth),boxY=Math.max(0,height-margin-boxHeight);
    ctx.save();ctx.shadowColor='rgba(15, 23, 42, 0.20)';ctx.shadowBlur=8;ctx.shadowOffsetY=2;
    ctx.fillStyle='rgba(15, 23, 42, 0.78)';ctx.beginPath();
    if(typeof ctx.roundRect==='function') ctx.roundRect(boxX,boxY,boxWidth,boxHeight,7); else ctx.rect(boxX,boxY,boxWidth,boxHeight);
    ctx.fill();ctx.shadowColor='transparent';ctx.strokeStyle='rgba(255, 255, 255, 0.12)';ctx.lineWidth=1;ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.96)';ctx.font=`600 ${timeFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillText(stamp.timeLabel,boxX+padX,boxY+padY+timeLineHeight/2);
    ctx.fillStyle='rgba(255,255,255,0.78)';ctx.font=`500 ${dateFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillText(stamp.dateLabel,boxX+padX,boxY+padY+timeLineHeight+gap+dateLineHeight/2);ctx.restore();
    const stamped=await canvas.convertToBlob({type:'image/jpeg',quality:0.98});
    return stamped?.size?{blob:stamped,applied:true}:{blob,applied:false};
  }catch{return {blob,applied:false};}
  finally{try{bitmap?.close?.()}catch{}}
}

async function putTestingEvidenceBlob(key,blob){
  const db=await openTestingEvidenceDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(TESTING_EVIDENCE_STORE,'readwrite');
    tx.objectStore(TESTING_EVIDENCE_STORE).put(blob,key);
    tx.oncomplete=()=>{try{db.close()}catch{};resolve(true)};
    tx.onerror=()=>{try{db.close()}catch{};reject(tx.error||new Error('Could not save screenshot evidence.'))};
    tx.onabort=()=>{try{db.close()}catch{};reject(tx.error||new Error('Saving screenshot evidence was aborted.'))};
  });
}

async function deleteTestingEvidenceBlob(key){
  if(!key)return;
  const db=await openTestingEvidenceDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(TESTING_EVIDENCE_STORE,'readwrite');
    tx.objectStore(TESTING_EVIDENCE_STORE).delete(key);
    tx.oncomplete=()=>{try{db.close()}catch{};resolve(true)};
    tx.onerror=()=>{try{db.close()}catch{};reject(tx.error||new Error('Could not remove incomplete evidence.'))};
    tx.onabort=()=>{try{db.close()}catch{};reject(tx.error||new Error('Removing incomplete evidence was aborted.'))};
  });
}

function summarizeTestingSessionForBackground(session){
  const cases=Array.isArray(session?.testCases)?session.testCases:[];
  const evidence=Array.isArray(session?.evidence)?session.evidence:[];
  return {
    id:session.id,version:session.version||3,mode:session.mode||'test-cases',workProduct:String(session.workProduct||''),
    createdAt:session.createdAt,updatedAt:session.updatedAt,status:session.status||'active',
    testCaseCount:cases.length,evidenceCount:evidence.length
  };
}

async function readActiveTestingSession(){
  const stored=await chrome.storage.local.get([TESTING_UI_STATE_KEY,TESTING_SESSIONS_KEY]);
  const ui=stored?.[TESTING_UI_STATE_KEY];
  if(!ui || ui.view!=='testing-workspace' || !ui.sessionId) return null;
  const sessions=stored?.[TESTING_SESSIONS_KEY];
  const session=sessions && typeof sessions==='object' ? sessions[ui.sessionId] : null;
  if(!session || session.status!=='active' || session.id!==ui.sessionId) return null;
  return session;
}

async function updateTestingSessionAfterCapture(session,evidence,dataUrl){
  const authority=await chrome.storage.local.get([TESTING_UI_STATE_KEY,TESTING_SESSIONS_KEY]);
  const ui=authority?.[TESTING_UI_STATE_KEY];
  const sessions=authority?.[TESTING_SESSIONS_KEY];
  if(ui?.view!=='testing-workspace' || ui?.sessionId!==session.id || !sessions || typeof sessions!=='object' || !sessions[session.id] || sessions[session.id].status!=='active'){
    throw new Error('The active testing session changed before the screenshot could be saved.');
  }
  // Re-read the authoritative session immediately before mutation so a session
  // switch or deletion during capture cannot attach evidence to a stale object.
  const fresh=sessions[session.id];
  if(!Array.isArray(fresh.evidence)) fresh.evidence=[];
  if(fresh.status!=='active') throw new Error('The testing session has ended.');
  if(fresh.evidence.some(item=>item.id===evidence.id)) return fresh;

  const capturedBlob=await (await fetch(dataUrl)).blob();
  const stamped=await stampTestingScreenshotBlob(capturedBlob,new Date(evidence.capturedAt));
  await putTestingEvidenceBlob(evidence.imageBlobKey,stamped.blob);
  evidence.timestampApplied=!!stamped.applied;
  fresh.evidence.push(evidence);
  fresh.updatedAt=evidence.capturedAt;
  try{
    sessions[session.id]=fresh;
    await chrome.storage.local.set({[TESTING_SESSIONS_KEY]:sessions});
  }catch(error){
    await deleteTestingEvidenceBlob(evidence.imageBlobKey).catch(()=>{});
    throw error;
  }
  // The index is a derived performance cache. If its write fails, keep the
  // authoritative session and screenshot intact; it can be rebuilt on next load.
  try{
    const indexData=await chrome.storage.local.get(TESTING_SESSIONS_INDEX_KEY);
    const currentIndex=Array.isArray(indexData?.[TESTING_SESSIONS_INDEX_KEY])?indexData[TESTING_SESSIONS_INDEX_KEY]:Object.values(sessions).map(summarizeTestingSessionForBackground);
    const summary=summarizeTestingSessionForBackground(fresh);
    const nextIndex=[summary,...currentIndex.filter(item=>item?.id!==session.id)].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    await chrome.storage.local.set({[TESTING_SESSIONS_INDEX_KEY]:nextIndex});
  }catch{}
  return fresh;
}

async function showPageToast(tabId,{title,subtitle='',type='success',duration=1500}={}){
  const cleanTitle=String(title||'').trim();
  if(!cleanTitle) return false;
  const cleanSubtitle=String(subtitle||'').trim();
  const kind=['success','error','warning','info'].includes(type)?type:'info';
  const settingsKey='forcepilot.settings.v1';
  let darkMode=false;
  try{
    const stored=await chrome.storage.local.get(settingsKey);
    darkMode=stored?.[settingsKey]?.darkMode===true;
  }catch{}
  try{
    await chrome.scripting.executeScript({
      target:{tabId},
      func:(toastTitle,subtitleText,toastKind,isDark,totalDuration)=>{
        try{
          const hostId='__forcepilot_screenshot_toast__';
          document.getElementById(hostId)?.remove();
          const host=document.createElement('div');
          host.id=hostId;
          host.setAttribute('aria-live',toastKind==='error'?'assertive':'polite');
          host.style.cssText='all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;';
          const shadow=host.attachShadow({mode:'open'});
          const style=document.createElement('style');
          style.textContent=`
            :host{all:initial}
            .toast{box-sizing:border-box;display:flex;align-items:flex-start;gap:11px;width:max-content;min-width:190px;max-width:min(360px,calc(100vw - 24px));padding:13px 16px;border:1px solid rgba(22,163,74,.24);border-radius:12px;background:#fff;color:#17212b;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.18);opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease}
            .toast[data-theme="dark"]{background:#171d26;color:#eef3f8;border-color:#344252;box-shadow:0 10px 32px rgba(0,0,0,.44)}
            .icon{width:20px;height:20px;flex:0 0 20px;margin-top:0}
            .copy{min-width:0;max-width:276px;flex:1 1 auto}
            .title{color:inherit;font-size:13px;font-weight:650;letter-spacing:.01em;line-height:1.4;overflow-wrap:anywhere}
            .subtitle{min-width:0;max-width:100%;margin-top:2px;color:#596575;font-size:12px;font-weight:400;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .toast[data-kind="success"]{border-color:rgba(22,163,74,.24)}
            .toast[data-kind="success"] .icon{color:#16a34a}
            .toast[data-kind="error"]{border-color:rgba(220,38,38,.26)}
            .toast[data-kind="error"] .icon{color:#dc2626}
            .toast[data-kind="warning"]{border-color:rgba(180,120,0,.28)}
            .toast[data-kind="warning"] .icon{color:#b77900}
            .toast[data-kind="info"]{border-color:rgba(1,118,211,.25)}
            .toast[data-kind="info"] .icon{color:#0176d3}
            .toast[data-theme="dark"] .subtitle{color:#9ba9b9}
            .toast[data-theme="dark"][data-kind="success"]{border-color:rgba(115,217,154,.28)}
            .toast[data-theme="dark"][data-kind="success"] .icon{color:#73d99a}
            .toast[data-theme="dark"][data-kind="error"]{border-color:rgba(255,115,128,.32)}
            .toast[data-theme="dark"][data-kind="error"] .icon{color:#ff7380}
            .toast[data-theme="dark"][data-kind="warning"]{border-color:rgba(243,197,109,.3)}
            .toast[data-theme="dark"][data-kind="warning"] .icon{color:#f3c56d}
            .toast[data-theme="dark"][data-kind="info"]{border-color:rgba(99,181,255,.3)}
            .toast[data-theme="dark"][data-kind="info"] .icon{color:#63b5ff}
            @media(max-width:420px){.toast{max-width:calc(100vw - 20px);padding:10px 12px}.copy{max-width:calc(100vw - 72px)}}
            @media(prefers-reduced-motion:reduce){.toast{transition:none}}
          `;
          const iconPaths={
            success:'<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.6 2.6L16.4 9"/>',
            error:'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
            warning:'<path d="M10.3 4.7a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3z"/><path d="M12 9v4m0 3h.01"/>',
            info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>'
          };
          const card=document.createElement('div');
          card.className='toast';
          card.dataset.theme=isDark?'dark':'light';
          card.dataset.kind=toastKind;
          card.setAttribute('role',toastKind==='error'?'alert':'status');
          card.innerHTML=`<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[toastKind]}</svg><div class="copy"><div class="title"></div>${subtitleText?'<div class="subtitle"></div>':''}</div>`;
          card.querySelector('.title').textContent=toastTitle;
          if(subtitleText) card.querySelector('.subtitle').textContent=subtitleText;
          shadow.append(style,card);
          (document.documentElement||document.body).appendChild(host);
          requestAnimationFrame(()=>{card.style.opacity='1';card.style.transform='translateY(0)'});
          // Duration includes the fade-out, matching the sidebar toast system.
          const fadeMs=180;
          const lifetime=Math.max(700,Number(totalDuration)||1500);
          setTimeout(()=>{
            card.style.opacity='0';
            card.style.transform='translateY(8px)';
            setTimeout(()=>host.remove(),fadeMs);
          },Math.max(0,lifetime-fadeMs));
        }catch{}
      },
      args:[cleanTitle,cleanSubtitle,kind,darkMode,duration]
    });
    return true;
  }catch{return false;}
}

async function captureScreenshotIntoActiveTestingSession(tab){
  if(!tab?.id || !tab?.windowId) return {ok:false,code:'TAB_UNAVAILABLE'};
  const url=String(tab.url||'');
  if(!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) return {ok:false,code:'RESTRICTED_PAGE'};
  const winId=Number(tab.windowId);
  const [activeTab]=await chrome.tabs.query({active:true,windowId:winId}).catch(()=>[]);
  if(activeTab?.id!==tab.id) return {ok:false,code:'TAB_NOT_ACTIVE'};

  const session=await readActiveTestingSession();
  if(!session) return {ok:false,code:'NO_ACTIVE_TESTING_SESSION'};
  let preparedSalesforce=false;
  if(isSalesforceUrl(url)){
    let prepared=await chrome.tabs.sendMessage(tab.id,{type:'PREPARE_TEST_CAPTURE'}).catch(()=>null);
    if(!prepared?.ok){
      const loaded=await ensureContentScripts(tab.id);
      if(loaded?.ok) prepared=await chrome.tabs.sendMessage(tab.id,{type:'PREPARE_TEST_CAPTURE'}).catch(()=>null);
    }
    preparedSalesforce=!!prepared?.ok;
  }
  // A success toast from the previous capture can still be visible when the
  // user captures again quickly. Hide only the page-level ForcePilot toast for
  // the capture frames, then restore its prior inline styles immediately after.
  let priorScreenshotToastStyle=null;
  try{
    const [toastState]=await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:async()=>{
        const host=document.getElementById('__forcepilot_screenshot_toast__');
        if(!host) return null;
        const prior={visibility:host.style.visibility,display:host.style.display};
        host.style.visibility='hidden';
        host.style.display='none';
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return prior;
      }
    });
    priorScreenshotToastStyle=toastState?.result||null;
  }catch{}
  let dataUrl;
  try{
    dataUrl=await chrome.tabs.captureVisibleTab(winId,{format:'jpeg',quality:95});
  }finally{
    if(preparedSalesforce) await chrome.tabs.sendMessage(tab.id,{type:'RESTORE_TEST_CAPTURE'}).catch(()=>null);
    if(priorScreenshotToastStyle){
      await chrome.scripting.executeScript({
        target:{tabId:tab.id},
        func:(prior)=>{
          const host=document.getElementById('__forcepilot_screenshot_toast__');
          if(!host) return;
          host.style.visibility=prior.visibility||'';
          host.style.display=prior.display||'';
        },
        args:[priorScreenshotToastStyle]
      }).catch(()=>null);
    }
  }
  if(!dataUrl) throw new Error('Chrome did not return a screenshot.');

  const currentData=await chrome.storage.local.get([TESTING_UI_STATE_KEY,TESTING_SESSIONS_KEY]);
  const ui=currentData?.[TESTING_UI_STATE_KEY];
  const currentSession=currentData?.[TESTING_SESSIONS_KEY]?.[session.id];
  if(ui?.view!=='testing-workspace' || ui?.sessionId!==session.id || !currentSession || currentSession.status!=='active'){
    throw new Error('The active testing session changed during capture. Please try again.');
  }

  const capturedAt=new Date().toISOString();
  const evidenceId=`evidence_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const imageBlobKey=`${session.id}:${evidenceId}`;
  const testCaseId=currentSession.mode==='evidence-only' ? null : (currentSession.currentEvidenceTestCaseId || currentSession.testCases?.[0]?.id || null);
  const evidence={id:evidenceId,sessionId:session.id,capturedAt,testCaseId,imageBlobKey,sourceTabId:tab.id,source:'native',timestampApplied:false};
  await updateTestingSessionAfterCapture(currentSession,evidence,dataUrl);
  // Render page confirmation only after both the image blob and session metadata persist.
  await showPageToast(tab.id,{title:'Screenshot captured',subtitle:`Saved to ${String(currentSession.workProduct||currentSession.exportFilename||'').trim()||'your ForcePilot testing session'}`,type:'success',duration:1500});
  try{chrome.runtime.sendMessage({type:'FORCEPILOT_TESTING_EVIDENCE_SAVED',sessionId:session.id,evidenceId}).catch(()=>{});}catch{}
  return {ok:true,sessionId:session.id,evidenceId};
}

function openForcePilot(tabId){
  const id=Number(tabId||0);
  if(!id) return Promise.resolve({ok:false,code:'TAB_UNAVAILABLE'});
  // The launcher path was already working; keep its open-only semantics. The
  // panel open call stays synchronous so Chrome preserves the click gesture.
  return chrome.sidePanel.open({tabId:id})
    .then(async()=>{await markPanelState(id,true); return ensureContentScripts(id);})
    .then(loaded=>({ok:true,loaded}))
    .catch(error=>({ok:false,code:'OPEN_FAILED',message:String(error?.message||'Could not open ForcePilot.')}));
}

function openForcePilotFromCommand(tab){
  const tabId=Number(tab?.id||0);
  if(!tabId) return;

  // IMPORTANT: this must remain the first browser API call on the open path.
  // Everything else happens after the promise resolves.
  openPanelTabs.add(tabId);
  const openPromise=chrome.sidePanel.open({tabId});
  openPromise
    .then(async()=>{
      await markPanelState(tabId,true);
      await ensureContentScripts(tabId);
    })
    .catch(()=>{
      openPanelTabs.delete(tabId);
    });
}

chrome.runtime.onInstalled.addListener(()=>{
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false}).catch(()=>{});
});

chrome.commands.onCommand.addListener((command,commandTab)=>{
  // For standard commands Chrome may omit the Tab argument. Resolve the active
  // tab explicitly instead of silently abandoning the shortcut when it is absent.
  if(command==='capture-testing-screenshot') {
    (async()=>{
      let tab=commandTab;
      if(!tab?.id || !tab?.windowId){
        const [activeTab]=await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
        tab=activeTab||null;
      } else {
        const [activeTab]=await chrome.tabs.query({active:true,windowId:Number(tab.windowId)}).catch(()=>[]);
        tab=activeTab||tab;
      }
      if(!tab?.id || !tab?.windowId) return;
      const windowId=Number(tab.windowId);
      const now=Date.now();
      if(now-(lastScreenshotCommandByWindow.get(windowId)||0)<900) return;
      lastScreenshotCommandByWindow.set(windowId,now);
      try{
        const outcome=await captureScreenshotIntoActiveTestingSession(tab);
        if(!outcome?.ok){
          const messages={
            NO_ACTIVE_TESTING_SESSION:'Start or resume a testing session before capturing.',
            RESTRICTED_PAGE:'Chrome does not allow screenshots on this page.',
            TAB_UNAVAILABLE:'Could not identify the active tab.',
            TAB_NOT_ACTIVE:'Switch to the tab you want to capture and try again.'
          };
          await showPageToast(tab.id,{title:messages[outcome?.code]||'Could not capture screenshot.',type:outcome?.code==='NO_ACTIVE_TESTING_SESSION'?'info':'error',duration:2400});
        }
      }catch(error){
        // Keep errors visually consistent with the success toast, and show them only
        // after the capture flow has actually failed.
        const reason=String(error?.message||'Could not capture screenshot.');
        await showPageToast(tab.id,{title:reason,type:'error',duration:2800});
      }
    })().catch(()=>{});
    return;
  }

  if(command!=='open-forcepilot') return;
  const tab=commandTab;
  const tabId=Number(tab?.id||0);
  const windowId=Number(tab?.windowId||0);
  if(!tabId || !windowId || !isSalesforceUrl(tab?.url||'')) return;

  const panelPort=forcePilotPanelPorts.get(windowId);
  if(panelPort){
    // Ask the live panel document to close itself, then immediately retire the
    // presence entry. The panel may take a moment to disconnect; keeping the
    // stale port here would make the next Alt+X look like another CLOSE instead
    // of taking the OPEN path.
    try{panelPort.postMessage({type:'FORCEPILOT_CLOSE'});}catch{}
    if(forcePilotPanelPorts.get(windowId)===panelPort){
      forcePilotPanelPorts.delete(windowId);
    }
    openPanelTabs.delete(tabId);
    markPanelState(tabId,false).catch(()=>{});
    return;
  }

  // No live panel document is registered, so this is an OPEN operation. Keep
  // chrome.sidePanel.open() as the first browser API call on this branch.
  openForcePilotFromCommand(tab);
});

if(chrome.sidePanel?.onOpened?.addListener){
  chrome.sidePanel.onOpened.addListener(info=>{
    if(info?.tabId) markPanelState(info.tabId,true).catch(()=>{});
  });
}

if(chrome.sidePanel?.onClosed?.addListener){
  chrome.sidePanel.onClosed.addListener(info=>{
    if(info?.tabId) markPanelState(info.tabId,false).catch(()=>{});
  });
}

chrome.tabs.onRemoved.addListener(async tabId=>{
  injectionFlights.delete(tabId);
  injectedFrameSignatures.delete(tabId);
  multiFrameProgressByTab.delete(tabId);
  openPanelTabs.delete(Number(tabId));
  const panelState=await getOpenPanelState();
  delete panelState[panelStateKey(tabId)];
  await setOpenPanelState(panelState);
  await mutateLocks(async locks=>{
    let changed=false;
    for(const [scope,lock] of Object.entries(locks)){if(lock?.tabId===tabId){delete locks[scope];changed=true;}}
    return {changed};
  }).catch(()=>{});
});

chrome.tabs.onUpdated.addListener(async(tabId,changeInfo)=>{
  if(changeInfo.status!=='loading') return;
  injectedFrameSignatures.delete(tabId);
  await mutateLocks(async locks=>{
    let changed=false;
    for(const [scope,lock] of Object.entries(locks)){if(lock?.tabId===tabId){delete locks[scope];changed=true;}}
    return {changed};
  }).catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  const senderTabId=sender.tab?.id ?? null;

  if(msg?.type==='FORCEPILOT_MULTIFRAME_REQUEST'){
    dispatchMultiFrameRequest(Number(msg.tabId||senderTabId||0),msg.message||{}).then(sendResponse).catch(e=>sendResponse({ok:false,message:String(e?.message||'Multi-frame Salesforce operation failed.')}));
    return true;
  }
  if(msg?.type==='FORCEPILOT_REPLAY_PROGRESS'){
    const progress=multiFrameProgressByTab.get(Number(senderTabId||0));
    if(progress&&Number.isFinite(Number(msg.index)))progress.index=Number(msg.index);
    sendResponse({ok:true});
    return false;
  }

  if(msg?.type==='ACQUIRE_RECORDING_LOCK'){
    mutateLocks(async locks=>{
      if(!senderTabId || !isSalesforceUrl(sender.tab?.url||'')){
        sendResponse({ok:false,code:'SALESFORCE_ONLY',message:'Recording is available only on Salesforce.'});
        return {changed:false};
      }
      const scopeWindowId=Number(sender.tab?.windowId||msg.windowId||0);
      const incognito=!!sender.tab?.incognito||!!msg.incognito;
      const scope=lockScope(scopeWindowId,incognito);
      const existing=locks[scope]||null;
      if(existing && !(await lockOwnerIsValid(existing))){delete locks[scope];}
      const current=locks[scope]||null;
      if(current?.tabId && current.tabId!==senderTabId){
        sendResponse({ok:false,code:'RECORDING_IN_OTHER_TAB',tabId:current.tabId,windowId:scopeWindowId,message:'A recording is already active in this window.'});
        return {changed:false};
      }
      const lock={tabId:senderTabId,windowId:scopeWindowId,incognito,startedAt:current?.startedAt||Date.now()};
      locks[scope]=lock;
      sendResponse({ok:true,...lock});
      return {changed:true};
    }).catch(()=>sendResponse({ok:false,code:'LOCK_ERROR',message:'Could not start recording.'}));
    return true;
  }

  if(msg?.type==='RELEASE_RECORDING_LOCK'){
    mutateLocks(async locks=>{
      const scopeWindowId=Number(sender.tab?.windowId||msg.windowId||0);
      const incognito=!!sender.tab?.incognito||!!msg.incognito;
      const scope=lockScope(scopeWindowId,incognito);
      const lock=locks[scope]||null;
      const requestedTabId=Number(msg?.tabId||0);
      let changed=false;
      if(!lock || lock.tabId===senderTabId || (requestedTabId && lock.tabId===requestedTabId)){delete locks[scope];changed=true;}
      sendResponse({ok:true});
      return {changed};
    }).catch(()=>sendResponse({ok:true}));
    return true;
  }

  if(msg?.type==='GET_RECORDING_LOCK'){
    const scopeWindowId=Number(msg?.windowId||sender.tab?.windowId||0);
    const incognito=!!msg?.incognito||!!sender.tab?.incognito;
    mutateLocks(async locks=>{
      const scope=lockScope(scopeWindowId,incognito);
      let lock=locks[scope]||null;
      let changed=false;
      if(lock && !(await lockOwnerIsValid(lock))){delete locks[scope];lock=null;changed=true;}
      sendResponse({recordingTabId:lock?.tabId||null,recordingStartedAt:lock?.startedAt||null,windowId:scopeWindowId,incognito});
      return {changed};
    }).catch(()=>sendResponse({recordingTabId:null,recordingStartedAt:null,windowId:scopeWindowId,incognito}));
    return true;
  }


  if(msg?.type==='ENSURE_CONTENT_SCRIPTS'){
    const tabId=Number(msg.tabId||senderTabId);
    ensureContentScripts(tabId).then(sendResponse).catch(e=>sendResponse({ok:false,code:'ENSURE_FAILED',message:String(e?.message||'Could not load ForcePilot.')}));
    return true;
  }

  if(msg?.type==='CAPTURE_AND_SAVE_TESTING_SESSION_SCREENSHOT'){
    (async()=>{
      const requestedTabId=Number(msg?.tabId||0);
      const tab=requestedTabId ? await chrome.tabs.get(requestedTabId).catch(()=>null) : null;
      if(!tab?.id){sendResponse({ok:false,code:'TAB_UNAVAILABLE',message:'The active browser tab is unavailable.'});return;}
      try{
        const result=await captureScreenshotIntoActiveTestingSession(tab);
        if(!result?.ok){
          const messages={
            NO_ACTIVE_TESTING_SESSION:'Open an active Screenshot session in ForcePilot first.',
            TAB_NOT_ACTIVE:'Switch to the tab you want to capture, then try again.',
            RESTRICTED_PAGE:'Chrome does not allow screenshot capture on this browser page.'
          };
          sendResponse({ok:false,code:result?.code||'CAPTURE_FAILED',message:messages[result?.code]||'Could not save the screenshot to the active testing session.'});
          return;
        }
        sendResponse(result);
      }catch(error){sendResponse({ok:false,code:'CAPTURE_FAILED',message:String(error?.message||'Could not capture and save the screenshot.')});}
    })();
    return true;
  }

  if(msg?.type==='OPEN_SIDE_PANEL'){
    if(!senderTabId || !isSalesforceUrl(sender.tab?.url||'')){
      sendResponse({ok:false,code:'SALESFORCE_ONLY'});
      return false;
    }
    // The message originates from the launcher's click. Keep the user gesture
    // alive by opening the panel before any async work.
    openForcePilot(senderTabId).then(sendResponse).catch(()=>sendResponse({ok:false,code:'OPEN_FAILED',message:'Could not open ForcePilot.'}));
    return true;
  }

  if(msg?.type==='GET_SALESFORCE_TAB'){
    refreshCustomExperienceDomains().then(()=>chrome.tabs.query({})).then(tabs=>{
      const tab=tabs.find(t=>isSalesforceUrl(t.url||''));
      sendResponse(tab?.id?{ok:true,tabId:tab.id}:{ok:false});
    }).catch(()=>sendResponse({ok:false}));
    return true;
  }

  if(msg?.type==='GET_FIELD_DESCRIPTORS'){
    chrome.tabs.query({}).then(async tabs=>{
      await refreshCustomExperienceDomains();
      const tab=tabs.find(t=>isSalesforceUrl(t.url||''));
      if(!tab?.id)return sendResponse({ok:false,error:'Open a Salesforce tab first.'});
      const result=await dispatchMultiFrameRequest(tab.id,{type:'GET_FIELD_DESCRIPTORS',targets:Array.isArray(msg.targets)?msg.targets:[]}).catch(()=>null);
      sendResponse(result||{ok:false,error:'Could not connect to the Salesforce page.'});
    }).catch(()=>sendResponse({ok:false,error:'Could not find a Salesforce tab.'}));
    return true;
  }

  if(msg?.type==='GET_ACTIVE_CONTEXT'){
    refreshCustomExperienceDomains().then(()=>chrome.tabs.query({active:true,currentWindow:true})).then(async([tab])=>{
      if(!tab?.id || !isSalesforceUrl(tab.url||'')) return sendResponse({salesforce:false,tabId:tab?.id||null});
      const loaded=await ensureContentScripts(tab.id);
      return sendResponse({salesforce:true,tabId:tab.id,context:loaded.context||null,connected:!!loaded.ok,message:loaded.message||''});
    }).catch(()=>sendResponse({salesforce:false}));
    return true;
  }

  return false;
});
