/* ForcePilot popup — compact command surface using the shared theme system. */
import { icon } from './src/material-icons.js';
import { getSettings, saveSettings } from './src/shared-module.js';
import { applyTheme, watchTheme } from './src/theme.js';

(async()=>{
  const $=s=>document.querySelector(s);
  let settings={...await getSettings()};

  const renderIcons=()=>{
    document.querySelectorAll('[data-icon]').forEach(el=>{
      const name=el.dataset.icon;
      el.replaceWith(document.createRange().createContextualFragment(icon(name)));
    });
  };

  const setLogoTheme=dark=>{
    document.documentElement.dataset.theme=dark?'dark':'light';
  };

  const updateTheme=dark=>{
    settings={...settings,darkMode:dark===true};
    applyTheme(settings.darkMode);
    setLogoTheme(settings.darkMode);
  };

  updateTheme(settings.darkMode);
  watchTheme(dark=>{
    updateTheme(dark);
    const toggle=$('#darkMode');
    if(toggle) toggle.checked=dark;
  });
  renderIcons();

  const toggle=$('#darkMode');
  if(toggle){
    toggle.checked=settings.darkMode===true;
    toggle.addEventListener('change',async()=>{
      settings={...settings,darkMode:toggle.checked};
      updateTheme(toggle.checked);
      await saveSettings(settings);
    });
  }

  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs[0];
  let isSalesforce=false;
  try{
    const u=new URL(tab?.url||'');
    const hosts=['salesforce.com','lightning.force.com','my.salesforce.com','visualforce.com','vf.force.com'];
    isSalesforce=u.protocol==='https:'&&hosts.some(s=>u.hostname===s||u.hostname.endsWith('.'+s));
  }catch{}

  if(isSalesforce){
    $('#connectionTitle').textContent='Salesforce';
    $('#connectionDetail').textContent='Current tab is supported';
    $('#statusDot').className='status-dot good';
  }else{
    $('#connectionTitle').textContent='Not a Salesforce page';
    $('#connectionDetail').textContent='Open Salesforce to use ForcePilot';
    $('#statusDot').className='status-dot bad';
    $('#open').disabled=true;
    $('#open').setAttribute('aria-disabled','true');
    $('#openLabel').textContent='Available on Salesforce';
  }

  $('#open').onclick=async()=>{
    if(!isSalesforce||!tab?.id)return;
    try{await chrome.sidePanel.open({tabId:tab.id});}catch{}
  };
  $('#manage').onclick=()=>chrome.runtime.openOptionsPage();
})().catch(()=>{});
