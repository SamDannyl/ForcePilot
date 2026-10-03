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
const openPanelTabs = new Set();
const forcePilotPanelPorts = new Map();
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
async function lockOwnerIsValid(lock){if(!lock?.tabId)return false;const tab=await chrome.tabs.get(lock.tabId).catch(()=>null);return !!tab?.id&&isSalesforceUrl(tab.url||'')&&Number(tab.windowId)===Number(lock.windowId)&&!!tab.incognito===!!lock.incognito;}
async function mutateLocks(mutator){
  return withLockMutation(async()=>{
    const locks=await getLocks();
    const result=await mutator(locks);
    if(result?.changed)await setLocks(locks);
    return result?.value;
  });
}

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

chrome.commands.onCommand.addListener((command,tab)=>{
  if(command!=='open-forcepilot') return;

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
  await mutateLocks(async locks=>{
    let changed=false;
    for(const [scope,lock] of Object.entries(locks)){if(lock?.tabId===tabId){delete locks[scope];changed=true;}}
    return {changed};
  }).catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  const senderTabId=sender.tab?.id ?? null;

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

  if(msg?.type==='CAPTURE_TEST_SCREENSHOT'){
    (async()=>{
      const requestedTabId = Number(msg?.tabId || senderTabId || 0);
      const tab = await chrome.tabs.get(requestedTabId).catch(() => null);
      if(!tab?.id) return sendResponse({ok:false,code:'TAB_UNAVAILABLE',message:'The tab is no longer available for capture.'});
      const [active] = await chrome.tabs.query({active:true,windowId:tab.windowId}).catch(() => []);
      if(!active?.id || active.id !== tab.id) return sendResponse({ok:false,code:'TAB_NOT_ACTIVE',message:'Switch to the tab you want to capture, then click Screenshot again.'});

      const url = String(tab.url || '');
      const extensionPage = url.startsWith('chrome-extension://');
      if (extensionPage) {
        return sendResponse({
          ok:false,
          code:'EXTENSION_PAGE_UNSUPPORTED',
          message:'Screenshots of other Chrome extensions are not supported from ForcePilot. Use Screenshot on a Salesforce or regular web page.'
        });
      }

      const salesforce = isSalesforceUrl(url);
      let preparedSalesforce=false;
      if(salesforce){
        let prepared = await chrome.tabs.sendMessage(tab.id,{type:'PREPARE_TEST_CAPTURE'}).catch(() => null);
        if(!prepared?.ok){
          const loaded = await ensureContentScripts(tab.id);
          if(!loaded?.ok) return sendResponse({ok:false,code:'CONTENT_UNAVAILABLE',message:loaded.message || 'Could not prepare the Salesforce page for capture.'});
          prepared = await chrome.tabs.sendMessage(tab.id,{type:'PREPARE_TEST_CAPTURE'}).catch(() => null);
        }
        if(!prepared?.ok) return sendResponse({ok:false,code:'CAPTURE_PREPARE_FAILED',message:prepared?.message || 'Could not prepare the Salesforce page for capture.'});
        preparedSalesforce=true;
      }

      try{
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:95});
        return sendResponse(dataUrl ? {ok:true,dataUrl} : {ok:false,code:'CAPTURE_EMPTY',message:'Chrome did not return a screenshot.'});
      }catch(error){
        const message=String(error?.message||'');
        if(/Cannot access a chrome-extension:\/\/ URL of different extension|chrome-extension:\/\//i.test(message)) {
          return sendResponse({ok:false,code:'EXTENSION_PAGE_UNSUPPORTED',message:'Screenshots of other Chrome extensions are not supported from ForcePilot. Use Screenshot on a Salesforce or regular web page.'});
        }
        if(/activeTab|permission|not allowed|permission denied|incognito|restricted/i.test(message)) {
          return sendResponse({ok:false,code:'CAPTURE_PERMISSION',message:'Chrome blocked screenshot capture for this tab.'});
        }
        return sendResponse({ok:false,code:'CAPTURE_FAILED',message:message||'Could not capture the current tab.'});
      }finally{
        if(preparedSalesforce) await chrome.tabs.sendMessage(tab.id,{type:'RESTORE_TEST_CAPTURE'}).catch(()=>null);
      }
    })().catch(error=>sendResponse({ok:false,code:'CAPTURE_FAILED',message:String(error?.message||'Could not capture the current tab.')}));
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
