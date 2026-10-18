/* ForcePilot popup — compact command surface using the shared theme system. */
import { icon } from './src/material-icons.js';
import { getSettings, saveSettings } from './src/shared-module.js';
import { applyTheme, watchTheme } from './src/theme.js';

(async()=>{
  const $=s=>document.querySelector(s);
  let settings={...await getSettings()};
  const renderIcons=()=>document.querySelectorAll('[data-icon]').forEach(el=>el.replaceWith(document.createRange().createContextualFragment(icon(el.dataset.icon))));
  const setLogoTheme=dark=>{document.documentElement.dataset.theme=dark?'dark':'light';};
  const updateTheme=dark=>{settings={...settings,darkMode:dark===true};applyTheme(settings.darkMode);setLogoTheme(settings.darkMode);};
  updateTheme(settings.darkMode);
  watchTheme(dark=>{updateTheme(dark);const toggle=$('#darkMode');if(toggle)toggle.checked=dark;});
  renderIcons();
  const toggle=$('#darkMode');
  if(toggle){
    toggle.checked=settings.darkMode===true;
    toggle.addEventListener('change',async()=>{settings={...settings,darkMode:toggle.checked};updateTheme(toggle.checked);await saveSettings(settings);});
    document.querySelector('.theme-row')?.addEventListener('click',event=>{if(event.target.closest('label, input'))return;toggle.checked=!toggle.checked;toggle.dispatchEvent(new Event('change',{bubbles:true}));});
  }
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});const tab=tabs[0];
  const salesforceSuffixes=['salesforce.com','lightning.force.com','my.salesforce.com','visualforce.com','vf.force.com','force.com','site.com','salesforce-sites.com','salesforce-communities.com','salesforce-setup.com','salesforce-experience.com','salesforce.app','forceusercontent.com','force-user-content.com','salesforce-scrt.com'];
  const configuredDomains=Array.isArray(settings.experienceCloudDomains)?settings.experienceCloudDomains:[];let isSalesforce=false;
  try{const u=new URL(tab?.url||'');const host=u.hostname.toLowerCase();const standard=salesforceSuffixes.some(s=>host===s||host.endsWith('.'+s));const custom=configuredDomains.some(raw=>{const domain=String(raw||'').trim().toLowerCase().replace(/^https?:\\/\\//,'').split(/[\\/?#]/)[0].replace(/^\\*\\./,'').replace(/:\\d+$/,'').replace(/\\.$/,'');return !!domain&&(host===domain||host.endsWith('.'+domain));});isSalesforce=u.protocol==='https:'&&(standard||custom);}catch{}
  if(isSalesforce){$('#connectionTitle').textContent='Salesforce';$('#connectionDetail').textContent='Current tab is supported';$('#statusDot').className='status-dot good';}
  else{$('#connectionTitle').textContent='Not a Salesforce page';$('#connectionDetail').textContent='Open Salesforce to use ForcePilot';$('#statusDot').className='status-dot bad';$('#open').disabled=true;$('#open').setAttribute('aria-disabled','true');$('#openLabel').textContent='Available on Salesforce';}
  $('#open').onclick=async()=>{if(!isSalesforce||!tab?.id)return;try{await chrome.sidePanel.open({tabId:tab.id});}catch{}};
  $('#manage').onclick=()=>chrome.runtime.openOptionsPage();
})().catch(()=>{});
