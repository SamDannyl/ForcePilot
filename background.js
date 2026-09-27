/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

const LOCK_KEY = 'forcepilot.recording.locks.v2';
const injectionFlights = new Map();
let lockMutation = Promise.resolve();
const withLockMutation = fn => {
  const run = lockMutation.then(fn, fn);
  lockMutation = run.catch(() => {});
  return run;
};

function isSalesforceUrl(url=''){
  try{
    const u=new URL(url);
    if(u.protocol!=='https:') return false;
    return u.hostname.endsWith('.salesforce.com') ||
      u.hostname.endsWith('.lightning.force.com') ||
      u.hostname.endsWith('.my.salesforce.com') ||
      u.hostname.endsWith('.visualforce.com') ||
      u.hostname.endsWith('.vf.force.com');
  }catch{return false;}
}

async function getLocks(){try{const d=await chrome.storage.session.get(LOCK_KEY);return d[LOCK_KEY]&&typeof d[LOCK_KEY]==='object'?d[LOCK_KEY]:{};}catch{return{}}}
async function setLocks(locks){try{await chrome.storage.session.set({[LOCK_KEY]:locks});}catch{}}
const lockScope=(windowId,incognito)=>`${Number(windowId||0)}:${incognito?'incognito':'normal'}`;
async function getLock(windowId,incognito){const locks=await getLocks();return locks[lockScope(windowId,incognito)]||null;}
async function setLock(windowId,incognito,lock){const locks=await getLocks();locks[lockScope(windowId,incognito)]=lock;await setLocks(locks);}
async function clearLock(windowId,incognito){const locks=await getLocks();delete locks[lockScope(windowId,incognito)];await setLocks(locks);}
async function lockOwnerIsValid(lock){if(!lock?.tabId)return false;const tab=await chrome.tabs.get(lock.tabId).catch(()=>null);return !!tab?.id&&isSalesforceUrl(tab.url||'')&&Number(tab.windowId)===Number(lock.windowId)&&!!tab.incognito===!!lock.incognito;}

async function ensureContentScripts(tabId){
  if(injectionFlights.has(tabId)) return injectionFlights.get(tabId);
  const flight=(async()=>{
    const tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(!tab?.id || !isSalesforceUrl(tab.url||'')) return {ok:false,code:'SALESFORCE_ONLY'};

    const ping=await chrome.tabs.sendMessage(tabId,{type:'GET_CONTEXT'}).catch(()=>null);
    if(ping) return {ok:true,context:ping,injected:false};

    try{await chrome.scripting.executeScript({target:{tabId},files:['page_bridge.js'],world:'MAIN'});}catch{}
    try{
      await chrome.scripting.executeScript({target:{tabId},files:['src/shared.js','src/content.js'],world:'ISOLATED'});
    }catch(e){
      return {ok:false,code:'INJECT_FAILED',message:String(e?.message||'Could not load ForcePilot on this Salesforce page.')};
    }
    const ctx=await chrome.tabs.sendMessage(tabId,{type:'GET_CONTEXT'}).catch(()=>null);
    return ctx
      ? {ok:true,context:ctx,injected:true}
      : {ok:false,code:'NO_RECEIVER',message:'ForcePilot could not connect to this Salesforce page. Refresh the page and try again.'};
  })();
  injectionFlights.set(tabId,flight);
  try{return await flight;}finally{if(injectionFlights.get(tabId)===flight)injectionFlights.delete(tabId);}
}

chrome.runtime.onInstalled.addListener(()=>{
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false}).catch(()=>{});
});

chrome.action.onClicked.addListener(async tab=>{
  if(!tab?.id || !isSalesforceUrl(tab.url||'')) return;
  await chrome.sidePanel.open({tabId:tab.id}).catch(()=>{});
});

chrome.tabs.onRemoved.addListener(async tabId=>{
  injectionFlights.delete(tabId);
  const locks=await getLocks();let changed=false;
  for(const [scope,lock] of Object.entries(locks)){if(lock?.tabId===tabId){delete locks[scope];changed=true;}}
  if(changed)await setLocks(locks);
});

chrome.tabs.onUpdated.addListener(async(tabId,changeInfo,tab)=>{
  if(changeInfo.status!=='loading') return;
  const locks=await getLocks();let changed=false;
  for(const [scope,lock] of Object.entries(locks)){if(lock?.tabId===tabId){delete locks[scope];changed=true;}}
  if(changed)await setLocks(locks);
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  const senderTabId=sender.tab?.id ?? null;

  if(msg?.type==='ACQUIRE_RECORDING_LOCK'){
    withLockMutation(async()=>{
      if(!senderTabId || !isSalesforceUrl(sender.tab?.url||'')){
        return sendResponse({ok:false,code:'SALESFORCE_ONLY',message:'Recording is available only on Salesforce.'});
      }
      const scopeWindowId=Number(sender.tab?.windowId||msg.windowId||0);
      const incognito=!!sender.tab?.incognito||!!msg.incognito;
      const existing=await getLock(scopeWindowId,incognito);
      if(existing && !(await lockOwnerIsValid(existing))) await clearLock(scopeWindowId,incognito);
      const current=await getLock(scopeWindowId,incognito);
      if(current?.tabId && current.tabId!==senderTabId){
        return sendResponse({ok:false,code:'RECORDING_IN_OTHER_TAB',tabId:current.tabId,windowId:scopeWindowId,message:'A recording is already active in this window.'});
      }
      const lock={tabId:senderTabId,windowId:scopeWindowId,incognito,startedAt:current?.startedAt||Date.now()};
      await setLock(scopeWindowId,incognito,lock);
      sendResponse({ok:true,...lock});
    }).catch(()=>sendResponse({ok:false,code:'LOCK_ERROR',message:'Could not start recording.'}));
    return true;
  }

  if(msg?.type==='RELEASE_RECORDING_LOCK'){
    withLockMutation(async()=>{
      const scopeWindowId=Number(sender.tab?.windowId||msg.windowId||0);
      const incognito=!!sender.tab?.incognito||!!msg.incognito;
      const lock=await getLock(scopeWindowId,incognito);
      const requestedTabId=Number(msg?.tabId||0);
      if(!lock || lock.tabId===senderTabId || (requestedTabId && lock.tabId===requestedTabId)) await clearLock(scopeWindowId,incognito);
      sendResponse({ok:true});
    }).catch(()=>sendResponse({ok:true}));
    return true;
  }

  if(msg?.type==='GET_RECORDING_LOCK'){
    const scopeWindowId=Number(msg?.windowId||sender.tab?.windowId||0);
    const incognito=!!msg?.incognito||!!sender.tab?.incognito;
    getLock(scopeWindowId,incognito).then(async lock=>{
      if(lock && !(await lockOwnerIsValid(lock))){await clearLock(scopeWindowId,incognito);lock=null;}
      sendResponse({recordingTabId:lock?.tabId||null,recordingStartedAt:lock?.startedAt||null,windowId:scopeWindowId,incognito});
    }).catch(()=>sendResponse({recordingTabId:null,recordingStartedAt:null}));
    return true;
  }

  if(msg?.type==='ENSURE_CONTENT_SCRIPTS'){
    const tabId=Number(msg.tabId||senderTabId);
    ensureContentScripts(tabId).then(sendResponse).catch(e=>sendResponse({ok:false,code:'ENSURE_FAILED',message:String(e?.message||'Could not load ForcePilot.')}));
    return true;
  }

  if(msg?.type==='OPEN_SIDE_PANEL'){
    (async()=>{
      const tabId=senderTabId;
      if(!tabId || !isSalesforceUrl(sender.tab?.url||'')) return sendResponse({ok:false,code:'SALESFORCE_ONLY'});
      await chrome.sidePanel.open({tabId});
      sendResponse({ok:true});
    })().catch(()=>sendResponse({ok:false,code:'OPEN_FAILED',message:'Could not open ForcePilot.'}));
    return true;
  }

  if(msg?.type==='GET_SALESFORCE_TAB'){
    chrome.tabs.query({}).then(tabs=>{
      const tab=tabs.find(t=>isSalesforceUrl(t.url||''));
      sendResponse(tab?.id?{ok:true,tabId:tab.id}:{ok:false});
    }).catch(()=>sendResponse({ok:false}));
    return true;
  }

  if(msg?.type==='GET_FIELD_DESCRIPTORS'){
    chrome.tabs.query({}).then(async tabs=>{
      const tab=tabs.find(t=>isSalesforceUrl(t.url||''));
      if(!tab?.id)return sendResponse({ok:false,error:'Open a Salesforce tab first.'});
      const result=await chrome.tabs.sendMessage(tab.id,{type:'GET_FIELD_DESCRIPTORS',targets:Array.isArray(msg.targets)?msg.targets:[]}).catch(()=>null);
      sendResponse(result||{ok:false,error:'Could not connect to the Salesforce page.'});
    }).catch(()=>sendResponse({ok:false,error:'Could not find a Salesforce tab.'}));
    return true;
  }

  if(msg?.type==='GET_ACTIVE_CONTEXT'){
    chrome.tabs.query({active:true,currentWindow:true}).then(async([tab])=>{
      if(!tab?.id || !isSalesforceUrl(tab.url||'')) return sendResponse({salesforce:false,tabId:tab?.id||null});
      const loaded=await ensureContentScripts(tab.id);
      return sendResponse({salesforce:true,tabId:tab.id,context:loaded.context||null,connected:!!loaded.ok,message:loaded.message||''});
    }).catch(()=>sendResponse({salesforce:false}));
    return true;
  }

  return false;
});
