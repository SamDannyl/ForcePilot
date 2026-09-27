/* ForcePilot popup — shared Material icon primitives. */
import { icon } from './src/material-icons.js';

(async()=>{
  const $=s=>document.querySelector(s);
  const STORAGE='forcepilot.recordings.v1';
  document.querySelectorAll('[data-icon]').forEach(el=>{ const name=el.dataset.icon; el.replaceWith(document.createRange().createContextualFragment(icon(name))); });
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs[0];
  let isSalesforce=false;
  try{const u=new URL(tab?.url||'');const hosts=['salesforce.com','lightning.force.com','my.salesforce.com','visualforce.com','vf.force.com'];isSalesforce=u.protocol==='https:'&&hosts.some(s=>u.hostname===s||u.hostname.endsWith('.'+s));}catch{}
  await chrome.storage.local.get([STORAGE]);
  if(isSalesforce){
    $('#status').textContent='Salesforce';
    $('#connectionTitle').textContent='Salesforce';
    $('#connectionDetail').textContent='ForcePilot is ready on this tab.';
    $('#statusDot').className='status-dot good';
  }else{
    $('#status').textContent='Not on Salesforce';
    $('#status').className='status bad';
    $('#connectionTitle').textContent='Not on Salesforce';
    $('#connectionDetail').textContent='Open ForcePilot from a Salesforce tab.';
    $('#statusDot').className='status-dot bad';
    $('#open').disabled=true;
    $('#openLabel').textContent='Open Salesforce';
    $('#heroTitle').textContent='Open a Salesforce page';
    $('#heroDetail').textContent='ForcePilot works on Salesforce pages. Open one, then launch the sidebar to get started.';
  }
  $('#open').onclick=async()=>{if(!isSalesforce||!tab?.id)return;try{await chrome.sidePanel.open({tabId:tab.id})}catch{}}
  $('#manage').onclick=()=>chrome.runtime.openOptionsPage();
})().catch(()=>{});
