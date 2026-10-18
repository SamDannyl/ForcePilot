/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

import { getRecordings, getSettings, saveRecordings, saveSettings, escapeHtml } from './src/shared-module.js';
import { icon } from './src/material-icons.js';
import { applyTheme, watchTheme } from './src/theme.js';
import {
  parseTestCasePaste, createTestingSession, createEvidenceOnlyTestingSession, loadTestingSessionSummaries, loadTestingSessionById, saveTestingSession, summarizeTestingSession, TESTING_UI_STATE_KEY,
  deleteTestingSession, putEvidenceBlob, getEvidenceBlob, deleteEvidenceBlob
} from './src/testing.js';
import { buildTestingDocx, downloadTestingDocx, getTestingDocxFilename } from './src/docx-export.js';
import { buildTestingEvidenceZip, downloadTestingZip, getTestingZipFilename } from './src/testing-zip-export.js';
import { showToast } from './src/toast.js';

// JSZip is relatively large and is needed only for evidence exports. Load the
// locally bundled library on demand and share the in-flight promise across exports.
let jsZipLoadPromise = null;
function ensureJSZipLoaded(){
  if (typeof globalThis.JSZip === 'function') return Promise.resolve(globalThis.JSZip);
  if (jsZipLoadPromise) return jsZipLoadPromise;
  jsZipLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/vendor/jszip.min.js');
    script.async = true;
    script.onload = () => {
      if (typeof globalThis.JSZip === 'function') resolve(globalThis.JSZip);
      else { jsZipLoadPromise = null; reject(new Error('The local ZIP engine did not initialize.')); }
    };
    script.onerror = () => {
      jsZipLoadPromise = null;
      reject(new Error('The local ZIP engine could not be loaded.'));
    };
    (document.head || document.documentElement).appendChild(script);
  });
  return jsZipLoadPromise;
}

const app = document.getElementById('app');
const FIRST_RUN_TOUR_KEY = 'forcepilot.firstRunTour.seen.v1';
const TESTING_FIRST_RUN_TOUR_KEY = 'forcepilot.testingFirstRunTour.seen.v1';
let testingUiSaveTimer = null;
let stopRecordingPromise = null;
let liveRecordingRevision = 0;
let suppressRecordingStorageRender = false;
let liveRecordingMutationInFlight = false;

// Keep a live connection so the service worker can tell whether the ForcePilot
// side panel is actually open without performing an async state query before a
// keyboard command. The panel itself owns the close operation.
let forcePilotPresencePort = null;
let forcePilotPresenceReconnectTimer = null;

function closeForcePilotPanelFromCommand(){
  try{ window.close(); }catch{}
  // Chrome's side-panel page supports window.close() as the self-close mechanism.
  // Keep a newer-API fallback for environments where window.close() is ignored.
  try{
    if(typeof chrome.sidePanel?.close==='function'){
      chrome.sidePanel.close().catch(()=>{});
    }
  }catch{}
}

function connectForcePilotPresence(){
  if(forcePilotPresencePort) return;
  try{
    const port=chrome.runtime.connect({name:'forcepilot-sidepanel'});
    forcePilotPresencePort=port;
    port.onMessage.addListener(message=>{
      if(message?.type==='FORCEPILOT_CLOSE') {
        closeForcePilotPanelFromCommand();
        return;
      }
    });
    port.onDisconnect.addListener(()=>{
      if(forcePilotPresencePort!==port) return;
      forcePilotPresencePort=null;
      if(forcePilotPresenceReconnectTimer) clearTimeout(forcePilotPresenceReconnectTimer);
      forcePilotPresenceReconnectTimer=setTimeout(()=>{
        forcePilotPresenceReconnectTimer=null;
        connectForcePilotPresence();
      },500);
    });

    Promise.resolve()
      .then(()=>chrome.windows?.getCurrent ? chrome.windows.getCurrent() : null)
      .then(win=>{
        const windowId=Number(win?.id||0);
        if(windowId) port.postMessage({type:'FORCEPILOT_PANEL_READY',windowId});
      })
      .catch(()=>{});
  }catch{
    forcePilotPresencePort=null;
  }
}

chrome.runtime.onMessage.addListener((message)=>{
  if(message?.type==='FORCEPILOT_CLOSE') closeForcePilotPanelFromCommand();
  if(message?.type==='FORCEPILOT_TESTING_EVIDENCE_SAVED') {
    void refreshTestingEvidenceAfterBackgroundCapture(String(message.sessionId||''));
  }
});

async function refreshTestingEvidenceAfterBackgroundCapture(sessionId){
  if(!sessionId || state.testingSession?.id!==sessionId) return;
  try{
    const latest=await loadTestingSessionById(sessionId);
    if(!latest) return;
    state.testingSession=latest;
    const summary=summarizeTestingSession(latest);
    state.testingSessions=[summary,...(state.testingSessions||[]).filter(item=>item.id!==sessionId)].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    await loadTestingEvidenceUrls();
    state.testingGeneralEvidenceExpanded=true;
    render();
  }catch{}
}

connectForcePilotPresence();
window.addEventListener('pagehide',()=>{
  if(forcePilotPresenceReconnectTimer) clearTimeout(forcePilotPresenceReconnectTimer);
  forcePilotPresenceReconnectTimer=null;
  try{forcePilotPresencePort?.disconnect();}catch{}
  forcePilotPresencePort=null;
});
const LAST_RUN_KEY = 'forcepilot.lastRun.v1';
const state = {
  context: null,
  salesforcePageDetected: false,
  forcePilotConnected: false,
  salesforceStatusMessage: '',
  tabId: null,
  windowId: null,
  incognito: false,
  recordings: {},
  selectedId: null,
  recording: false,
  recordingPaused: false,
  run: null,
  filter: '',
  fillEmptyOnly: true,
  recordingTabId: null,
  resultTab: 'all',
  activeSteps: [],
  activeLookupCreation: null,
  view: 'home',
  editing: false,
  draft: null,
  progress: { current: 0, total: 0 },
  refreshing: false,
  darkMode: false,
  addingToRecordingId: null,
  pendingRecording: null,
  pendingRecordingTabId: null,
  saveNameError: '',
  inlineMessage: '',
  isRetrying: false,
  selectionMode: false,
  selectedStepIndexes: new Set(),
  expandedRandomizationEditors: new Set(),
  testingSession: null,
  testingSessions: [],
  testingShowAllSessions: false,
  testingSessionSearch: '',
  testingSessionMenuOpen: false,
  testingStatusMenuId: null,
  testingNoteOpenId: null,
  testingPasteText: '',
  testingPasteError: '',
  testingMessage: '',
  testingMessageError: false,
  testingCaptureBusy: false,
  testingAssociatingEvidenceId: null,
  testingAutofillBusy: false,
  testingAutofillPickerOpen: false,
  testingAutofillQuery: '',
  testingAutofillActive: false,
  testingCollapsedCases: new Set(),
  testingExpandedEvidence: new Set(),
  testingActiveCaseId: null,
  testingGeneralEvidenceExpanded: false,
  testingOpenMenu: null,
  testingExportBusy: false,
  testingExportStage: '',
  testingExportError: '',
  testingExportCompleted: false,
  testingExportFilename: '',
  testingExportBlob: null,
  testingZipBusy: false,
  testingZipStage: '',
  testingZipError: '',
  testingZipCompleted: false,
  testingZipFilename: '',
  testingZipBlob: null,
  testingConfirmDialog: null,
  testingEvidenceNameDialog: null,
  testingEvidenceNameInput: '',
  testingEvidenceNameError: '',
  testingSessionNameEditing: false,
  testingEditingExistingSession: false,
  firstRunOpen: false,
  testingFirstRunOpen: false,
  testingUiHydrated: false,
};

const clone = v => JSON.parse(JSON.stringify(v));
const setGuardedInterval = (fn, ms) => {
  let inFlight = false;
  return setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try { await fn(); } finally { inFlight = false; }
  }, ms);
};
const fmtValue = v => Array.isArray(v)
  ? (v.join(', ') || '—')
  : v && typeof v === 'object'
    ? ('displayValue' in v ? (v.displayValue || '—') : Object.values(v).filter(x => x !== '' && x != null).join(' · '))
    : (String(v ?? '') || '—');
const fmtStepValue = s => {
  const t = fieldTypeLabel(s);
  if (t === 'Currency' || t === 'Percent' || t === 'Number') return cleanNumber(s?.value);
  return t === 'Date' ? dateFieldDisplay(s) : fmtValue(s?.value);
};
const cleanNumber = v => { const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? String(Number(m[0])) : String(v ?? '').trim(); };
const rawTypes = s => [s?.target?.fieldType,s?.target?.sfDataType,s?.target?.salesforceType,s?.target?.type].map(v=>String(v||'').toLowerCase()).filter(Boolean);
const fieldTypeLabel = s => {
  const raws=rawTypes(s),r=raws.find(v=>!['text','string','field','input'].includes(v))||String(s?.target?.kind||'').toLowerCase();
  if (raws.includes('currency')) return 'Currency';
  if (raws.includes('percent')) return 'Percent';
  if (r === 'boolean' || r === 'checkbox' || s?.target?.kind === 'boolean') return 'Checkbox';
  if (r === 'multipicklist' || r === 'multi-picklist' || r.includes('multi') || s?.target?.kind === 'multi-picklist') return 'Multipicklist';
  if (r === 'picklist' || r === 'combobox' || r.includes('picklist') || s?.target?.kind === 'picklist') return 'Picklist';
  if (r === 'date' || s?.target?.kind === 'date') return 'Date';
  if (r === 'datetime' || r === 'date/time' || s?.target?.kind === 'datetime') return 'Date/Time';
  if (r === 'time' || s?.target?.kind === 'time') return 'Time';
  if (r === 'email' || s?.target?.sfDataType === 'email') return 'Email';
  if (r === 'phone' || s?.target?.sfDataType === 'phone') return 'Phone';
  if (r === 'url' || s?.target?.sfDataType === 'url') return 'URL';
  if (['textarea','longtext','longtextarea','richtext'].includes(r) || s?.target?.kind === 'longText') return 'Long Text';
  if (r === 'address' || s?.target?.kind === 'address' || s?.target?.fieldType === 'address') return 'Address';
  if (['double','int','integer','long','decimal','number'].includes(r) || r.includes('number') || s?.target?.kind === 'number') return 'Number';
  if (r === 'reference' || r === 'lookup' || s?.target?.reference || s?.target?.kind === 'lookup') return 'Lookup';
  return 'Text';
};
const fieldTypeDisplay = s => {
  const workflow=s?.meta?.createNewRecord;
  return fieldTypeLabel(s)==='Lookup' && workflow && Array.isArray(workflow.fields)
    ? `Lookup + New (${workflow.fields.length})`
    : fieldTypeLabel(s);
};
const fieldTypeDisplayTitle = s => {
  const workflow=s?.meta?.createNewRecord;
  return workflow && Array.isArray(workflow.fields)
    ? `Creates a new ${workflow.objectLabel || 'record'} and fills ${workflow.fields.length} recorded field${workflow.fields.length===1?'':'s'}`
    : fieldTypeLabel(s);
};
const statusOf = x => x?.result?.status || (x?.result?.ok ? 'filled' : 'failed');
const valuesArray = v => Array.isArray(v) ? v : String(v ?? '').split(/\s*;\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
const cleanEditedValue = (s, v) => { const t = fieldTypeLabel(s); return ['Currency','Percent','Number'].includes(t) ? cleanNumber(v) : v; };
const localDateISO = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const dateAtLocalMidnight = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null; const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3])); return Number.isNaN(d.getTime()) ? null : d; };
const dateOffsetDays = (fromISO, toISO) => { const from = dateAtLocalMidnight(fromISO), to = dateAtLocalMidnight(toISO); return from && to ? Math.round((to.getTime()-from.getTime())/86400000) : null; };
const dateOffsetLabel = offset => { const n = Number(offset); if (!Number.isFinite(n)) return ''; if (n === 0) return 'Today'; return `Today ${n > 0 ? '+' : '-'} ${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`; };
const parseRelativeDate = value => { const s = String(value ?? '').trim().toLowerCase().replace(/\s+/g,' '); if (s === 'today') return 0; const m = s.match(/^today\s*([+-])\s*(\d+)\s*days?$/); if (!m) return null; return (m[1] === '-' ? -1 : 1) * Number(m[2]); };
const dateFieldDisplay = s => { const meta = s?.meta || {}; if (meta.dateMode === 'relative' && Number.isFinite(Number(meta.dateOffsetDays))) return String(meta.dateExpression || dateOffsetLabel(meta.dateOffsetDays)); return String(s?.value ?? ''); };
const shiftDateFrom = (baseISO, offset) => { const d = dateAtLocalMidnight(baseISO) || new Date(); d.setDate(d.getDate() + Number(offset)); return localDateISO(d); };
const typeOptions = s => Array.isArray(s?.target?.options) ? s.target.options : [];
const isAggregatePicklistText = (value, fieldLabel='') => {
  const raw=String(value??'').trim();
  const norm=s=>String(s??'').toLowerCase().replace(/\s+/g,' ').trim();
  const label=norm(fieldLabel),n=norm(raw);
  return !!raw && (/help\s*info/i.test(raw) || (label && n.startsWith(label) && n.length>label.length+8));
};
const recoverPicklistLabel = (value, fieldLabel, options=[]) => {
  const raw=String(value??'').trim();
  if(!isAggregatePicklistText(raw,fieldLabel))return value;
  const normal=s=>String(s??'').toLowerCase().replace(/\s+/g,' ').trim();
  const candidates=(options||[]).map(o=>({value:String(o?.value??''),label:String(o?.displayValue??o?.label??o?.value??'').trim()})).filter(o=>o.label)
    .filter(o=>normal(raw).endsWith(normal(o.label))).sort((a,b)=>b.label.length-a.label.length);
  if(!candidates.length)return value;
  const longest=candidates[0].label;
  const equallyLong=[...new Set(candidates.filter(o=>o.label.length===longest.length&&normal(o.label)===normal(longest)).map(o=>o.label))];
  return equallyLong.length===1?longest:value;
};
const humanizeObjectApiName = value => {
  const raw=String(value||'').trim();
  if(!raw || /^salesforce$/i.test(raw)) return '';
  const objectName=(raw.replace(/__c$/i,'').split('__').pop()||raw);
  return objectName.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim();
};
const cleanObjectLabel = value => String(value||'').trim().replace(/^\s*[*.•·]+\s*/,'').replace(/\s+/g,' ');
const objectLabel = c => {
  const api=String(c?.objectApiName||'').trim();
  const raw=cleanObjectLabel(c?.objectLabelPlural||c?.objectLabel||c?.label||'');
  if(raw && !/^Salesforce$/i.test(raw) && !/^(recently viewed|home)$/i.test(raw) && !/[|]/.test(raw) && !/\brecently viewed\b/i.test(raw)) return raw;
  return api && api!=='Salesforce' ? humanizeObjectApiName(api) : 'Salesforce';
};
const recordingTitle = r => {
  // The name entered in the Save Recording prompt is the canonical recording title.
  // Never replace it with the Salesforce object label just because the context has one.
  const name=String(r?.name||'').trim();
  if(name && !/^salesforce$/i.test(name) && !/^(recently viewed|home)$/i.test(name) && !/[|]/.test(name)) return name;
  const label=cleanObjectLabel(r?.context?.objectLabel||r?.context?.objectLabelPlural||'');
  if(label && !/^salesforce$/i.test(label) && !/^(recently viewed|home)$/i.test(label) && !/[|]/.test(label)) return label;
  const api=String(r?.context?.objectApiName||'').trim();
  return humanizeObjectApiName(api) || 'Recording';
};
const recordingMeta = r => `${r?.steps?.length || 0} field${r?.steps?.length===1?'':'s'}`;

function renderFirstRunOverlay() {
  return `<div class="first-run-overlay" id="firstRunOverlay" role="presentation">
    <div class="first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="firstRunTitle" aria-describedby="firstRunMessage">
      <div class="first-run-kicker">ForcePilot</div>
      <h2 id="firstRunTitle">Welcome to ForcePilot</h2>
      <p class="first-run-intro" id="firstRunMessage">Record Salesforce changes, reuse them with Autofill, and keep your testing work organized in one place.</p>
      <div class="first-run-items">
        <div class="first-run-item"><strong>Testing Sessions</strong><span>Organize scenarios, capture screenshots, add notes, and track Pass, Fail, or Blocked results.</span></div>
        <div class="first-run-item"><strong>Record &amp; Review</strong><span>Record Salesforce field changes, review captured values, and edit recordings before saving.</span></div>
        <div class="first-run-item"><strong>Save &amp; Autofill</strong><span>Reuse saved recordings on compatible Salesforce records. Use saved values or configured randomization.</span></div>
      </div>
      <div class="first-run-shortcut"><span>Open/Close ForcePilot</span><strong>Shortcut: Alt + X</strong></div>
      <p class="first-run-replay-note">You can find this tour again in Settings.</p>
      <button class="primary first-run-start" id="firstRunGetStarted" type="button">Get Started</button>
    </div>
  </div>`;
}

function renderTestingFirstRunOverlay() {
 return `<div class="first-run-overlay" id="testingFirstRunOverlay" role="presentation"><div class="first-run-dialog testing-first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="testingFirstRunTitle"><div class="first-run-kicker">WELCOME</div><h2 id="testingFirstRunTitle">Welcome to Testing!</h2><p class="first-run-intro">Run scenario-based tests or quick checks. Capture screenshots, add notes, and track results in one place.</p><div class="first-run-items"><div class="first-run-item"><strong>1. Choose Testing Mode</strong><span>Use <b>Scenarios</b> to organize test cases or <b>Quick Testing</b> for standalone checks.</span></div><div class="first-run-item"><strong>2. Select a Scenario</strong><span>Choose a scenario to link screenshots, or use its camera or paste option.</span></div><div class="first-run-item"><strong>3. Capture Screenshots</strong><span>Click <b>Screenshot</b> or press <b>Alt + S</b>. For clean captures, close ForcePilot with <b>Alt + X</b>, take the screenshot, then reopen it. Add expected and actual behavior notes.</span></div><div class="first-run-item"><strong>4. Track Results</strong><span>Mark each scenario <b>Pass, Fail, or Blocked</b>.</span></div><div class="first-run-item"><strong>5. Export Evidence</strong><span>Export screenshots and notes to Word (.docx) or download screenshots as a ZIP.</span></div></div><p class="first-run-replay-note">You're all set!</p><button class="primary first-run-start" id="testingFirstRunGetStarted" type="button">Got it, Start Testing</button></div></div>`;
}
async function maybeShowTestingFirstRunTour() { try { const data = await chrome.storage.local.get(TESTING_FIRST_RUN_TOUR_KEY); if (!data?.[TESTING_FIRST_RUN_TOUR_KEY]) state.testingFirstRunOpen = true; } catch { state.testingFirstRunOpen = true; } }
async function dismissTestingFirstRunTour() { state.testingFirstRunOpen = false; try { await chrome.storage.local.set({ [TESTING_FIRST_RUN_TOUR_KEY]: true }); } catch {} render(); }

async function dismissFirstRunTour() {
  state.firstRunOpen = false;
  try { await chrome.storage.local.set({ [FIRST_RUN_TOUR_KEY]: true }); } catch {}
  render();
}

async function showFirstRunTour() {
  state.firstRunOpen = true;
  render();
  requestAnimationFrame(() => document.getElementById('firstRunGetStarted')?.focus());
}

async function initializeFirstRunTour() {
  try {
    const data = await chrome.storage.local.get(FIRST_RUN_TOUR_KEY);
    if (!data?.[FIRST_RUN_TOUR_KEY]) state.firstRunOpen = true;
  } catch {
    state.firstRunOpen = true;
  }
}

function applyMissingButtonTitles() {
  app.querySelectorAll('button:not([title])').forEach(button => {
    const label = String(button.getAttribute('aria-label') || button.innerText || button.textContent || '')
      .replace(/\s+/g, ' ').trim();
    if (label) button.title = label;
  });
}

function render() {
  const recs = Object.values(state.recordings)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter(r => `${recordingTitle(r)} ${r.name || ''} ${r.context?.objectApiName || ''}`.toLowerCase().includes(state.filter.toLowerCase()));
  const selected = state.selectedId ? state.recordings[state.selectedId] : null;
  const testingAutofillModalActive = !!state.testingSession && !!state.testingAutofillActive && (state.view === 'running' || state.view === 'result');
  const scrollTargets = [
    '.content',
    '#recording-field-list',
    '.testing-workspace-page',
    '.testing-workspace-scroll',
    '.testing-preview-workspace',
    '.testing-evidence-only-page .testing-general-evidence-body',
    '.testing-summary-body',
    '.result-page .result-list'
  ];
  const oldLiveList = document.querySelector('#recording-field-list');
  const hadLiveRecordingList = !!oldLiveList;
  const priorLiveStepCount = oldLiveList ? Number(oldLiveList.dataset.fpStepCount ?? state.activeSteps.length) : 0;
  const newLiveFieldCaptured = state.activeSteps.length > priorLiveStepCount;
  const preservedScroll = Object.fromEntries(scrollTargets.map(selector => {
    const el = document.querySelector(selector);
    return [selector, el ? { top: el.scrollTop, left: el.scrollLeft } : null];
  }));
  // Re-rendering the side panel replaces its DOM. Preserve all viewport scroll
  // coordinates too, so action clicks and evidence previews never jump to top.
  const preservedViewport = {
    x: window.scrollX || 0,
    y: window.scrollY || 0,
    documentTop: document.documentElement?.scrollTop || 0,
    bodyTop: document.body?.scrollTop || 0
  };
  const body = testingAutofillModalActive
    ? renderTestingAutofillOverlay()
    : state.view === 'recording' || state.recording
      ? renderRecording()
      : state.view === 'save-name' && state.pendingRecording
        ? renderSaveNamePrompt()
        : state.view === 'running'
          ? renderRunning()
          : state.view === 'result' && state.run
            ? renderResult()
            : String(state.view || '').startsWith('testing-')
              ? renderTesting()
              : state.view === 'detail' && selected
                ? renderDetail(selected)
                : renderHome(recs);
  app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><img class="brandmark" src="branding/forcepilot-icon.png" alt="ForcePilot"><img class="wordmark" src="branding/forcepilot-wordmark.png" alt="ForcePilot"></div><div class="header-actions"><button class="iconbtn refresh-btn${state.refreshing ? ' is-loading' : ''}" id="refreshHeader" type="button" title="Refresh ForcePilot" aria-label="Refresh ForcePilot" ${state.refreshing ? 'disabled aria-busy="true"' : ''}>${icon('refresh')}</button><button class="iconbtn theme-toggle-btn" id="toggleDarkMode" type="button" title="${state.darkMode ? 'Switch to light mode' : 'Switch to dark mode'}" aria-label="${state.darkMode ? 'Switch to light mode' : 'Switch to dark mode'}" aria-pressed="${state.darkMode ? 'true' : 'false'}">${icon('darkMode')}</button><button class="iconbtn settings-btn" id="settings" type="button" title="Settings" aria-label="Settings">${icon('settings')}</button></div></header><main class="content">${body}</main>${state.testingEvidenceNameDialog ? renderEvidenceNameDialog() : ''}${state.testingConfirmDialog ? renderTestingConfirmDialog() : ''}</div>${state.firstRunOpen ? renderFirstRunOverlay() : ''}${state.testingFirstRunOpen && state.view === 'testing-dashboard' ? renderTestingFirstRunOverlay() : ''}`;
  applyMissingButtonTitles();
  const initialLiveList = document.getElementById('recording-field-list'); if (initialLiveList) { initialLiveList.dataset.fpRenderSignature = liveStepsRenderSignature(state.activeSteps); initialLiveList.dataset.fpStepCount = String(state.activeSteps.length); }
  scheduleTestingUiStateSave();
  document.body.classList.toggle('testing-modal-open', testingAutofillModalActive || state.testingAutofillPickerOpen || !!state.testingAssociatingEvidenceId || !!state.testingEvidenceNameDialog || !!state.testingConfirmDialog || state.firstRunOpen || state.testingFirstRunOpen);
  bind();
  const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (modal && (state.firstRunOpen || state.testingFirstRunOpen || state.testingConfirmDialog || state.testingAutofillPickerOpen || state.testingAssociatingEvidenceId || state.testingEvidenceNameDialog)) {
    requestAnimationFrame(() => {
      if (state.firstRunOpen) document.getElementById('firstRunGetStarted')?.focus({ preventScroll: true });
      else if (state.testingFirstRunOpen) document.getElementById('testingFirstRunGetStarted')?.focus({ preventScroll: true });
      else if (state.testingEvidenceNameDialog) document.getElementById('testingEvidenceName')?.focus({ preventScroll: true });
      else if (state.testingConfirmDialog) document.getElementById('acceptTestingConfirm')?.focus({ preventScroll: true });
      else if (state.testingAutofillPickerOpen) document.getElementById('testingAutofillSearch')?.focus({ preventScroll: true });
      else document.getElementById('closeAssociateDialog')?.focus({ preventScroll: true });
    });
  }
  document.onkeydown = event => {
    const activeModal = document.querySelector('[role="dialog"][aria-modal="true"]');
    const statusMenu = document.querySelector('.testing-status-menu');
    if (!activeModal && state.testingStatusMenuId && statusMenu?.contains(document.activeElement) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = [...statusMenu.querySelectorAll('[role="menuitem"]')];
      const currentIndex = items.indexOf(document.activeElement);
      if (items.length) {
        event.preventDefault();
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1 + items.length) % items.length : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus({ preventScroll: true });
      }
      return;
    }
    if (!activeModal && event.key === 'Escape' && state.testingStatusMenuId) {
      const caseId = state.testingStatusMenuId;
      state.testingStatusMenuId = null;
      render();
      requestAnimationFrame(() => document.querySelector(`[data-open-testing-status="${CSS.escape(caseId)}"]`)?.focus({ preventScroll: true }));
      return;
    }
    if (!activeModal) return;
    if (event.key === 'Escape') {
      const close = activeModal.querySelector('#firstRunGetStarted, #testingFirstRunGetStarted, #cancelTestingEvidenceName, #cancelTestingEvidenceNameAction, #cancelTestingConfirm, #closeAssociateDialog, #closeTestingAutofill, .testing-image-preview-close');
      if (close) { event.preventDefault(); close.click(); }
    } else if (event.key === 'Tab') {
      const focusable = [...activeModal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  requestAnimationFrame(() => {
    scrollTargets.forEach(selector => {
      const saved = preservedScroll[selector];
      const el = document.querySelector(selector);
      if (selector === '#recording-field-list' && el && (newLiveFieldCaptured || (!hadLiveRecordingList && state.activeSteps.length))) {
        // Follow a newly captured field even when an app action caused a full
        // render. Otherwise restore the user's manual scroll position exactly.
        el.scrollTop = el.scrollHeight;
      } else if (el && saved && Number.isFinite(saved.top)) {
        el.scrollTop = saved.top;
        el.scrollLeft = saved.left || 0;
      }
    });
    if (window.scrollY !== preservedViewport.y || window.scrollX !== preservedViewport.x) {
      window.scrollTo({ left: preservedViewport.x, top: preservedViewport.y, behavior: 'instant' });
    }
    if (document.documentElement && document.documentElement.scrollTop !== preservedViewport.documentTop) document.documentElement.scrollTop = preservedViewport.documentTop;
    if (document.body && document.body.scrollTop !== preservedViewport.bodyTop) document.body.scrollTop = preservedViewport.bodyTop;
    if (String(state.view || '').startsWith('testing-')) autoResizeTestingTextareas();
    positionTestingStatusMenu();
  });
}

function renderHome(recs) {
  const c = state.context;
  const currentObject = c ? objectLabel(c) : 'Salesforce';
  const sfStatus = state.forcePilotConnected
    ? `<div class="salesforce-connection-inline is-connected" role="status"><span class="salesforce-status-dot" aria-hidden="true"></span><strong>Connected</strong><span class="salesforce-status-separator" aria-hidden="true">·</span><span>Salesforce</span></div>`
    : state.salesforcePageDetected
      ? `<div class="salesforce-connection-inline is-warning" role="status"><span class="salesforce-status-dot" aria-hidden="true"></span><strong>Salesforce page detected</strong><span class="salesforce-status-separator" aria-hidden="true">·</span><span>${escapeHtml(state.salesforceStatusMessage || 'Refresh to reconnect')}</span></div>`
      : `<div class="salesforce-connection-inline is-warning" role="status"><span class="salesforce-status-dot" aria-hidden="true"></span><strong>Not connected</strong><span class="salesforce-status-separator" aria-hidden="true">·</span><span>Open a Salesforce page</span></div>`;
  const other = state.recordingTabId && state.recordingTabId !== state.tabId;
  const hasRecordings = Object.keys(state.recordings).length > 0;
  const hasMatches = recs.length > 0;
  return `<section class="home-page-context">
    <div class="eyebrow">Current page</div>
    <div class="context-title">${escapeHtml(currentObject)}</div>
    ${sfStatus}
  </section>
  ${other ? '<div class="notice"><strong>Recording is active in another tab.</strong><span>Use that tab to stop the recording.</span></div>' : ''}
  <div class="home-actions actions home-actions-inline">
    <button class="primary full-action" id="record" ${(!c || !state.forcePilotConnected || other) ? 'disabled' : ''}><span class="button-icon" aria-hidden="true">${icon('play')}</span>Record</button>
    <button class="secondary full-action testing-home-action" id="startTesting"><span class="button-icon" aria-hidden="true">${icon('checklist')}</span><span>Testing</span></button>
  </div>
  <section class="section recent-section">
    <div class="section-title-row"><div class="section-title-with-icon"><span class="section-title-icon" aria-hidden="true">${icon('folder')}</span><h2>Saved recordings</h2></div><span class="section-count">${recs.length}</span></div>
    ${hasRecordings ? `<input class="search" id="search" placeholder="Search recordings…" value="${escapeHtml(state.filter)}" aria-label="Search recordings"><div class="list">${hasMatches ? recs.slice(0,12).map(r => `<button class="recording-row" data-id="${escapeHtml(r.id)}"><span class="row-main"><span class="recording-name">${escapeHtml(recordingTitle(r))}</span><span class="row-meta">${escapeHtml(recordingMeta(r))}</span></span><span class="row-chevron" aria-hidden="true">${icon('arrowRight')}</span></button>`).join('') : `<div class="empty-state"><strong>No recordings match</strong><span>Try a different search term.</span></div>`}</div>` : `<div class="empty-state"><strong>No Saved Recordings</strong><span>Record Salesforce field changes to create your first recording.</span></div>`}
  </section>`;
}

function renderTestingConfirmDialog() {
  const d = state.testingConfirmDialog;
  if (!d) return '';
  return `<div class="testing-dialog-backdrop" role="presentation"><div class="testing-dialog testing-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="testingConfirmTitle" aria-describedby="testingConfirmMessage"><div class="testing-dialog-header"><div><h2 id="testingConfirmTitle">${escapeHtml(d.title || 'Confirm action')}</h2></div><button class="iconbtn" id="cancelTestingConfirm" type="button" aria-label="Cancel">${icon('close')}</button></div><div class="testing-dialog-list"><p id="testingConfirmMessage">${escapeHtml(d.message || 'Are you sure?')}</p><div class="testing-lifecycle-actions"><button class="${d.danger === false ? 'primary' : 'danger'} action-button" id="acceptTestingConfirm" type="button">${escapeHtml(d.confirmLabel || 'Confirm')}</button><button class="secondary action-button" id="cancelTestingConfirmAction" type="button">${escapeHtml(d.cancelLabel || 'Cancel')}</button></div></div></div></div>`;
}

function requestTestingConfirm({ title = 'Confirm action', message = 'Are you sure?', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise(resolve => {
    state.testingConfirmDialog = { title, message, confirmLabel, cancelLabel, danger, resolve };
    render();
  });
}

function resolveTestingConfirm(value) {
  const dialog = state.testingConfirmDialog;
  if (!dialog) return;
  state.testingConfirmDialog = null;
  dialog.resolve(!!value);
  render();
}

function testingUpdatedLabel(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'unknown';
}

function renderEvidenceNameDialog() {
  const mode = state.testingEvidenceNameDialog?.mode || 'start';
  const isExport = mode === 'export-word' || mode === 'export-zip';
  const isFinish = mode === 'finish';
  const title = isExport ? 'Name export file' : 'Name your evidence session';
  const hasMultipleWorkProducts = (state.testingSession?.sourceWorkProducts || []).length > 1;
  const message = isExport
    ? (hasMultipleWorkProducts
      ? 'Multiple Work Products were detected. Enter the filename to use for this export and future exports in this session.'
      : 'No Work Product was detected. Enter the filename to use for this export and future exports in this session.')
    : 'This name will be used for the exported .docx and .zip files.';
  const value = state.testingEvidenceNameInput || '';
  const error = state.testingEvidenceNameError ? `<div class="testing-name-error" id="testingEvidenceNameError" role="alert">${escapeHtml(state.testingEvidenceNameError)}</div>` : '';
  const confirmLabel = isExport ? 'Use filename' : mode === 'name-existing-session' ? 'Save name' : isFinish ? 'Save & finish' : 'Start session';
  const helpText = mode === 'export-word'
    ? 'The .docx extension is added automatically.'
    : mode === 'export-zip'
      ? 'The .zip extension is added automatically.'
      : 'The .docx and .zip extensions are added automatically.';
  return `<div class="testing-dialog-backdrop testing-name-dialog-backdrop" role="presentation">
    <div class="testing-dialog testing-name-dialog" role="dialog" aria-modal="true" aria-labelledby="testingEvidenceNameTitle" aria-describedby="testingEvidenceNameDescription">
      <div class="testing-dialog-header"><div><h2 id="testingEvidenceNameTitle">${escapeHtml(title)}</h2><p id="testingEvidenceNameDescription">${message}</p></div><button class="iconbtn" id="cancelTestingEvidenceName" type="button" aria-label="Close">${icon('close')}</button></div>
      <div class="testing-name-dialog-body">
        <label class="testing-name-field" for="testingEvidenceName"><span>File name</span><input id="testingEvidenceName" type="text" value="${escapeHtml(value)}" maxlength="160" autocomplete="off" placeholder="e.g. US#" aria-describedby="testingEvidenceNameHelp${state.testingEvidenceNameError ? ' testingEvidenceNameError' : ''}" ${state.testingEvidenceNameError ? 'aria-invalid="true"' : ''}></label>
        <div class="testing-name-help" id="testingEvidenceNameHelp">${helpText}</div>${error}
      </div>
      <div class="testing-name-actions"><button class="secondary action-button" id="cancelTestingEvidenceNameAction" type="button">Cancel</button><button class="primary action-button" id="confirmTestingEvidenceName" type="button">${confirmLabel}</button></div>
    </div>
  </div>`;
}

function openEvidenceNameDialog(mode, initialValue = '') {
  const allowedModes = ['start', 'start-test-cases', 'name-existing-session', 'finish', 'export-word', 'export-zip'];
  state.testingEvidenceNameDialog = { mode: allowedModes.includes(mode) ? mode : 'start' };
  state.testingEvidenceNameInput = String(initialValue || '');
  state.testingEvidenceNameError = '';
  render();
  requestAnimationFrame(() => document.getElementById('testingEvidenceName')?.focus());
}

function closeEvidenceNameDialog() {
  const mode = state.testingEvidenceNameDialog?.mode;
  state.testingEvidenceNameDialog = null;
  state.testingEvidenceNameInput = '';
  state.testingEvidenceNameError = '';
  if (mode === 'start') state.view = 'testing-paste';
  if (mode === 'start-test-cases') {
    state.testingSession = null;
    state.view = 'testing-paste';
  }
  state.testingSessionNameEditing = false;
  render();
}

async function confirmEvidenceNameDialog() {
  const mode = state.testingEvidenceNameDialog?.mode || 'start';
  const name = String(state.testingEvidenceNameInput || '').trim().replace(/\.(?:docx|zip)$/i, '');
  if (!name) {
    state.testingEvidenceNameError = 'Enter a file name to continue.';
    render();
    requestAnimationFrame(() => document.getElementById('testingEvidenceName')?.focus());
    return;
  }
  state.testingEvidenceNameError = '';
  state.testingEvidenceNameDialog = null;
  state.testingEvidenceNameInput = '';

  if (mode === 'start') {
    await createAndStartEvidenceOnlySession(name);
  } else if (mode === 'start-test-cases') {
    const session = state.testingSession;
    if (!session) { state.view = 'testing-paste'; render(); return; }
    session.sessionName = name;
    session.exportFilename = name;
    await continueImportedTestingSession();
  } else if (mode === 'name-existing-session') {
    if (!state.testingSession) { state.view = 'testing-dashboard'; render(); return; }
    state.testingSession.sessionName = name;
    state.testingSession.exportFilename = name;
    await persistTestingSession();
    state.view = 'testing-workspace';
    await loadTestingEvidenceUrls();
    render();
  } else if (mode === 'finish') {
    if (!state.testingSession) { state.view = 'home'; render(); return; }
    state.testingSession.sessionName = name;
    state.testingSession.exportFilename = name;
    await persistTestingSession();
    await completeTestingSession();
  } else {
    if (!state.testingSession) return;
    state.testingSession.exportFilename = name;
    await persistTestingSession();
    if (mode === 'export-word') await exportTestingSessionWord();
    else await exportTestingSessionZip();
  }
}

function handleEvidenceNameKeydown(event) {
  if (!state.testingEvidenceNameDialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeEvidenceNameDialog(); return; }
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); confirmEvidenceNameDialog(); }
}

const testingObjectUrls = new Map();

function testingCaseEvidence(session, testCaseId) {
  return (session?.evidence || []).filter(item => item.testCaseId === testCaseId);
}

function testingUnassociatedEvidence(session) {
  const caseIds = new Set((session?.testCases || []).map(tc => tc.id));
  return (session?.evidence || []).filter(item => !item.testCaseId || !caseIds.has(item.testCaseId));
}

function testingCaseLabel(session, testCaseId) {
  if (!testCaseId) return 'Unassigned';
  const tc = (session?.testCases || []).find(item => item.id === testCaseId);
  return tc?.title || 'Unassigned';
}

async function loadTestingEvidenceUrls() {
  const session = state.testingSession;
  if (!session) return;
  await Promise.all((session.evidence || []).map(async evidence => {
    if (testingObjectUrls.has(evidence.id)) return;
    try {
      const blob = await getEvidenceBlob(evidence.imageBlobKey);
      if (blob) testingObjectUrls.set(evidence.id, URL.createObjectURL(blob));
    } catch {}
  }));
}

function revokeTestingObjectUrl(evidenceId) {
  const url = testingObjectUrls.get(evidenceId);
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch {}
  testingObjectUrls.delete(evidenceId);
}

async function persistTestingSession() {
  if (!state.testingSession) return;
  state.testingSession.updatedAt = new Date().toISOString();
  const saved = await saveTestingSession(state.testingSession);
  if (!saved) return;
  state.testingSession = saved;
  const summary = summarizeTestingSession(saved);
  const index = (state.testingSessions || []).findIndex(session => session.id === saved.id);
  if (index >= 0) state.testingSessions[index] = summary;
  else state.testingSessions = [summary, ...(state.testingSessions || [])];
  state.testingSessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function testingToast(message, kind = 'success') { showToast(message, { type: kind }); }
function testingError(message) { showToast(message || 'Something went wrong.', { type: 'error', duration: 3400 }); }

function testingSessionName(session) {
  return String(session?.sessionName || session?.workProduct || session?.exportFilename || '').trim();
}

function testingSessionMeta(session) {
  const captures = session?.evidence?.length || 0;
  if (isEvidenceOnlyTesting(session)) return `${captures} screenshot${captures === 1 ? '' : 's'}`;
  const cases = session?.testCaseCount ?? session?.testCases?.length ?? 0;
  return `${cases} scenario${cases === 1 ? '' : 's'} · ${captures} screenshot${captures === 1 ? '' : 's'}`;
}

function renderTestingDashboard() {
  const sessions = [...(state.testingSessions || [])].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const query = String(state.testingSessionSearch || '').trim().toLocaleLowerCase();
  // Session search intentionally matches the session name only. Counts,
  // timestamps, IDs, and mode are display metadata, not searchable content.
  const matchingSessions = query
    ? sessions.filter(session => String(testingSessionName(session) || 'Untitled testing session').trim().toLocaleLowerCase().includes(query))
    : sessions;
  const visibleSessions = state.testingShowAllSessions ? matchingSessions : matchingSessions.slice(0, 6);
  const rows = visibleSessions.map(session => {
      const name = testingSessionName(session) || 'Untitled testing session';
      const caseCount = Number(session.testCaseCount || 0);
      const screenshotCount = Number(session.evidenceCount || 0);
      const progress = session.mode === 'evidence-only'
        ? `${screenshotCount} screenshot${screenshotCount === 1 ? '' : 's'}`
        : `${caseCount} scenario${caseCount === 1 ? '' : 's'} · ${screenshotCount} screenshot${screenshotCount === 1 ? '' : 's'}`;
      return `<article class="testing-session-row" data-testing-session-row="${escapeHtml(session.id)}">
        <div class="testing-session-row-main">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(progress)}</span>
          <small>Last active: ${escapeHtml(testingUpdatedLabel(session.updatedAt))}</small>
        </div>
        <div class="testing-session-row-actions">
          <button class="secondary testing-resume-button" type="button" data-resume-testing-session="${escapeHtml(session.id)}">Resume</button>
          <button class="testing-session-delete" type="button" data-delete-testing-session="${escapeHtml(session.id)}" aria-label="Delete ${escapeHtml(name)}" title="Delete session">${icon('delete')}</button>
        </div>
      </article>`;
    }).join('');
  const emptyContent = sessions.length
    ? `<div class="empty-state"><strong>No sessions match</strong><span>Try a different search term.</span></div>`
    : `<div class="empty-state"><strong>No Saved Sessions</strong><span>Start a new session to begin testing.</span></div>`;
  const sessionList = sessions.length
    ? `<input class="search testing-session-search" id="testingSessionSearch" type="search" placeholder="Search sessions…" value="${escapeHtml(state.testingSessionSearch || '')}" aria-label="Search saved sessions"><div class="list testing-session-list">${rows || emptyContent}</div>`
    : emptyContent;

  return `<section class="testing-page testing-dashboard-page">
    ${renderTestingHeader('Testing Sessions', 'Start a new session or resume an existing one.', 'testingDashboardBack', '', 'Workspace')}
    <button class="primary testing-new-session-button" id="startNewTestSession" type="button">${icon('add')}<span>Start a new session</span></button>
    <section class="section recent-section testing-sessions-section">
      <div class="section-title-row"><div class="section-title-with-icon"><span class="section-title-icon" aria-hidden="true">${icon('folder')}</span><h2>Saved Sessions</h2></div><span class="section-count">${sessions.length}</span></div>
      ${sessionList}
      ${matchingSessions.length > 6 ? `<button class="testing-view-all" id="testingViewAllSessions" type="button">${state.testingShowAllSessions ? 'Show recent only' : 'View all →'}</button>` : ''}
    </section>
  </section>`;
}
function renderTesting() {
  if (state.view === 'testing-dashboard') return renderTestingDashboard();
  if (state.view === 'testing-paste') return renderTestingPaste();
  if (state.view === 'testing-preview') return renderTestingPreview();
  if (state.view === 'testing-summary') return renderTestingSummary();
  return renderTestingWorkspace();
}

function isEvidenceOnlyTesting(session = state.testingSession) {
  return String(session?.mode || '').toLowerCase() === 'evidence-only' || (!session?.testCases?.length && session?.mode !== 'test-cases');
}

function renderTestingHeader(title, subtitle = '', backId = 'testingBack', actionHtml = '', eyebrow = 'Testing') {
  return `<div class="testing-topbar fp-route-header">
    <div class="testing-heading-wrap">
      ${backButton('Back', backId)}
      <div class="testing-heading"><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1>${subtitle ? `<div class="testing-subtitle">${escapeHtml(subtitle)}</div>` : ''}</div>
    </div>
    <div class="testing-header-actions">${actionHtml}</div>
  </div>`;
}

function renderTestingSessionToolbar() {
  const session = state.testingSession;
  if (!session || state.view !== 'testing-workspace') return '';
  const sessions = state.testingSessions || [];
  return `<div class="testing-session-toolbar" aria-label="Testing session controls">
    <div class="testing-session-select-wrap">
      <select class="testing-session-selector" id="testingSessionSelector" aria-label="Current testing session">
        ${sessions.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === session.id ? 'selected' : ''}>${escapeHtml(testingSessionName(item) || 'Untitled testing session')}</option>`).join('')}
      </select>
      <span class="testing-session-select-arrow" aria-hidden="true">${icon('chevron')}</span>
    </div>
    <button class="secondary testing-session-new-inline" id="startNewTestSessionInline" type="button">${icon('add')}<span>New</span></button>
  </div>`;
}

function renderTestingPaste() {
  const error = state.testingPasteError ? `<div class="testing-message error" role="alert">${escapeHtml(state.testingPasteError)}</div>` : '';
  const hasPaste = Boolean(String(state.testingPasteText || '').trim());
  return `<section class="testing-page testing-start-page">
    ${renderTestingHeader('Start Testing', 'Choose how to start testing.')}
    ${error}
    <section class="testing-card testing-paste-card">
      <div class="testing-paste-header"><div class="testing-paste-heading">
        <div class="testing-paste-title-row"><h2>Import scenarios</h2></div>
        <p>Paste scenario titles or a table from your QA sheet.</p>
      </div></div>
      <div class="testing-paste-field">
        <textarea id="testingPaste" class="testing-paste" spellcheck="false" placeholder="Paste scenario titles or a table copied from Excel or Markdown…">${escapeHtml(state.testingPasteText)}</textarea>
        <div class="testing-format-note">Accepted formats: Excel/CSV, Markdown tables, or plain-text lists.</div>
        <div class="testing-paste-help">Only scenario titles are imported; other columns are ignored.</div>
      </div>
      <div class="testing-actions"><button class="primary action-button" id="parseTestingPaste" type="button" ${hasPaste ? '' : 'disabled'}>Import scenarios</button></div>
    </section>
    <div class="testing-skip-divider"><span>or</span></div>
    <section class="testing-start-choice">
      <button class="secondary testing-skip-button" id="skipTestingCases" type="button">${icon('camera')}<span>Start without scenarios</span></button>
      <div class="testing-skip-note">Capture screenshots and use Autofill without importing scenarios.</div>
    </section>
  </section>`;
}

function renderTestingPreview() {
  const session = state.testingSession;
  const testCases = session?.testCases || [];
  const warnings = Array.isArray(session?.importWarnings) ? session.importWarnings : [];
  const errors = state.testingPasteError ? `<div class="testing-message error" role="alert">${escapeHtml(state.testingPasteError)}</div>` : '';
  const warningBlock = warnings.length ? `<div class="testing-message warning" role="status"><strong>Review import</strong><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : '';
  const editingExisting = Boolean(state.testingEditingExistingSession);
  return `<section class="testing-page testing-preview-page">
    <div class="testing-preview-header">
      ${renderTestingHeader(editingExisting ? 'Edit scenarios' : 'Review scenarios', editingExisting ? 'Edit scenario titles and the session filename.' : `${testCases.length} scenario${testCases.length === 1 ? '' : 's'} detected`, editingExisting ? 'backFromTestingEditor' : 'backToTestingPaste')}
      <button class="primary testing-start-button" data-start-testing type="button" ${testCases.length ? '' : 'disabled'}>${icon(editingExisting ? 'check' : 'play')}<span>${editingExisting ? 'Save changes' : 'Start testing'}</span></button>
    </div>
    <div class="testing-preview-workspace">
      ${errors}${warningBlock}
      <section class="testing-editor-summary-card">
        <div class="testing-editor-summary-top"><div><h2>Scenarios</h2><span class="testing-row-count">${testCases.length} scenario${testCases.length === 1 ? '' : 's'}</span></div></div>
        <div class="testing-editor-meta">
          <label class="testing-editor-meta-field"><span>Session name / default export filename</span><input data-testing-field="sessionName" value="${escapeHtml(testingSessionName(session))}" maxlength="160" placeholder="Session name" aria-label="Session name and default export filename"></label>
          ${(session?.sourceWorkProducts || []).length > 1 ? `<div class="testing-message warning">Multiple Work Products were detected. Confirm or edit the session name used for exports.</div>` : ''}
        </div>
      </section>
      <section class="testing-editor-cases">
        ${testCases.map((tc, tcIndex) => `<article class="testing-editor-case" data-testing-case-id="${escapeHtml(tc.id)}">
          <div class="testing-editor-case-header"><div class="testing-editor-case-heading"><span class="testing-editor-case-number">Scenario ${tcIndex + 1}</span></div><button class="testing-case-remove-preview" type="button" data-delete-test-case="${escapeHtml(tc.id)}" aria-label="Remove Scenario ${tcIndex + 1}" title="Remove scenario">${icon('delete')}</button></div>
          ${tc.importWarning ? `<div class="testing-message warning">${escapeHtml(tc.importWarning)}</div>` : ''}
          <label class="testing-editor-title testing-editor-title-compact"><textarea data-testing-field="title" data-tc-id="${escapeHtml(tc.id)}" rows="2" aria-label="Scenario ${tcIndex + 1} title" placeholder="Enter scenario title">${escapeHtml(tc.title)}</textarea></label>
        </article>`).join('')}
      </section>
      <button class="testing-add-test-case" type="button" data-add-test-case>${icon('add')}<span>Add scenario</span></button>
      <section class="testing-editor-note">${icon('edit')}<span>Each entry becomes one independent scenario. Step rows are not imported.</span></section>
    </div>
  </section>`;
}

function renderTestingAutofillOverlay() {
  const content = state.view === 'result' && state.run ? renderResult() : renderRunning();
  return `${renderTestingWorkspace()}<div class="testing-autofill-overlay" role="dialog" aria-modal="true" aria-label="Autofill status"><div class="testing-autofill-modal">${content}</div></div>`;
}

function renderTestingEvidenceCard(evidence, session) {
  const url = testingObjectUrls.get(evidence.id);
  const capturedDate = new Date(evidence.capturedAt);
  const capturedTime = capturedDate.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  const capturedFull = capturedDate.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const noteOpen = state.testingNoteOpenId === evidence.id;
  const note = String(evidence.note || '').trim();
  return `<article class="testing-evidence-card" data-evidence-id="${escapeHtml(evidence.id)}">
    <button class="testing-evidence-preview" type="button" data-preview-evidence="${escapeHtml(evidence.id)}" aria-label="Preview captured evidence"><img src="${url || ''}" alt="Captured Salesforce evidence"></button>
    <div class="testing-evidence-meta" title="Captured ${escapeHtml(capturedFull)}">
      <span class="testing-evidence-time">${escapeHtml(capturedTime)}</span>
      <div class="testing-evidence-actions${isEvidenceOnlyTesting(session) ? ' is-evidence-only' : ''}">
        ${isEvidenceOnlyTesting(session) ? '' : `<button type="button" class="testing-evidence-icon-action" data-associate-evidence="${escapeHtml(evidence.id)}" title="Associate with a scenario" aria-label="Associate screenshot with a scenario">${icon('link')}</button>`}
        <button type="button" class="testing-evidence-icon-action" data-copy-evidence="${escapeHtml(evidence.id)}" title="Copy screenshot" aria-label="Copy screenshot">${icon('contentCopy')}</button>
        <button type="button" class="testing-evidence-icon-action${note ? ' has-note' : ''}" data-note-evidence="${escapeHtml(evidence.id)}" title="${note ? 'Edit note' : 'Add note'}" aria-label="${note ? 'Edit note' : 'Add note'}">${icon('noteAdd')}</button>
        <button type="button" class="testing-evidence-icon-action danger" data-remove-evidence="${escapeHtml(evidence.id)}" title="Remove screenshot" aria-label="Remove screenshot">${icon('delete')}</button>
      </div>
    </div>
    ${noteOpen ? `<div class="testing-inline-note-editor"><textarea data-note-input="${escapeHtml(evidence.id)}" rows="1" placeholder="Add a note…">${escapeHtml(note)}</textarea><div class="testing-inline-note-actions"><button class="secondary" type="button" data-note-cancel="${escapeHtml(evidence.id)}">Cancel</button><button class="primary" type="button" data-note-save="${escapeHtml(evidence.id)}">Save</button></div></div>` : ''}
  </article>`;
}

function testingStatusLabel(status) {
  return ({ pass: 'Pass', fail: 'Fail', blocked: 'Blocked', 'not-marked': 'Not marked' })[status] || 'Not marked';
}

function testingStatusDot(status) {
  const klass = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : status === 'blocked' ? 'blocked' : 'not-marked';
  return `<span class="testing-status-dot ${klass}" aria-hidden="true"></span>`;
}

function testingCaseStatus(tc) {
  const status = ['pass', 'fail', 'blocked', 'not-marked'].includes(String(tc?.status || '').toLowerCase()) ? String(tc.status).toLowerCase() : 'not-marked';
  return status;
}

function renderTestingStatusMenu(tc) {
  if (state.testingStatusMenuId !== tc.id) return '';
  const status = testingCaseStatus(tc);
  return `<div class="testing-status-menu" data-testing-status-menu="${escapeHtml(tc.id)}" role="menu" aria-label="Scenario result">
    ${['pass', 'fail', 'blocked'].map(value => `<button type="button" role="menuitem" class="testing-status-option ${status === value ? 'is-selected' : ''}" data-testing-status="${escapeHtml(value)}" data-testing-status-tc="${escapeHtml(tc.id)}">${testingStatusDot(value)}<span>${testingStatusLabel(value)}</span></button>`).join('')}
  </div>`;
}

function positionTestingStatusMenu() {
  const menu = document.querySelector('.testing-status-menu');
  if (!menu) return;
  const caseId = menu.dataset.testingStatusMenu;
  const trigger = [...document.querySelectorAll('[data-open-testing-status]')]
    .find(button => button.dataset.openTestingStatus === caseId);
  if (!trigger) return;

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const margin = 8;
  const gap = 6;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  menu.style.maxHeight = `${Math.max(40, viewportHeight - margin * 2)}px`;
  menu.style.overflowY = 'auto';

  const naturalHeight = menu.scrollHeight;
  const menuWidth = Math.min(menu.getBoundingClientRect().width, viewportWidth - margin * 2);
  const triggerRect = trigger.getBoundingClientRect();
  const availableAbove = Math.max(0, triggerRect.top - gap - margin);
  const availableBelow = Math.max(0, viewportHeight - triggerRect.bottom - gap - margin);
  let top;

  if (naturalHeight <= availableBelow) {
    top = triggerRect.bottom + gap;
  } else if (naturalHeight <= availableAbove) {
    top = triggerRect.top - naturalHeight - gap;
  } else if (availableBelow >= availableAbove) {
    menu.style.maxHeight = `${Math.max(40, Math.min(availableBelow, viewportHeight - margin * 2))}px`;
    top = triggerRect.bottom + gap;
  } else {
    menu.style.maxHeight = `${Math.max(40, Math.min(availableAbove, viewportHeight - margin * 2))}px`;
    top = triggerRect.top - Math.min(naturalHeight, availableAbove) - gap;
  }

  const actualHeight = menu.getBoundingClientRect().height;
  top = Math.max(margin, Math.min(top, viewportHeight - actualHeight - margin));
  let left = triggerRect.right - menuWidth;
  left = Math.max(margin, Math.min(left, viewportWidth - menuWidth - margin));

  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.visibility = 'visible';
}
function renderAssociateDialog(session, evidenceId) {
  if (!evidenceId) return '';
  const evidence = session?.evidence?.find(item => item.id === evidenceId);
  return `<div class="testing-dialog-backdrop" id="testingAssociateDialog" role="presentation">
    <div class="testing-dialog" role="dialog" aria-modal="true" aria-labelledby="testingAssociateTitle">
      <div class="testing-dialog-header"><div><h2 id="testingAssociateTitle">Associate screenshot</h2><p>Select the scenario it belongs to</p></div><button class="iconbtn" id="closeAssociateDialog" type="button" aria-label="Close">${icon('close')}</button></div>
      <div class="testing-dialog-list">
        ${(session?.testCases || []).map((tc, index) => `<button type="button" class="testing-dialog-case${evidence?.testCaseId === tc.id ? ' is-current' : ''}" data-associate-case="${escapeHtml(tc.id)}" data-associate-evidence="${escapeHtml(evidenceId)}"><span class="testing-dialog-scenario-number">Scenario ${index + 1}</span><span class="testing-dialog-scenario-title">${escapeHtml(tc.title)}</span>${evidence?.testCaseId === tc.id ? `<span class="testing-dialog-current">Current</span>` : ''}</button>`).join('')}
        ${!session?.testCases?.length ? '<div class="empty-state">No scenarios available.</div>' : ''}
        ${evidence?.testCaseId ? `<button type="button" class="testing-dialog-case testing-dialog-unassign" data-associate-case="" data-associate-evidence="${escapeHtml(evidenceId)}"><span class="testing-dialog-scenario-title">Unassign from scenario</span></button>` : ''}
      </div>
    </div>
  </div>`;
}

function renderTestingAutofillPicker(recordingOptions) {
  const query = String(state.testingAutofillQuery || '').trim().toLowerCase();
  const filtered = recordingOptions.filter(r => {
    const hay = `${recordingTitle(r)} ${recordingMeta(r)} ${r?.name || ''}`.toLowerCase();
    return !query || hay.includes(query);
  });
  return `<div class="testing-dialog-backdrop" id="testingAutofillDialog" role="presentation">
    <div class="testing-dialog testing-autofill-dialog" role="dialog" aria-modal="true" aria-labelledby="testingAutofillTitle">
      <div class="testing-dialog-header">
        <div><h2 id="testingAutofillTitle">Autofill a Salesforce record</h2><p>Search your saved recordings and run one on the current Salesforce record.</p></div>
        <button class="iconbtn" id="closeTestingAutofill" type="button" aria-label="Close">${icon('close')}</button>
      </div>
      <div class="testing-autofill-search-wrap">
        ${icon('search')}
        <input id="testingAutofillSearch" class="testing-autofill-search" type="search" value="${escapeHtml(state.testingAutofillQuery)}" placeholder="Search saved recordings…" aria-label="Search saved recordings">
      </div>
      <div class="testing-dialog-list testing-autofill-list">
        ${filtered.length ? filtered.map(r => `<button type="button" class="testing-autofill-row" data-testing-autofill-run="${escapeHtml(r.id)}">
          <span class="testing-autofill-row-main"><strong>${escapeHtml(recordingTitle(r))}</strong><span>${escapeHtml(recordingMeta(r))}</span></span>
          <span class="testing-autofill-row-side"><span>${r?.steps?.length || 0} fields</span>${icon('arrowRight')}</span>
        </button>`).join('') : '<div class="testing-autofill-empty">No saved recordings match that search.</div>'}
      </div>
    </div>
  </div>`;
}

function renderTestingWorkspace() {
  const session = state.testingSession;
  const evidenceOnly = isEvidenceOnlyTesting(session);
  const unassociated = evidenceOnly ? (session?.evidence || []) : testingUnassociatedEvidence(session);
  const recordingOptions = Object.values(state.recordings).sort((a, b) => recordingTitle(a).localeCompare(recordingTitle(b)));
  const unassocExpanded = state.testingGeneralEvidenceExpanded;
  const sessionName = testingSessionName(session) || 'Untitled testing session';
  const headerActions = state.testingSessionNameEditing
    ? `<button class="primary testing-header-action" id="saveTestingSessionNameInline" type="button">${icon('check')}<span>Save</span></button><button class="secondary testing-header-action" id="cancelTestingSessionNameInline" type="button">${icon('close')}<span>Cancel</span></button>`
    : `<button class="testing-header-action" id="${evidenceOnly ? 'editTestingSessionName' : 'editTestingCases'}" type="button">${icon('edit')}<span>Edit</span></button>`;
  const headerTitle = state.testingSessionNameEditing
    ? `<input class="testing-session-name-inline" id="testingSessionNameInline" maxlength="160" aria-label="Session name and export filename" value="${escapeHtml(sessionName === 'Untitled testing session' ? '' : sessionName)}" placeholder="Session name">`
    : `<h1 title="${escapeHtml(sessionName)}">${escapeHtml(sessionName)}</h1>`;

  const casesMarkup = evidenceOnly ? '' : `<section class="testing-cases-card">
      <div class="testing-workspace-case-tools"><span>${session?.testCases?.length || 0} scenario${(session?.testCases?.length || 0) === 1 ? '' : 's'}</span></div>
      ${(session?.testCases || []).map((tc, tcIndex) => {
        const collapsed = state.testingCollapsedCases.has(tc.id);
        const caseEvidence = testingCaseEvidence(session, tc.id);
        const active = state.testingActiveCaseId === tc.id;
        const statusMenuOpen = state.testingStatusMenuId === tc.id;
        return `<section class="testing-case ${collapsed ? 'is-collapsed' : ''}${active ? ' is-active-case' : ''}" data-testing-case-id="${escapeHtml(tc.id)}">
          <div class="testing-case-header-row">
            <button class="testing-case-collapse" type="button" data-select-testing-case="${escapeHtml(tc.id)}" data-toggle-testing-case="${escapeHtml(tc.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} Scenario ${tcIndex + 1}"><span class="testing-case-collapse-icon">${icon('chevron')}</span></button>
            <div class="testing-case-header-content" data-activate-testing-case="${escapeHtml(tc.id)}">
              <div class="testing-case-primary-line"><span class="testing-case-kicker">Scenario ${tcIndex + 1}${active ? ' · Selected' : ''}</span><div class="testing-case-capture-actions testing-case-inline-actions"><button type="button" class="testing-case-icon-action testing-case-inline-action" data-capture-case="${escapeHtml(tc.id)}" title="Capture screenshot (Alt + S) for Scenario ${tcIndex + 1}" aria-label="Capture screenshot for Scenario ${tcIndex + 1}">${icon('camera')}</button><button type="button" class="testing-case-icon-action testing-case-inline-action" data-paste-case="${escapeHtml(tc.id)}" title="Paste an image from clipboard (Ctrl + V) for Scenario ${tcIndex + 1}" aria-label="Paste an image from clipboard for Scenario ${tcIndex + 1}">${icon('contentPaste')}</button></div><div class="testing-status-control"><button class="testing-status-indicator" type="button" data-open-testing-status="${escapeHtml(tc.id)}" aria-haspopup="menu" aria-expanded="${statusMenuOpen ? 'true' : 'false'}" aria-label="Change scenario status. Current status: ${escapeHtml(testingStatusLabel(testingCaseStatus(tc)))}" title="${escapeHtml(testingStatusLabel(testingCaseStatus(tc)))}">${testingStatusDot(testingCaseStatus(tc))}</button>${renderTestingStatusMenu(tc)}</div></div>
              <strong class="testing-case-title">${escapeHtml(tc.title)}</strong>
            </div>
          </div>
          ${collapsed ? '' : `<div class="testing-case-content">${caseEvidence.length ? `<div class="testing-evidence-grid">${caseEvidence.map(item => renderTestingEvidenceCard(item, session)).join('')}</div>` : ''}</div>`}
        </section>`;
      }).join('') || '<div class="empty-state">No scenarios are available.</div>'}
    </section>`;

  const evidenceMarkup = `<section class="testing-general-evidence ${unassocExpanded ? 'is-expanded' : ''}${evidenceOnly ? ' testing-general-evidence-evidence-only' : ''}">
      <div class="testing-general-evidence-header">
        <button class="testing-general-evidence-toggle testing-general-evidence-title" type="button" data-toggle-general-evidence aria-expanded="${unassocExpanded ? 'true' : 'false'}"><strong>${evidenceOnly ? 'Evidence' : 'Unassigned screenshots'}</strong><small>${unassociated.length ? `${unassociated.length} screenshot${unassociated.length === 1 ? '' : 's'}` : (evidenceOnly ? 'No screenshots yet' : 'None')}</small></button>
        <button class="testing-paste-screenshot" id="testingPasteScreenshot" type="button" title="Paste an image from clipboard (Ctrl + V)" aria-label="Paste an image from clipboard (Ctrl + V)">${icon('contentPaste')}</button>
        <button class="testing-general-evidence-toggle testing-general-evidence-icon-toggle" type="button" data-toggle-general-evidence aria-expanded="${unassocExpanded ? 'true' : 'false'}" title="${unassocExpanded ? 'Collapse evidence' : 'Expand evidence'}" aria-label="${unassocExpanded ? 'Collapse evidence' : 'Expand evidence'}"><span class="testing-section-toggle-icon">${icon('chevron')}</span></button>
      </div>
      ${unassocExpanded ? `<div class="testing-general-evidence-body">${unassociated.length ? `<div class="testing-evidence-grid">${unassociated.map(item => renderTestingEvidenceCard(item, session)).join('')}</div>` : `<div class="testing-empty-evidence">${evidenceOnly ? 'Captured screenshots will appear here.' : 'New screenshots attach to the selected scenario.'}</div>`}</div>` : ''}
    </section>`;

  return `<section class="testing-page testing-workspace-page${evidenceOnly ? ' testing-evidence-only-page' : ''}">
    <div class="testing-topbar fp-route-header">
      <div class="testing-heading-wrap">${backButton('Back', 'testingBack')}<div class="testing-heading"><div class="eyebrow">Testing</div>${headerTitle}</div></div>
      <div class="testing-header-actions${state.testingSessionNameEditing ? ' is-editing' : ''}">${headerActions}</div>
    </div>
    <section class="testing-sticky-actions ${evidenceOnly ? 'testing-sticky-actions-evidence-only' : ''}"><div class="testing-action-bar">
      <button class="primary testing-capture-button" id="captureTestingScreenshot" type="button" title="Capture screenshot (Alt + S)" aria-label="Capture screenshot (Alt + S)" ${state.testingCaptureBusy ? 'disabled aria-busy="true"' : ''}>${icon('camera')}<span>${state.testingCaptureBusy ? 'Capturing…' : 'Screenshot'}</span></button>
      <button class="secondary testing-toolbar-button testing-autofill-launch" id="testingAutofillOpen" type="button" ${state.testingAutofillBusy ? 'disabled aria-busy="true"' : ''}>${icon('bolt')}<span>${state.testingAutofillBusy ? 'Autofilling…' : 'Autofill'}</span></button>
    </div></section>
    ${renderTestingSessionToolbar()}
    ${evidenceOnly ? '' : '<div class="testing-workspace-scroll">'}
    ${casesMarkup}
    ${evidenceMarkup}
    ${evidenceOnly ? '' : '</div>'}
    <button class="primary testing-finish" data-finish-testing type="button">Finish testing</button>
    ${evidenceOnly ? '' : renderAssociateDialog(session, state.testingAssociatingEvidenceId)}
    ${state.testingAutofillPickerOpen ? renderTestingAutofillPicker(recordingOptions) : ''}
  </section>`;
}
function renderTestingSummary() {
  const session = state.testingSession;
  const evidenceOnly = isEvidenceOnlyTesting(session);
  const countEvidence = session?.evidence?.length || 0;
  const stats = evidenceOnly
    ? `<div><strong>${countEvidence}</strong><span>${countEvidence === 1 ? 'Screenshot' : 'Screenshots'}</span></div>`
    : `<div><strong>${session?.testCases?.length || 0}</strong><span>Scenarios</span></div><div><strong>${countEvidence}</strong><span>${countEvidence === 1 ? 'Screenshot' : 'Screenshots'}</span></div>`;
  const anyExportBusy = state.testingExportBusy || state.testingZipBusy;
  const exportDisabled = anyExportBusy || countEvidence === 0;
  const wordStatus = state.testingExportBusy
    ? `<div class="testing-export-item-status" role="status" aria-live="polite"><div class="testing-export-spinner" aria-hidden="true"></div><span>${escapeHtml(state.testingExportStage || 'Preparing…')}</span></div>`
    : state.testingExportCompleted
        ? `<div class="testing-export-item-status success" role="status"><span>${escapeHtml(state.testingExportFilename)}</span></div>`
        : '';
  const zipStatus = state.testingZipBusy
    ? `<div class="testing-export-item-status" role="status" aria-live="polite"><div class="testing-export-spinner" aria-hidden="true"></div><span>${escapeHtml(state.testingZipStage || 'Preparing screenshots…')}</span></div>`
    : state.testingZipCompleted
        ? `<div class="testing-export-item-status success" role="status"><span>${escapeHtml(state.testingZipFilename)}</span></div>`
        : '';
  const wordLabel = state.testingExportBusy ? 'Exporting…' : state.testingExportCompleted ? 'Download Word document again' : 'Export Word document';
  const zipLabel = state.testingZipBusy ? 'Exporting…' : state.testingZipCompleted ? 'Download screenshots ZIP again' : 'Export screenshots ZIP';
  return `<section class="testing-page testing-summary-page">
    ${renderTestingHeader('Testing complete', testingSessionName(session), 'backToTestingSummary')}
    <div class="testing-summary-body">
    <section class="testing-summary-card">
      <div class="testing-summary-icon">${icon('check')}</div>
      <p class="testing-summary-ready">Your evidence is ready to export.</p>
      <div class="testing-summary-stats${evidenceOnly ? ' is-single' : ''}">${stats}</div>
      <section class="testing-export-section">
        <div class="testing-export-section-title">Export</div>
        <div class="testing-export-actions">
          <div class="testing-export-item">
            <button class="primary action-button testing-export-button" id="exportTestingWord" type="button" ${exportDisabled ? 'disabled' : ''}>${icon('fileDownload')}<span>${wordLabel}</span></button>
            ${wordStatus}
          </div>
          <div class="testing-export-item">
            <button class="secondary action-button testing-export-button" id="exportTestingZip" type="button" ${exportDisabled ? 'disabled' : ''}>${icon('archive')}<span>${zipLabel}</span></button>
            ${zipStatus}
          </div>
        </div>
      </section>
      ${countEvidence === 0 ? '<div class="testing-export-empty-hint">Capture at least one screenshot before exporting.</div>' : ''}
      <div class="testing-summary-primary-actions"><button class="secondary action-button" id="testingDoneAction" data-testing-done type="button" aria-label="Finish and end testing session">Done</button></div>
    </section>
    </div>
  </section>`;
}
function randomizerCore() { return window.ForcePilotRandomizer || null; }
function getRandomizationDefaults(step, strategy) {
  const core = randomizerCore();
  return core?.defaults ? core.defaults(step, strategy) : { version: 1, enabled: false, strategy: strategy || 'text', options: {} };
}
function randomizationView(context = 'edit') { return String(context).startsWith('live') ? 'live' : 'edit'; }
function randomizationEditorToken(context, key) { return `${randomizationView(context)}|${context}|${String(key)}`; }
function collapseRandomizationGroup(view = 'live') {
  const set = state.expandedRandomizationEditors instanceof Set ? state.expandedRandomizationEditors : (state.expandedRandomizationEditors = new Set());
  for (const token of [...set]) if (token.startsWith(`${view}|`)) set.delete(token);
  document.querySelectorAll('[data-randomization-editor]').forEach(editor => {
    if (randomizationView(editor.dataset.randContext || 'edit') === view && editor.classList.contains('is-enabled')) editor.classList.add('is-collapsed');
  });
}
function setRandomizationExpanded(context, key, expanded) {
  const view = randomizationView(context);
  const set = state.expandedRandomizationEditors instanceof Set ? state.expandedRandomizationEditors : (state.expandedRandomizationEditors = new Set());
  const token = randomizationEditorToken(context, key);
  if (expanded) {
    // Randomization editors act as a compact accordion: only one expanded panel per
    // view, even when a live recording refresh rebuilds the row DOM.
    for (const existing of [...set]) if (existing.startsWith(`${view}|`)) set.delete(existing);
    set.add(token);
  } else set.delete(token);
  document.querySelectorAll('[data-randomization-editor]').forEach(editor => {
    if (randomizationView(editor.dataset.randContext || 'edit') !== view || !editor.classList.contains('is-enabled')) return;
    editor.classList.toggle('is-collapsed', !set.has(randomizationEditorToken(editor.dataset.randContext || 'edit', editor.dataset.randKey || '')));
  });
}
function randomizationOptionValue(step, cfg) {
  const core = randomizerCore();
  if (!core?.generate) return 'Example generated on Autofill';
  if (String(cfg?.strategy || '') === 'dependentPicklist') {
    const target = step?.target || {};
    const isDependent = !!(target.isDependentPicklist || target.controllerName || (Array.isArray(target.controllingFields) && target.controllingFields.length) || (target.controllerValues && Object.keys(target.controllerValues).length));
    if (isDependent) return 'Options for the current controlling value';
    if (!(core?.validOptions?.(step) || []).length) return 'Available options will be read from Salesforce';
  }
  // Keep the existing Example preview unchanged when the saved recording has no
  // option catalogue; runtime Autofill now resolves the real Salesforce choices.
  if (['picklist','multiPicklist'].includes(String(cfg?.strategy||'')) && !(core?.validOptions?.(step)||[]).length) return 'No valid Salesforce options are available. Refresh field metadata or allow at least one option.';
  const sample = core.generate(step, { ...(cfg || {}), enabled: true }, { usedValues: new Set() });
  if (!sample?.ok) return sample?.error || 'Configure valid settings to preview.';
  if (sample.lookup) return sample.searchTerm ? `Random Salesforce result matching “${sample.searchTerm}”` : 'A random lookup record';
  if (sample.preserveCreateWorkflow) return 'Use the captured Create New workflow';
  if (Array.isArray(sample.value)) return sample.value.join('; ');
  if (sample.value && typeof sample.value === 'object') return Object.values(sample.value).filter(Boolean).join(' · ') || 'Sample address';
  return String(sample.value ?? '');
}
function randomizationStrategies(step, cfg) {
  const core = randomizerCore();
  const list = core?.strategies ? core.strategies(step) : [{ value: cfg.strategy || 'text', label: 'Random text' }];
  if (cfg?.strategy && !list.some(x => x.value === cfg.strategy)) return [{ value: cfg.strategy, label: 'Current configuration' }, ...list];
  return list;
}
function renderRandomizationEditor(step, key, { context = 'edit' } = {}) {
  const core = randomizerCore();
  let cfg = step?.randomization && typeof step.randomization === 'object' ? clone(step.randomization) : getRandomizationDefaults(step);
  if (!cfg.options || typeof cfg.options !== 'object') cfg.options = {};
  // Migrate the intermediate v2.2.27/28 Today-relative Date Range controls back
  // to the absolute From/To date pickers used in v2.2.26. Do not mutate the
  // stored recording until the user saves the randomization config.
  const today=localDateISO();
  if(cfg.strategy==='dateRange'&&(cfg.options.fromDays!==undefined||cfg.options.toDays!==undefined)){const from=Number(cfg.options.fromDays??-30),to=Number(cfg.options.toDays??30);cfg.options.startDate=shiftDateFrom(today,from);cfg.options.endDate=shiftDateFrom(today,to);delete cfg.options.fromDays;delete cfg.options.toDays;delete cfg.options.direction;delete cfg.options.weekdaysOnly;}
  if(cfg.strategy==='dateTimeRange'&&cfg.options.fromDays===undefined&&cfg.options.toDays===undefined&&cfg.options.startDateTime&&cfg.options.endDateTime){const from=dateOffsetDays(today,String(cfg.options.startDateTime).slice(0,10)),to=dateOffsetDays(today,String(cfg.options.endDateTime).slice(0,10));if(from!==null&&to!==null){cfg.options.fromDays=from;cfg.options.toDays=to;cfg.options.startTime=String(cfg.options.startDateTime).slice(11,16)||'09:00';cfg.options.endTime=String(cfg.options.endDateTime).slice(11,16)||'17:00';cfg.options.stepMinutes=Number(cfg.options.stepMinutes)||15;cfg.options.direction=cfg.options.direction||'any';cfg.options.weekdaysOnly=!!cfg.options.weekdaysOnly;delete cfg.options.startDateTime;delete cfg.options.endDateTime;}}
  const type = core?.fieldType ? core.fieldType(step) : 'text';
  const strategyList = randomizationStrategies(step, cfg);
  const option = (name, fallback='') => cfg.options?.[name] ?? fallback;
  const attrKey = `data-rand-key="${escapeHtml(String(key))}" data-rand-context="${context}"`;
  const input = (name, label, value, typeName='number', extra='') => `<label class="fp-random-field"><span>${label}</span><input class="edit-control fp-random-input" type="${typeName}" ${attrKey} data-rand-option="${name}" value="${escapeHtml(value ?? '')}" ${extra || (typeName==='number'?'step="any"':'')}></label>`;
  const select = (name, label, value, options) => `<label class="fp-random-field"><span>${label}</span><select class="edit-control fp-random-input" ${attrKey} data-rand-option="${name}">${options.map(o=>`<option value="${escapeHtml(o.value)}" ${String(value ?? '')===String(o.value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}</select></label>`;
  const check = (name, label, value) => `<label class="fp-random-check"><input type="checkbox" ${attrKey} data-rand-option="${name}" ${value?'checked':''}><span>${label}</span></label>`;
  let fields = '';
  if (['numberRange','numberRangeIncrement','currencyRange','percentRange'].includes(cfg.strategy)) {
    const isNumber = cfg.strategy === 'numberRange' || cfg.strategy === 'numberRangeIncrement';
    const hasIncrement = !isNumber || cfg.strategy === 'numberRangeIncrement';
    const labels = cfg.strategy === 'currencyRange' ? ['Min','Max','Increment'] : cfg.strategy === 'percentRange' ? ['Min (%)','Max (%)','Increment'] : ['Min','Max','Increment'];
    fields = `<div class="fp-random-grid fp-random-grid-numeric fp-random-grid-numeric-${hasIncrement?'4':'3'}">${input('min',labels[0],option('min',1))}${input('max',labels[1],option('max',100))}${hasIncrement?input('step',labels[2],option('step',1)):''}${input('decimals','Decimals',option('decimals',0),'number','min="0" max="10" step="1"')}</div>`;
    if(cfg.strategy==='percentRange')fields+='<p class="fp-random-help">Enter percentage points: 25 means 25%.</p>';
    else if(cfg.strategy==='currencyRange')fields+='<p class="fp-random-help">Enter amounts without currency symbols.</p>';
  } else if (cfg.strategy === 'relativeDate') { const d=getRandomizationDefaults(step,'relativeDate').options; fields=`<div class="fp-random-relative-date-row"><span class="fp-random-fixed">Today</span><select class="edit-control fp-random-input" ${attrKey} data-rand-option="sign" aria-label="Date direction"><option value="+" ${String(option('sign',d.sign))==='+'?'selected':''}>+</option><option value="-" ${String(option('sign',d.sign))==='-'?'selected':''}>−</option></select><input class="edit-control fp-random-input" type="number" ${attrKey} data-rand-option="days" value="${escapeHtml(option('days',d.days))}" min="0" max="36500" step="1" aria-label="Days"><span class="fp-random-relative-days">days</span></div><p class="fp-random-help">Days before or after the current date.</p>`;
  } else if (cfg.strategy === 'dateRange') {
    const d = getRandomizationDefaults(step,'dateRange').options;
    fields = `<div class="fp-random-grid fp-random-grid-date">${input('startDate','From',option('startDate',d.startDate),'date')}${input('endDate','To',option('endDate',d.endDate),'date')}</div>`;
  } else if (cfg.strategy === 'dateTimeRange') {
    const d = getRandomizationDefaults(step,'dateTimeRange').options;
    fields = `<p class="fp-random-help">Experimental: combined date/time inputs only. Split Lightning controls are not verified.</p><div class="fp-random-grid fp-random-grid-date">${input('fromDays','From days',option('fromDays',d.fromDays),'number','min="-36500" max="36500" step="1"')}${input('toDays','To days',option('toDays',d.toDays),'number','min="-36500" max="36500" step="1"')}${select('direction','Preset',option('direction','any'),[{value:'any',label:'Any'},{value:'past',label:'Past only'},{value:'future',label:'Future only'}])}${input('startTime','From time',option('startTime',d.startTime),'time')}${input('endTime','To time',option('endTime',d.endTime),'time')}${input('stepMinutes','Minute step',option('stepMinutes',15),'number','min="1" max="1440" step="1"')}${check('weekdaysOnly','Weekdays only',option('weekdaysOnly',false))}</div>`;
  } else if (cfg.strategy === 'timeRange') {
    fields = `<div class="fp-random-grid">${input('startTime','Start time',option('startTime','09:00'),'time')}${input('endTime','End time',option('endTime','17:00'),'time')}${input('stepMinutes','Minute increment',option('stepMinutes',15),'number','min="1" max="1440" step="1"')}</div>`;
  } else if (cfg.strategy === 'textPrefixUnique') {
    const d = getRandomizationDefaults(step,'textPrefixUnique').options;
    const limit = Number(step?.target?.length || step?.target?.maxLength || 255);
    fields = input('prefix','Custom Text',option('prefix',d.prefix),'text',`maxlength="${Math.max(1,limit)}"`);
  } else if (cfg.strategy === 'text' || cfg.strategy === 'paragraph') {
    const d = getRandomizationDefaults(step,cfg.strategy).options;
    fields = `<div class="fp-random-grid fp-random-grid-small-inputs">${input('minLength','Minimum length',option('minLength',d.minLength),'number','min="1" step="1"')}${input('maxLength','Maximum length',option('maxLength',d.maxLength),'number','min="1" step="1"')}</div>`;
  } else if (cfg.strategy === 'email' || cfg.strategy === 'url') {
    fields = input('domain',cfg.strategy === 'email' ? 'Email domain' : 'URL domain',option('domain','example.com'),'text','maxlength="253"');
  } else if (cfg.strategy === 'phone') {
    fields = select('country','Number format',option('country','US'),[{value:'US',label:'United States (555 test range)'},{value:'UK',label:'United Kingdom (test format)'},{value:'IN',label:'India (format only)'},{value:'Generic',label:'International format'}]);
  } else if (cfg.strategy === 'boolean') {
    fields = '';
  } else if (cfg.strategy === 'multiPicklist') {
    fields = `<div class="fp-random-grid fp-random-grid-small-inputs">${input('minSelections','Minimum selected',option('minSelections',1),'number','min="1" step="1"')}${input('maxSelections','Maximum selected',option('maxSelections',3),'number','min="1" step="1"')}</div>`;
  } else if (cfg.strategy === 'lookupRandom') {
    fields = input('searchTerm','Optional search text',option('searchTerm',''),'text','maxlength="100"');
  } else if (cfg.strategy === 'lookupCreate') {
    fields = '<p class="fp-random-help">Uses the captured Create New workflow. Configure the new-record fields below.</p>';
  } else if (cfg.strategy === 'address') {
    fields = select('country','Sample address country',option('country','US'),[{value:'US',label:'United States'},{value:'UK',label:'United Kingdom'},{value:'IN',label:'India'}]);
  } else if (cfg.strategy === 'picklist') {
    fields = '<p class="fp-random-help">Selects from available recorded options. Do not use for dependent picklists.</p>';
  } else if (cfg.strategy === 'dependentPicklist') {
    fields = '<p class="fp-random-help">Selects any random available option</p>';
  }
  if (['picklist','multiPicklist'].includes(cfg.strategy)) {
    const opts = core?.validOptions ? core.validOptions(step) : typeOptions(step).map(o=>({value:o.value,label:o.displayValue||o.value}));
    if (opts.length) {
      const allowed = Array.isArray(cfg.options.allowedValues) ? new Set(cfg.options.allowedValues.map(x=>String(x).toLowerCase())) : null;
      fields += `<details class="fp-random-allowed-options"><summary>Limit to specific options <span>(optional)</span></summary><div>${opts.map(o=>{const v=o.label||o.value;const checked=!allowed||allowed.has(String(v).toLowerCase())||allowed.has(String(o.value).toLowerCase());return `<label><input type="checkbox" ${attrKey} data-rand-allowed data-rand-value="${escapeHtml(v)}" ${checked?'checked':''}><span>${escapeHtml(v)}</span></label>`}).join('')}</div></details>`;
    }
  }
  const supportsUnique = ['text','paragraph','company','currencyRange','percentRange','email','url'].includes(cfg.strategy);
  const unique = cfg.options.unique === true || (cfg.strategy === 'email');
  const sample = randomizationOptionValue(step,cfg);
  const status = cfg.enabled ? 'true' : 'false';
  const expanded = state.expandedRandomizationEditors instanceof Set && state.expandedRandomizationEditors.has(randomizationEditorToken(context,key));
  return `<section class="fp-randomization-editor ${cfg.enabled?'is-enabled':''} ${cfg.enabled&&!expanded?'is-collapsed':''}" data-randomization-editor ${attrKey}><div class="fp-randomization-heading"><strong class="fp-randomization-heading-title" data-rand-heading tabindex="0" role="button" aria-label="Collapse or expand randomization settings">Randomize value</strong><label class="fp-random-switch" title="Randomize value"><input type="checkbox" role="switch" aria-label="Randomize ${escapeHtml(step?.target?.label||'field')}" aria-checked="${status}" ${attrKey} data-rand-enabled ${cfg.enabled?'checked':''}><span class="fp-random-switch-track"><span></span></span></label></div>${cfg.enabled?`<div class="fp-randomization-body"><label class="fp-random-field fp-random-strategy"><span>Generate</span><select class="edit-control fp-random-input" ${attrKey} data-rand-strategy>${strategyList.map(x=>`<option value="${escapeHtml(x.value)}" ${cfg.strategy===x.value?'selected':''}>${escapeHtml(x.label)}</option>`).join('')}</select></label><div class="fp-random-options">${fields}</div>${supportsUnique?`<label class="fp-random-unique"><input type="checkbox" ${attrKey} data-rand-option="unique" ${unique?'checked':''}><span>Generate a unique value</span></label>`:''}${cfg.enabled&&cfg.strategy==='lookupRandom'?'<p class="fp-random-warning" role="note">May select a real Salesforce record.</p>':''}<div class="fp-random-preview"><div><span class="fp-random-preview-label">Example</span><output data-rand-preview-value ${attrKey}>${escapeHtml(sample)}</output></div><button type="button" class="fp-random-preview-button" ${attrKey} data-rand-preview><span>Preview</span></button></div></div>`:''}</section>`;
}
function readRandomizationFromDOM(step, key, { context = 'edit' } = {}) {
  const root = [...document.querySelectorAll('[data-randomization-editor]')].find(el => el.dataset.randKey === String(key) && el.dataset.randContext === context);
  if (!root) return step?.randomization ? clone(step.randomization) : getRandomizationDefaults(step);
  const enabled = !!root.querySelector('[data-rand-enabled]')?.checked;
  const strategyControl = root.querySelector('[data-rand-strategy]');
  const strategy = strategyControl?.value || step?.randomization?.strategy || randomizerCore()?.guessStrategy?.(step) || 'text';
  const previous = step?.randomization && step.randomization.strategy === strategy ? clone(step.randomization) : getRandomizationDefaults(step,strategy);
  const cfg = { version: 1, enabled, strategy, options: { ...(previous.options || {}) } };
  root.querySelectorAll('[data-rand-option]').forEach(el => {
    const name = el.dataset.randOption;
    if (!name) return;
    if (el.type === 'checkbox') cfg.options[name] = el.checked;
    else if (el.type === 'number') cfg.options[name] = el.value.trim() === '' ? '' : Number(el.value);
    else cfg.options[name] = el.value;
  });
  if (strategy === 'dateRange' && cfg.options.startDate && cfg.options.endDate) {
    delete cfg.options.fromDays; delete cfg.options.toDays; delete cfg.options.direction; delete cfg.options.weekdaysOnly;
  }
  if (strategy === 'boolean') cfg.options.mode = 'random';
  const allowed = [...root.querySelectorAll('[data-rand-allowed]:checked')].map(el=>el.dataset.randValue).filter(Boolean);
  if (root.querySelector('[data-rand-allowed]')) cfg.options.allowedValues = allowed;
  return cfg;
}
function resolveDraftStep(key) {
  const raw = String(key);
  const workflow = raw.match(/^wf-(\d+)-(\d+)$/);
  if (workflow) return lookupCreateWorkflow(state.draft?.steps?.[Number(workflow[1])])?.fields?.[Number(workflow[2])] || null;
  const index = Number(raw);
  return Number.isInteger(index) ? state.draft?.steps?.[index] || null : null;
}
function resolveLiveStep(key, context='live') {
  const raw=String(key);
  if(context==='live') return state.activeSteps?.[Number(raw)] || null;
  const workflow=raw.match(/^wf-(\d+)-(\d+)$/);
  if(context==='live-child' && workflow) return lookupCreateWorkflow(state.activeSteps?.[Number(workflow[1])])?.fields?.[Number(workflow[2])] || null;
  return null;
}
function replaceRandomizationEditor(step, key, context) {
  const old = [...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===String(key)&&el.dataset.randContext===context);
  if (!old) return;
  const template = document.createElement('template');
  template.innerHTML = renderRandomizationEditor(step,String(key),{context}).trim();
  old.replaceWith(template.content.firstElementChild);
}
function setRandomizationError(root, message) {
  if (!root) return;
  let error = root.querySelector('.fp-random-error');
  if (!message) { error?.remove(); root.querySelectorAll('.fp-random-input').forEach(el=>el.removeAttribute('aria-invalid')); return; }
  if (!error) { error=document.createElement('p'); error.className='fp-random-error'; error.setAttribute('role','alert'); const body=root.querySelector('.fp-randomization-body'); if(body)body.append(error); else root.append(error); }
  error.textContent = message;
  root.querySelectorAll('.fp-random-input').forEach(el=>el.setAttribute('aria-invalid','true'));
}
function bindRandomizationDelegation() {
  if (app.dataset.fpRandomizationBound === 'true') return;
  app.dataset.fpRandomizationBound = 'true';
  app.addEventListener('click', async event => {
    const heading = event.target.closest('[data-rand-heading]');
    if (heading && !event.target.closest('.fp-random-switch')) {
      const editor = heading.closest('[data-randomization-editor]');
      if (editor?.classList.contains('is-enabled')) {
        const collapsed = editor.classList.contains('is-collapsed');
        setRandomizationExpanded(editor.dataset.randContext || 'edit', editor.dataset.randKey || '', collapsed);
      }
      event.preventDefault();
      return;
    }
    const preview = event.target.closest('[data-rand-preview]');
    if (preview) {
      event.preventDefault(); event.stopPropagation();
      const context=preview.dataset.randContext, key=preview.dataset.randKey;
      const step=context.startsWith('live')?resolveLiveStep(key,context):resolveDraftStep(key);
      const cfg=readRandomizationFromDOM(step,key,{context});
      const output=[...document.querySelectorAll('[data-rand-preview-value]')].find(el=>el.dataset.randKey===String(key)&&el.dataset.randContext===context);
      if(output) {
        if(['numberRangeIncrement','currencyRange','percentRange'].includes(cfg.strategy)){
          const min=Number(cfg.options?.min),max=Number(cfg.options?.max),decimals=Math.max(0,Math.min(10,Number(cfg.options?.decimals)||0));
          let increment=Number(cfg.options?.step);if(cfg.strategy==='percentRange'){const scaleRaw=step?.target?.scale,targetScale=scaleRaw!==undefined&&scaleRaw!==null&&String(scaleRaw)!==''&&Number.isInteger(Number(scaleRaw))?Math.max(0,Math.min(10,Number(scaleRaw))):null,defaultStep=targetScale===null?1:1/Math.pow(10,targetScale),autoStep=targetScale===null?decimals>0:decimals!==targetScale;if(autoStep&&Math.abs(increment-defaultStep)<1e-12)increment=1/Math.pow(10,decimals);}
          const current=Number(String(output.textContent||'').replace(/[^0-9eE+.-]/g,''));
          let next=Number.isFinite(current)&&current>=min&&current<=max?current+increment:min;
          if(!Number.isFinite(next)||next>max+1e-9)next=min;
          if(Math.abs(next)<1e-9){next=min>0?min:increment;if(next>max)next=min;}
          output.textContent=Number(next.toFixed(decimals)).toString();
        } else output.textContent=randomizationOptionValue(step,cfg);
      }
      return;
    }
    const remove = event.target.closest('[data-remove-live-step]');
    if(remove){ event.preventDefault();event.stopPropagation();await removeLiveRecordingStep(Number(remove.dataset.removeLiveStep)); }
  });
  app.addEventListener('keydown', event => {
    const heading = event.target.closest('[data-rand-heading]');
    if (!heading || !['Enter',' '].includes(event.key)) return;
    const editor = heading.closest('[data-randomization-editor]');
    if (!editor?.classList.contains('is-enabled')) return;
    event.preventDefault();
    const collapsed = editor.classList.contains('is-collapsed');
    setRandomizationExpanded(editor.dataset.randContext || 'edit', editor.dataset.randKey || '', collapsed);
  });
  app.addEventListener('change', async event => {
    const control=event.target.closest('[data-rand-enabled],[data-rand-strategy],[data-rand-option],[data-rand-allowed]');
    if(!control)return;
    const context=control.dataset.randContext||'edit', key=control.dataset.randKey;
    const step=context.startsWith('live')?resolveLiveStep(key,context):resolveDraftStep(key);
    if(!step)return;
    if(control.dataset.randOption==='step') control.dataset.fpStepTouched='true';
    if(control.dataset.randOption==='decimals' && (step.randomization?.strategy||control.closest('[data-randomization-editor]')?.querySelector('[data-rand-strategy]')?.value)==='percentRange'){
      const increment=control.closest('[data-randomization-editor]')?.querySelector('[data-rand-option="step"]');
      const defaultStep=Number(getRandomizationDefaults(step,'percentRange').options.step);
      if(increment && increment.dataset.fpStepTouched!=='true' && Number.isFinite(defaultStep) && Math.abs(Number(increment.value)-defaultStep)<1e-12 && Number(control.value)>=0) increment.value=String(1/Math.pow(10,Math.min(10,Number(control.value))));
    }
    const oldConfig=step.randomization?clone(step.randomization):null;
    let cfg=readRandomizationFromDOM(step,key,{context});
    if(control.matches('[data-rand-strategy]')){
      const enabled=!!document.querySelector(`[data-randomization-editor][data-rand-key="${CSS.escape(String(key))}"][data-rand-context="${context}"] [data-rand-enabled]`)?.checked;
      cfg=getRandomizationDefaults(step,control.value);cfg.enabled=enabled;
      if(oldConfig?.options?.unique && cfg.options)cfg.options.unique=true;
      step.randomization=cfg;
      replaceRandomizationEditor(step,key,context);
      cfg=readRandomizationFromDOM(step,key,{context});
    }
    if(control.matches('[data-rand-enabled]') && cfg.enabled){
      if(cfg.strategy==='lookupCreate'){
        control.checked=false;
        setRandomizationError(control.closest('[data-randomization-editor]'),'This lookup already uses its captured Create New workflow. Randomize the new-record fields below, or choose “Random existing record”.');
        return;
      }
      const core=randomizerCore();const verdict=core?.validate?.(step,cfg)||{ok:true};
      if(!verdict.ok){
        control.checked=false;
        setRandomizationError(control.closest('[data-randomization-editor]'),verdict.error);
        return;
      }
      step.randomization=cfg;
      setRandomizationExpanded(context,key,true);
      replaceRandomizationEditor(step,key,context);
      cfg=readRandomizationFromDOM(step,key,{context});
    } else if(control.matches('[data-rand-enabled]') && !cfg.enabled) {
      step.randomization=cfg;
      setRandomizationExpanded(context,key,false);
      replaceRandomizationEditor(step,key,context);
      cfg=readRandomizationFromDOM(step,key,{context});
    }
    if(context==='edit'){
      const verdict=cfg.enabled?(randomizerCore()?.validate?.(step,cfg)||{ok:true}):{ok:true};
      setRandomizationError([...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===String(key)&&el.dataset.randContext===context),verdict.ok?'':verdict.error);
      const output=[...document.querySelectorAll('[data-rand-preview-value]')].find(el=>el.dataset.randKey===String(key)&&el.dataset.randContext===context);if(output)output.textContent=randomizationOptionValue(step,cfg);
      step.randomization=cfg;
      return;
    }
    const editor=[...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===String(key)&&el.dataset.randContext===context);
    const verdict=cfg.enabled?(randomizerCore()?.validate?.(step,cfg)||{ok:true}):{ok:true};
    if(!verdict.ok){setRandomizationError(editor,verdict.error);return;}
    setRandomizationError(editor,'');
    const success=await persistLiveRandomization(key,cfg,oldConfig,context);
    if(!success){ if(oldConfig)step.randomization=oldConfig; else delete step.randomization; }
    else step.randomization=clone(cfg);
    const list=document.getElementById('recording-field-list');
    if(list) {
      list.dataset.fpRenderSignature=liveStepsRenderSignature(state.activeSteps);
      const liveIndex=context==='live'?Number(key):Number(String(key).match(/^wf-(\d+)-/)?.[1]);
      if(context==='live'&&Number.isInteger(liveIndex)) {
        const row=list.querySelector(`.recording-live-row[data-live-row-index="${liveIndex}"]`);
        const display=row?.querySelector('.field-value');
        if(display)display.innerHTML=renderStepValue(step);
      }
    }
  });
}
async function persistLiveRandomization(key, config, previousConfig, context='live') {
  const raw=String(key);let index=Number(raw),step=null,parent=null,childIndex=null;
  if(context==='live-child'){
    const match=raw.match(/^wf-(\d+)-(\d+)$/);if(!match)return false;
    index=Number(match[1]);childIndex=Number(match[2]);parent=state.activeSteps?.[index];step=lookupCreateWorkflow(parent)?.fields?.[childIndex]||null;
  }else step=state.activeSteps?.[index];
  if(!step)return false;
  if((step.__fpExistingAppendStep || parent?.__fpExistingAppendStep) && state.addingToRecordingId){
    const recording=state.recordings[state.addingToRecordingId];const at=Number(parent?.__fpExistingIndex ?? step.__fpExistingIndex);
    const stored=childIndex===null?recording?.steps?.[at]:lookupCreateWorkflow(recording?.steps?.[at])?.fields?.[childIndex];
    if(!stored)return false;
    const old=clone(stored);if(config)stored.randomization=clone(config);else delete stored.randomization;recording.updatedAt=new Date().toISOString();
    try{await saveRecordings(state.recordings);step.randomization=config?clone(config):undefined;return true;}catch(error){
      if(childIndex===null)recording.steps[at]=old;else{const fields=lookupCreateWorkflow(recording?.steps?.[at])?.fields;if(fields)fields[childIndex]=old;}
      showInline(error?.message||'Could not save randomization settings.');return false;
    }
  }
  const tab=await chrome.tabs.get(state.recordingTabId).catch(()=>null);if(!tab?.id){showInline('The Salesforce recording tab is no longer available.');return false;}
  const result=await sendTab(tab,{type:'UPDATE_RECORDING_STEP_RANDOMIZATION',index,localIndex:parent?.__fpFrameStepIndex??step.__fpFrameStepIndex??index,storageFrameId:parent?.__fpStorageFrameId??step.__fpStorageFrameId??0,frameId:parent?.frame?.frameId??step?.frame?.frameId,frame:parent?.frame||step?.frame,stepId:parent?.id||parent?.meta?.recordedAt||step?.id||step?.meta?.recordedAt,workflowChildIndex:childIndex,randomization:config||null});
  if(!result?.ok){showInline(result?.message||'Could not save randomization settings to the active recording.');if(previousConfig)step.randomization=clone(previousConfig);return false;}
  step.randomization=config?clone(config):undefined;return true;
}

function liveStepsRenderSignature(steps) { try { return JSON.stringify(steps || []); } catch { return String((steps || []).length); } }
function updateLiveRecordingList(list, steps, force = false) {
  if (!list) return;
  const signature = liveStepsRenderSignature(steps);
  if (!force && list.dataset.fpRenderSignature === signature) return;
  const oldScrollTop = list.scrollTop;
  const oldRows = [...list.querySelectorAll('.recording-live-row')];
  const oldCount = Number(list.dataset.fpStepCount ?? oldRows.length);
  const hasNewSteps = Array.isArray(steps) && steps.length > oldCount;
  const scrollToLatest = () => requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  const prefixMatches = oldRows.length === oldCount && oldRows.every((row, index) => row.dataset.liveRowKey === liveRowIdentity(steps?.[index]));
  // New captures are appended without rebuilding existing DOM. This keeps focused
  // controls and in-progress values intact, while the previous field panels fold up.
  if (!force && prefixMatches && Array.isArray(steps) && steps.length > oldCount) {
    // A newly captured field starts with its own collapsed editor. Do not retain an
    // old open-editor token: the next 300 ms recording refresh would otherwise
    // reopen previously collapsed fields when their rows are reconstructed.
    collapseRandomizationGroup('live');
    oldRows.forEach(row => row.querySelectorAll('.fp-randomization-editor.is-enabled').forEach(editor => editor.classList.add('is-collapsed')));
    const template = document.createElement('template');
    template.innerHTML = renderLiveRecordingRows(steps.slice(oldCount), oldCount).trim();
    list.append(template.content);
    list.dataset.fpStepCount = String(steps.length);
    list.dataset.fpRenderSignature = signature;
    scrollToLatest();
    return;
  }
  // Preserve unsaved editor values and focus if a same-length update requires a
  // refresh (for example, a Salesforce descriptor was enriched asynchronously).
  const draftControls = [...list.querySelectorAll('[data-rand-option],[data-rand-enabled],[data-rand-allowed],[data-rand-strategy]')].map(el => ({
    key:el.dataset.randKey, context:el.dataset.randContext, option:el.dataset.randOption || '', allowed:el.hasAttribute('data-rand-allowed') ? el.dataset.randValue || '' : null,
    strategy:el.hasAttribute('data-rand-strategy'), enabled:el.hasAttribute('data-rand-enabled'), checked:!!el.checked, value:el.value,
    focused:el===document.activeElement, start:typeof el.selectionStart==='number'?el.selectionStart:null, end:typeof el.selectionEnd==='number'?el.selectionEnd:null
  }));
  const openedWorkflowRandomizers = new Set([...list.querySelectorAll('.fp-live-child-randomizers[open]')].map(el => el.querySelector('[data-randomization-editor]')?.dataset.randKey?.match(/^wf-(\d+)-/)?.[1]).filter(x => x != null));
  const openedCreateWorkflows = new Set([...list.querySelectorAll('[data-lookup-create-details][open]')].map(el => el.closest('.field-row')?.querySelector('[data-randomization-editor][data-rand-context="live"]')?.dataset.randKey).filter(x => x != null));
  list.innerHTML = renderLiveRecordingRows(steps);
  for (const workflow of list.querySelectorAll('.fp-live-child-randomizers')) {
    const index = workflow.querySelector('[data-randomization-editor]')?.dataset.randKey?.match(/^wf-(\d+)-/)?.[1];
    if (index != null && openedWorkflowRandomizers.has(index)) workflow.open = true;
  }
  for (const detail of list.querySelectorAll('[data-lookup-create-details]')) {
    const key = detail.closest('.field-row')?.querySelector('[data-randomization-editor][data-rand-context="live"]')?.dataset.randKey;
    if (key != null && openedCreateWorkflows.has(key)) detail.open = true;
  }
  let focusTarget = null;
  for (const snapshot of draftControls) {
    const match = [...list.querySelectorAll('[data-rand-option],[data-rand-enabled],[data-rand-allowed],[data-rand-strategy]')].find(el =>
      el.dataset.randKey===snapshot.key && el.dataset.randContext===snapshot.context &&
      (snapshot.strategy ? el.hasAttribute('data-rand-strategy') : snapshot.enabled ? el.hasAttribute('data-rand-enabled') : snapshot.allowed!==null ? el.hasAttribute('data-rand-allowed') && (el.dataset.randValue||'')===snapshot.allowed : el.dataset.randOption===snapshot.option));
    if (!match) continue;
    if (match.type==='checkbox') match.checked=snapshot.checked; else if (snapshot.value!==undefined) match.value=snapshot.value;
    if (snapshot.focused) focusTarget={el:match,start:snapshot.start,end:snapshot.end};
  }
  if (focusTarget) {
    try { focusTarget.el.focus({preventScroll:true}); if(focusTarget.start!==null)focusTarget.el.setSelectionRange(focusTarget.start,focusTarget.end); } catch {}
  }
  list.dataset.fpStepCount = String(Array.isArray(steps)?steps.length:0);
  list.dataset.fpRenderSignature = signature;
  if (hasNewSteps) scrollToLatest();
  else requestAnimationFrame(() => { list.scrollTop = oldScrollTop; });
}
function renderLiveWorkflowRandomization(step,parentIndex){
  const workflow=lookupCreateWorkflow(step);if(!workflow?.fields?.length)return '';
  const randomized=workflow.fields.filter(f=>f?.randomization?.enabled).length;
  return `<details class="fp-live-child-randomizers"><summary><span>New-record field values</span><small>${randomized?`${randomized} randomized`:'Optional randomization'}</small><span class="fp-randomization-chevron">${icon('chevron')}</span></summary><div class="fp-live-child-randomizers-body">${workflow.fields.map((child,i)=>`<div class="fp-live-child-randomizer"><div class="fp-live-child-label">${escapeHtml(child?.target?.label||'New-record field')}</div>${renderRandomizationEditor(child,`wf-${parentIndex}-${i}`,{context:'live-child'})}</div>`).join('')}</div></details>`;
}
function renderStepValue(step) {
  return step?.randomization?.enabled
    ? '<span class="fp-randomized-value">Randomized</span>'
    : escapeHtml(fmtStepValue(step));
}
function liveRowIdentity(step) {
  return String(step?.id || step?.meta?.recordedAt || step?.target?.key || `${step?.target?.label||'field'}:${step?.sequence||''}`);
}
function renderLiveRecordingRows(steps, startIndex = 0) {
  return (steps || []).map((s, localIndex) => {
    const i = startIndex + localIndex;
    return `<div class="field-row recording-live-row" data-live-row-index="${i}" data-live-row-key="${escapeHtml(liveRowIdentity(s))}"><span class="step-number">${i + 1}</span><div class="field-main"><span class="field-name">${escapeHtml(s.target.label)}</span><span class="field-detail"><span class="field-value">${renderStepValue(s)}</span><span class="field-type" title="${escapeHtml(fieldTypeDisplayTitle(s))}">${escapeHtml(fieldTypeDisplay(s))}</span></span>${renderLookupCreateWorkflow(s)}${renderRandomizationEditor(s, String(i), { context: 'live' })}${renderLiveWorkflowRandomization(s,i)}</div><button class="live-remove-field" type="button" data-remove-live-step="${i}" title="Remove field from recording" aria-label="Remove ${escapeHtml(s.target.label)} from recording"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l1 2h3v2H3V5h3l1-2Zm-2 5h10l-.7 9H5.7L5 8Zm3 2v5h1v-5H8Zm3 0v5h1v-5h-1Z"/></svg></button></div>`;
  }).join('') || (startIndex || state.recording ? '' : '<div class="empty-state"><strong>Nothing recorded yet</strong></div>');
}

function lookupCreateWorkflow(step){
  const workflow=step?.meta?.createNewRecord;
  return workflow&&Array.isArray(workflow.fields)?workflow:null;
}
function renderWorkflowRecordType(workflow,parentIndex,editing){
  const typeLabel=String(workflow?.recordTypeLabel||'').trim();
  const options=[...new Set((Array.isArray(workflow?.recordTypeOptions)?workflow.recordTypeOptions:[]).map(x=>String(x||'').trim()).filter(Boolean))];
  if(typeLabel&&!options.some(x=>x.toLowerCase()===typeLabel.toLowerCase()))options.unshift(typeLabel);
  let valueMarkup;
  if(editing&&options.length){
    valueMarkup=`<select class="edit-control fp-workflow-record-type-select" data-edit-record-type="${parentIndex}" aria-label="Record type"><option value="" ${!typeLabel?'selected':''}>Salesforce default</option>${options.map(option=>`<option value="${escapeHtml(option)}" ${option.toLowerCase()===typeLabel.toLowerCase()?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  }else if(editing){
    valueMarkup=`<input class="edit-control fp-workflow-record-type-input" data-edit-record-type="${parentIndex}" value="${escapeHtml(typeLabel)}" placeholder="Salesforce default" aria-label="Record type label">`;
  }else{
    valueMarkup=`<strong>${escapeHtml(typeLabel||'Salesforce default')}</strong>`;
  }
  return `<div class="fp-workflow-record-type ${typeLabel?'':'is-auto'}"><span>Record type</span>${valueMarkup}</div>`;
}
function renderLookupCreateWorkflow(step,result=null,{compact=false,editing=false,parentIndex=null}={}){
  const workflow=lookupCreateWorkflow(step);if(!workflow)return'';
  const fields=Array.isArray(workflow.fields)?workflow.fields:[];
  const objectLabel=String(workflow.objectLabel||'record');
  const typeLabel=String(workflow.recordTypeLabel||'').trim();
  const resultById=new Map((Array.isArray(result?.workflowResults)?result.workflowResults:[]).map(item=>[String(item?.id||''),item]));
  const resultByLabel=new Map((Array.isArray(result?.workflowResults)?result.workflowResults:[]).map(item=>[String(item?.label||'').toLowerCase(),item]));
  if(compact)return `<div class="fp-create-workflow-compact"><span class="fp-create-workflow-icon">${icon('add')}</span><span><strong>Create new ${escapeHtml(objectLabel)}</strong><small>${fields.length} field${fields.length===1?'':'s'}${typeLabel?` · ${escapeHtml(typeLabel)}`:''}</small></span></div>`;
  const fieldRows=fields.map((child,index)=>{
    const childResult=resultById.get(String(child?.id||''))||resultByLabel.get(String(child?.target?.label||'').toLowerCase());
    const status=String(childResult?.status||'');
    const statusClass=status==='filled'||status==='ok'?'is-done':status==='failed'?'is-failed':status==='skipped'?'is-skipped':'';
    const statusText=status==='filled'||status==='ok'?'Filled':status==='failed'?'Failed':status==='skipped'?'Skipped':'';
    if(editing){
      const editKey=`wf-${parentIndex}-${index}`;
      return `<li class="fp-workflow-field fp-workflow-field-editing"><span class="fp-workflow-field-number">${index+1}</span><div class="fp-workflow-field-copy"><strong>${escapeHtml(child?.target?.label||'Unnamed field')}</strong><div class="fp-workflow-child-editor">${renderEditField(child,editKey)}${renderRandomizationEditor(child,editKey,{context:"edit"})}</div></div><button class="delete-step iconbtn fp-workflow-delete-child" data-delete-workflow-child="${parentIndex}:${index}" title="Remove child field" aria-label="Remove ${escapeHtml(child?.target?.label||'child field')}" type="button">${icon('delete')}</button></li>`;
    }
    const childWasRandomized=status==='filled'&&!!childResult?.randomized&&childResult?.generatedValue!==undefined;
    const childApplied=childWasRandomized?{...child,value:childResult.generatedValue,meta:{...(child?.meta||{}),...(childResult?.generationMetaPatch||{})}}:child;
    const childDisplay=escapeHtml(fmtStepValue(childApplied));
    return `<li class="fp-workflow-field ${statusClass}"><span class="fp-workflow-field-number">${index+1}</span><span class="fp-workflow-field-copy"><strong>${escapeHtml(child?.target?.label||'Unnamed field')}</strong><small>${childDisplay} <span>· ${escapeHtml(fieldTypeLabel(child))}</span></small>${childResult?.message&&status==='failed'?`<small class="fp-workflow-child-error">${escapeHtml(childResult.message)}</small>`:''}</span>${statusText?`<span class="fp-workflow-child-status">${escapeHtml(statusText)}</span>`:''}</li>`;
  }).join('');
  const instruction=result
    ? (statusOf({result})==='failed'?'A step needs attention.':'Related record created and fields filled.')
    : 'Opens New, fills the fields below, then saves.';
  return `<details class="fp-create-workflow-details ${editing?'is-editing':''}" data-lookup-create-details ${editing?'open':''}><summary><span class="fp-create-workflow-icon">${icon('add')}</span><span class="fp-create-workflow-summary-copy"><strong>Create new ${escapeHtml(objectLabel)}</strong><small>${fields.length} field${fields.length===1?'':'s'} ${editing?'to edit':'to fill'}</small></span><span class="fp-create-workflow-chevron" aria-hidden="true">${icon('chevron')}</span></summary><div class="fp-create-workflow-body">${editing?'':`<p class="fp-create-workflow-instruction">${escapeHtml(instruction)}</p>`}${renderWorkflowRecordType(workflow,parentIndex,editing)}<div class="fp-workflow-fields-heading">New ${escapeHtml(objectLabel)} fields <span>${fields.length}</span></div><ol class="fp-workflow-fields">${fieldRows||'<li class="fp-workflow-empty">No fields captured yet.</li>'}</ol></div></details>`;
}
function renderLiveLookupCreationStatus(capture){
  if(!capture?.active)return'';
  const stage=capture.stage==='record-type'?(capture.recordTypeLabel?`Selected record type: ${capture.recordTypeLabel} · click Next to continue`:'Choose a record type, then click Next'):capture.stage==='opening'?'Opening the new-record form':'Fill the new record, then click Save';
  return `<div class="fp-live-create-status" role="status" aria-live="polite"><div class="fp-live-create-icon">${icon('add')}</div><div class="fp-live-create-copy"><div class="fp-live-create-title">Creating a related record</div><div class="fp-live-create-context">${escapeHtml(capture.lookupLabel||'Lookup')} → New ${escapeHtml(capture.objectLabel||'record')}</div><div class="fp-live-create-stage">${escapeHtml(stage)}</div>${capture.recordTypeLabel?`<div class="fp-live-create-recordtype">Record type: <strong>${escapeHtml(capture.recordTypeLabel)}</strong></div>`:''}<div class="fp-live-create-count">${Number(capture.fieldCount||0)} field${Number(capture.fieldCount||0)===1?'':'s'} captured in this form</div></div></div>`;
}

function renderRecording() {
  const adding = !!state.addingToRecordingId;
  const title = adding ? recordingTitle(state.recordings[state.addingToRecordingId]) : 'New recording';
  const hasSteps = state.activeSteps.length > 0;
  return `<section class="recording-top sticky-action ${adding ? 'recording-top-append' : ''}">
    <div class="recording-state"><span class="recording-dot" aria-hidden="true"></span><div><strong>${adding ? 'Adding field' : 'Recording'}</strong><span id="recording-object">${escapeHtml(adding ? title : (state.context?.objectLabel || state.context?.objectApiName || 'Salesforce'))}</span></div></div>
    <div class="recording-actions"><button class="pause-button${state.recordingPaused ? ' is-paused' : ''}" id="pauseRecording" type="button"><span class="pause-glyph" aria-hidden="true">${icon(state.recordingPaused ? 'play' : 'pause')}</span><span>${state.recordingPaused ? 'Resume' : 'Pause'}</span></button><button class="stop-button button-with-icon" id="stop" type="button" ${stopRecordingPromise ? 'disabled aria-busy="true"' : ''}>${icon('stop')}<span>${stopRecordingPromise ? 'Stopping…' : (adding ? 'Done adding' : 'Stop recording')}</span></button></div>
  </section>
  <div class="recording-note ${hasSteps ? 'is-hidden' : ''}" id="recording-note">${adding ? 'Edit Salesforce fields to add them to this recording.' : 'Edit Salesforce fields to record their values.'}</div>
  <div id="lookup-create-capture-status">${renderLiveLookupCreationStatus(state.activeLookupCreation)}</div>
  <section class="field-list" id="recording-field-list">${renderLiveRecordingRows(state.activeSteps)}</section>`;
}

function renderSaveNamePrompt() {
  const r = state.pendingRecording;
  const suggested = r?.name || recordingTitle(r) || 'New recording';
  const fieldCount = r?.steps?.length || 0;
  return `<section class="save-name-page">
    <section class="save-name-card">
      <h1>Save recording</h1>
      <label class="recording-name-editor"><span>Recording name</span><input class="edit-control ${state.saveNameError ? 'has-error' : ''}" id="pendingRecordingName" maxlength="200" value="${escapeHtml(suggested)}" placeholder="Recording name" aria-invalid="${state.saveNameError ? 'true' : 'false'}"><span class="name-error" role="alert" ${state.saveNameError ? '' : 'hidden'}>${escapeHtml(state.saveNameError || '')}</span></label>
      <div class="save-tip">Tip: Use Object + status e.g. Project – Scoping</div>
      <div class="save-name-meta">${fieldCount} recorded field${fieldCount === 1 ? '' : 's'}</div>
      <div class="actions save-name-actions"><button class="secondary action-button" id="cancelSave">Cancel</button><button class="primary action-button" id="confirmSave">Save recording</button></div>
    </section>
  </section>`;
}

async function hydrateDraftPicklists(draftObj){
  const allSteps=[];const queue=[...(Array.isArray(draftObj?.steps)?draftObj.steps:[])];const seen=new Set();
  while(queue.length){const step=queue.shift();if(!step||typeof step!=='object'||seen.has(step))continue;seen.add(step);allSteps.push(step);const child=step?.meta?.createNewRecord?.fields;if(Array.isArray(child))queue.push(...child);}
  const eligible=allSteps.filter(s=>['Picklist','Multipicklist'].includes(fieldTypeLabel(s)));
  for(const s of eligible){const recovered=recoverPicklistLabel(s.value,s?.target?.label,typeOptions(s));if(recovered!==s.value){s.value=recovered;s.meta={...(s.meta||{}),selectedDisplayValue:recovered};}}
  const needs=eligible.filter(s=>!typeOptions(s).length);
  if(!needs.length)return;
  const resp=await chrome.runtime.sendMessage({type:'GET_FIELD_DESCRIPTORS',targets:needs.map(s=>s.target)}).catch(()=>null);
  if(!resp?.ok)return;
  const byKey=new Map();
  const addDescriptor=(key,d)=>{if(!key)return;const previous=byKey.get(key);byKey.set(key,previous?{...previous,...d,options:d.options?.length?d.options:(previous.options||[])}:d);};
  for(const d of resp.descriptors||[]){addDescriptor(d.targetKey,d);addDescriptor(d.resolvedTargetKey,d);addDescriptor(d.apiName?`api:${d.apiName}`:'',d);}
  for(const step of needs){
    const d=byKey.get(step.target?.key)||byKey.get(step.target?.apiName?`api:${step.target.apiName}`:'');if(!d)continue;
    const mergedOptions=d.options?.length?d.options:typeOptions(step);
    step.target={...step.target,apiName:d.apiName||step.target?.apiName,objectApiName:d.objectApiName||step.target?.objectApiName,fieldPath:d.fieldPath||step.target?.fieldPath,kind:d.kind||step.target.kind,fieldType:d.fieldType||step.target.fieldType,sfDataType:d.sfDataType||step.target.sfDataType,salesforceType:d.salesforceType||step.target.salesforceType,options:mergedOptions};
    const recovered=recoverPicklistLabel(step.value,step?.target?.label,mergedOptions);if(recovered!==step.value){step.value=recovered;step.meta={...(step.meta||{}),selectedDisplayValue:recovered};}
  }
}

function renderEditField(s, i) {
  const t = fieldTypeLabel(s), v = s.value;
  if (t === 'Checkbox') return `<label class="edit-check"><input class="check" type="checkbox" data-edit-bool="${i}" ${v === true || String(v).toLowerCase() === 'true' ? 'checked' : ''}><span>Checked</span></label>`;
  if (t === 'Picklist' && typeOptions(s).length) {
    return `<select class="edit-control" data-edit-value="${i}">${typeOptions(s).map(o => `<option value="${escapeHtml(o.value)}" ${(String(v) === String(o.value) || String(v) === String(o.displayValue)) ? 'selected' : ''}>${escapeHtml(o.displayValue || o.value)}</option>`).join('')}</select>`;
  }
  if (t === 'Multipicklist' && typeOptions(s).length) {
    return `<div class="multi-editor">${typeOptions(s).map(o => {
      const on = valuesArray(v).some(x => String(x).toLowerCase() === String(o.value).toLowerCase() || String(x).toLowerCase() === String(o.displayValue).toLowerCase());
      return `<label><input type="checkbox" data-multi-index="${i}" data-multi-value="${escapeHtml(o.displayValue || o.value)}" ${on ? 'checked' : ''}><span>${escapeHtml(o.displayValue || o.value)}</span></label>`;
    }).join('')}</div>`;
  }
  if (t === 'Address') {
    const address = v && typeof v === 'object' ? v : {};
    // Lightning's address component exposes the region as `province`; keep the
    // original component key so editing does not create a second, ignored `state`
    // property alongside the value the live Salesforce control actually uses.
    const parts = [
      ['street','Street',['Street']],['city','City',['City']],['province','State / Province',['state','State','province']],['postalCode','Postal code',['PostalCode','postalCode']],['country','Country',['Country']]
    ];
    return `<div class="fp-address-editor">${parts.map(([part,label,aliases])=>{const value=address[part] ?? aliases.map(alias=>address[alias]).find(v=>v!==undefined) ?? '';return `<label><span>${label}</span><input class="edit-control" type="text" data-address-edit-part="${i}" data-address-part="${part}" value="${escapeHtml(value)}" placeholder="${label}"></label>`}).join('')}</div>`;
  }
  if (t === 'Date') {
    const meta = s?.meta || {};
    if (meta.dateMode === 'relative' && Number.isFinite(Number(meta.dateOffsetDays))) {
      const offset = Number(meta.dateOffsetDays), sign = offset < 0 ? '-' : '+';
      return `<div class="relative-date-editor"><span class="relative-date-fixed">Today</span><select class="edit-control relative-date-sign" data-date-sign="${i}" aria-label="Relative date direction"><option value="+" ${sign === '+' ? 'selected' : ''}>+</option><option value="-" ${sign === '-' ? 'selected' : ''}>-</option></select><input class="edit-control relative-date-number" type="number" min="0" step="1" data-date-offset="${i}" value="${Math.abs(offset)}" aria-label="Number of days"><span class="relative-date-fixed">days</span></div>`;
    }
    const exact = String(s.value || '').slice(0, 10);
    return `<input class="edit-control" type="date" data-edit-value="${i}" value="${escapeHtml(exact)}" aria-label="Recorded date">`;
  }
  if (t === 'Date/Time') return `<input class="edit-control" type="datetime-local" data-edit-value="${i}" value="${escapeHtml(String(v || '').slice(0,16))}" aria-label="Recorded date and time">`;
  if (t === 'Time') return `<input class="edit-control" type="time" data-edit-value="${i}" value="${escapeHtml(String(v || '').slice(0,5))}" aria-label="Recorded time">`;
  if (t === 'Long Text') return `<textarea class="edit-control fp-longtext-edit" data-edit-value="${i}" rows="3" placeholder="Recorded value">${escapeHtml(String(v ?? ''))}</textarea>`;
  const inputType = t === 'Email' ? 'email' : t === 'Phone' ? 'tel' : t === 'URL' ? 'url' : 'text';
  return `<input class="edit-control" type="${inputType}" data-edit-value="${i}" value="${escapeHtml(Array.isArray(v) ? v.join('; ') : v && typeof v === 'object' && 'displayValue' in v ? v.displayValue : String(v ?? ''))}" placeholder="Recorded value">`;
}

function eligibleStepIndexes(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s, i) => s && s.enabled !== false ? i : -1)
    .filter(i => i >= 0);
}

function enterFieldSelectionMode() {
  const r = state.recordings[state.selectedId];
  if (!r || state.editing) return;
  state.selectionMode = true;
  state.selectedStepIndexes = new Set(eligibleStepIndexes(r.steps));
  render();
}

function exitFieldSelectionMode() {
  state.selectionMode = false;
  state.selectedStepIndexes = new Set();
  render();
}

function toggleSelectedStep(index) {
  const i = Number(index);
  if (!Number.isInteger(i)) return;
  const next = new Set(state.selectedStepIndexes);
  if (next.has(i)) next.delete(i); else next.add(i);
  state.selectedStepIndexes = next;
  render();
  document.querySelector(`[data-select-checkbox="${i}"]`)?.focus();
}

function selectAllFields() {
  const r = state.recordings[state.selectedId];
  state.selectedStepIndexes = new Set(eligibleStepIndexes(r?.steps));
  render();
}

function clearAllFields() {
  state.selectedStepIndexes = new Set();
  render();
}

async function runSelectedFields() {
  const indexes = [...state.selectedStepIndexes].sort((a, b) => a - b);
  if (!indexes.length) return;
  await startAutofill(indexes);
}

function renderDetail(r) {
  const x = state.editing && state.draft ? state.draft : r;
  const steps = Array.isArray(x?.steps) ? x.steps : [];
  const detailActions = state.editing
    ? `<button class="secondary action-button button-with-icon" id="cancelEdit" type="button">${icon('close')}<span>Cancel</span></button><button class="primary action-button button-with-icon" id="saveInline" type="button">${icon('save')}<span>Save changes</span></button>`
    : `<button class="primary autofill-button action-button button-with-icon" id="autofill" type="button">${icon('bolt')}<span>Autofill</span></button><button class="secondary action-button button-with-icon" id="edit" type="button">${icon('edit')}<span>Edit</span></button>`;
  const selectedCount = state.selectedStepIndexes.size;
  const selectableCount = eligibleStepIndexes(steps).length;
  const allSelected = selectableCount > 0 && selectedCount === selectableCount;
  const fieldHeaderAction = state.selectionMode
    ? `<div class="recorded-fields-actions is-selection-mode"><div class="run-selected-selection-tools"><span class="run-selected-count">${selectedCount}/${selectableCount} selected</span><button class="run-selected-mini-action" id="selectAllFields" type="button">${allSelected ? 'Clear' : 'Select all'}</button><button class="run-selected-done" id="doneSelectingFields" type="button">Done</button></div></div>`
    : state.editing
      ? `<div class="recorded-fields-actions"><button class="add-field-button button-with-icon" id="addField" type="button" title="Add fields to this recording">${icon('add')}<span>Add Fields</span></button></div>`
      : `<div class="recorded-fields-actions"><button class="run-selected-toggle" id="runSelectedFields" type="button" title="Choose which recorded fields to autofill">${icon('check')}<span>Run Selected Fields</span></button></div>`;
  const fieldRows = steps.map((s, i) => {
    if (state.selectionMode) {
      const checked = state.selectedStepIndexes.has(i);
      const eligible = s?.enabled !== false;
      return `<label class="field-row selection-field-row ${checked ? 'is-selected' : ''} ${eligible ? '' : 'is-ineligible'}" data-select-step="${i}">
        <input class="run-select-checkbox" type="checkbox" data-select-checkbox="${i}" ${checked ? 'checked' : ''} ${eligible ? '' : 'disabled'} aria-label="Include ${escapeHtml(s?.target?.label || 'field')} in Autofill">
        <div class="field-main"><span class="field-name">${escapeHtml(s?.target?.label || 'Unnamed field')}</span><span class="field-detail"><span class="field-value">${renderStepValue(s)}</span><span class="field-type" title="${escapeHtml(fieldTypeDisplayTitle(s))}">${escapeHtml(fieldTypeDisplay(s))}</span></span>${renderLookupCreateWorkflow(s,null,{compact:true})}</div>
      </label>`;
    }
    return `<div class="field-row ${state.editing ? 'editing' : 'clickable'}" ${state.editing ? '' : `data-focus-step="${i}"`}>
      <span class="step-number">${i + 1}</span><div class="field-main">${state.editing ? `<div class="fp-field-name-row"><span class="field-name">${escapeHtml(s?.target?.label || 'Unnamed field')}</span><button class="delete-step iconbtn" data-delete-step="${i}" title="Remove field" aria-label="Remove field" type="button">${icon('delete')}</button></div><span class="edit-wrap">${renderEditField(s, i)}${renderRandomizationEditor(s,String(i),{context:"edit"})}</span>${renderLookupCreateWorkflow(s,null,{editing:true,parentIndex:i})}` : `<span class="field-name">${escapeHtml(s?.target?.label || 'Unnamed field')}</span><span class="field-detail"><span class="field-value">${renderStepValue(s)}</span><span class="field-type" title="${escapeHtml(fieldTypeDisplayTitle(s))}">${escapeHtml(fieldTypeDisplay(s))}</span></span>${renderLookupCreateWorkflow(s)}`}</div>${state.editing ? '' : `<span class="row-chevron" aria-hidden="true">${icon('arrowRight')}</span>`}
    </div>`;
  }).join('');
  const selectionFooter = state.selectionMode
    ? `<div class="run-selected-footer"><span>${selectedCount} field${selectedCount === 1 ? '' : 's'} selected</span><button class="primary run-selected-autofill" id="autofillSelected" type="button" ${selectedCount ? '' : 'disabled'}>${icon('bolt')}<span>Autofill${selectedCount ? ` ${selectedCount} field${selectedCount === 1 ? '' : 's'}` : ''}</span></button></div>`
    : '';
  return `<section class="detail-page">
  <div class="testing-topbar fp-route-header"><div class="testing-heading-wrap">${backButton('Back', 'backHome')}<div class="testing-heading"><div class="eyebrow">Recording</div><h1>${escapeHtml(recordingTitle(x))}</h1><div class="testing-subtitle">${escapeHtml(recordingMeta(x))} <span aria-hidden="true">•</span> ${escapeHtml(objectLabel(x?.context || {}))}</div></div></div></div>
  ${state.editing ? `<div class="recording-name-editor"><div class="recording-name-label-row"><label for="recordingName">Recording name</label><button class="secondary action-button button-with-icon delete-recording-edit" id="deleteRecordingEdit" type="button">${icon('delete')}<span>Delete recording</span></button></div><input class="edit-control" id="recordingName" value="${escapeHtml(x.name||recordingTitle(x))}" placeholder="Recording name"></div>` : ''}
  <div class="actions detail-actions">${detailActions}</div>
  ${!state.editing ? `<div class="setting-row compact-fill-empty"><div class="setting-copy"><strong>Fill empty fields only</strong><span>Existing Salesforce values won't be changed.</span></div><label class="switch"><input type="checkbox" id="fillEmptyOnly" ${state.fillEmptyOnly ? 'checked' : ''}><span class="slider"></span></label></div>` : ''}
  <section class="detail-field-section"><div class="section-title-row detail-fields-title"><h2>Recorded fields</h2>${fieldHeaderAction}</div>
  <div class="field-list detail-fields">${fieldRows}</div>${selectionFooter}</section></section>`;
}

function renderRunning() {
  const total = state.progress.total || (state.recordings[state.selectedId]?.steps?.length || 0);
  const current = Math.min(state.progress.current || 0, total);
  const fieldName = state.progress.fieldName || (state.recordings[state.selectedId]?.steps?.[current]?.target?.label || 'Starting…');
  const inTesting = !!state.testingAutofillActive;
  const backId = inTesting ? 'backToTesting' : 'backToDetail';
  const eyebrow = inTesting ? 'Testing · Autofill' : 'Autofill';
  const subtext = state.isRetrying ? 'Retrying the fields that failed.' : inTesting ? `Applying ${total} recorded value${total === 1 ? '' : 's'} to the current Salesforce record.` : `Applying ${total} recorded value${total === 1 ? '' : 's'}.`;
  return `<section class="progress-page"><div class="testing-topbar fp-route-header"><div class="testing-heading-wrap">${backButton('Back', backId)}<div class="testing-heading"><div class="eyebrow">${eyebrow}</div><h1>${state.isRetrying ? 'Retrying failed fields…' : 'Filling fields…'}</h1><div class="testing-subtitle">${escapeHtml(subtext)}</div></div></div></div><div class="progress-card" role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><div class="progress-current-field"><span>Current field</span><strong id="progress-field">${escapeHtml(fieldName)}</strong></div><strong id="progress-count">${current} of ${total} fields</strong><div class="progress-track" role="progressbar" aria-label="Autofill progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${current}"><span id="progress-bar" style="width:${total ? Math.round((current / total) * 100) : 0}%"></span></div></div></section>`;
}

function renderResult() {
  const r = state.recordings[state.selectedId];
  const exec = Array.isArray(state.run?.executed) ? state.run.executed : [];
  const counts = {
    filled: exec.filter(x => statusOf(x) === 'filled').length,
    skipped: exec.filter(x => statusOf(x) === 'skipped').length,
    failed: exec.filter(x => statusOf(x) === 'failed').length,
    pendingVerification: exec.filter(x => x?.result?.verificationPending).length,
  };
  const filter = ['all','filled','skipped','failed'].includes(state.resultTab) ? state.resultTab : 'all';
  const statusOrder = { failed: 0, skipped: 1, filled: 2 };
  const list = (filter === 'all' ? exec : exec.filter(x => statusOf(x) === filter)).slice().sort((a, b) => (statusOrder[statusOf(a)] ?? 9) - (statusOrder[statusOf(b)] ?? 9));
  const labels = { all: 'All', filled: 'Filled', skipped: 'Skipped', failed: 'Failed' };
  const icons = { filled: '✓', skipped: '—', failed: '!' };
  const total = exec.length;
  const success = total > 0 && counts.failed === 0 && counts.skipped === 0;
  const summary = total === 0
    ? (state.run?.error ? 'No fields were autofilled' : 'No fields were processed')
    : counts.failed
      ? `${counts.failed} field${counts.failed === 1 ? '' : 's'} failed`
      : counts.skipped
        ? `${counts.skipped} field${counts.skipped === 1 ? '' : 's'} skipped`
        : counts.pendingVerification
          ? `All ${total} field${total === 1 ? '' : 's'} filled; verification pending for ${counts.pendingVerification}`
          : `All ${total} field${total === 1 ? '' : 's'} filled successfully`;
  const summaryClass = success ? 'result-success-message' : counts.failed ? 'result-failure-message' : 'result-neutral-message';
  const preflight = state.run?.preflight;
  const preflightMessages = [
    ...(preflight?.missing || []).map(x => `Field not found: ${x.label}`),
    ...(preflight?.invalid || []).map(x => x.reason),
  ].slice(0, 8);
  const preflightDetails = preflight && !preflight.ok
    ? `<div class="result-error"><strong>Preflight checks</strong><span>${escapeHtml(preflightMessages.join(' • ') || 'Some preflight checks failed.')}</span></div>`
    : '';
  const retryButton = counts.failed
    ? `<button class="primary retry-inline button-with-icon" id="retryFailed" type="button" aria-label="Retry failed fields">${icon('refresh')}<span>Retry Failed</span></button>`
    : '';
  const resultRows = list.map(x => {
    const st = statusOf(x);
    const reason = st === 'filled' ? 'Filled' : st === 'skipped' ? (x.result?.message || 'Skipped') : (x.result?.message || 'Could not fill');
    const pending = x.result?.verificationPending ? 'Verification pending — Salesforce accepted the change, but the final value was not yet exposed for confirmation.' : '';
    const finalReason = pending || reason;
    const statusLabel=st==='filled'?'Filled':st==='skipped'?'Skipped':'Failed';
    const statusIcon=st==='filled'?'✓':st==='skipped'?'↷':'×';
    // Results show the value that was actually applied, not merely the fact that
    // randomization was enabled in the saved recording. Skipped fields retain their
    // original value because the generator deliberately runs only after the empty check.
    const didApplyRandomValue=st==='filled'&&x.result?.randomized&&x.result?.generatedValue!==undefined;
    const appliedStep=didApplyRandomValue?{...x.step,value:x.result.generatedValue,meta:{...(x.step?.meta||{}),...(x.result?.generationMetaPatch||{})}}:x.step;
    const appliedValue=didApplyRandomValue?escapeHtml(fmtStepValue(appliedStep)):escapeHtml(fmtStepValue(x.step));
    const valueMarkup = st === 'skipped'
      ? `<span class="result-value-wrap"><span class="result-row-value">${appliedValue}</span><button class="result-use" data-overwrite-index="${x.index}" type="button" aria-label="Use recorded value">Use</button></span>`
      : `<span class="result-value-wrap"><span class="result-row-value">${appliedValue}</span></span>`;
    const type=fieldTypeDisplay(x.step);
    const visibleReason=(st==='failed'||st==='skipped')?finalReason:(x.result?.randomizationWarning||'');
    const detailReason=visibleReason?`<span class="result-row-reason" title="${escapeHtml(visibleReason)}">${escapeHtml(visibleReason)}</span>`:'';
    const workflowDetails=renderLookupCreateWorkflow(x.step,x.result);
    const rowLabel=`${x?.step?.target?.label || 'Field'}, ${statusLabel}${visibleReason?`. ${visibleReason}`:''}. Select to locate this field in Salesforce.`;
    if(lookupCreateWorkflow(x.step)){const childCount=lookupCreateWorkflow(x.step).fields.length;return `<div class="result-row result-row-has-workflow ${st}" role="listitem" data-focus-index="${x.index}" tabindex="0" aria-label="${escapeHtml(rowLabel)}"><div class="result-row-main"><div class="result-row-line1"><span class="result-row-title">${escapeHtml(x?.step?.target?.label || 'Unnamed field')}</span><span class="result-status-pill"><span class="result-status-icon" aria-hidden="true">${statusIcon}</span><span>${statusLabel}</span></span></div><span class="result-row-value-line">${valueMarkup}</span><span class="fp-result-workflow-meta">Lookup + New · ${childCount} field${childCount===1?'':'s'}</span>${detailReason}${workflowDetails}</div><span class="result-chevron" aria-hidden="true">${icon('arrowRight')}</span></div>`;}
    return `<div class="result-row ${st}" role="listitem" data-focus-index="${x.index}" tabindex="0" aria-label="${escapeHtml(rowLabel)}"><div class="result-row-main"><span class="result-row-title">${escapeHtml(x?.step?.target?.label || 'Unnamed field')}</span><span class="result-row-value-line">${valueMarkup}</span>${detailReason}</div><span class="result-row-side"><span class="result-status-pill"><span class="result-status-icon" aria-hidden="true">${statusIcon}</span><span>${statusLabel}</span></span><span class="result-type">${escapeHtml(type)}</span></span><span class="result-chevron" aria-hidden="true">${icon('arrowRight')}</span></div>`;
  }).join('');
  const emptyResult = `<div class="result-empty"><strong>${filter === 'failed' ? 'No failed fields' : filter === 'skipped' ? 'No skipped fields' : filter === 'filled' ? 'No filled fields' : 'No results'}</strong></div>`;
  const inTesting = !!state.testingAutofillActive;
  const resultBackId = inTesting ? 'backToTestingFromAutofill' : 'backToDetail';
  const resultEyebrow = inTesting ? 'Testing · Autofill results' : 'Autofill results';
  return `<section class="result-page"><div class="testing-topbar fp-route-header"><div class="testing-heading-wrap">${backButton('Back', resultBackId)}<div class="testing-heading"><div class="eyebrow">${resultEyebrow}</div><h1>${escapeHtml(r?.name || 'Autofill')}</h1><div class="testing-subtitle ${summaryClass}" role="status" aria-live="polite">${escapeHtml(summary)}</div></div></div></div>
  ${state.run?.error ? `<div class="result-error"><strong>Autofill could not complete</strong><span>${escapeHtml(state.run.error)}</span></div>` : ''}${preflightDetails}
  <section class="result-section"><div class="section-title-row result-fields-title"><h2>Fields</h2>${retryButton}</div><div class="result-tabs" role="group" aria-label="Filter fields by result">${[['all',exec.length],['filled',counts.filled],['skipped',counts.skipped],['failed',counts.failed]].map(([k,n]) => `<button class="result-tab ${filter === k ? 'active' : ''}" data-result-tab="${k}" type="button" aria-pressed="${filter===k}" aria-label="${labels[k]} fields, ${n}" >${labels[k]} ${n}</button>`).join('')}</div>
  <div class="result-list" role="list" aria-label="Autofill field results">${resultRows || emptyResult}</div></section>
  </section>`;
}

function backButton(label = 'Back', id = 'backHome') {
  // Compact, text-free back control shared by every ForcePilot sidebar route.
  // Keep the accessible name even though the visible label is intentionally omitted.
  return `<button class="backtop backtop-icon-only" id="${id}" type="button" aria-label="${escapeHtml(label || 'Back')}" title="${escapeHtml(label || 'Back')}"><svg class="back-chevron-svg" aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}

function bind() {
  bindRandomizationDelegation();
  document.getElementById('startTesting')?.addEventListener('click', openTestingDashboard);
  document.querySelectorAll('[data-resume-testing-session]').forEach(button => button.addEventListener('click', e => resumeTestingSession(e.currentTarget.dataset.resumeTestingSession)));
  document.querySelectorAll('[data-delete-testing-session]').forEach(button => button.addEventListener('click', e => deleteResumableTestingSession(e.currentTarget.dataset.deleteTestingSession)));
  document.getElementById('startNewTestSession')?.addEventListener('click', startNewTestingSession);
  document.getElementById('testingViewAllSessions')?.addEventListener('click', () => { state.testingShowAllSessions = !state.testingShowAllSessions; render(); });
  document.getElementById('startNewTestSessionInline')?.addEventListener('click', startNewTestingSession);
  document.getElementById('testingSessionSelector')?.addEventListener('change', e => resumeTestingSession(e.currentTarget.value));
  document.getElementById('acceptTestingConfirm')?.addEventListener('click', () => resolveTestingConfirm(true));
  document.getElementById('cancelTestingConfirm')?.addEventListener('click', () => resolveTestingConfirm(false));
  document.getElementById('cancelTestingConfirmAction')?.addEventListener('click', () => resolveTestingConfirm(false));
  document.getElementById('record')?.addEventListener('click', startRecording);
  document.getElementById('stop')?.addEventListener('click', stopRecording);
  document.getElementById('pauseRecording')?.addEventListener('click', togglePauseRecording);
  document.getElementById('confirmSave')?.addEventListener('click', savePendingRecording);
  document.getElementById('pendingRecordingName')?.addEventListener('input', () => {
    if (!state.saveNameError) return;
    state.saveNameError = '';
    const input = document.getElementById('pendingRecordingName');
    input?.classList.remove('has-error');
    input?.setAttribute('aria-invalid', 'false');
    const error = document.querySelector('.name-error');
    if (error) { error.textContent = ''; error.hidden = true; }
  });
  document.getElementById('cancelSave')?.addEventListener('click', cancelPendingRecording);
  document.getElementById('cancelSaveRecording')?.addEventListener('click', cancelPendingRecording);
  document.getElementById('autofill')?.addEventListener('click', startAutofill);
  document.getElementById('runSelectedFields')?.addEventListener('click', enterFieldSelectionMode);
  document.getElementById('doneSelectingFields')?.addEventListener('click', exitFieldSelectionMode);
  document.getElementById('selectAllFields')?.addEventListener('click', () => { const r = state.recordings[state.selectedId]; const total = eligibleStepIndexes(r?.steps).length; if (state.selectedStepIndexes.size === total) clearAllFields(); else selectAllFields(); });
  document.getElementById('autofillSelected')?.addEventListener('click', () => runSelectedFields());
  document.getElementById('addField')?.addEventListener('click', async e => {
    const button=e.currentTarget;
    if(button.disabled)return;
    button.disabled=true;
    suppressRecordingStorageRender=true;
    try {
      // Persist edits without letting the storage-change listener briefly redraw
      // the details screen before the Salesforce recorder opens.
      if (state.editing) await saveInline({ renderAfter: false });
      await startAddField();
    } finally {
      suppressRecordingStorageRender=false;
      if(button.isConnected && state.view!=='recording'){button.disabled=false;render();}
    }
  });
  document.getElementById('edit')?.addEventListener('click', async () => { state.draft = clone(state.recordings[state.selectedId]); state.selectionMode = false; state.selectedStepIndexes = new Set(); state.editing = true; render(); await hydrateDraftPicklists(state.draft); render(); });
  document.getElementById('deleteRecordingEdit')?.addEventListener('click', async () => { if(!state.editing)return; const rec=state.recordings[state.selectedId]; if(!rec)return; const confirmed=await requestTestingConfirm({title:'Delete recording',message:`Delete “${rec.name||'Untitled recording'}” with ${(rec.steps||[]).length} field${(rec.steps||[]).length===1?'':'s'}? This cannot be undone.`,confirmLabel:'Delete recording',cancelLabel:'Cancel',danger:true}); if(!confirmed)return; delete state.recordings[state.selectedId]; state.selectedId=Object.keys(state.recordings)[0]||null; state.editing=false; state.draft=null; await saveRecordings(state.recordings); render(); });
  document.getElementById('cancelEdit')?.addEventListener('click', () => { state.editing = false; state.draft = null; state.selectionMode = false; state.selectedStepIndexes = new Set(); render(); });
  document.getElementById('saveInline')?.addEventListener('click', saveInline);
  document.getElementById('fillEmptyOnly')?.addEventListener('change', async e => { state.fillEmptyOnly = e.target.checked; await saveSettings({...await getSettings(), fillEmptyOnly: state.fillEmptyOnly}); });
  document.getElementById('refreshHeader')?.addEventListener('click', refresh);
  document.getElementById('toggleDarkMode')?.addEventListener('click', toggleSidepanelTheme);
  document.getElementById('settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('firstRunGetStarted')?.addEventListener('click', dismissFirstRunTour);
  document.getElementById('testingFirstRunGetStarted')?.addEventListener('click', dismissTestingFirstRunTour);
  document.getElementById('testingFirstRunOverlay')?.addEventListener('click', e => { if (e.target?.id === 'testingFirstRunOverlay') dismissTestingFirstRunTour(); });
  document.getElementById('firstRunOverlay')?.addEventListener('click', event => { if (event.target?.id === 'firstRunOverlay') dismissFirstRunTour(); });

  document.getElementById('testingDashboardBack')?.addEventListener('click', exitTestingToHome);
  document.getElementById('backToTestingSummary')?.addEventListener('click', () => resumeTestingSession(state.testingSession?.id));
  document.getElementById('testingBack')?.addEventListener('click', exitTestingToDashboard);
  document.getElementById('testingEvidenceName')?.addEventListener('input', event => {
    state.testingEvidenceNameInput = event.currentTarget.value;
    if (state.testingEvidenceNameError) { state.testingEvidenceNameError = ''; event.currentTarget.removeAttribute('aria-invalid'); document.getElementById('testingEvidenceNameError')?.remove(); }
  });
  document.getElementById('confirmTestingEvidenceName')?.addEventListener('click', confirmEvidenceNameDialog);
  document.getElementById('cancelTestingEvidenceName')?.addEventListener('click', closeEvidenceNameDialog);
  document.getElementById('cancelTestingEvidenceNameAction')?.addEventListener('click', closeEvidenceNameDialog);
  document.getElementById('parseTestingPaste')?.addEventListener('click', parseTestingPasteAndPreview);
  document.getElementById('skipTestingCases')?.addEventListener('click', startEvidenceOnlyTestingSession);
  document.getElementById('backToTestingPaste')?.addEventListener('click', () => {
    state.testingPasteError = '';
    state.testingEditingExistingSession = false;
    state.view = 'testing-paste';
    render();
  });
  document.getElementById('backFromTestingEditor')?.addEventListener('click', async () => {
    state.testingEditingExistingSession = false;
    state.view = 'testing-workspace';
    await persistTestingSession();
    render();
  });
  document.querySelectorAll('[data-start-testing]').forEach(btn => btn.addEventListener('click', startTestingWorkspace));
  document.getElementById('editTestingCases')?.addEventListener('click', () => { state.testingOpenMenu = null; state.testingEditingExistingSession = true; state.view = 'testing-preview'; render(); requestAnimationFrame(() => autoResizeTestingTextareas()); });
  document.getElementById('editTestingSessionName')?.addEventListener('click', () => { state.testingSessionNameEditing = true; render(); requestAnimationFrame(() => { const input = document.getElementById('testingSessionNameInline'); input?.focus(); input?.select(); }); });
  document.getElementById('saveTestingSessionNameInline')?.addEventListener('click', saveTestingSessionNameInline);
  document.getElementById('cancelTestingSessionNameInline')?.addEventListener('click', () => { state.testingSessionNameEditing = false; render(); });
  document.getElementById('testingSessionNameInline')?.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); saveTestingSessionNameInline(); } if(e.key === 'Escape'){ e.preventDefault(); state.testingSessionNameEditing = false; render(); } });
  document.getElementById('captureTestingScreenshot')?.addEventListener('click', () => captureTestingEvidence(state.testingActiveCaseId || state.testingSession?.testCases?.[0]?.id || null));
  document.getElementById('captureTestingScreenshotBottom')?.addEventListener('click', () => captureTestingEvidence(state.testingActiveCaseId || state.testingSession?.testCases?.[0]?.id || null));
  document.querySelectorAll('[data-finish-testing]').forEach(btn => btn.addEventListener('click', finishTestingSession));
  document.getElementById('exportTestingWord')?.addEventListener('click', () => {
    if (state.testingExportCompleted && state.testingExportBlob) downloadTestingWordAgain();
    else exportTestingSessionWord();
  });
  document.getElementById('downloadTestingWordAgain')?.addEventListener('click', downloadTestingWordAgain);
  document.getElementById('exportTestingZip')?.addEventListener('click', () => {
    if (state.testingZipCompleted && state.testingZipBlob) downloadTestingZipAgain();
    else exportTestingSessionZip();
  });
  document.getElementById('downloadTestingZipAgain')?.addEventListener('click', downloadTestingZipAgain);
  document.querySelectorAll('[data-testing-done]').forEach(button => button.addEventListener('click', handleTestingDone));
  document.getElementById('testingPaste')?.addEventListener('input', e => {
    state.testingPasteText = e.currentTarget.value;
    const button = document.getElementById('parseTestingPaste');
    if (button) button.disabled = !String(e.currentTarget.value || '').trim();
  });
  document.querySelectorAll('[data-testing-field]').forEach(el => {
    el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', handleTestingEditorInput);
  });
  document.querySelectorAll('[data-toggle-testing-case]').forEach(btn => btn.addEventListener('click', e => toggleTestingCase(e.currentTarget.dataset.toggleTestingCase)));
  document.querySelectorAll('[data-activate-testing-case]').forEach(el => el.addEventListener('click', e => { if (e.target.closest('button')) return; const id = e.currentTarget.dataset.activateTestingCase; if (!id || !state.testingSession?.testCases?.some(tc => tc.id === id)) return; state.testingActiveCaseId = id; state.testingSession.currentEvidenceTestCaseId = id; persistTestingSession().catch(() => {}); render(); }));
  document.querySelectorAll('[data-testing-expand-all]').forEach(btn => btn.addEventListener('click', expandTestingAll));
  document.querySelectorAll('[data-testing-collapse-all]').forEach(btn => btn.addEventListener('click', collapseTestingAll));
  document.querySelectorAll('[data-testing-case-menu]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const id = e.currentTarget.dataset.testingCaseMenu; state.testingOpenMenu = state.testingOpenMenu === `tc:${id}` ? null : `tc:${id}`; render(); }));
  document.querySelectorAll('[data-add-test-case]').forEach(btn => btn.addEventListener('click', addTestingCase));
  document.querySelectorAll('[data-delete-test-case]').forEach(btn => btn.addEventListener('click', e => { if (!e.currentTarget.disabled) deleteTestingCase(e.currentTarget.dataset.deleteTestCase); }));
  document.querySelectorAll('[data-toggle-general-evidence]').forEach(btn => btn.addEventListener('click', () => { state.testingGeneralEvidenceExpanded = !state.testingGeneralEvidenceExpanded; render(); }));
  document.getElementById('testingPasteScreenshot')?.addEventListener('click', pasteTestingScreenshot);
  document.querySelectorAll('[data-paste-case]').forEach(btn => btn.addEventListener('click', e => pasteTestingScreenshot(e.currentTarget.dataset.pasteCase)));
  document.querySelectorAll('[data-capture-case]').forEach(btn => btn.addEventListener('click', e => captureTestingEvidence(e.currentTarget.dataset.captureCase)));
  document.querySelectorAll('[data-copy-evidence]').forEach(btn => btn.addEventListener('click', e => copyTestingEvidence(e.currentTarget.dataset.copyEvidence)));
  document.querySelectorAll('[data-associate-evidence]').forEach(btn => btn.addEventListener('click', e => { state.testingAssociatingEvidenceId = e.currentTarget.dataset.associateEvidence; render(); }));
  document.querySelectorAll('[data-remove-evidence]').forEach(btn => btn.addEventListener('click', e => removeTestingEvidence(e.currentTarget.dataset.removeEvidence)));
  document.querySelectorAll('[data-preview-evidence]').forEach(btn => btn.addEventListener('click', e => previewTestingEvidence(e.currentTarget.dataset.previewEvidence)));
  document.querySelector('.testing-workspace-scroll')?.addEventListener('scroll', positionTestingStatusMenu, { passive: true });
  window.addEventListener('resize', positionTestingStatusMenu, { passive: true });
  document.querySelectorAll('[data-open-testing-status]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const id = e.currentTarget.dataset.openTestingStatus;
    state.testingStatusMenuId = state.testingStatusMenuId === id ? null : id;
    render();
    if (state.testingStatusMenuId) requestAnimationFrame(() => {
      positionTestingStatusMenu();
      const menu = document.querySelector(`[data-testing-status-menu="${CSS.escape(id)}"]`);
      (menu?.querySelector('.testing-status-option.is-selected') || menu?.querySelector('[role="menuitem"]'))?.focus({ preventScroll: true });
    });
  }));
  document.querySelectorAll('[data-testing-status]').forEach(btn => btn.addEventListener('click', e => setTestingCaseStatus(e.currentTarget.dataset.testingStatusTc, e.currentTarget.dataset.testingStatus)));
  document.querySelectorAll('[data-note-evidence]').forEach(btn => btn.addEventListener('click', e => openTestingNote(e.currentTarget.dataset.noteEvidence)));
  document.querySelectorAll('[data-note-cancel]').forEach(btn => btn.addEventListener('click', closeTestingNote));
  document.querySelectorAll('[data-note-save]').forEach(btn => btn.addEventListener('click', e => saveTestingNote(e.currentTarget.dataset.noteSave)));
  document.querySelectorAll('[data-note-input]').forEach(input => { autoResizeTestingNote(input); input.addEventListener('input', () => autoResizeTestingNote(input)); });
  document.getElementById('closeAssociateDialog')?.addEventListener('click', () => { const id=state.testingAssociatingEvidenceId; state.testingAssociatingEvidenceId = null; render(); document.querySelector(`[data-associate-evidence="${id}"]`)?.focus({ preventScroll: true }); });
  document.querySelectorAll('[data-associate-case]').forEach(btn => btn.addEventListener('click', e => associateTestingEvidence(e.currentTarget.dataset.associateEvidence, e.currentTarget.dataset.associateCase)));
  document.getElementById('testingAutofillOpen')?.addEventListener('click', () => {
    state.testingAutofillPickerOpen = true;
    state.testingAutofillQuery = '';
    render();
    requestAnimationFrame(() => document.getElementById('testingAutofillSearch')?.focus());
  });
  document.getElementById('closeTestingAutofill')?.addEventListener('click', () => {
    state.testingAutofillPickerOpen = false;
    state.testingAutofillQuery = '';
    render();
    document.getElementById('testingAutofillOpen')?.focus();
  });
  document.getElementById('testingAutofillSearch')?.addEventListener('input', e => {
    state.testingAutofillQuery = e.currentTarget.value;
    render();
    const input = document.getElementById('testingAutofillSearch');
    if (input) {
      input.focus();
      input.setSelectionRange(state.testingAutofillQuery.length, state.testingAutofillQuery.length);
    }
  });
  document.querySelectorAll('[data-testing-autofill-run]').forEach(btn => {
    btn.addEventListener('click', e => runTestingRecording(e.currentTarget.dataset.testingAutofillRun));
  });
  document.getElementById('backHome')?.addEventListener('click', async () => {
    state.run = null; state.resultTab = 'all'; state.editing = false; state.draft = null; state.addingToRecordingId = null; state.selectionMode = false; state.selectedStepIndexes = new Set(); state.view = 'home';
    try { await chrome.storage.session.remove(LAST_RUN_KEY); } catch {}
    render();
  });
  document.getElementById('backToTesting')?.addEventListener('click', () => {
    clearInterval(window.fpProgressTimer);
    state.run = null;
    state.isRetrying = false;
    state.testingAutofillBusy = false;
    state.testingAutofillActive = false;
    state.testingAutofillPickerOpen = false;
    state.view = 'testing-workspace';
    render();
  });
  document.getElementById('backToTestingFromAutofill')?.addEventListener('click', () => {
    state.run = null;
    state.resultTab = 'all';
    state.isRetrying = false;
    state.testingAutofillBusy = false;
    state.testingAutofillActive = false;
    state.testingAutofillPickerOpen = false;
    state.view = 'testing-workspace';
    render();
  });
  document.getElementById('backToDetail')?.addEventListener('click', async () => {
    state.run = state.view === 'result' ? state.run : null; state.resultTab = state.view === 'result' ? state.resultTab : 'all'; state.editing = false; state.draft = null; state.addingToRecordingId = null; state.selectionMode = false; state.selectedStepIndexes = new Set();
    if (state.selectedId && state.recordings[state.selectedId]) state.view = 'detail'; else state.view = 'home';
    if (state.view !== 'result') { try { await chrome.storage.session.remove(LAST_RUN_KEY); } catch {} }
    render();
  });
  document.getElementById('retryFailed')?.addEventListener('click', retryFailed);
  document.getElementById('search')?.addEventListener('input', e => { state.filter=e.target.value; const pos=Number.isFinite(e.target.selectionStart)?e.target.selectionStart:state.filter.length; clearTimeout(window.fpSearchTimer); window.fpSearchTimer=setTimeout(()=>{render();const el=document.getElementById('search');if(el){el.focus();el.setSelectionRange(pos,pos)}},80); });
  document.getElementById('testingSessionSearch')?.addEventListener('input', e => { state.testingSessionSearch=e.target.value; state.testingShowAllSessions=false; const pos=Number.isFinite(e.target.selectionStart)?e.target.selectionStart:state.testingSessionSearch.length; clearTimeout(window.fpTestingSessionSearchTimer); window.fpTestingSessionSearchTimer=setTimeout(()=>{render();const el=document.getElementById('testingSessionSearch');if(el){el.focus();el.setSelectionRange(pos,pos)}},80); });
  document.querySelectorAll('.recording-row[data-id]').forEach(b => b.addEventListener('click', async () => {
    const id=b.dataset.id;state.selectedId=id;state.run=null;state.view='detail';state.editing=false;state.selectionMode=false;state.selectedStepIndexes=new Set();render();
    const recording=state.recordings[id];if(!recording)return;
    const before=JSON.stringify(recording.steps||[]);
    await hydrateDraftPicklists(recording);
    if(before!==JSON.stringify(recording.steps||[])){
      recording.updatedAt=new Date().toISOString();state.recordings[id]=recording;
      await saveRecordings(state.recordings).catch(()=>{});
      if(state.view==='detail'&&state.selectedId===id&&!state.editing)render();
    }
  }));
  document.querySelectorAll('[data-result-tab]').forEach(b => b.addEventListener('click', () => { state.resultTab = b.dataset.resultTab; render(); document.querySelector(`[data-result-tab="${state.resultTab}"]`)?.focus(); }));
  document.querySelectorAll('[data-select-checkbox]').forEach(box => {
    box.addEventListener('click', e => e.stopPropagation());
    box.addEventListener('change', e => toggleSelectedStep(Number(e.currentTarget.dataset.selectCheckbox)));
  });
  document.querySelectorAll('[data-focus-step]').forEach(b => b.addEventListener('click', e => { if(e.target.closest('[data-lookup-create-details]'))return; focusStep(Number(e.currentTarget.dataset.focusStep)); }));
  document.querySelectorAll('[data-focus-index]').forEach(b => { b.addEventListener('click', e => { if (e.target.closest('[data-overwrite-index],[data-lookup-create-details]')) return; focusIndex(Number(e.currentTarget.dataset.focusIndex)); }); b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-overwrite-index],[data-lookup-create-details]')) { e.preventDefault(); focusIndex(Number(e.currentTarget.dataset.focusIndex)); } }); });
  document.querySelectorAll('[data-overwrite-index]').forEach(b => { b.addEventListener('click', e => { e.stopPropagation(); overwriteSkipped(Number(e.currentTarget.dataset.overwriteIndex)); }); b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); overwriteSkipped(Number(e.currentTarget.dataset.overwriteIndex)); } }); });
  document.querySelectorAll('[data-delete-step]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); state.draft.steps.splice(Number(e.currentTarget.dataset.deleteStep), 1); state.draft.steps.forEach((s, i) => s.sequence = i + 1); render(); }));
  document.querySelectorAll('[data-delete-workflow-child]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const [parentIndex, childIndex] = String(e.currentTarget.dataset.deleteWorkflowChild || '').split(':').map(Number); const workflow = lookupCreateWorkflow(state.draft?.steps?.[parentIndex]); if (!workflow || !Number.isInteger(childIndex) || childIndex < 0 || childIndex >= workflow.fields.length) return; workflow.fields.splice(childIndex, 1); workflow.fields.forEach((step, i) => step.sequence = i + 1); render(); }));
}

function saveEditedStepValue(step,key){
  const t=fieldTypeLabel(step);
  const bool=document.querySelector(`[data-edit-bool="${key}"]`);
  if(bool){step.value=bool.checked;return;}
  if(t==='Multipicklist'&&typeOptions(step).length){step.value=[...document.querySelectorAll(`[data-multi-index="${key}"]:checked`)].map(x=>x.dataset.multiValue).filter(Boolean);return;}
  if(t==='Address'){const old=step.value&&typeof step.value==='object'?step.value:{};const next={...old};document.querySelectorAll(`[data-address-edit-part="${key}"]`).forEach(input=>{const part=input.dataset.addressPart;const aliases=part==='province'?['province','state','State']:part==='postalCode'?['postalCode','PostalCode','postalcode']:part==='street'?['street','Street']:part==='city'?['city','City']:part==='country'?['country','Country']:[part];const existing=aliases.find(alias=>Object.prototype.hasOwnProperty.call(old,alias));next[existing||part]=String(input.value||'').trim();});step.value=next;return;}
  const el=document.querySelector(`[data-edit-value="${key}"]`);
  if(!el)return;
  if(t==='Date'){
    const recordingDate=step.meta?.dateRecordedOn||state.draft?.recordingDate||localDateISO();
    if(step.meta?.dateMode==='relative'&&Number.isFinite(Number(step.meta?.dateOffsetDays))){
      const sign=document.querySelector(`[data-date-sign="${key}"]`)?.value==='-'?-1:1;const days=Math.max(0,Number(document.querySelector(`[data-date-offset="${key}"]`)?.value||0));const relativeOffset=sign*days;
      step.value=shiftDateFrom(recordingDate,relativeOffset);step.meta={...(step.meta||{}),dateRecordedOn:recordingDate,dateOffsetDays:relativeOffset,dateExpression:dateOffsetLabel(relativeOffset),dateMode:'relative'};
    }else{const input=String(el.value||'').trim();step.value=input.replace(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/,'$3-$1-$2');if(step.meta){delete step.meta.dateExpression;delete step.meta.dateOffsetDays;delete step.meta.dateMode;}}
  }else if(t==='Picklist'&&String(el.tagName||'').toLowerCase()==='select'){
    const selected=el.selectedOptions?.[0]||el.options?.[el.selectedIndex];const label=String(selected?.textContent||selected?.label||'').trim();step.value=label;step.meta={...(step.meta||{}),selectedDisplayValue:label};
  }else if(t==='Lookup'){
    const displayValue=String(el.value||'').trim();const old=step.value&&typeof step.value==='object'?step.value:{};const oldLabel=String(old.displayValue||'').trim();
    step.value={displayValue,recordId:displayValue===oldLabel?String(old.recordId||''):''};step.meta={...(step.meta||{}),lookupDisplayValue:displayValue,lookupRecordId:step.value.recordId};
  }else step.value=cleanEditedValue(step,el.value);
}
async function saveInline({ renderAfter = true } = {}) {
  if(!state.draft)return;
  for (let index=0; index<state.draft.steps.length; index++) {
    const step=state.draft.steps[index];
    saveEditedStepValue(step,index);
    const randomConfig=readRandomizationFromDOM(step,String(index),{context:'edit'});
    if(randomConfig.enabled&&randomConfig.strategy==='lookupCreate'){
      setRandomizationError([...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===String(index)&&el.dataset.randContext==='edit'),'This lookup already uses its captured Create New workflow. Randomize the new-record fields below, or choose “Random existing record”.');
      showInline(`${step.target?.label||'Lookup'}: randomize the new-record fields below or choose Random existing record.`);return;
    }
    const validation=randomConfig.enabled?(randomizerCore()?.validate?.(step,randomConfig)||{ok:true}):{ok:true};
    if(!validation.ok){setRandomizationError([...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===String(index)&&el.dataset.randContext==='edit'),validation.error);showInline(`${step.target?.label||'Field'}: ${validation.error}`);return;}
    step.randomization=randomConfig;
    const workflow=lookupCreateWorkflow(step);
    if(workflow){
      const typeEditor=document.querySelector(`[data-edit-record-type="${index}"]`);
      if(typeEditor)workflow.recordTypeLabel=String(typeEditor.value||'').trim();
      if(!workflow.recordTypeLabel)workflow.recordTypeLabel='';
      for(let childIndex=0;childIndex<(workflow.fields||[]).length;childIndex++){
        const child=workflow.fields[childIndex], childKey=`wf-${index}-${childIndex}`;
        saveEditedStepValue(child,childKey);
        const childConfig=readRandomizationFromDOM(child,childKey,{context:'edit'});
        if(childConfig.enabled&&childConfig.strategy==='lookupCreate'){
          setRandomizationError([...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===childKey&&el.dataset.randContext==='edit'),'This lookup already uses its captured Create New workflow. Randomize the new-record fields below, or choose “Random existing record”.');
          showInline(`${child.target?.label||'Lookup'}: randomize the new-record fields below or choose Random existing record.`);return;
        }
        const childValidation=childConfig.enabled?(randomizerCore()?.validate?.(child,childConfig)||{ok:true}):{ok:true};
        if(!childValidation.ok){setRandomizationError([...document.querySelectorAll('[data-randomization-editor]')].find(el=>el.dataset.randKey===childKey&&el.dataset.randContext==='edit'),childValidation.error);showInline(`${child.target?.label||'Field'}: ${childValidation.error}`);return;}
        child.randomization=childConfig;child.sequence=childIndex+1;
      }
    }
    step.sequence=index+1;
  }
  state.draft.name=document.getElementById('recordingName')?.value.trim()||state.draft.name||recordingTitle(state.draft);
  state.draft.updatedAt=new Date().toISOString();state.recordings[state.draft.id]=clone(state.draft);await saveRecordings(state.recordings);state.editing=false;state.draft=null;if(renderAfter)render();
}

async function toggleSidepanelTheme() {
  const settings = await getSettings();
  state.darkMode = !(settings.darkMode === true);
  applyTheme(state.darkMode);
  await saveSettings({ ...settings, darkMode: state.darkMode });
}

async function refresh() {
  if (state.refreshing) return;
  const restoreFocusId = document.activeElement?.id || '';
  state.refreshing = true;
  render();
  try {
    const tab = await activeTab();
    const fastConnectionProbe = tab?.id ? chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_CONTEXT' }).catch(() => null) : Promise.resolve(null);
    fastConnectionProbe.then(d => {
      if (!d || !state.refreshing || !tab?.id) return;
      state.tabId = tab.id;
      state.salesforcePageDetected = true;
      state.forcePilotConnected = true;
      state.context = d || state.context;
      state.salesforceStatusMessage = '';
      render();
    }).catch(() => {});
    const win = await chrome.windows.getCurrent().catch(() => ({ id: null, incognito: false }));
    const windowId = win?.id ?? tab?.windowId ?? null;
    const incognito = !!(win?.incognito ?? tab?.incognito);
    let testingUiState = null;
    try {
      const storedUi = await chrome.storage.local.get(TESTING_UI_STATE_KEY);
      testingUiState = storedUi?.[TESTING_UI_STATE_KEY] || null;
    } catch {}
    const currentTestingSessionId = state.testingSession?.id || testingUiState?.sessionId || null;
    const [recs, settings, active, lock, testingSessions, restoredTestingSession] = await Promise.all([
      getRecordings(),
      getSettings(),
      chrome.runtime.sendMessage({ type:'GET_ACTIVE_CONTEXT' }).catch(() => ({})),
      chrome.runtime.sendMessage({ type:'GET_RECORDING_LOCK', windowId, incognito }).catch(() => ({})),
      loadTestingSessionSummaries().catch(() => []),
      currentTestingSessionId ? loadTestingSessionById(currentTestingSessionId).catch(() => null) : Promise.resolve(null)
    ]);
    state.recordings = recs || {};
    state.tabId = active?.tabId || tab?.id || null;
    state.windowId = windowId;
    state.incognito = incognito;
    state.context = active?.context || null;
    state.salesforcePageDetected = !!active?.salesforce;
    state.forcePilotConnected = !!active?.connected;
    state.salesforceStatusMessage = String(active?.message || '');
    // Keep saved recording names/contexts aligned with Salesforce's real object labels.
    // This repairs older recordings that stored values such as Custom_Object__c or "c".
    const activeApi = String(state.context?.objectApiName || '').trim();
    const activeObjectLabel = String(state.context?.objectLabel || '').trim();
    const activeObjectLabelPlural = String(state.context?.objectLabelPlural || '').trim();
    if (activeApi && activeObjectLabel && !/^salesforce$/i.test(activeObjectLabel)) {
      let recordingsChanged = false;
      for (const recording of Object.values(state.recordings)) {
        if (String(recording?.context?.objectApiName || '').trim().toLowerCase() !== activeApi.toLowerCase()) continue;
        const nextContext = { ...(recording.context || {}), objectLabel: activeObjectLabel, objectLabelPlural: activeObjectLabelPlural || recording.context?.objectLabelPlural || activeObjectLabel };
        const oldName = String(recording.name || '').trim();
        const humanizedApi = humanizeObjectApiName(activeApi);
        const shouldRename = !oldName || oldName.toLowerCase() === activeApi.toLowerCase() || /^c$/i.test(oldName) || oldName.toLowerCase() === humanizedApi.toLowerCase();
        const next = { ...recording, context: nextContext, ...(shouldRename ? { name: activeObjectLabel } : {}) };
        if (JSON.stringify(next) !== JSON.stringify(recording)) { Object.assign(recording, next); recordingsChanged = true; }
      }
      if (recordingsChanged) await saveRecordings(state.recordings).catch(() => {});
    }
    state.recordingTabId = lock?.recordingTabId ?? null;
    state.recording = !!(state.recordingTabId && state.recordingTabId === state.tabId);
    state.recordingPaused = false;
    state.testingSessions = Array.isArray(testingSessions) ? testingSessions : [];
    state.testingSession = restoredTestingSession || null;
    if (state.testingSession) {
      state.testingActiveCaseId = state.testingSession.currentEvidenceTestCaseId || state.testingSession.testCases?.[0]?.id || null;
      const summary = summarizeTestingSession(state.testingSession);
      state.testingSessions = state.testingSessions.filter(item => item.id !== state.testingSession.id);
      if (summary) state.testingSessions.unshift(summary);
      await loadTestingEvidenceUrls();
    }
    state.testingUiHydrated = true;
    state.fillEmptyOnly = settings.fillEmptyOnly !== false;
    state.darkMode = settings.darkMode === true;
    applyTheme(state.darkMode);
    if (tab?.id) {
      const d = await chrome.tabs.sendMessage(tab.id, { type:'GET_RECORDING_STATE' }).catch(() => null);
      if (d?.recording) {
        state.recording = true;
        state.recordingTabId = tab.id;
        state.activeSteps = d.steps || [];
        state.recordingPaused = !!d.paused;
      }
      if (d?.pendingRecording && !d?.recording) {
        const pendingId = String(d.pendingRecording.id || '');
        const alreadySaved = !!pendingId && !!state.recordings[pendingId];
        if (alreadySaved) {
          await clearPendingRecordingInTab(tab.id);
          if (state.pendingRecording?.id === pendingId) {
            state.pendingRecording = null;
            state.pendingRecordingTabId = null;
          }
        } else {
          state.pendingRecording = clone(d.pendingRecording);
          state.pendingRecordingTabId = tab.id;
        }
      }
    }
    if (state.pendingRecording) {
      state.view = 'save-name';
    } else if (state.recording) {
      state.view = 'recording';
    } else if (state.testingSession && String(testingUiState?.view || '').startsWith('testing-')) {
      state.view = ['testing-workspace','testing-summary','testing-preview'].includes(testingUiState.view) ? testingUiState.view : 'testing-workspace';
    } else if (testingUiState?.view === 'testing-dashboard') {
      state.view = 'testing-dashboard';
    } else {
      state.selectedId = null;
      state.run = null;
      state.resultTab = 'all';
      state.editing = false;
      state.draft = null;
      state.filter = '';
      state.view = 'home';
    }
    // Side-panel instances are recreated when the panel is closed/reopened.
    // Restore evidence expanded on every entry to an evidence-only session.
    if (state.view === 'testing-workspace' && state.testingSession && isEvidenceOnlyTesting(state.testingSession)) {
      state.testingGeneralEvidenceExpanded = true;
    }
  } finally {
    state.refreshing = false;
    render();
    if (restoreFocusId) document.getElementById(restoreFocusId)?.focus();
  }
}

async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null; }
async function ensureTabConnection(tab) {
  if (!tab?.id) return { ok: false, message: 'Open a Salesforce page first.' };
  const context = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }).catch(() => null);
  if (context) return { ok: true, context, existing: true };
  const existing = await chrome.tabs.sendMessage(tab.id, { type: 'GET_RECORDING_STATE' }).catch(() => null);
  if (existing) return { ok: true, context: existing.context || null, existing: true };
  return chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPTS', tabId: tab.id }).catch(e => ({ ok: false, message: e?.message || 'Could not connect to Salesforce.' }));
}
const MULTIFRAME_REQUEST_TYPES=new Set(['GET_RECORDING_STATE','START_RECORDING','STOP_RECORDING','PAUSE_RECORDING','RESUME_RECORDING','CLEAR_PENDING_RECORDING','REMOVE_RECORDING_STEP','UPDATE_RECORDING_STEP_RANDOMIZATION','REPLAY_RECORDING','OVERWRITE_STEP','FOCUS_FIELD','GET_FIELD_DESCRIPTORS']);
async function sendTab(tab,msg){
  if(!tab?.id)return{ok:false,message:'Open a Salesforce page first.'};
  if(MULTIFRAME_REQUEST_TYPES.has(msg?.type)){
    return chrome.runtime.sendMessage({type:'FORCEPILOT_MULTIFRAME_REQUEST',tabId:tab.id,message:msg}).catch(e=>({ok:false,message:e?.message||'Could not communicate with Salesforce frames.'}));
  }
  let r=await chrome.tabs.sendMessage(tab.id,msg).catch(()=>null);if(r)return r;
  const ready=await ensureTabConnection(tab);if(!ready?.ok)return{ok:false,message:ready?.message||'Could not connect to Salesforce.'};
  return chrome.tabs.sendMessage(tab.id,msg).catch(e=>({ok:false,message:e?.message||'Could not connect to Salesforce.'}));
}

async function receivePendingRecording(recording, { auto = false, pendingSave = true, sourceTabId = null } = {}) {
  if (!recording?.id) return;
  clearInterval(window.fpTimer);
  state.recording = false;
  state.recordingTabId = null;
  state.pendingRecordingTabId = Number(sourceTabId || 0) || null;
  state.addingToRecordingId = null;
  state.run = null;
  if (!pendingSave) {
    state.pendingRecording = null;
    state.recordings[recording.id] = clone(recording);
    state.selectedId = recording.id;
    state.view = 'detail';
    render();
    return;
  }
  state.pendingRecording = clone(recording);
  state.selectedId = recording.id;
  state.view = 'save-name';
  render();
  state.saveNameError = '';
  const input = document.getElementById('pendingRecordingName');
  if (input) {
    input.focus();
    input.select();
  }
}

async function clearPendingRecordingInTab(tabId) {
  const id = Number(tabId || 0);
  if (!id) return;
  try { await chrome.runtime.sendMessage({type:'FORCEPILOT_MULTIFRAME_REQUEST',tabId:id,message:{type:'CLEAR_PENDING_RECORDING'}}); } catch {}
}

async function savePendingRecording() {
  const r = state.pendingRecording;
  if (!r) return;
  const recordedSteps = Array.isArray(r.steps) ? r.steps.filter(Boolean) : [];
  if (recordedSteps.length === 0) {
    await cancelPendingRecording();
    showInline('No Salesforce fields were recorded, so the recording was not saved.');
    return;
  }
  const input = document.getElementById('pendingRecordingName');
  const name = String(input?.value || '').trim().slice(0, 200);
  if (!name) {
    state.saveNameError = 'Enter a recording name.';
    render();
    document.getElementById('pendingRecordingName')?.focus();
    return;
  }
  const duplicate = Object.values(state.recordings).some(existing =>
    existing?.id !== r.id && String(existing?.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    state.saveNameError = 'A recording with this name already exists. Use a different name to avoid confusion.';
    render();
    document.getElementById('pendingRecordingName')?.focus();
    return;
  }
  state.saveNameError = '';
  const releaseTabId = state.recordingTabId || state.pendingRecordingTabId || null;
  const recording = {...clone(r), name, updatedAt: new Date().toISOString()};
  state.recordings[recording.id] = recording;
  await saveRecordings(state.recordings);
  state.pendingRecording = null;
  state.pendingRecordingTabId = null;
  state.selectedId = recording.id;
  state.view = 'detail';
  await clearPendingRecordingInTab(releaseTabId);
  try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: releaseTabId, windowId: state.windowId, incognito: state.incognito }); } catch {}
  showToast('Recording saved', { type: 'success', duration: 2200 });
  render();
}

async function cancelPendingRecording() {
  if (!state.pendingRecording) return;
  const releaseTabId = state.recordingTabId || state.pendingRecordingTabId || null;
  const pendingTabId = state.pendingRecordingTabId || null;
  state.pendingRecording = null;
  state.pendingRecordingTabId = null;
  state.view = 'home';
  state.selectedId = null;
  await clearPendingRecordingInTab(pendingTabId);
  try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: releaseTabId, windowId: state.windowId, incognito: state.incognito }); } catch {}
  render();
}

async function startAddField() {
  const recording = state.recordings[state.selectedId];
  if (!recording) return;
  const tab = await activeTab();
  if (!tab?.id) return showInline('Open the Salesforce record where you want to add a field.');
  const ready = await ensureTabConnection(tab);
  if (!ready?.ok) return showInline(ready.message || 'Could not connect to Salesforce.');
  // Re-resolve the Salesforce object before validating the recording target.
  // The Side Panel can retain the previous object's context while Salesforce
  // itself has already navigated to a different record in its SPA shell.
  const fresh = await sendTab(tab, { type: 'REFRESH_CONTEXT' });
  if (!fresh?.objectApiName) return showInline('Could not read the Salesforce page context. Refresh the page and try again.');
  state.context = fresh;
  // Setup, Visualforce utilities, and Experience Cloud landing pages may have a
  // generic Salesforce context rather than a concrete sObject. Only reject an
  // append when both sides identify different concrete objects.
  const existingObject = String(recording.context?.objectApiName || '').trim();
  const currentObject = String(fresh.objectApiName || '').trim();
  const isGenericObject = value => !value || value.toLowerCase() === 'salesforce';
  if (!isGenericObject(existingObject) && !isGenericObject(currentObject) && existingObject.toLowerCase() !== currentObject.toLowerCase()) {
    return showInline(`This recording is for ${existingObject}. Open a matching Salesforce record first.`);
  }
  const r = await sendTab(tab, { type: 'START_RECORDING', appendRecording: recording });
  if (!r?.ok) return showInline(r?.message || 'Could not start field recording.');
  liveRecordingRevision++;
  state.recording = true;
  state.recordingTabId = tab.id;
  state.addingToRecordingId = recording.id;
  state.context = r.context || state.context;
  state.activeSteps = [...(recording.steps||[]).map((step,index)=>({...clone(step),__fpExistingAppendStep:true,__fpExistingIndex:index})),...(r.steps||[])];
  state.run = null;
  state.view = 'recording';
  render();
  clearInterval(window.fpTimer);
  window.fpTimer = setGuardedInterval(async () => {
    if(liveRecordingMutationInFlight||stopRecordingPromise)return;
    const revision=liveRecordingRevision;
    const d = await sendTab(tab, { type:'GET_RECORDING_STATE' });
    if (liveRecordingMutationInFlight||stopRecordingPromise||revision!==liveRecordingRevision || !d?.recording) return;
    if(state.addingToRecordingId){
      const baseSteps=(state.recordings[state.addingToRecordingId]?.steps||[]).map((step,index)=>({...clone(step),__fpExistingAppendStep:true,__fpExistingIndex:index}));
      state.activeSteps=[...baseSteps,...(d.steps||[])];
    }else state.activeSteps = d.steps || state.activeSteps;
    const list = document.getElementById('recording-field-list');
    if (list) {
      updateLiveRecordingList(list, state.activeSteps);
      const note = document.getElementById('recording-note');
      if (note) note.classList.toggle('is-hidden', state.activeSteps.length > 0);
    }
   }, 300);
}

async function removeLiveRecordingStep(index) {
  if(liveRecordingMutationInFlight)return;
  liveRecordingMutationInFlight=true;
  try{return await removeLiveRecordingStepImpl(index)}finally{liveRecordingMutationInFlight=false}
}

async function removeLiveRecordingStepImpl(index) {
  const tabId = state.recordingTabId;
  if (!tabId) return;
  const selectedStep=state.activeSteps?.[index];
  if(!selectedStep)return;
  const previousActiveSteps=clone(state.activeSteps||[]);
  liveRecordingRevision++;
  // Remove immediately from the panel. Salesforce frame coordination can take
  // longer than the local interaction, so do not make the user wait for a full
  // cross-frame state refresh before the row disappears.
  state.activeSteps.splice(index,1);
  state.activeSteps=state.activeSteps.map((step,i)=>({...step,sequence:i+1}));
  const immediateList=document.getElementById('recording-field-list');
  if(immediateList){updateLiveRecordingList(immediateList,state.activeSteps);const note=document.getElementById('recording-note');if(note)note.classList.toggle('is-hidden',state.activeSteps.length>0);}
  if(selectedStep?.__fpExistingAppendStep&&state.addingToRecordingId){
    const existing=state.recordings[state.addingToRecordingId];
    const removeAt=Number(selectedStep.__fpExistingIndex);
    if(!existing||!Number.isInteger(removeAt)||removeAt<0||removeAt>=existing.steps.length){
      state.activeSteps=previousActiveSteps;render();return;
    }
    const previousRecording=clone(existing);
    existing.steps.splice(removeAt,1);existing.steps=existing.steps.map((step,i)=>({...step,sequence:i+1}));existing.updatedAt=new Date().toISOString();
    try{await saveRecordings(state.recordings)}catch(error){state.recordings[state.addingToRecordingId]=previousRecording;state.activeSteps=previousActiveSteps;render();showInline(error?.message||'Could not remove the recorded field.');return}
    liveRecordingRevision++;
    const newSteps=previousActiveSteps.filter((step,i)=>i!==index&&!step.__fpExistingAppendStep).map((step,i)=>({...step,sequence:existing.steps.length+i+1}));
    state.activeSteps=[...existing.steps.map((step,i)=>({...clone(step),__fpExistingAppendStep:true,__fpExistingIndex:i})),...newSteps];render();return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) { liveRecordingRevision++; state.activeSteps=previousActiveSteps; render(); return; }
  const r = await sendTab(tab, { type: 'REMOVE_RECORDING_STEP', index, localIndex:selectedStep?.__fpFrameStepIndex??index, storageFrameId:selectedStep?.__fpStorageFrameId??0, frameId:selectedStep?.frame?.frameId, frame:selectedStep?.frame, stepId:selectedStep?.id||selectedStep?.meta?.recordedAt });
  liveRecordingRevision++;
  if (!r?.ok) { state.activeSteps=previousActiveSteps; render(); return showInline(r?.message || 'Could not remove the field from the recording.'); }
  // The background now acknowledges the targeted-frame delete directly instead
  // of waiting for a full cross-frame refresh. Reconcile from our pre-delete
  // snapshot so the rest of the visible fields and their identities are retained.
  const remainingSteps=previousActiveSteps.filter((step,i)=>i!==index);
  if(state.addingToRecordingId){
    const base=(state.recordings[state.addingToRecordingId]?.steps||[]).map((step,i)=>({...clone(step),__fpExistingAppendStep:true,__fpExistingIndex:i,sequence:i+1}));
    const newSteps=remainingSteps.filter(step=>!step.__fpExistingAppendStep).map((step,i)=>({...step,sequence:base.length+i+1}));
    state.activeSteps=[...base,...newSteps];
  }else state.activeSteps=remainingSteps.map((step,i)=>({...step,sequence:i+1}));
  render();
}


function scheduleTestingUiStateSave() {
  if (!state.testingUiHydrated) return;
  clearTimeout(testingUiSaveTimer);
  testingUiSaveTimer = setTimeout(() => {
    const isTestingView = String(state.view || '').startsWith('testing-');
    const payload = isTestingView ? { view: state.view, sessionId: state.testingSession?.id || null } : { view: 'home', sessionId: null };
    chrome.storage.local.set({ [TESTING_UI_STATE_KEY]: payload }).catch(() => {});
  }, 120);
}

async function openTestingDashboard() {
  state.testingPasteError = '';
  state.testingShowAllSessions = false;
  state.testingStatusMenuId = null;
  state.testingNoteOpenId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.view = 'testing-dashboard';
  await maybeShowTestingFirstRunTour();
  render();
}

async function startNewTestingSession() {
  if (state.recording) {
    return showInline('Stop the active recording before starting Testing Mode.');
  }
  state.testingPasteText = '';
  state.testingPasteError = '';
  state.testingMessage = '';
  state.testingAssociatingEvidenceId = null;
  state.testingStatusMenuId = null;
  state.testingNoteOpenId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingCollapsedCases = new Set();
  state.testingExpandedEvidence = new Set();
  state.testingGeneralEvidenceExpanded = false;
  state.testingOpenMenu = null;
  state.testingSessionNameEditing = false;
  state.testingEditingExistingSession = false;
  state.view = 'testing-paste';
  render();
}

async function startEvidenceOnlyTestingSession() {
  if (state.recording) {
    return showInline('Stop the active recording before starting Testing Mode.');
  }
  openEvidenceNameDialog('start');
}

async function createAndStartEvidenceOnlySession(name) {
  state.testingPasteText = '';
  state.testingPasteError = '';
  state.testingMessage = '';
  state.testingAssociatingEvidenceId = null;
  state.testingStatusMenuId = null;
  state.testingNoteOpenId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingCollapsedCases = new Set();
  state.testingExpandedEvidence = new Set();
  state.testingGeneralEvidenceExpanded = true;
  state.testingOpenMenu = null;
  state.testingSessionNameEditing = false;
  state.testingEditingExistingSession = false;
  state.testingSession = createEvidenceOnlyTestingSession();
  state.testingSession.sessionName = String(name || '').trim();
  state.testingSession.exportFilename = String(name || '').trim();
  resetTestingExportState();
  await persistTestingSession();
  state.view = 'testing-workspace';
  render();
}

async function openTestingSession(sessionId) {
  const previousSessionId = state.testingSession?.id || null;
  const saved = await loadTestingSessionById(sessionId).catch(() => null);
  if (!saved) {
    await refresh();
    return;
  }
  if (saved.status === 'finished') saved.status = 'active';
  if (previousSessionId && previousSessionId !== saved.id) {
    const previous = state.testingSessions.find(session => session.id === previousSessionId);
    for (const evidence of previous?.evidence || []) revokeTestingObjectUrl(evidence.id);
  }
  state.testingSession = saved;
  state.testingActiveCaseId = saved.currentEvidenceTestCaseId || saved.testCases?.[0]?.id || null;
  if (!isEvidenceOnlyTesting(saved)) saved.currentEvidenceTestCaseId = state.testingActiveCaseId;
  const existingIndex = (state.testingSessions || []).findIndex(session => session.id === saved.id);
  const summary = summarizeTestingSession(saved);
  if (existingIndex >= 0) state.testingSessions[existingIndex] = summary;
  else state.testingSessions = [summary, ...(state.testingSessions || [])];
  await persistTestingSession();
  await loadTestingEvidenceUrls();
  state.testingPasteError = '';
  state.testingAssociatingEvidenceId = null;
  state.testingStatusMenuId = null;
  state.testingNoteOpenId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingCollapsedCases = new Set();
  state.testingExpandedEvidence = new Set();
  state.testingGeneralEvidenceExpanded = isEvidenceOnlyTesting(saved);
  state.testingSessionNameEditing = false;
  state.testingEditingExistingSession = false;
  state.testingOpenMenu = null;
  state.view = 'testing-workspace';
  if (!testingSessionName(saved)) {
    render();
    openEvidenceNameDialog('name-existing-session', '');
    return;
  }
  render();
}

async function resumeTestingSession(sessionId) {
  const id = sessionId || state.testingSession?.id;
  if (!id) return startNewTestingSession();
  await openTestingSession(id);
}

function exitTestingToDashboard() {
  state.testingPasteError = '';
  state.testingAssociatingEvidenceId = null;
  state.testingStatusMenuId = null;
  state.testingNoteOpenId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.view = 'testing-dashboard';
  render();
}

function exitTestingToHome() {
  state.testingPasteError = '';
  state.testingAssociatingEvidenceId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.view = 'home';
  render();
}

function toggleTestingCase(caseId) {
  if (!caseId || !state.testingSession?.testCases?.some(tc => tc.id === caseId)) return;
  if (state.testingCollapsedCases.has(caseId)) state.testingCollapsedCases.delete(caseId);
  else state.testingCollapsedCases.add(caseId);
  state.testingActiveCaseId = caseId;
  state.testingSession.currentEvidenceTestCaseId = caseId;
  state.testingOpenMenu = null;
  persistTestingSession().catch(() => {});
  render();
}

function expandTestingAll() {
  state.testingCollapsedCases = new Set();
  render();
}

function collapseTestingAll() {
  state.testingCollapsedCases = new Set((state.testingSession?.testCases || []).map(tc => tc.id));
  render();
}

function handleTestingEditorInput(event) {
  const el = event.currentTarget;
  const field = el?.dataset?.testingField;
  const session = state.testingSession;
  if (!field || !session) return;
  if (field === 'sessionName') {
    const nextName = String(el.value || '').trim();
    session.sessionName = nextName;
    session.exportFilename = nextName;
  } else if (field === 'workProduct') {
    session.workProduct = String(el.value || '').trim();
  } else if (field === 'title') {
    const tc = session.testCases?.find(item => item.id === el.dataset.tcId);
    if (!tc) return;
    // Preserve the user's full title; trimming is only used for validation.
    tc.title = String(el.value ?? '');
  } else {
    return;
  }
  persistTestingSession().catch(() => {});
}

async function saveTestingSessionNameInline() {
  const session = state.testingSession;
  const input = document.getElementById('testingSessionNameInline');
  const name = String(input?.value || '').trim().replace(/\.(?:docx|zip)$/i, '');
  if (!session || !name) {
    showToast('Enter a session name.', { type: 'warning', duration: 2300 });
    input?.focus();
    return;
  }
  session.sessionName = name;
  session.exportFilename = name;
  state.testingSessionNameEditing = false;
  await persistTestingSession();
  render();
  showToast('Session name updated', { type: 'success', duration: 1500 });
}

function validateTestingSessionForStart() {
  const session = state.testingSession;
  if (isEvidenceOnlyTesting(session)) return '';
  if (!session?.testCases?.length) return 'Add at least one scenario.';
  if (session.testCases.some(tc => !String(tc.title ?? '').trim())) return 'Every scenario needs a title.';
  return '';
}

async function parseTestingPasteAndPreview() {
  const value = String(document.getElementById('testingPaste')?.value ?? state.testingPasteText ?? '');
  state.testingPasteText = value;
  state.testingPasteError = '';
  if (!value.trim()) {
    state.testingPasteError = 'Paste your scenarios first.';
    render();
    return;
  }
  try {
    const parsed = parseTestCasePaste(value);
    const session = createTestingSession(parsed);
    session.sessionName = String(parsed.workProduct || '').trim();
    session.exportFilename = '';
    state.testingSession = session;
    state.testingActiveCaseId = session.testCases?.[0]?.id || null;
    session.currentEvidenceTestCaseId = state.testingActiveCaseId;
    state.testingAssociatingEvidenceId = null;
    // Scenarios are expanded by default; users can collapse individual cards later.
    state.testingCollapsedCases = new Set();
    state.testingExpandedEvidence = new Set();
    state.testingGeneralEvidenceExpanded = false;
    state.testingOpenMenu = null;
    state.testingSessionNameEditing = false;
    state.testingEditingExistingSession = false;
    resetTestingExportState();
    const settings = await getSettings();
    const needsName = !String(parsed.workProduct || '').trim();
    if (needsName) {
      openEvidenceNameDialog('start-test-cases', '');
      return;
    }
    if (settings.skipTestCaseReview) {
      await continueImportedTestingSession();
    } else {
      await persistTestingSession();
      state.view = 'testing-preview';
      render();
      requestAnimationFrame(() => autoResizeTestingTextareas());
    }
  } catch (error) {
    state.testingPasteError = error?.message || 'Could not parse the pasted content.';
    render();
  }
}

async function continueImportedTestingSession() {
  const session = state.testingSession;
  if (!session) { state.view = 'testing-paste'; render(); return; }
  const settings = await getSettings();
  if (settings.skipTestCaseReview) {
    await startTestingWorkspace();
  } else {
    await persistTestingSession();
    state.view = 'testing-preview';
    render();
    requestAnimationFrame(() => autoResizeTestingTextareas());
  }
}

async function startTestingWorkspace() {
  const validation = validateTestingSessionForStart();
  if (validation) {
    state.testingPasteError = validation;
    render();
    return;
  }
  state.testingPasteError = '';
  state.testingEditingExistingSession = false;
  if (!isEvidenceOnlyTesting(state.testingSession)) {
    const ids = new Set((state.testingSession?.testCases || []).map(tc => tc.id));
    if (!ids.has(state.testingActiveCaseId)) state.testingActiveCaseId = state.testingSession?.testCases?.[0]?.id || null;
    state.testingSession.currentEvidenceTestCaseId = state.testingActiveCaseId;
  }
  await persistTestingSession();
  await loadTestingEvidenceUrls();
  state.testingOpenMenu = null;
  state.view = 'testing-workspace';
  render();
}

function addTestingCase() {
  const session = state.testingSession;
  if (!session || isEvidenceOnlyTesting(session)) return;
  const tc = {
    id: `tc_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
    title: 'New scenario',
    status: 'not-marked',
    statusSource: 'none'
  };
  session.testCases.push(tc);
  state.testingActiveCaseId = tc.id;
  session.currentEvidenceTestCaseId = tc.id;
  state.testingCollapsedCases.delete(tc.id);
  state.testingOpenMenu = null;
  persistTestingSession().catch(() => {});
  render();
  requestAnimationFrame(() => {
    const input = document.querySelector(`textarea[data-testing-field="title"][data-tc-id="${CSS.escape(tc.id)}"]`);
    input?.focus();
    input?.select();
  });
}

async function deleteTestingCase(tcId) {
  const session = state.testingSession;
  const tc = session?.testCases?.find(item => item.id === tcId);
  if (!session || !tc) return;
  const confirmed = await requestTestingConfirm({
    title: 'Remove scenario?',
    message: `Remove “${tc.title || 'Untitled scenario'}”? Any associated screenshots will be kept and moved to Unassigned screenshots.`,
    confirmLabel: 'Remove scenario',
    danger: true
  });
  if (!confirmed) return;
  session.testCases = session.testCases.filter(item => item.id !== tcId);
  session.evidence.forEach(item => { if (item.testCaseId === tcId) item.testCaseId = null; });
  state.testingCollapsedCases.delete(tcId);
  if (state.testingActiveCaseId === tcId) state.testingActiveCaseId = session.testCases[0]?.id || null;
  session.currentEvidenceTestCaseId = state.testingActiveCaseId;
  state.testingOpenMenu = null;
  await persistTestingSession();
  render();
}

async function deleteResumableTestingSession(sessionId) {
  const summary = (state.testingSessions || []).find(item => item.id === sessionId);
  if (!summary) return;
  const session = await loadTestingSessionById(sessionId).catch(() => null);
  if (!session) return;
  const name = testingSessionName(session) || 'Untitled testing session';
  const captures = session.evidence?.length || 0;
  const confirmed = await requestTestingConfirm({
    title: 'Delete testing session?',
    message: `Delete “${name}” and its ${captures} saved screenshot${captures === 1 ? '' : 's'}? This cannot be undone.`,
    confirmLabel: 'Delete session',
    danger: true
  });
  if (!confirmed) return;
  await deleteTestingSession(session);
  for (const evidence of session.evidence || []) revokeTestingObjectUrl(evidence.id);
  state.testingSessions = (state.testingSessions || []).filter(item => item.id !== sessionId);
  if (state.testingSession?.id === sessionId) state.testingSession = null;
  render();
}

function testingDismissOpenMenu(event) {
  let changed = false;
  if (state.testingOpenMenu && !event.target?.closest?.('.testing-context-menu') && !event.target?.closest?.('[data-testing-case-menu]')) {
    state.testingOpenMenu = null;
    changed = true;
  }
  if (state.testingStatusMenuId && !event.target?.closest?.('.testing-status-menu') && !event.target?.closest?.('[data-open-testing-status]')) {
    state.testingStatusMenuId = null;
    changed = true;
  }
  if (changed && String(state.view || '').startsWith('testing-')) render();
}

function autoResizeTestingNote(textarea) {
  if (!textarea) return;
  textarea.style.height = '30px';
  textarea.style.height = `${Math.min(120, Math.max(30, textarea.scrollHeight))}px`;
  textarea.style.overflowY = textarea.scrollHeight > 120 ? 'auto' : 'hidden';
}

function openTestingNote(evidenceId) {
  const evidence = state.testingSession?.evidence?.find(item => item.id === evidenceId);
  if (!evidence) return;
  state.testingNoteOpenId = state.testingNoteOpenId === evidenceId ? null : evidenceId;
  render();
  if (state.testingNoteOpenId) requestAnimationFrame(() => {
    const input = document.querySelector(`[data-note-input="${CSS.escape(evidenceId)}"]`);
    input?.focus();
    autoResizeTestingNote(input);
  });
}

function closeTestingNote() {
  state.testingNoteOpenId = null;
  render();
}

async function saveTestingNote(evidenceId) {
  const evidence = state.testingSession?.evidence?.find(item => item.id === evidenceId);
  if (!evidence) return;
  const input = document.querySelector(`[data-note-input="${CSS.escape(evidenceId)}"]`);
  evidence.note = String(input?.value || '').trim() || null;
  state.testingNoteOpenId = null;
  await persistTestingSession();
  render();
}

async function saveTestingEvidenceBlob(inputBlob, { source = 'native', sourceTabId = null, toastMessage = 'Screenshot captured', requestedTestCaseId = null } = {}) {
  const session = state.testingSession;
  if (!session || !inputBlob || session.status !== 'active') return false;
  const evidenceId = `evidence_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const imageBlobKey = `${session.id}:${evidenceId}`;
  await putEvidenceBlob(imageBlobKey, inputBlob);
  let testCaseId = null;
  if (!isEvidenceOnlyTesting(session)) {
    const currentId = requestedTestCaseId || state.testingActiveCaseId || session.currentEvidenceTestCaseId || session.testCases?.[0]?.id || null;
    testCaseId = session.testCases?.some(tc => tc.id === currentId) ? currentId : null;
    if (testCaseId) {
      state.testingActiveCaseId = testCaseId;
      session.currentEvidenceTestCaseId = testCaseId;
    }
  }
  const evidence = {
    id: evidenceId,
    sessionId: session.id,
    capturedAt: new Date().toISOString(),
    testCaseId,
    imageBlobKey,
    sourceTabId: sourceTabId || null,
    source,
    timestampApplied: false,
    note: null
  };
  session.evidence = Array.isArray(session.evidence) ? session.evidence : [];
  session.evidence.push(evidence);
  testingObjectUrls.set(evidenceId, URL.createObjectURL(inputBlob));
  if (isEvidenceOnlyTesting(session)) state.testingGeneralEvidenceExpanded = true;
  else state.testingCollapsedCases.delete(testCaseId);
  await persistTestingSession();
  showToast(toastMessage, {
    type: 'success', duration: 1500,
    transientKey: source === 'pasted' ? 'screenshot-pasted' : 'screenshot-captured',
    subtitle: `Saved to ${String(session.sessionName || session.workProduct || session.exportFilename || '').trim() || 'your ForcePilot testing session'}`
  });
  return true;
}

function autoResizeTestingTextareas() {
  document.querySelectorAll('.testing-editor-title textarea').forEach(textarea => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(42, textarea.scrollHeight)}px`;
  });
}

async function setTestingCaseStatus(tcId, status) {
  const session = state.testingSession;
  const tc = session?.testCases?.find(item => item.id === tcId);
  if (!tc || !['pass', 'fail', 'blocked', 'not-marked'].includes(status)) return;
  tc.status = status;
  tc.statusSource = 'manual';
  state.testingStatusMenuId = null;
  await persistTestingSession();
  render();
  requestAnimationFrame(() => document.querySelector(`[data-open-testing-status="${CSS.escape(tcId)}"]`)?.focus({ preventScroll: true }));
}

function isImageClipboardItem(item) {
  return !!item && typeof item.type === 'string' && item.type.toLowerCase().startsWith('image/');
}

async function readClipboardImage() {
  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read();
    for (const item of items || []) {
      const type = (item.types || []).find(t => String(t).toLowerCase().startsWith('image/'));
      if (type) return item.getType(type);
    }
  }
  return null;
}

async function pasteTestingScreenshot(testCaseId = null) {
  if (!state.testingSession || state.testingCaptureBusy) return;
  try {
    const blob = await readClipboardImage();
    if (!blob) {
      showToast('No screenshot found in clipboard.', { type: 'warning', duration: 2600 });
      return;
    }
    await saveTestingEvidenceBlob(blob, { source: 'pasted', stamp: false, toastMessage: 'Screenshot pasted', requestedTestCaseId: state.testingActiveCaseId || state.testingSession.currentEvidenceTestCaseId || null });
    render();
  } catch (error) {
    showToast(error?.message || 'Could not paste screenshot.', { type: 'error', duration: 3200 });
  }
}

async function handleTestingImagePaste(event) {
  if (!state.testingSession || state.view !== 'testing-workspace') return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find(isImageClipboardItem);
  if (!imageItem) return;
  const blob = imageItem.getAsFile?.() || null;
  if (!blob) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    await saveTestingEvidenceBlob(blob, { source: 'pasted', stamp: false, toastMessage: 'Screenshot pasted', requestedTestCaseId: state.testingActiveCaseId || state.testingSession.currentEvidenceTestCaseId || null });
    render();
  } catch (error) {
    showToast(error?.message || 'Could not paste screenshot.', { type: 'error', duration: 3200 });
  }
}

async function captureTestingEvidence(testCaseId = null) {
  if (!state.testingSession || state.testingSession.status !== 'active' || state.testingCaptureBusy) return;
  state.testingCaptureBusy = true;
  if (!isEvidenceOnlyTesting(state.testingSession)) {
    state.testingActiveCaseId = testCaseId || state.testingActiveCaseId || state.testingSession.testCases?.[0]?.id || null;
    state.testingSession.currentEvidenceTestCaseId = state.testingActiveCaseId;
  }
  render();
  const sessionId = state.testingSession.id;
  const tab = await activeTab();
  if (!tab?.id) {
    testingError('No active browser tab is available for capture.');
    state.testingCaptureBusy = false;
    render();
    return;
  }
  try {
    // Persist the active screenshot page/session and selected test case before asking
    // the background worker to run the same capture-and-save pipeline as Alt+S.
    await persistTestingSession();
    await chrome.storage.local.set({ [TESTING_UI_STATE_KEY]: { view: 'testing-workspace', sessionId } });
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_AND_SAVE_TESTING_SESSION_SCREENSHOT', tabId: tab.id });
    if (!response?.ok) throw new Error(response?.message || 'Could not capture and save the screenshot.');
    const latest = await loadTestingSessionById(sessionId).catch(() => null);
    if (latest && state.testingSession?.id === sessionId) {
      state.testingSession = latest;
      const summary = summarizeTestingSession(latest);
      state.testingSessions = [summary, ...(state.testingSessions || []).filter(item => item.id !== sessionId)]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      await loadTestingEvidenceUrls();
      state.testingGeneralEvidenceExpanded = true;
    }
  } catch (error) {
    testingError(error?.message || 'Could not capture the current tab.');
  } finally {
    state.testingCaptureBusy = false;
    render();
  }
}

async function blobAsPng(blob) {
  if (!blob) throw new Error('The screenshot is unavailable.');
  if (String(blob.type || '').toLowerCase() === 'image/png') return blob;
  let bitmap = null, objectUrl = null;
  try {
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(blob);
    else {
      objectUrl = URL.createObjectURL(blob);
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The screenshot could not be decoded.'));
        img.src = objectUrl;
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bitmap.width || bitmap.naturalWidth);
    canvas.height = Math.max(1, bitmap.height || bitmap.naturalHeight);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('The browser could not prepare the screenshot.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('The screenshot could not be prepared for copying.')), 'image/png'));
  } finally {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function copyTestingEvidence(evidenceId) {
  const evidence = state.testingSession?.evidence?.find(item => item.id === evidenceId);
  if (!evidence) return showToast('The screenshot is unavailable.', { type: 'error', duration: 3200 });
  try {
    const blob = await getEvidenceBlob(evidence.imageBlobKey);
    if (!blob) throw new Error('The screenshot is unavailable.');
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard is not supported in this browser.');
    const png = await blobAsPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    showToast('Copied to clipboard', { type: 'success', duration: 1050, transientKey: 'copied-to-clipboard' });
  } catch (error) {
    showToast(error?.message || 'Could not copy to clipboard.', { type: 'error', duration: 3400 });
  }
}

function previewTestingEvidence(evidenceId) {
  const evidence = state.testingSession?.evidence?.find(item => item.id === evidenceId);
  const url = evidence ? testingObjectUrls.get(evidence.id) : null;
  if (!url) return;
  const trigger = document.querySelector(`[data-preview-evidence="${evidenceId}"]`);
  const preview = document.createElement('div');
  preview.className = 'testing-image-preview-backdrop';
  preview.setAttribute('role','dialog');preview.setAttribute('aria-modal','true');preview.setAttribute('aria-label','Screenshot preview');
  preview.innerHTML = `<button class="testing-image-preview-close" type="button" aria-label="Close preview">${icon('close')}</button><img src="${url}" alt="Captured Salesforce evidence preview">`;
  document.body.appendChild(preview);
  preview.querySelector('.testing-image-preview-close')?.focus({ preventScroll: true });
  preview.addEventListener('click', event => { if (event.target === preview || event.target.closest('.testing-image-preview-close')) { preview.remove(); trigger?.focus({ preventScroll: true }); } });
}

async function removeTestingEvidence(evidenceId) {
  const session = state.testingSession;
  const evidence = session?.evidence?.find(item => item.id === evidenceId);
  if (!evidence) return;
  session.evidence = session.evidence.filter(item => item.id !== evidenceId);
  revokeTestingObjectUrl(evidenceId);
  await deleteEvidenceBlob(evidence.imageBlobKey).catch(() => {});
  await persistTestingSession();
  if (state.testingAssociatingEvidenceId === evidenceId) state.testingAssociatingEvidenceId = null;
  showToast('Screenshot removed', { type: 'success', duration: 2000 });
  render();
}

async function associateTestingEvidence(evidenceId, testCaseId) {
  const session = state.testingSession;
  const evidence = session?.evidence?.find(item => item.id === evidenceId);
  if (!evidence) return;
  if (testCaseId && !session.testCases?.some(tc => tc.id === testCaseId)) return;
  evidence.testCaseId = testCaseId || null;
  if (state.testingActiveCaseId && !session.testCases.some(tc => tc.id === state.testingActiveCaseId)) state.testingActiveCaseId = null;
  state.testingAssociatingEvidenceId = null;
  await persistTestingSession();
  showToast(testCaseId ? 'Screenshot associated with scenario' : 'Screenshot unassigned', { type: 'success', duration: 2000 });
  render();
}

async function confirmRecordingObjectCompatibility(recording, liveContext, alreadyConfirmed = false) {
  if (alreadyConfirmed) return true;
  const recordedObject = String(recording?.context?.objectApiName || recording?.context?.objectName || '').trim();
  const currentObject = String(liveContext?.objectApiName || liveContext?.objectName || '').trim();
  const isGeneric = value => !value || /^salesforce$/i.test(value);
  // Pages such as Setup may not expose a reliable object context. Only warn when
  // both sides identify concrete objects; an unknown context is not a mismatch.
  if (isGeneric(recordedObject) || isGeneric(currentObject) || recordedObject.toLowerCase() === currentObject.toLowerCase()) return true;
  return !!(await requestTestingConfirm({
    title: 'Different Salesforce object',
    message: `This recording belongs to ${objectLabel(recording.context || {})}, but the current live page appears to be ${objectLabel(liveContext || {})}. Do you want to autofill anyway?`,
    confirmLabel: 'Continue Autofill',
    cancelLabel: 'Cancel',
    danger: false
  }));
}

async function runTestingRecording(recordingId) {
  if (!recordingId || state.testingAutofillBusy) return;
  const recording = state.recordings[recordingId];
  if (!recording) return;
  state.testingAutofillBusy = true;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  render();
  const tab = await activeTab();
  if (!tab?.id) { testingError('Open the Salesforce record where you want to run Autofill.'); state.testingAutofillBusy = false; render(); return; }
  // Testing pages normally already have the Salesforce content script loaded.
  // Probe it directly first to avoid the extra ENSURE_CONTENT_SCRIPTS round-trip.
  let ready = null;
  const ping = await chrome.tabs.sendMessage(tab.id, { type: 'GET_RECORDING_STATE' }).catch(() => null);
  if (ping) ready = { ok: true, context: ping.context || null };
  else ready = await ensureTabConnection(tab);
  if (!ready?.ok) { testingError(ready.message || 'Could not connect to Salesforce.'); state.testingAutofillBusy = false; render(); return; }
  let liveContext = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }).catch(() => null);
  if (!liveContext) liveContext = ready.context || await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }).catch(() => null);
  if (!liveContext?.objectApiName && liveContext?.context?.objectApiName) liveContext = liveContext.context;
  if (!(await confirmRecordingObjectCompatibility(recording, liveContext))) {
    state.testingAutofillBusy = false;
    render();
    return;
  }
  let runRecording = { ...recording, steps: (recording.steps || []).filter(Boolean) };
  const enabledSteps = runRecording.steps.filter(step => step?.enabled !== false);
  if (!enabledSteps.length && runRecording.steps.length) runRecording = { ...runRecording, steps: runRecording.steps.map(step => ({ ...step, enabled: true })) };
  const eligibleIndexes = eligibleStepIndexes(runRecording.steps);
  if (!eligibleIndexes.length) { testingError('This recording has no eligible fields to autofill.'); state.testingAutofillBusy = false; render(); return; }
  const executionTotal = eligibleIndexes.length;
  const firstExecutionIndex = eligibleIndexes[0];
  state.selectedId = recordingId;
  state.testingAutofillActive = true;
  state.isRetrying = false;
  state.run = null;
  state.progress = { current: 0, total: executionTotal, fieldName: runRecording.steps[firstExecutionIndex]?.target?.label || 'Starting…' };
  state.view = 'running';
  render();
  clearInterval(window.fpProgressTimer);
  window.fpProgressTimer = setGuardedInterval(async () => {
    const d = await sendTab(tab, { type: 'GET_RECORDING_STATE' });
    const idx = Number.isFinite(d?.currentStepIndex) ? d.currentStepIndex : -1;
    if (idx >= 0) {
      const pos = eligibleIndexes.indexOf(idx);
      if (pos >= 0) {
        state.progress.current = Math.min(pos + 1, executionTotal);
        const count = document.getElementById('progress-count');
        const bar = document.getElementById('progress-bar');
        const field = document.getElementById('progress-field');
        if (count) count.textContent = `${state.progress.current} of ${executionTotal}`;
        if (bar) bar.style.width = `${executionTotal ? Math.round((state.progress.current / executionTotal) * 100) : 0}%`;
        if (field) field.textContent = runRecording.steps[idx]?.target?.label || 'Starting…';
      }
    }
  }, 350);
  try {
    const resp = await sendTab(tab, { type: 'REPLAY_RECORDING', recording: runRecording, fillOnlyBlank: state.fillEmptyOnly });
    clearInterval(window.fpProgressTimer);
    state.run = resp || { ok: false, executed: [], error: 'Salesforce did not respond.' };
    if (!Array.isArray(state.run.executed)) state.run.executed = [];
    state.progress.current = state.run.executed.length;
    state.resultTab = 'all';
    state.view = 'result';
    state.testingAutofillBusy = false;
    try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: recording.id, run: state.run, resultTab: 'all', testingAutofill: true } }); } catch {}
    render();
  } catch (error) {
    clearInterval(window.fpProgressTimer);
    state.run = { ok: false, executed: [], error: error?.message || 'Autofill could not be completed.' };
    state.resultTab = 'all';
    state.view = 'result';
    state.testingAutofillBusy = false;
    render();
  }
}

function resetTestingExportState() {
  state.testingExportBusy = false;
  state.testingExportStage = '';
  state.testingExportError = '';
  state.testingExportCompleted = false;
  state.testingExportFilename = '';
  state.testingExportBlob = null;
  state.testingZipBusy = false;
  state.testingZipStage = '';
  state.testingZipError = '';
  state.testingZipCompleted = false;
  state.testingZipFilename = '';
  state.testingZipBlob = null;
}

function setTestingExportStage(message) {
  state.testingExportStage = String(message || 'Preparing…');
  if (state.view === 'testing-summary') render();
}

async function loadTestingEvidenceBlobsForExport(snapshot) {
  const evidence = Array.isArray(snapshot?.evidence) ? snapshot.evidence : [];
  const loaded = await Promise.all(evidence.map(async item => {
    const blob = await getEvidenceBlob(item.imageBlobKey);
    if (!blob) throw new Error('A captured evidence image is unavailable. Capture it again before exporting.');
    return [item.imageBlobKey, blob];
  }));
  return new Map(loaded);
}

async function exportTestingSessionWord() {
  const session = state.testingSession;
  if (!session) return;
  if (state.testingExportBusy || state.testingZipBusy) return;
  if (!(session.evidence || []).length) {
    showToast('Capture at least one screenshot before exporting.', { type: 'warning' });
    state.testingExportError = '';
    render();
    return;
  }
  if (!String(session.exportFilename || session.workProduct || session.sessionName || '').trim()) { openEvidenceNameDialog('export-word'); return; }

  state.testingExportBusy = true;
  state.testingExportCompleted = false;
  state.testingExportError = '';
  state.testingExportStage = 'Preparing captured evidence…';
  render();

  try {
    const snapshot = clone(session);
    const evidenceBlobs = await loadTestingEvidenceBlobsForExport(snapshot);
    const exportSettings = await getSettings();
    const imageQuality = Math.min(0.95, Math.max(0.70, Number(exportSettings.exportImageQuality) || 88)) / 100;
    state.testingExportStage = 'Loading export engine…';
    render();
    await ensureJSZipLoaded();
    state.testingExportStage = 'Building Word document…';
    render();
    const result = await buildTestingDocx(snapshot, evidenceBlobs, {
      imageQuality,
      validate: false,
      onProgress: ({ message }) => {
        state.testingExportStage = message || 'Building Word document…';
        if (state.view === 'testing-summary') render();
      }
    });
    if (!result?.blob?.size) throw new Error('The Word document was empty.');
    const filename = getTestingDocxFilename(snapshot);
    downloadTestingDocx(result.blob, filename);
    state.testingExportBlob = result.blob;
    state.testingExportFilename = filename;
    state.testingExportCompleted = true;
    state.testingExportStage = '';
    state.testingExportBusy = false;
    state.testingExportError = '';
    render();
  } catch (error) {
    state.testingExportBusy = false;
    state.testingExportStage = '';
    state.testingExportCompleted = false;
    state.testingExportBlob = null;
    state.testingExportFilename = '';
    state.testingExportError = '';
    showToast(error?.message || 'The Word document could not be generated.', { type: 'error', duration: 3800 });
    render();
  }
}

async function exportTestingSessionZip() {
  const session = state.testingSession;
  if (!session) return;
  if (state.testingZipBusy || state.testingExportBusy) return;
  if (!(session.evidence || []).length) {
    showToast('Capture at least one screenshot before exporting the ZIP.', { type: 'warning' });
    state.testingZipError = '';
    render();
    return;
  }
  if (!String(session.exportFilename || session.workProduct || session.sessionName || '').trim()) { openEvidenceNameDialog('export-zip'); return; }

  state.testingZipBusy = true;
  state.testingZipCompleted = false;
  state.testingZipError = '';
  state.testingZipStage = 'Preparing screenshots…';
  render();
  try {
    const snapshot = clone(session);
    const evidenceBlobs = await loadTestingEvidenceBlobsForExport(snapshot);
    const exportSettings = await getSettings();
    const imageQuality = Math.min(0.95, Math.max(0.70, Number(exportSettings.exportImageQuality) || 88)) / 100;
    state.testingZipStage = 'Loading export engine…';
    render();
    await ensureJSZipLoaded();
    state.testingZipStage = 'Creating ZIP…';
    render();
    const result = await buildTestingEvidenceZip(snapshot, evidenceBlobs, {
      imageQuality,
      onProgress: ({ current, total }) => {
        state.testingZipStage = `Adding screenshot ${current} of ${total}…`;
        if (state.view === 'testing-summary' && (current === total || current % 8 === 0)) render();
      }
    });
    if (!result?.blob?.size) throw new Error('The screenshots ZIP was empty.');
    const filename = getTestingZipFilename(snapshot);
    downloadTestingZip(result.blob, filename);
    state.testingZipBlob = result.blob;
    state.testingZipFilename = filename;
    state.testingZipCompleted = true;
    state.testingZipStage = '';
    state.testingZipBusy = false;
    state.testingZipError = '';
    render();
  } catch (error) {
    state.testingZipBusy = false;
    state.testingZipStage = '';
    state.testingZipCompleted = false;
    state.testingZipBlob = null;
    state.testingZipFilename = '';
    state.testingZipError = '';
    showToast(error?.message || 'The screenshots ZIP could not be generated.', { type: 'error', duration: 3800 });
    render();
  }
}

function downloadTestingWordAgain() {
  if (!state.testingExportBlob || !state.testingExportFilename) return;
  downloadTestingDocx(state.testingExportBlob, state.testingExportFilename);
}

function downloadTestingZipAgain() {
  if (!state.testingZipBlob || !state.testingZipFilename) return;
  downloadTestingZip(state.testingZipBlob, state.testingZipFilename);
}

async function finishTestingSession() {
  const session = state.testingSession;
  if (!session) return;
  await completeTestingSession();
}

async function completeTestingSession() {
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingExportCompleted = false;
  state.testingExportFilename = '';
  state.testingExportBlob = null;
  state.testingExportError = '';
  state.testingZipCompleted = false;
  state.testingZipFilename = '';
  state.testingZipBlob = null;
  state.testingZipError = '';
  if (state.testingSession) state.testingSession.status = 'finished';
  await persistTestingSession();
  state.view = 'testing-summary';
  render();
}

async function endTestingSession() {
  const session = state.testingSession;
  if (!session) {
    state.view = 'home';
    render();
    return;
  }
  const captures = session.evidence?.length || 0;
  const missingExports = captures ? [
    ...(!state.testingExportCompleted ? ['Word document'] : []),
    ...(!state.testingZipCompleted ? ['screenshots ZIP'] : [])
  ] : [];
  const name = testingSessionName(session) || 'Screenshot session';
  const message = missingExports.length
    ? `End the “${name}” session and delete its ${captures} saved screenshot${captures === 1 ? '' : 's'}? The ${missingExports.join(' and ')} ${missingExports.length === 1 ? 'has' : 'have'} not been exported yet.`
    : `End the “${name}” session${captures ? ` and delete its ${captures} saved screenshot${captures === 1 ? '' : 's'}` : ''}? This can’t be undone.`;
  const confirmed = await requestTestingConfirm({
    title: 'End testing session?',
    message,
    confirmLabel: 'End session',
    danger: true
  });
  if (!confirmed) return;
  await discardTestingSession();
}

async function handleTestingDone(event) {
  event.preventDefault();
  event.stopPropagation();
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await endTestingSession();
  } catch (error) {
    showToast(error?.message || 'Could not end the testing session.', { type: 'error', duration: 3400 });
    render();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

async function discardTestingSession() {
  const deleting = state.testingSession;
  try {
    for (const evidence of deleting?.evidence || []) revokeTestingObjectUrl(evidence.id);
    if (deleting?.id) await deleteTestingSession(deleting);
  } catch {}
  if (deleting?.id) state.testingSessions = (state.testingSessions || []).filter(session => session.id !== deleting.id);
  state.testingSession = null;
  state.testingConfirmDialog = null;
  state.testingEvidenceNameDialog = null;
  state.testingPasteText = '';
  state.testingPasteError = '';
  state.testingMessage = '';
  state.testingAssociatingEvidenceId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  resetTestingExportState();
  state.view = 'home';
  render();
}

async function startRecording() {
  const tab = await activeTab(); if (!tab?.id) return;
  const ready = await ensureTabConnection(tab); if (!ready?.ok) return showToast(ready.message || 'Could not connect to Salesforce.', { type: 'error', duration: 3400 });
  const fresh = await sendTab(tab, { type: 'REFRESH_CONTEXT' });
  // A concrete object is useful on Lightning record pages, but is not required
  // on Salesforce Setup, Visualforce utility, or Experience Cloud pages.
  if (!fresh?.objectApiName) return showInline('Could not read the Salesforce page context. Refresh the page and try again.');
  state.context = fresh;
  const r = await sendTab(tab, { type: 'START_RECORDING' });
  if (!r?.ok) return showInline(r?.message || 'Could not start recording.');
  liveRecordingRevision++;
  state.pendingRecording = null; state.pendingRecordingTabId = null; state.recordingPaused = false; state.recording = true; state.recordingTabId = tab.id; state.addingToRecordingId = null; state.context = r.context || state.context; state.activeSteps = r.steps || []; state.activeLookupCreation=null; state.run = null; state.view = 'recording'; render();
   clearInterval(window.fpTimer); window.fpTimer = setGuardedInterval(async () => { if(liveRecordingMutationInFlight||stopRecordingPromise)return; const revision=liveRecordingRevision; const d = await sendTab(tab, { type:'GET_RECORDING_STATE' }); if (liveRecordingMutationInFlight||stopRecordingPromise||revision!==liveRecordingRevision || !d?.recording) return; state.activeSteps = d.steps || []; state.activeLookupCreation=d.lookupCreation||null; const captureStatus=document.getElementById('lookup-create-capture-status'); if(captureStatus)captureStatus.innerHTML=renderLiveLookupCreationStatus(state.activeLookupCreation); const list=document.getElementById('recording-field-list'); if(list){ updateLiveRecordingList(list, state.activeSteps); const note=document.getElementById('recording-note'); if(note) note.classList.toggle('is-hidden',state.activeSteps.length>0);  } }, 300);
}

async function togglePauseRecording(){const id=state.recordingTabId;if(!id)return;const tab=await chrome.tabs.get(id).catch(()=>null);if(!tab?.id)return;const next=!state.recordingPaused;const r=await sendTab(tab,{type:next?'PAUSE_RECORDING':'RESUME_RECORDING'});if(!r?.ok)return showInline(r?.message||'Could not change recording state.');state.recordingPaused=!!r.paused;render()}

async function stopRecording() {
  if (stopRecordingPromise) return stopRecordingPromise;
  // Invalidate an already-running poll so it cannot repaint stale rows while
  // Stop is collecting the final recording snapshot.
  liveRecordingRevision++;
  const button=document.getElementById('stop');
  if(button){button.disabled=true;button.setAttribute('aria-busy','true');const label=button.querySelector('span');if(label)label.textContent='Stopping…';}
  stopRecordingPromise=(async()=>stopRecordingImpl())();
  try{return await stopRecordingPromise;}
  finally{
    stopRecordingPromise=null;
    if(state.recording && button?.isConnected){button.disabled=false;button.removeAttribute('aria-busy');const label=button.querySelector('span');if(label)label.textContent=state.addingToRecordingId?'Done adding':'Stop recording';}
  }
}

async function stopRecordingImpl() {
  clearInterval(window.fpTimer);
  const id = state.recordingTabId;
  const wasAppending = !!state.addingToRecordingId;
  const appendId = state.addingToRecordingId;
  const tab = id ? await chrome.tabs.get(id).catch(() => null) : null;
  const r = tab?.id ? await sendTab(tab, { type: 'STOP_RECORDING', multiFrame:true, appendRecording:wasAppending&&appendId?state.recordings[appendId]:null }) : null;
  state.recording = false; state.recordingPaused=false; state.recordingTabId = null; state.addingToRecordingId = null;
  // If the Salesforce content script was reloaded/navigated while recording,
  // STOP_RECORDING can legitimately return NOT_RECORDING even though the Side Panel
  // still has the latest polled field list. Recover that snapshot instead of losing it.
  if (!r?.recording && Array.isArray(state.activeSteps) && state.activeSteps.length) {
    const recoveredSteps = clone(state.activeSteps).filter(step=>!step?.__fpExistingAppendStep).map(step=>{const clean={...step};delete clean.__fpExistingAppendStep;delete clean.__fpExistingIndex;delete clean.__fpFrameStepIndex;delete clean.__fpStorageFrameId;return clean;});
    const context = state.context || {};
    if (wasAppending && appendId && state.recordings[appendId]) {
      const previous=state.recordings[appendId];
      const keyOf=step=>`${step?.frame?.framePath||step?.frame?.origin||''}|${step?.target?.key||step?.target?.apiName||step?.target?.label||''}|${step?.meta?.recordedAt||JSON.stringify(step?.value??'')}`;
      const recovered=[...(previous.steps||[])];const seen=new Set(recovered.map(keyOf));
      for(const step of recoveredSteps){const clean={...step};delete clean.__fpFrameStepIndex;delete clean.__fpStorageFrameId;const key=keyOf(clean);if(!seen.has(key)){seen.add(key);recovered.push(clean);}}
      state.recordings[appendId] = {
        ...previous,
        context: {...previous.context, ...context},
        steps: recovered.map((step,i)=>({...step,sequence:i+1})),
        updatedAt: new Date().toISOString()
      };
      await saveRecordings(state.recordings);
      state.selectedId = appendId;
      state.pendingRecording = null;
      state.run = null;
      state.view = 'detail';
      if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id, windowId: state.windowId, incognito: state.incognito }); } catch {} }
      render();
      return;
    }
    state.pendingRecording = {
      id: `rec_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
      name: recordingTitle({context}),
      context,
      version: 5,
      recordingDate: localDateISO(),
      steps: recoveredSteps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.pendingRecordingTabId = id || null;
    state.run = null;
    state.view = 'save-name';
    if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id, windowId: state.windowId, incognito: state.incognito }); } catch {} }
    render();
    return;
  }
  if (r?.recording) {
    const recordedSteps = Array.isArray(r.recording.steps) ? r.recording.steps.filter(Boolean) : [];
    // Multi-frame append mode returns a merged pending record so all frames can
    // contribute without saving partial copies. Commit it back to the existing
    // recording here, preserving the existing name and identity.
    if (wasAppending && appendId && r.recording.id === appendId && recordedSteps.length) {
      const previous=state.recordings[appendId]||{};
      state.recordings[appendId]={...previous,...r.recording,id:appendId,name:previous.name||r.recording.name,createdAt:previous.createdAt||r.recording.createdAt,updatedAt:new Date().toISOString()};
      await saveRecordings(state.recordings);
      state.selectedId=appendId;state.pendingRecording=null;state.pendingRecordingTabId=null;state.run=null;state.view='detail';
      if(id){try{await chrome.runtime.sendMessage({type:'RELEASE_RECORDING_LOCK',tabId:id,windowId:state.windowId,incognito:state.incognito});}catch{}}
      render();return;
    }
    if (recordedSteps.length === 0) {
      const pendingTabId = state.pendingRecordingTabId || id;
      state.pendingRecording = null;
      state.pendingRecordingTabId = null;
      state.selectedId = null;      state.run = null;
      state.view = 'home';
      await clearPendingRecordingInTab(pendingTabId);
      if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id, windowId: state.windowId, incognito: state.incognito }); } catch {} }
      render();
      showInline('No Salesforce fields were recorded, so the recording was not saved.');
      return;
    }
    if (r.pendingSave) {
      await receivePendingRecording(r.recording, { sourceTabId: id });
      if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id, windowId: state.windowId, incognito: state.incognito }); } catch {} }
    } else {
      state.recordings[r.recording.id] = r.recording;
      state.selectedId = r.recording.id;
      state.pendingRecording = null;
      state.run = null;
      state.view = 'detail';
    }
  } else {
    const code = String(r?.code || '');
    const message = code === 'NOT_RECORDING' || !tab?.id
      ? 'Recording could not be stopped because the Salesforce page was reloaded or the recording state was lost.'
      : (r?.message || 'Recording could not be stopped.');
    showToast(message, { type: 'error', duration: 3600 });
  }
  render();
}

async function startAutofill(onlyIndexes = null, confirmedObjectMismatch = false) {
  const r = state.recordings[state.selectedId]; if (!r) return;
  const tab = await activeTab(); if (!tab?.id) return showInline('Open a Salesforce page to run Autofill.');
  // Never use state.context for this guard: the side panel can outlive a
  // Salesforce SPA navigation, so it may describe the previous object.
  let liveContext = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }).catch(() => null);
  let ready = liveContext ? { ok: true, context: liveContext, existing: true } : await ensureTabConnection(tab);
  if (!ready?.ok) { showToast(ready.message || 'Could not connect to Salesforce.', { type: 'error', duration: 3400 }); return; }
  if (!liveContext) liveContext = ready.context || await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }).catch(() => null);
  if (!liveContext?.objectApiName && liveContext?.context?.objectApiName) liveContext = liveContext.context;
  if (!(await confirmRecordingObjectCompatibility(r, liveContext, confirmedObjectMismatch))) return;
  const hasMalformedPicklist = (r.steps||[]).some(s=>['Picklist','Multipicklist'].includes(fieldTypeLabel(s))&&isAggregatePicklistText(s.value,s?.target?.label));
  if(hasMalformedPicklist){
    const before=JSON.stringify(r.steps||[]);
    await hydrateDraftPicklists(r);
    if(before!==JSON.stringify(r.steps||[])){
      r.updatedAt=new Date().toISOString();state.recordings[r.id]=r;
      await saveRecordings(state.recordings).catch(()=>{});
    }
  }
  const totalSteps = Array.isArray(r.steps) ? r.steps.length : 0;
  if (!totalSteps) {
    showToast('This recording has no fields to autofill.', { type: 'warning' });
    return;
  }
  // Keep explicit per-field Autofill settings, but recover older recordings
  // whose fields were all marked disabled by an earlier build.
  let runRecording = {...r, steps: r.steps.filter(Boolean)};
  const enabledSteps = runRecording.steps.filter(s => s?.enabled !== false);
  if (!enabledSteps.length && runRecording.steps.length) runRecording = {...runRecording, steps: runRecording.steps.map(s => ({...s, enabled: true}))};
  const eligibleIndexes = eligibleStepIndexes(runRecording.steps);
  const requestedIndexes = Array.isArray(onlyIndexes) ? [...new Set(onlyIndexes.map(Number).filter(i => eligibleIndexes.includes(i)))].sort((a, b) => a - b) : null;
  const executionIndexes = requestedIndexes;
  const executionTotal = executionIndexes ? executionIndexes.length : eligibleIndexes.length;
  if (executionIndexes && !executionIndexes.length) return;
  const firstExecutionIndex = executionIndexes ? executionIndexes[0] : eligibleIndexes[0];
  state.selectionMode = false;
  state.selectedStepIndexes = new Set();
  state.run = null; state.isRetrying = false; state.progress = { current: 0, total: executionTotal, fieldName: runRecording.steps[firstExecutionIndex]?.target?.label || 'Starting…' }; state.view = 'running'; render();
  clearInterval(window.fpProgressTimer);
  let autofillProgressPollBusy = false;
  window.fpProgressTimer = setGuardedInterval(async () => {
    if (autofillProgressPollBusy) return;
    autofillProgressPollBusy = true;
    try {
      const d = await sendTab(tab, { type:'GET_RECORDING_STATE' }); const idx = Number.isFinite(d?.currentStepIndex) ? d.currentStepIndex : -1; if (idx >= 0) { const pos = executionIndexes ? executionIndexes.indexOf(idx) : eligibleIndexes.indexOf(idx); if (pos >= 0) { state.progress.current = Math.min(pos + 1, executionTotal); const count=document.getElementById('progress-count'); const bar=document.getElementById('progress-bar'); if(count) count.textContent=`${state.progress.current} of ${executionTotal} fields`; if(bar) bar.style.width=`${executionTotal ? Math.round((state.progress.current/executionTotal)*100) : 0}%`; bar?.parentElement?.setAttribute('aria-valuenow', String(state.progress.current)); const field=document.getElementById('progress-field'); if(field) field.textContent=runRecording.steps[idx]?.target?.label||'Starting…'; } }
    } finally {
      autofillProgressPollBusy = false;
    }
  }, 350);
  const replayOptions = { recording: runRecording, fillOnlyBlank: state.fillEmptyOnly };
  if (executionIndexes) replayOptions.onlyIndexes = executionIndexes;
  const resp = await sendTab(tab, { type: 'REPLAY_RECORDING', ...replayOptions });
  clearInterval(window.fpProgressTimer);
  state.run = resp || { ok: false, executed: [], error: 'Salesforce did not respond.' };
  if (!Array.isArray(state.run.executed)) state.run.executed = [];
  if (state.run.error && state.run.executed.length === 0) {
    showToast(state.run.error, { type: 'error', duration: 3800 });
    state.run = null; state.resultTab = 'all'; state.view = 'detail';
    state.progress.current = 0;
    state.testingAutofillBusy = false;
    render();
    return;
  }
  state.progress.current = state.run.executed.length; state.resultTab = 'all'; state.view = 'result';
  state.testingAutofillBusy = false;
  try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: r.id, run: state.run, resultTab: 'all' } }); } catch {}
  render();
}

async function retryFailed() {
  const r = state.recordings[state.selectedId];
  const failed = (state.run?.executed || []).filter(x => statusOf(x) === 'failed').map(x => x.index);
  if (!r || !failed.length) return;
  const previousRun = state.run;
  const tab = await activeTab();
  if (!tab?.id) {
    if (state.testingAutofillActive) { testingError('Open the Salesforce record where you want to retry Autofill.'); render(); }
    return;
  }
  const ready = await ensureTabConnection(tab);
  if (!ready?.ok) {
    showToast(ready.message || 'Could not connect to Salesforce.', { type: 'error', duration: 3400 });
    if (state.testingAutofillActive) render();
    return;
  }
  state.run = null;
  state.isRetrying = true;
  state.testingAutofillBusy = !!state.testingAutofillActive;
  state.progress = { current: 0, total: failed.length, fieldName: r.steps[failed[0]]?.target?.label || 'Starting…' };
  state.view = 'running';
  render();
  clearInterval(window.fpProgressTimer);
  window.fpProgressTimer = setGuardedInterval(async () => {
    const d = await sendTab(tab, { type: 'GET_RECORDING_STATE' });
    const idx = Number.isFinite(d?.currentStepIndex) ? d.currentStepIndex : -1;
    if (idx < 0) return;
    const pos = failed.indexOf(idx);
    if (pos >= 0) {
      state.progress.current = Math.min(pos + 1, failed.length);
      const count = document.getElementById('progress-count');
      const bar = document.getElementById('progress-bar');
      const field = document.getElementById('progress-field');
        if (count) count.textContent = `${state.progress.current} of ${failed.length} fields`;
        if (bar) bar.style.width = `${Math.round((state.progress.current / failed.length) * 100)}%`;
        bar?.parentElement?.setAttribute('aria-valuenow', String(state.progress.current));
      if (field) field.textContent = r.steps[idx]?.target?.label || 'Starting…';
    }
  }, 350);
  // Reuse values already generated for failed fields so Retry Failed is a retry
  // of the same payload, not a second attempt with different random data.
  const reuseGeneratedValues = {};
  const retryStepKey = step => String(step?.id || step?.meta?.recordedAt || step?.target?.key || `${step?.target?.label || 'Field'}:${step?.sequence || ''}`);
  const collectRetryValue = (step, result) => {
    if (!step || !result) return;
    if (result.randomized && result.generatedValue !== undefined) {
      const strategy = result.generationStrategy || step?.randomization?.strategy || '';
      const cached = { ok: true, value: result.generatedValue, strategy, metaPatch: result.generationMetaPatch || {} };
      if (strategy === 'lookupRandom' && result.generatedValue && typeof result.generatedValue === 'object') {
        cached.lookup = true;
        cached.lookupResolved = !!(result.generatedValue.recordId || result.generatedValue.displayValue);
        cached.selected = result.generatedValue.displayValue || '';
        cached.selectedRecordId = result.generatedValue.recordId || '';
      }
      reuseGeneratedValues[retryStepKey(step)] = cached;
    }
    const childSteps = Array.isArray(step?.meta?.createNewRecord?.fields) ? step.meta.createNewRecord.fields : [];
    const childResults = Array.isArray(result?.workflowResults) ? result.workflowResults : [];
    for (let i = 0; i < childSteps.length; i++) {
      const child = childSteps[i];
      const childResult = childResults.find(item => String(item?.id || '') === String(child?.id || ''))
        || childResults.find(item => String(item?.label || '').toLowerCase() === String(child?.target?.label || '').toLowerCase())
        || childResults[i];
      if (childResult) collectRetryValue(child, childResult);
    }
  };
  const failedSetForReuse = new Set(failed.map(Number));
  for (const item of previousRun?.executed || []) {
    if (failedSetForReuse.has(Number(item.index))) collectRetryValue(item.step, item.result);
  }
  try {
    const resp = await sendTab(tab, { type: 'REPLAY_RECORDING', recording: r, onlyIndexes: failed, fillOnlyBlank: false, reuseGeneratedValues, usedRandomizationValues: previousRun?.usedRandomizationValues || [] });
    clearInterval(window.fpProgressTimer);
    const retryRun = resp || { ok: false, executed: [], error: 'Salesforce did not respond.' };
    const failedIndexes = new Set(failed);
    const replacements = new Map((Array.isArray(retryRun.executed) ? retryRun.executed : []).map(item => [Number(item.index), item]));
    // A retry is a patch to the previous results, not a new full run. Never let
    // the retry response's shortened list (or aggregate ok flag) change fields
    // that were already filled or skipped in the original run.
    const mergedExecuted = (previousRun?.executed || []).map(item => {
      const index=Number(item.index);
      if(!failedIndexes.has(index))return item;
      return replacements.get(index) || item;
    });
    const remainingFailures=mergedExecuted.some(item=>statusOf(item)==='failed');
    state.run = {
      ...previousRun,
      ...retryRun,
      executed: mergedExecuted,
      ok: !remainingFailures,
      error: remainingFailures ? (retryRun.error || '') : ''
    };
  } catch (error) {
    clearInterval(window.fpProgressTimer);
    state.run = { ...previousRun, ok: false, executed: previousRun?.executed || [], error: error?.message || 'Autofill retry could not be completed.' };
  }
  clearInterval(window.fpProgressTimer);
  state.isRetrying = false;
  state.resultTab = 'all';
  state.view = 'result';
  state.testingAutofillBusy = false;
  try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: r.id, run: state.run, resultTab: 'all', testingAutofill: !!state.testingAutofillActive } }); } catch {}
  render();
}

async function overwriteSkipped(index) {
  const r = state.recordings[state.selectedId]; const current = state.run?.executed?.find(x => x.index === index); if (!r || !current || statusOf(current) !== 'skipped') return;
  const tab = await activeTab(); if (!tab?.id) return;
  const ready = await ensureTabConnection(tab); if (!ready?.ok) return showInline(ready.message || 'Could not connect to Salesforce.');
  const valueTarget = document.querySelector(`[data-overwrite-index="${index}"]`);
  if (valueTarget) { valueTarget.disabled = true; valueTarget.classList.add('is-applying'); valueTarget.setAttribute('aria-busy','true'); valueTarget.textContent = 'Using…'; }
  const resp = await sendTab(tab, { type: 'OVERWRITE_STEP', recording: r, index });
  const replacement = Array.isArray(resp?.executed) ? resp.executed.find(x => x.index === index) : null;
  if (replacement) { state.run.executed = state.run.executed.map(x => x.index === index ? replacement : x); state.run.ok = !state.run.executed.some(x => statusOf(x) === 'failed'); }
  try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: r.id, run: state.run, resultTab: state.resultTab } }); } catch {}
  render();
}

async function focusStep(i) { const r = state.recordings[state.selectedId], tab = await activeTab(); if (r && tab?.id && r.steps[i]) await sendTab(tab, { type: 'FOCUS_FIELD', target: r.steps[i].target, frame:r.steps[i].frame }); }
async function focusIndex(i) { const ex = state.run?.executed?.find(x => x.index === i), tab = await activeTab(); if (ex && tab?.id) await sendTab(tab, { type: 'FOCUS_FIELD', target: ex.step.target, frame:ex.frame||ex.step.frame }); }
function showInline(msg, type = 'error') { showToast(msg, { type, duration: type === 'success' ? 2200 : 3400 }); }

document.addEventListener('click', testingDismissOpenMenu);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['forcepilot.recordings.v1']) {
    getRecordings().then(next => {
      state.recordings = next;
      if (state.selectedId && !state.recordings[state.selectedId]) {
        state.selectedId = null; state.run = null; state.view = 'home'; state.editing = false; state.draft = null;
      }
      if (!suppressRecordingStorageRender) render();
    }).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[FIRST_RUN_TOUR_KEY]) return;
  if (changes[FIRST_RUN_TOUR_KEY].newValue === false) {
    showFirstRunTour();
  }
});

watchTheme(dark=>{
  state.darkMode = dark === true;
  applyTheme(state.darkMode);
  const toggle = document.getElementById('toggleDarkMode');
  if (toggle) {
    const label = state.darkMode ? 'Switch to light mode' : 'Switch to dark mode';
    toggle.setAttribute('aria-pressed', String(state.darkMode));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
});
initializeFirstRunTour().finally(() => refresh());

window.addEventListener('keydown', handleEvidenceNameKeydown);
window.addEventListener('paste', handleTestingImagePaste, true);
window.addEventListener('keydown', async event => {
  if (!(event.ctrlKey || event.metaKey) || String(event.key || '').toLowerCase() !== 'v') return;
  if (!state.testingSession || state.view !== 'testing-workspace') return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  if (typeof navigator.clipboard?.read !== 'function') return;
  event.preventDefault();
  await pasteTestingScreenshot(state.testingActiveCaseId || state.testingSession.currentEvidenceTestCaseId || null);
}, true);
