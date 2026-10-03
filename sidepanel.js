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
  parseTestCasePaste, createTestingSession, createEvidenceOnlyTestingSession, loadTestingSession, saveTestingSession,
  clearTestingSession, putEvidenceBlob, getEvidenceBlob, deleteEvidenceBlob
} from './src/testing.js';
import { buildTestingDocx, downloadTestingDocx, getTestingDocxFilename } from './src/docx-export.js';
import { buildTestingEvidenceZip, downloadTestingZip, getTestingZipFilename } from './src/testing-zip-export.js';
import { showToast } from './src/toast.js';

const app = document.getElementById('app');
const FIRST_RUN_TOUR_KEY = 'forcepilot.firstRunTour.seen.v1';

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
      if(message?.type==='FORCEPILOT_CLOSE') closeForcePilotPanelFromCommand();
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
});

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
  view: 'home',
  editing: false,
  draft: null,
  progress: { current: 0, total: 0 },
  refreshing: false,
  addingToRecordingId: null,
  pendingRecording: null,
  pendingRecordingTabId: null,
  saveNameError: '',
  inlineMessage: '',
  isRetrying: false,
  selectionMode: false,
  selectedStepIndexes: new Set(),
  testingSession: null,
  testingLifecycleDialog: false,
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
  firstRunOpen: false,
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
  if (['double','int','integer','long','decimal','number'].includes(r) || r.includes('number') || s?.target?.kind === 'number') return 'Number';
  if (r === 'reference' || r === 'lookup' || s?.target?.reference || s?.target?.kind === 'lookup') return 'Lookup';
  return 'Text';
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
      <p class="first-run-intro" id="firstRunMessage">A simple way to test Salesforce and keep your work organized.</p>
      <div class="first-run-items">
        <div class="first-run-item"><strong>Testing Sessions</strong><span>Run a test case step by step, or start a session without one for quick testing.</span></div>
        <div class="first-run-item"><strong>Record &amp; Review</strong><span>Record what you do and see the fields and changes captured along the way.</span></div>
        <div class="first-run-item"><strong>Save &amp; Autofill</strong><span>Save recordings and use them later to autofill the same fields.</span></div>
      </div>
      <div class="first-run-shortcut"><span>Open/Close ForcePilot</span><strong>Shortcut: Alt + X</strong></div>
      <p class="first-run-replay-note">You can find this tour again in Settings.</p>
      <button class="primary first-run-start" id="firstRunGetStarted" type="button">Get Started</button>
    </div>
  </div>`;
}

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

function render() {
  const recs = Object.values(state.recordings)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter(r => `${recordingTitle(r)} ${r.name || ''} ${r.context?.objectApiName || ''}`.toLowerCase().includes(state.filter.toLowerCase()));
  const selected = state.selectedId ? state.recordings[state.selectedId] : null;
  const testingAutofillModalActive = !!state.testingSession && !!state.testingAutofillActive && (state.view === 'running' || state.view === 'result');
  const scrollTargets = [
    '.testing-workspace-page',
    '.testing-preview-workspace',
    '.testing-evidence-only-page .testing-general-evidence-body',
    '.testing-summary-body',
    '.result-page .result-list'
  ];
  const preservedScroll = Object.fromEntries(scrollTargets.map(selector => {
    const el = document.querySelector(selector);
    return [selector, el ? el.scrollTop : null];
  }));
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
  app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><img class="brandmark" src="branding/forcepilot-icon.png" alt="ForcePilot"><img class="wordmark" src="branding/forcepilot-wordmark.png" alt="ForcePilot"></div><div class="header-actions"><button class="iconbtn refresh-btn${state.refreshing ? ' is-loading' : ''}" id="refreshHeader" title="Refresh ForcePilot" aria-label="Refresh ForcePilot" ${state.refreshing ? 'disabled aria-busy="true"' : ''}>${icon('refresh')}</button><button class="iconbtn settings-btn" id="settings" title="Settings" aria-label="Settings">${icon('settings')}</button></div></header><main class="content">${body}</main>${state.testingEvidenceNameDialog ? renderEvidenceNameDialog() : ''}${state.testingConfirmDialog ? renderTestingConfirmDialog() : ''}</div>${state.firstRunOpen ? renderFirstRunOverlay() : ''}`;
  document.body.classList.toggle('testing-modal-open', testingAutofillModalActive || state.testingAutofillPickerOpen || !!state.testingAssociatingEvidenceId || !!state.testingEvidenceNameDialog || !!state.testingConfirmDialog || !!state.testingLifecycleDialog || state.firstRunOpen);
  bind();
  const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (modal && (state.firstRunOpen || state.testingLifecycleDialog || state.testingConfirmDialog || state.testingAutofillPickerOpen || state.testingAssociatingEvidenceId || state.testingEvidenceNameDialog)) {
    requestAnimationFrame(() => {
      if (state.firstRunOpen) document.getElementById('firstRunGetStarted')?.focus();
      else if (state.testingEvidenceNameDialog) document.getElementById('testingEvidenceName')?.focus();
      else if (state.testingConfirmDialog) document.getElementById('acceptTestingConfirm')?.focus();
      else if (state.testingLifecycleDialog) document.getElementById('resumeSavedTesting')?.focus();
      else if (state.testingAutofillPickerOpen) document.getElementById('testingAutofillSearch')?.focus();
      else document.getElementById('closeAssociateDialog')?.focus();
    });
  }
  document.onkeydown = event => {
    const activeModal = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!activeModal) return;
    if (event.key === 'Escape') {
      const close = activeModal.querySelector('#firstRunGetStarted, #cancelTestingEvidenceName, #cancelTestingEvidenceNameAction, #cancelTestingConfirm, #cancelStartTesting, #closeAssociateDialog, #closeTestingAutofill, .testing-image-preview-close');
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
      if (el && Number.isFinite(saved)) el.scrollTop = saved;
    });
    if (String(state.view || '').startsWith('testing-')) autoResizeTestingTextareas();
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
  const activeSession = state.testingSession;
  const activeSessionName = activeSession?.workProduct || 'Screenshot session';
  const activeSessionMeta = `${activeSession?.evidence?.length || 0} capture${(activeSession?.evidence?.length || 0) === 1 ? '' : 's'}`;
  return `<section class="home-page-context">
    <div class="eyebrow">Current page</div>
    <div class="context-title">${escapeHtml(currentObject)}</div>
    ${sfStatus}
  </section>
  ${other ? '<div class="notice"><strong>Recording is active in another tab.</strong><span>Use that tab to stop the recording.</span></div>' : ''}
  <div class="home-actions actions home-actions-stack">
    <button class="primary full-action" id="record" ${(!c || !state.forcePilotConnected || other) ? 'disabled' : ''}><span class="button-icon" aria-hidden="true">${icon('play')}</span>Record</button>
    ${activeSession ? `<div class="testing-session-active" role="status"><div class="testing-session-active-copy"><div class="eyebrow">Testing session in progress</div><strong>${escapeHtml(activeSessionName)} · ${escapeHtml(activeSessionMeta)}</strong></div><button class="secondary" id="resumeTesting" type="button"><span class="button-icon" aria-hidden="true">${icon('checklist')}</span>Resume</button></div>` : ''}
    <button class="secondary full-action testing-home-action" id="startTesting"><span class="button-icon" aria-hidden="true">${icon('checklist')}</span><span>${activeSession ? 'Start New Testing Session' : 'Start Testing'}</span></button>
  </div>
  <section class="section recent-section">
    <div class="section-title-row"><div class="section-title-with-icon"><span class="section-title-icon" aria-hidden="true">${icon('folder')}</span><h2>Saved recordings</h2></div><span class="section-count">${recs.length}</span></div>
    ${hasRecordings ? `<input class="search" id="search" placeholder="Search recordings…" value="${escapeHtml(state.filter)}" aria-label="Search recordings"><div class="list">${hasMatches ? recs.slice(0,12).map(r => `<button class="recording-row" data-id="${escapeHtml(r.id)}"><span class="row-main"><span class="recording-name">${escapeHtml(recordingTitle(r))}</span><span class="row-meta">${escapeHtml(recordingMeta(r))}</span></span><span class="row-chevron" aria-hidden="true">${icon('arrowRight')}</span></button>`).join('') : `<div class="empty-state"><strong>No recordings match</strong><span>Try a different search term.</span></div>`}</div>` : `<div class="empty-state"><strong>No saved recordings</strong><span>Record Salesforce field changes to create your first recording.</span></div>`}
  </section>${state.testingLifecycleDialog ? renderTestingLifecycleDialog() : ''}`;
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
  const mode = state.testingEvidenceNameDialog?.mode === 'finish' ? 'finish' : 'start';
  const isFinish = mode === 'finish';
  const title = isFinish ? 'Name evidence session' : 'Name evidence session';
  const message = 'Use a file name for the Word document and screenshots ZIP.';
  const value = state.testingEvidenceNameInput || '';
  const error = state.testingEvidenceNameError ? `<div class="testing-name-error" id="testingEvidenceNameError" role="alert">${escapeHtml(state.testingEvidenceNameError)}</div>` : '';
  return `<div class="testing-dialog-backdrop testing-name-dialog-backdrop" role="presentation">
    <div class="testing-dialog testing-name-dialog" role="dialog" aria-modal="true" aria-labelledby="testingEvidenceNameTitle" aria-describedby="testingEvidenceNameDescription">
      <div class="testing-dialog-header">
        <div><h2 id="testingEvidenceNameTitle">${title}</h2><p id="testingEvidenceNameDescription">${message}</p></div>
        <button class="iconbtn" id="cancelTestingEvidenceName" type="button" aria-label="Cancel">${icon('close')}</button>
      </div>
      <div class="testing-name-dialog-body">
        <label class="testing-name-field" for="testingEvidenceName"><span>File name</span><input id="testingEvidenceName" type="text" value="${escapeHtml(value)}" maxlength="160" autocomplete="off" placeholder="US#" aria-describedby="testingEvidenceNameHelp${state.testingEvidenceNameError ? ' testingEvidenceNameError' : ''}" ${state.testingEvidenceNameError ? 'aria-invalid="true"' : ''}></label>
        <div class="testing-name-help" id="testingEvidenceNameHelp">Used as the base export name.</div>
        ${error}
      </div>
      <div class="testing-name-actions">
        <button class="secondary action-button" id="cancelTestingEvidenceNameAction" type="button">Cancel</button>
        <button class="primary action-button" id="confirmTestingEvidenceName" type="button">${isFinish ? 'Save & finish' : 'Start session'}</button>
      </div>
    </div>
  </div>`;
}

function openEvidenceNameDialog(mode, initialValue = '') {
  state.testingEvidenceNameDialog = { mode: mode === 'finish' ? 'finish' : 'start' };
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
  if (mode === 'start') {
    state.view = 'testing-paste';
    render();
  } else {
    render();
  }
}

async function confirmEvidenceNameDialog() {
  const mode = state.testingEvidenceNameDialog?.mode === 'finish' ? 'finish' : 'start';
  const name = String(state.testingEvidenceNameInput || '').trim();
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
  } else {
    if (!state.testingSession) { state.view = 'home'; render(); return; }
    state.testingSession.workProduct = name;
    await persistTestingSession();
    await completeTestingSession();
  }
}

function handleEvidenceNameKeydown(event) {
  if (!state.testingEvidenceNameDialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeEvidenceNameDialog(); return; }
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); confirmEvidenceNameDialog(); }
}

function renderTestingLifecycleDialog() {
  const session = state.testingSession;
  const name = session?.workProduct || 'Screenshot session';
  return `<div class="testing-dialog-backdrop" role="presentation"><div class="testing-dialog testing-lifecycle-dialog" role="dialog" aria-modal="true" aria-labelledby="testingLifecycleTitle"><div class="testing-dialog-header"><div><h2 id="testingLifecycleTitle">Testing session in progress</h2><p>${escapeHtml(name)} · ${session?.testCases?.length || 0} test cases · ${session?.evidence?.length || 0} captures</p></div><button class="iconbtn" id="cancelStartTesting" type="button" aria-label="Cancel">${icon('close')}</button></div><div class="testing-dialog-list"><p>Resume the saved session or start a new one.</p><div class="testing-lifecycle-actions"><button class="secondary action-button" id="resumeSavedTesting" type="button">Resume Testing</button><button class="danger action-button" id="discardAndStartTesting" type="button">Start fresh</button><button class="secondary action-button" id="cancelStartTestingAction" type="button">Cancel</button></div></div></div></div>`;
}


const testingObjectUrls = new Map();

function testingStepById(session, stepId) {
  for (const tc of session?.testCases || []) {
    const step = (tc.steps || []).find(item => item.id === stepId);
    if (step) return { testCase: tc, step };
  }
  return null;
}

function testingStepEvidence(session, stepId) {
  return (session?.evidence || []).filter(item => item.stepId === stepId);
}

function testingUnassociatedEvidence(session) {
  return (session?.evidence || []).filter(item => !item.stepId);
}

function testingStepLabel(session, stepId) {
  if (!stepId) return 'Unassociated';
  const hit = testingStepById(session, stepId);
  return hit ? `${hit.testCase.title} · Step ${hit.step.index}` : 'Unassociated';
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
  await saveTestingSession(state.testingSession);
}

function testingToast(message, kind = 'success') { showToast(message, { type: kind }); }
function testingError(message) { showToast(message || 'Something went wrong.', { type: 'error', duration: 3400 }); }

function renderTesting() {
  if (state.view === 'testing-paste') return renderTestingPaste();
  if (state.view === 'testing-preview') return renderTestingPreview();
  if (state.view === 'testing-summary') return renderTestingSummary();
  return renderTestingWorkspace();
}

function isEvidenceOnlyTesting(session = state.testingSession) {
  return String(session?.mode || '').toLowerCase() === 'evidence-only' || (!session?.testCases?.length && session?.mode !== 'test-cases');
}

function renderTestingHeader(title, subtitle = '', backId = 'testingBack', actionHtml = '') {
  return `<div class="testing-topbar fp-route-header">
    <div class="testing-heading-wrap">
      ${backButton('Back', backId)}
      <div class="testing-heading"><div class="eyebrow">Testing</div><h1>${escapeHtml(title)}</h1>${subtitle ? `<div class="testing-subtitle">${escapeHtml(subtitle)}</div>` : ''}</div>
    </div>
    ${actionHtml ? `<div class="testing-header-actions">${actionHtml}</div>` : ''}
  </div>`;
}

function renderTestingPaste() {
  const error = state.testingPasteError ? `<div class="testing-message error" role="alert">${escapeHtml(state.testingPasteError)}</div>` : '';
  const hasPaste = Boolean(String(state.testingPasteText || '').trim());
  return `<section class="testing-page testing-start-page">
    ${renderTestingHeader('Start Testing', 'Choose how you want to test.')}
    ${error}
    <section class="testing-card testing-paste-card">
      <div class="testing-paste-header">
        <div class="testing-paste-heading">
          <div class="testing-paste-title-row"><h2>Use test cases</h2><button class="secondary testing-template-download" id="downloadTestingTemplate" type="button">${icon('fileDownload')}<span>Download template</span></button></div>
          <p>Paste your test-case table below.</p>
        </div>
      </div>
      <div class="testing-paste-field">
        <textarea id="testingPaste" class="testing-paste" spellcheck="false" placeholder="Paste test cases…">${escapeHtml(state.testingPasteText)}</textarea>
        <div class="testing-format-note"><span>Expected format:</span> Work Product · Object Type · Test Case · Step Index · Steps</div>
        <div class="testing-paste-help">Repeated blank cells use the previous test-case context.</div>
      </div>
      <div class="testing-actions"><button class="primary action-button" id="parseTestingPaste" type="button" ${hasPaste ? '' : 'disabled'}>Continue</button></div>
    </section>
    <div class="testing-skip-divider"><span>or</span></div>
    <section class="testing-start-choice">
      <button class="secondary testing-skip-button" id="skipTestingCases" type="button">${icon('camera')}<span>Start without test cases</span></button>
      <div class="testing-skip-note">Capture screenshots and use Autofill without preparing test steps.</div>
    </section>
  </section>`;
}

function renderTestingPreview() {
  const session = state.testingSession;
  const testCases = session?.testCases || [];
  const totalSteps = testCases.reduce((sum, tc) => sum + (tc.steps?.length || 0), 0);
  const error = state.testingPasteError ? `<div class="testing-message error" role="alert">${escapeHtml(state.testingPasteError)}</div>` : '';
  return `<section class="testing-page testing-preview-page">
    <div class="testing-preview-header">
      ${renderTestingHeader('Review test cases', `${session?.workProduct || ''} · ${testCases.length} test case${testCases.length === 1 ? '' : 's'}`, 'backToTestingPaste')}
      <button class="primary testing-start-button" data-start-testing type="button">${icon('play')}<span>Start testing</span></button>
    </div>
    <div class="testing-preview-workspace">
      ${error}
      <section class="testing-editor-summary-card">
        <div class="testing-editor-summary-top">
          <div><h2>Test case details</h2><span class="testing-row-count">${testCases.length} case${testCases.length === 1 ? '' : 's'} · ${totalSteps} step${totalSteps === 1 ? '' : 's'}</span></div>
        </div>
        <div class="testing-editor-meta">
          <label class="testing-editor-meta-field"><span>Work Product</span><input data-testing-field="workProduct" data-tc-id="${escapeHtml(testCases[0]?.id || '')}" value="${escapeHtml(session?.workProduct || '')}" aria-label="Work Product"></label>
        </div>
        <div class="testing-editor-controls">
          <span class="testing-editor-controls-label">Review</span>
          <button class="testing-text-button" type="button" data-testing-expand-all>${icon('chevron')}<span>Expand all</span></button>
          <button class="testing-text-button" type="button" data-testing-collapse-all>${icon('chevron')}<span>Collapse all</span></button>
        </div>
      </section>
      <section class="testing-editor-cases">
        ${testCases.map((tc, tcIndex) => {
          const steps = tc.steps || [];
          const collapsed = state.testingCollapsedCases.has(tc.id);
          return `<article class="testing-editor-case ${collapsed ? 'is-collapsed' : ''}" data-testing-case-id="${escapeHtml(tc.id)}">
            <div class="testing-editor-case-header">
              <button class="testing-editor-case-toggle" type="button" data-toggle-testing-case="${escapeHtml(tc.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(tc.title)}">
                <span class="testing-editor-case-number">TC_${tcIndex + 1}</span>
                <span class="testing-editor-case-label">Test Case</span>
                ${icon('chevron')}
              </button>
              <span class="testing-editor-case-meta">${steps.length} step${steps.length === 1 ? '' : 's'}</span>
            </div>
            ${collapsed ? '' : `<div class="testing-editor-case-body">
              <label class="testing-editor-title testing-editor-title-compact"><span>Test Case</span><input data-testing-field="title" data-tc-id="${escapeHtml(tc.id)}" value="${escapeHtml(tc.title)}" aria-label="Test Case ${tcIndex + 1} title"></label>
              <div class="testing-editor-steps">
                ${steps.map((step, stepIndex) => `<div class="testing-editor-step" data-testing-step-id="${escapeHtml(step.id)}">
                  <span class="testing-editor-step-number">${stepIndex + 1}</span>
                  <label class="testing-editor-step-field"><span>Step ${stepIndex + 1}</span><textarea data-testing-field="stepText" data-tc-id="${escapeHtml(tc.id)}" data-step-id="${escapeHtml(step.id)}" rows="1" aria-label="Step ${stepIndex + 1}">${escapeHtml(step.text)}</textarea></label>
                </div>`).join('')}
                <button class="testing-add-step" type="button" data-add-step-to-case="${escapeHtml(tc.id)}">${icon('add')}<span>Add step</span></button>
              </div>
            </div>`}
          </article>`;
        }).join('')}
      </section>
      <button class="testing-add-test-case" type="button" data-add-test-case>${icon('add')}<span>Add test case</span></button>
      <section class="testing-editor-note">${icon('edit')}<span>Changes save automatically. Step numbers stay in order.</span></section>
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
  return `<article class="testing-evidence-card" data-evidence-id="${escapeHtml(evidence.id)}">
    <button class="testing-evidence-preview" type="button" data-preview-evidence="${escapeHtml(evidence.id)}" aria-label="Preview captured evidence"><img src="${url || ''}" alt="Captured Salesforce evidence"></button>
    <div class="testing-evidence-meta" title="Captured ${escapeHtml(capturedFull)}">
      <span class="testing-evidence-time">${escapeHtml(capturedTime)}</span>
      <div class="testing-evidence-actions">
        <button type="button" class="testing-evidence-icon-action" data-copy-evidence="${escapeHtml(evidence.id)}" title="Copy screenshot" aria-label="Copy screenshot">${icon('contentCopy')}</button>
        ${isEvidenceOnlyTesting(session) ? '' : `<button type="button" class="testing-evidence-icon-action" data-associate-evidence="${escapeHtml(evidence.id)}" title="Associate with a step" aria-label="Associate screenshot with a step">${icon('link')}</button>`}
        <button type="button" class="testing-evidence-icon-action danger" data-remove-evidence="${escapeHtml(evidence.id)}" title="Remove screenshot" aria-label="Remove screenshot">${icon('delete')}</button>
      </div>
    </div>
  </article>`;
}

function renderTestingStep(session, tc, step) {
  const evidence = testingStepEvidence(session, step.id);
  const current = session.currentEvidenceStepId === step.id;
  const expanded = state.testingExpandedEvidence.has(step.id);
  return `<div class="testing-step ${current ? 'is-current' : ''}">
    <div class="testing-step-row">
      <span class="testing-step-index">${escapeHtml(step.index)}</span>
      <div class="testing-step-body"><div class="testing-step-text">${escapeHtml(step.text)}</div><div class="testing-step-hint">${current ? 'New general captures attach here.' : evidence.length ? `${evidence.length} evidence capture${evidence.length === 1 ? '' : 's'}` : 'No evidence yet'}</div></div>
      ${evidence.length ? `<button class="testing-evidence-toggle" type="button" data-toggle-step-evidence="${escapeHtml(step.id)}" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? 'Hide evidence' : 'Show evidence'}" aria-label="${expanded ? 'Hide evidence' : 'Show evidence'} for Step ${escapeHtml(step.index)}">${icon('chevron')}</button>` : '<span class="testing-evidence-toggle-placeholder" aria-hidden="true"></span>'}
      <button class="testing-step-camera" type="button" data-capture-step="${escapeHtml(step.id)}" title="Capture screenshot for this step" aria-label="Capture screenshot for Step ${escapeHtml(step.index)}">${icon('camera')}</button>
    </div>
    ${evidence.length && expanded ? `<div class="testing-evidence-grid">${evidence.map(item => renderTestingEvidenceCard(item, session)).join('')}</div>` : ''}
  </div>`;
}

function renderAssociateDialog(session, evidenceId) {
  if (!evidenceId) return '';
  return `<div class="testing-dialog-backdrop" id="testingAssociateDialog" role="presentation">
    <div class="testing-dialog" role="dialog" aria-modal="true" aria-labelledby="testingAssociateTitle">
      <div class="testing-dialog-header"><div><h2 id="testingAssociateTitle">Associate evidence</h2><p>Choose the test step this screenshot belongs to.</p></div><button class="iconbtn" id="closeAssociateDialog" type="button" aria-label="Close">${icon('close')}</button></div>
      <div class="testing-dialog-list">
        ${(session?.testCases || []).map(tc => `<div class="testing-dialog-group"><div class="testing-dialog-group-title">${escapeHtml(tc.title)}</div>${(tc.steps || []).map(step => `<button type="button" class="testing-dialog-step" data-associate-step="${escapeHtml(step.id)}" data-associate-evidence="${escapeHtml(evidenceId)}"><span>${escapeHtml(step.index)}</span><span>${escapeHtml(step.text)}</span></button>`).join('')}</div>`).join('')}
        ${!session?.testCases?.length ? '<div class="empty-state">No steps available.</div>' : ''}
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
  const unassociated = testingUnassociatedEvidence(session);
  const recordingOptions = Object.values(state.recordings).sort((a, b) => recordingTitle(a).localeCompare(recordingTitle(b)));
  const unassocExpanded = state.testingGeneralEvidenceExpanded;
  const headerTitle = evidenceOnly ? 'Screenshot session' : (session?.workProduct || 'Testing');
  const headerSubtitle = evidenceOnly ? `${session?.evidence?.length || 0} capture${(session?.evidence?.length || 0) === 1 ? '' : 's'}` : `${session?.testCases?.length || 0} test case${(session?.testCases?.length || 0) === 1 ? '' : 's'}`;
  const headerActions = evidenceOnly
    ? ''
    : `<button class="testing-header-action" id="editTestingCases" type="button">${icon('edit')}<span>Edit cases</span></button>`;
  return `<section class="testing-page testing-workspace-page${evidenceOnly ? ' testing-evidence-only-page' : ''}">
    ${renderTestingHeader(headerTitle, headerSubtitle, 'testingBack', headerActions)}
    <section class="testing-sticky-actions ${evidenceOnly ? 'testing-sticky-actions-evidence-only' : ''}">
      <div class="testing-action-bar">
        <button class="primary testing-capture-button" id="captureTestingScreenshot" type="button" ${state.testingCaptureBusy ? 'disabled aria-busy="true"' : ''}>${icon('camera')}<span>${state.testingCaptureBusy ? 'Capturing…' : 'Screenshot'}</span></button>
        <button class="secondary testing-toolbar-button testing-autofill-launch" id="testingAutofillOpen" type="button" ${state.testingAutofillBusy ? 'disabled aria-busy="true"' : ''}>${icon('bolt')}<span>${state.testingAutofillBusy ? 'Autofilling…' : 'Autofill'}</span></button>
      </div>
      </section>
    ${evidenceOnly ? '' : `<section class="testing-cases-card">
      <div class="testing-workspace-case-tools"><span>${session?.testCases?.length || 0} test cases</span><div><button class="testing-text-button" type="button" data-testing-expand-all>${icon('chevron')}<span>Expand all</span></button><button class="testing-text-button" type="button" data-testing-collapse-all>${icon('chevron')}<span>Collapse all</span></button></div></div>
      ${(session?.testCases || []).map((tc, tcIndex) => {
        const collapsed = state.testingCollapsedCases.has(tc.id);
        return `<section class="testing-case ${collapsed ? 'is-collapsed' : ''}" data-testing-case-id="${escapeHtml(tc.id)}">
          <button class="testing-case-collapse" type="button" data-toggle-testing-case="${escapeHtml(tc.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(tc.title)}">
            <span class="testing-case-collapse-icon">${icon('chevron')}</span>
            <span class="testing-case-heading"><span class="testing-case-kicker">TC_${tcIndex + 1}</span><strong>${escapeHtml(tc.title)}</strong></span>
            <span class="testing-case-count">${tc.steps.length} step${tc.steps.length === 1 ? '' : 's'}</span>
          </button>
          ${collapsed ? '' : `<div class="testing-steps">${(tc.steps || []).map(step => renderTestingStep(session, tc, step)).join('')}</div>`}
        </section>`;
      }).join('') || '<div class="empty-state">No test cases are available.</div>'}
    </section>`}
    <section class="testing-general-evidence ${unassocExpanded ? 'is-expanded' : ''}${evidenceOnly ? ' testing-general-evidence-evidence-only' : ''}">
      <div class="testing-general-evidence-header">
        <button class="testing-general-evidence-toggle testing-general-evidence-title" type="button" data-toggle-general-evidence aria-expanded="${unassocExpanded ? 'true' : 'false'}">
          <strong>${evidenceOnly ? 'Evidence' : 'Unassociated evidence'}</strong><small>${unassociated.length ? `${unassociated.length} capture${unassociated.length === 1 ? '' : 's'}` : 'No captures'}</small>
        </button>
        <button class="testing-paste-screenshot" id="testingPasteScreenshot" type="button" title="Paste an image from the clipboard" aria-label="Paste screenshot"><span>Paste Screenshot</span></button>
        <button class="testing-general-evidence-toggle testing-general-evidence-icon-toggle" type="button" data-toggle-general-evidence aria-expanded="${unassocExpanded ? 'true' : 'false'}" title="${unassocExpanded ? 'Collapse evidence' : 'Expand evidence'}" aria-label="${unassocExpanded ? 'Collapse evidence' : 'Expand evidence'}">
          <span class="testing-section-toggle-icon">${icon('chevron')}</span>
        </button>
      </div>
      ${unassocExpanded ? `<div class="testing-general-evidence-body">${unassociated.length ? `<div class="testing-evidence-grid">${unassociated.map(item => renderTestingEvidenceCard(item, session)).join('')}</div>` : `<div class="testing-empty-evidence">${evidenceOnly ? 'Captured screenshots will appear here.' : 'Captures taken before selecting a step can be linked later.'}</div>`}</div>` : ''}
    </section>
    <button class="primary testing-finish" data-finish-testing type="button">Finish Testing</button>
    ${evidenceOnly ? '' : renderAssociateDialog(session, state.testingAssociatingEvidenceId)}
    ${state.testingAutofillPickerOpen ? renderTestingAutofillPicker(recordingOptions) : ''}
  </section>`;
}

function renderTestingSummary() {
  const session = state.testingSession;
  const evidenceOnly = isEvidenceOnlyTesting(session);
  const countEvidence = session?.evidence?.length || 0;
  const countSteps = (session?.testCases || []).reduce((sum, tc) => sum + (tc.steps?.length || 0), 0);
  const stats = evidenceOnly
    ? `<div><strong>${countEvidence}</strong><span>Captures</span></div>`
    : `<div><strong>${session?.testCases?.length || 0}</strong><span>Test cases</span></div><div><strong>${countSteps}</strong><span>Steps</span></div><div><strong>${countEvidence}</strong><span>Evidence</span></div>`;
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
  const wordLabel = state.testingExportBusy ? 'Exporting…' : state.testingExportCompleted ? 'Download Word again' : 'Export Word Document';
  const zipLabel = state.testingZipBusy ? 'Exporting…' : state.testingZipCompleted ? 'Download Screenshots ZIP again' : 'Export Screenshots ZIP';
  return `<section class="testing-page testing-summary-page">
    ${renderTestingHeader('Testing complete', evidenceOnly ? 'Evidence session finished' : (session?.workProduct || ''))}
    <div class="testing-summary-body">
    <section class="testing-summary-card">
      <div class="testing-summary-icon">${icon('check')}</div>
      <h2>Testing complete</h2>
      <p>Your evidence is ready to export.</p>
      <div class="testing-summary-stats${evidenceOnly ? ' is-single' : ''}">${stats}</div>
      ${evidenceOnly ? `<div class="testing-export-name"><span>File name</span><strong>${escapeHtml(session?.workProduct || '—')}</strong></div>` : ''}
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
function renderLiveRecordingRows(steps) {
  return (steps || []).map((s, i) => `<div class="field-row recording-live-row"><span class="step-number">${i + 1}</span><span class="field-main"><span class="field-name">${escapeHtml(s.target.label)}</span><span class="field-detail"><span class="field-value">${escapeHtml(fmtStepValue(s))}</span><span class="field-type">${escapeHtml(fieldTypeLabel(s))}</span></span></span><button class="live-remove-field" type="button" data-remove-live-step="${i}" title="Remove field from recording" aria-label="Remove ${escapeHtml(s.target.label)} from recording"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l1 2h3v2H3V5h3l1-2Zm-2 5h10l-.7 9H5.7L5 8Zm3 2v5h1v-5H8Zm3 0v5h1v-5h-1Z"/></svg></button></div>`).join('') || '<div class="empty-state"><strong>Nothing recorded yet</strong></div>';
}

function renderRecording() {
  const adding = !!state.addingToRecordingId;
  const title = adding ? recordingTitle(state.recordings[state.addingToRecordingId]) : 'New recording';
  const hasSteps = state.activeSteps.length > 0;
  return `<section class="recording-top sticky-action ${adding ? 'recording-top-append' : ''}">
    <div class="recording-state"><span class="recording-dot" aria-hidden="true"></span><div><strong>${adding ? 'Adding field' : 'Recording'}</strong><span id="recording-object">${escapeHtml(adding ? title : (state.context?.objectLabel || state.context?.objectApiName || 'Salesforce'))}</span></div></div>
    <div class="recording-actions"><button class="pause-button${state.recordingPaused ? ' is-paused' : ''}" id="pauseRecording" type="button"><span class="pause-glyph" aria-hidden="true">${icon(state.recordingPaused ? 'play' : 'pause')}</span><span>${state.recordingPaused ? 'Resume' : 'Pause'}</span></button><button class="stop-button button-with-icon" id="stop" type="button">${icon('stop')}<span>${adding ? 'Done adding' : 'Stop recording'}</span></button></div>
  </section>
  <div class="recording-note ${hasSteps ? 'is-hidden' : ''}" id="recording-note">${adding ? 'Edit Salesforce fields to add them to this recording.' : 'Edit Salesforce fields to record their values.'}</div>
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
  const needs=(draftObj?.steps||[]).filter(s=>['Picklist','Multipicklist'].includes(fieldTypeLabel(s)) && (!typeOptions(s).length));
  if(!needs.length)return;
  const resp=await chrome.runtime.sendMessage({type:'GET_FIELD_DESCRIPTORS',targets:needs.map(s=>s.target)}).catch(()=>null); if(!resp?.ok)return;
  const byKey=new Map((resp.descriptors||[]).map(d=>[d.targetKey,d]));
  for(const s of draftObj.steps||[]){const d=byKey.get(s.target?.key)||byKey.get(`api:${s.target?.apiName}`);if(!d)continue;s.target={...s.target,kind:d.kind||s.target.kind,fieldType:d.fieldType||s.target.fieldType,sfDataType:d.sfDataType||s.target.sfDataType,salesforceType:d.salesforceType||s.target.salesforceType,options:d.options?.length?d.options:s.target.options};}
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
      return `<label><input type="checkbox" data-multi-index="${i}" data-multi-value="${escapeHtml(o.value)}" ${on ? 'checked' : ''}><span>${escapeHtml(o.displayValue || o.value)}</span></label>`;
    }).join('')}</div>`;
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
  return `<input class="edit-control" type="text" data-edit-value="${i}" value="${escapeHtml(Array.isArray(v) ? v.join('; ') : v && typeof v === 'object' && 'displayValue' in v ? v.displayValue : String(v ?? ''))}" placeholder="Recorded value">`;
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
        <span class="field-main"><span class="field-name">${escapeHtml(s?.target?.label || 'Unnamed field')}</span><span class="field-detail"><span class="field-value">${escapeHtml(fmtStepValue(s))}</span><span class="field-type">${escapeHtml(fieldTypeLabel(s))}</span></span></span>
      </label>`;
    }
    return `<div class="field-row ${state.editing ? 'editing' : 'clickable'}" ${state.editing ? '' : `data-focus-step="${i}"`}>
      <span class="step-number">${i + 1}</span><span class="field-main"><span class="field-name">${escapeHtml(s?.target?.label || 'Unnamed field')}</span>${state.editing ? `<span class="edit-wrap">${renderEditField(s, i)}<button class="delete-step iconbtn" data-delete-step="${i}" title="Remove field" aria-label="Remove field" type="button">${icon('delete')}</button></span>` : `<span class="field-detail"><span class="field-value">${escapeHtml(fmtStepValue(s))}</span><span class="field-type">${escapeHtml(fieldTypeLabel(s))}</span></span>`}</span>${state.editing ? '' : `<span class="row-chevron" aria-hidden="true">${icon('arrowRight')}</span>`}
    </div>`;
  }).join('');
  const selectionFooter = state.selectionMode
    ? `<div class="run-selected-footer"><span>${selectedCount} field${selectedCount === 1 ? '' : 's'} selected</span><button class="primary run-selected-autofill" id="autofillSelected" type="button" ${selectedCount ? '' : 'disabled'}>${icon('bolt')}<span>Autofill${selectedCount ? ` ${selectedCount} field${selectedCount === 1 ? '' : 's'}` : ''}</span></button></div>`
    : '';
  return `<section class="detail-page">
  <div class="testing-topbar fp-route-header"><div class="testing-heading-wrap">${backButton('Back', 'backHome')}<div class="testing-heading"><div class="eyebrow">Recording</div><h1>${escapeHtml(recordingTitle(x))}</h1><div class="testing-subtitle">${escapeHtml(recordingMeta(x))} <span aria-hidden="true">•</span> ${escapeHtml(objectLabel(x?.context || {}))}</div></div></div></div>
  ${state.editing ? `<label class="recording-name-editor"><span>Recording name</span><input class="edit-control" id="recordingName" value="${escapeHtml(x.name||recordingTitle(x))}" placeholder="Recording name"></label>` : ''}
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
    const recordedValue = escapeHtml(fmtStepValue(x.step));
    const valueMarkup = st === 'skipped'
      ? `<span class="result-value-wrap"><span class="result-row-value">${recordedValue}</span><button class="result-use" data-overwrite-index="${x.index}" type="button" aria-label="Use recorded value">Use</button></span>`
      : `<span class="result-row-value">${recordedValue}</span>`;
    const type=fieldTypeLabel(x.step);
    const visibleReason=(st==='failed'||st==='skipped')?finalReason:'';
    const detailReason=visibleReason?`<span class="result-row-reason" title="${escapeHtml(visibleReason)}">${escapeHtml(visibleReason)}</span>`:'';
    return `<div class="result-row ${st}" role="listitem" data-focus-index="${x.index}" tabindex="0" aria-label="${escapeHtml(`${x?.step?.target?.label || 'Field'}, ${statusLabel}${visibleReason?`. ${visibleReason}`:''}. Select to locate this field in Salesforce.`)}"><span class="result-row-main"><span class="result-row-title">${escapeHtml(x?.step?.target?.label || 'Unnamed field')}</span><span class="result-row-value-line">${valueMarkup}</span>${detailReason}</span><span class="result-row-side"><span class="result-status-pill"><span class="result-status-icon" aria-hidden="true">${statusIcon}</span><span>${statusLabel}</span></span><span class="result-type">${escapeHtml(type)}</span></span><span class="result-chevron" aria-hidden="true">${icon('arrowRight')}</span></div>`;
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
  return `<button class="backtop" id="${id}" type="button"><span class="back-icon" aria-hidden="true">${icon('arrowBack')}</span><span>${label}</span></button>`;
}

function bind() {
  document.getElementById('startTesting')?.addEventListener('click', startNewTestingSession);
  document.getElementById('resumeTesting')?.addEventListener('click', resumeTestingSession);
  document.getElementById('cancelStartTesting')?.addEventListener('click', closeTestingLifecycleDialog);
  document.getElementById('cancelStartTestingAction')?.addEventListener('click', closeTestingLifecycleDialog);
  document.getElementById('resumeSavedTesting')?.addEventListener('click', async () => { state.testingLifecycleDialog = false; await resumeTestingSession(); });
  document.getElementById('discardAndStartTesting')?.addEventListener('click', discardAndStartTesting);
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
  document.getElementById('addField')?.addEventListener('click', async () => { if (state.editing) await saveInline({ renderAfter: false }); await startAddField(); });
  document.getElementById('edit')?.addEventListener('click', async () => { state.draft = clone(state.recordings[state.selectedId]); state.selectionMode = false; state.selectedStepIndexes = new Set(); state.editing = true; render(); await hydrateDraftPicklists(state.draft); render(); });
  document.getElementById('cancelEdit')?.addEventListener('click', () => { state.editing = false; state.draft = null; state.selectionMode = false; state.selectedStepIndexes = new Set(); render(); });
  document.getElementById('saveInline')?.addEventListener('click', saveInline);
  document.getElementById('fillEmptyOnly')?.addEventListener('change', async e => { state.fillEmptyOnly = e.target.checked; await saveSettings({...await getSettings(), fillEmptyOnly: state.fillEmptyOnly}); });
  document.getElementById('refreshHeader')?.addEventListener('click', refresh);
  document.getElementById('settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('firstRunGetStarted')?.addEventListener('click', dismissFirstRunTour);
  document.getElementById('firstRunOverlay')?.addEventListener('click', event => { if (event.target?.id === 'firstRunOverlay') dismissFirstRunTour(); });

  document.getElementById('testingBack')?.addEventListener('click', exitTestingToHome);
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
    state.view = 'testing-paste';
    render();
  });
  document.querySelectorAll('[data-start-testing]').forEach(btn => btn.addEventListener('click', startTestingWorkspace));
  document.getElementById('editTestingCases')?.addEventListener('click', () => { state.testingOpenMenu = null; state.view = 'testing-preview'; render(); });
  document.getElementById('captureTestingScreenshot')?.addEventListener('click', () => captureTestingEvidence(state.testingSession?.currentEvidenceStepId || null));
  document.getElementById('captureTestingScreenshotBottom')?.addEventListener('click', () => captureTestingEvidence(state.testingSession?.currentEvidenceStepId || null));
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
  document.getElementById('downloadTestingTemplate')?.addEventListener('click', downloadTestingTemplate);
  document.getElementById('testingPaste')?.addEventListener('input', e => {
    state.testingPasteText = e.currentTarget.value;
    const button = document.getElementById('parseTestingPaste');
    if (button) button.disabled = !String(e.currentTarget.value || '').trim();
  });
  document.querySelectorAll('[data-testing-field]').forEach(el => {
    el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', handleTestingEditorInput);
  });
  document.querySelectorAll('[data-toggle-testing-case]').forEach(btn => btn.addEventListener('click', e => toggleTestingCase(e.currentTarget.dataset.toggleTestingCase)));
  document.querySelectorAll('[data-testing-expand-all]').forEach(btn => btn.addEventListener('click', expandTestingAll));
  document.querySelectorAll('[data-testing-collapse-all]').forEach(btn => btn.addEventListener('click', collapseTestingAll));
  document.querySelectorAll('[data-testing-case-menu]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const id = e.currentTarget.dataset.testingCaseMenu; state.testingOpenMenu = state.testingOpenMenu === `tc:${id}` ? null : `tc:${id}`; render(); }));
  document.querySelectorAll('[data-testing-step-menu]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const id = e.currentTarget.dataset.testingStepMenu; state.testingOpenMenu = state.testingOpenMenu === `step:${id}` ? null : `step:${id}`; render(); }));
  document.querySelectorAll('[data-add-step-to-case]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); addTestingStep(e.currentTarget.dataset.addStepToCase); }));
  document.querySelectorAll('[data-add-test-case]').forEach(btn => btn.addEventListener('click', addTestingCase));
  document.querySelectorAll('[data-delete-test-case]').forEach(btn => btn.addEventListener('click', e => { if (!e.currentTarget.disabled) deleteTestingCase(e.currentTarget.dataset.deleteTestCase); }));
  document.querySelectorAll('[data-delete-test-step]').forEach(btn => btn.addEventListener('click', e => { if (!e.currentTarget.disabled) deleteTestingStep(e.currentTarget.dataset.tcId, e.currentTarget.dataset.deleteTestStep); }));
  document.querySelectorAll('[data-move-step]').forEach(btn => btn.addEventListener('click', e => { if (!e.currentTarget.disabled) moveTestingStep(e.currentTarget.dataset.tcId, e.currentTarget.dataset.stepId, e.currentTarget.dataset.moveStep); }));
  document.querySelectorAll('[data-toggle-step-evidence]').forEach(btn => btn.addEventListener('click', e => toggleTestingEvidence(e.currentTarget.dataset.toggleStepEvidence)));
  document.querySelectorAll('[data-toggle-general-evidence]').forEach(btn => btn.addEventListener('click', () => { state.testingGeneralEvidenceExpanded = !state.testingGeneralEvidenceExpanded; render(); }));
  document.getElementById('testingPasteScreenshot')?.addEventListener('click', pasteTestingScreenshot);
  document.querySelectorAll('[data-capture-step]').forEach(btn => btn.addEventListener('click', e => captureTestingEvidence(e.currentTarget.dataset.captureStep)));
  document.querySelectorAll('[data-copy-evidence]').forEach(btn => btn.addEventListener('click', e => copyTestingEvidence(e.currentTarget.dataset.copyEvidence)));
  document.querySelectorAll('[data-associate-evidence]').forEach(btn => btn.addEventListener('click', e => { state.testingAssociatingEvidenceId = e.currentTarget.dataset.associateEvidence; render(); }));
  document.querySelectorAll('[data-remove-evidence]').forEach(btn => btn.addEventListener('click', e => removeTestingEvidence(e.currentTarget.dataset.removeEvidence)));
  document.querySelectorAll('[data-preview-evidence]').forEach(btn => btn.addEventListener('click', e => previewTestingEvidence(e.currentTarget.dataset.previewEvidence)));
  document.getElementById('closeAssociateDialog')?.addEventListener('click', () => { const id=state.testingAssociatingEvidenceId; state.testingAssociatingEvidenceId = null; render(); document.querySelector(`[data-associate-evidence="${id}"]`)?.focus(); });
  document.querySelectorAll('[data-associate-step]').forEach(btn => btn.addEventListener('click', e => associateTestingEvidence(e.currentTarget.dataset.associateEvidence, e.currentTarget.dataset.associateStep)));
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
  document.querySelectorAll('.recording-row[data-id]').forEach(b => b.addEventListener('click', () => { state.selectedId = b.dataset.id; state.run = null; state.view = 'detail'; state.editing = false; state.selectionMode = false; state.selectedStepIndexes = new Set(); render(); }));
  document.querySelectorAll('[data-result-tab]').forEach(b => b.addEventListener('click', () => { state.resultTab = b.dataset.resultTab; render(); document.querySelector(`[data-result-tab="${state.resultTab}"]`)?.focus(); }));
  document.querySelectorAll('[data-select-checkbox]').forEach(box => {
    box.addEventListener('click', e => e.stopPropagation());
    box.addEventListener('change', e => toggleSelectedStep(Number(e.currentTarget.dataset.selectCheckbox)));
  });
  document.querySelectorAll('[data-focus-step]').forEach(b => b.addEventListener('click', e => focusStep(Number(e.currentTarget.dataset.focusStep))));
  document.querySelectorAll('[data-remove-live-step]').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); await removeLiveRecordingStep(Number(e.currentTarget.dataset.removeLiveStep)); }));
  document.querySelectorAll('[data-focus-index]').forEach(b => { b.addEventListener('click', e => { if (e.target.closest('[data-overwrite-index]')) return; focusIndex(Number(e.currentTarget.dataset.focusIndex)); }); b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-overwrite-index]')) { e.preventDefault(); focusIndex(Number(e.currentTarget.dataset.focusIndex)); } }); });
  document.querySelectorAll('[data-overwrite-index]').forEach(b => { b.addEventListener('click', e => { e.stopPropagation(); overwriteSkipped(Number(e.currentTarget.dataset.overwriteIndex)); }); b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); overwriteSkipped(Number(e.currentTarget.dataset.overwriteIndex)); } }); });
  document.querySelectorAll('[data-delete-step]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); state.draft.steps.splice(Number(e.currentTarget.dataset.deleteStep), 1); state.draft.steps.forEach((s, i) => s.sequence = i + 1); render(); }));
}

async function saveInline({ renderAfter = true } = {}) {
  if (!state.draft) return;
  state.draft.steps.forEach((s, i) => {
    const t = fieldTypeLabel(s);
    const bool = document.querySelector(`[data-edit-bool="${i}"]`);
    if (bool) {
      s.value = bool.checked;
    } else if (t === 'Multipicklist' && typeOptions(s).length) {
      s.value = [...document.querySelectorAll(`[data-multi-index="${i}"]:checked`)]
        .map(x => x.dataset.multiValue).filter(Boolean);
    } else {
      const el = document.querySelector(`[data-edit-value="${i}"]`);
      if (!el) return;
      if (t === 'Date') {
        const recordingDate = s.meta?.dateRecordedOn || state.draft?.recordingDate || localDateISO();
        if (s.meta?.dateMode === 'relative' && Number.isFinite(Number(s.meta?.dateOffsetDays))) {
          const sign = document.querySelector(`[data-date-sign="${i}"]`)?.value === '-' ? -1 : 1;
          const days = Math.max(0, Number(document.querySelector(`[data-date-offset="${i}"]`)?.value || 0));
          const relativeOffset = sign * days;
          s.value = shiftDateFrom(recordingDate, relativeOffset);
          s.meta = { ...(s.meta || {}), dateRecordedOn: recordingDate, dateOffsetDays: relativeOffset, dateExpression: dateOffsetLabel(relativeOffset), dateMode: 'relative' };
        } else {
          const input = String(el.value || '').trim();
          const normalized = input.replace(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/, '$3-$1-$2');
          s.value = normalized;
          if (s.meta) { delete s.meta.dateExpression; delete s.meta.dateOffsetDays; delete s.meta.dateMode; }
        }
      } else {
        s.value = cleanEditedValue(s, el.value);
      }
    }
    s.sequence = i + 1;
  });
  state.draft.name = document.getElementById('recordingName')?.value.trim() || state.draft.name || recordingTitle(state.draft);
  state.draft.updatedAt = new Date().toISOString();
  state.recordings[state.draft.id] = clone(state.draft);
  await saveRecordings(state.recordings);
  state.editing = false;
  state.draft = null;
  if (renderAfter) render();
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
    const [recs, settings, active, lock, testingSession] = await Promise.all([
      getRecordings(),
      getSettings(),
      chrome.runtime.sendMessage({ type:'GET_ACTIVE_CONTEXT' }).catch(() => ({})),
      chrome.runtime.sendMessage({ type:'GET_RECORDING_LOCK', windowId, incognito }).catch(() => ({})),
      loadTestingSession().catch(() => null)
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
    state.testingSession = testingSession || null;
    if (state.testingSession) await loadTestingEvidenceUrls();
    state.fillEmptyOnly = settings.fillEmptyOnly !== false;
    applyTheme(settings.darkMode);
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
    } else if (String(state.view || '').startsWith('testing-') && state.testingSession) {
      // Preserve the active Testing view during a refresh.
    } else {
      state.selectedId = null;
      state.run = null;
      state.resultTab = 'all';
      state.editing = false;
      state.draft = null;
      state.filter = '';
      state.view = 'home';
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
async function sendTab(tab, msg) { let r = await chrome.tabs.sendMessage(tab.id, msg).catch(() => null); if (r) return r; const ready = await ensureTabConnection(tab); if (!ready?.ok) return { ok: false, message: ready?.message || 'Could not connect to Salesforce.' }; return chrome.tabs.sendMessage(tab.id, msg).catch(e => ({ ok: false, message: e?.message || 'Could not connect to Salesforce.' })); }

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
  try { await chrome.tabs.sendMessage(id, { type: 'CLEAR_PENDING_RECORDING' }); } catch {}
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
  if (!fresh?.objectApiName || fresh.objectApiName === 'Salesforce') return showInline('Could not determine the current Salesforce object. Refresh the Salesforce record and try again.');
  state.context = fresh;
  if (recording.context?.objectApiName && fresh.objectApiName && recording.context.objectApiName !== fresh.objectApiName) {
    return showInline(`This recording is for ${recording.context.objectApiName}. Open a matching Salesforce record first.`);
  }
  const r = await sendTab(tab, { type: 'START_RECORDING', appendRecording: recording });
  if (!r?.ok) return showInline(r?.message || 'Could not start field recording.');
  state.recording = true;
  state.recordingTabId = tab.id;
  state.addingToRecordingId = recording.id;
  state.context = r.context || state.context;
  state.activeSteps = r.steps || recording.steps || [];
  state.run = null;
  state.view = 'recording';
  render();
  clearInterval(window.fpTimer);
  window.fpTimer = setGuardedInterval(async () => {
    const d = await sendTab(tab, { type:'GET_RECORDING_STATE' });
    if (!d?.recording) return;
    state.activeSteps = d.steps || state.activeSteps;
    const list = document.getElementById('recording-field-list');
    if (list) {
      list.innerHTML = renderLiveRecordingRows(state.activeSteps);
      const note = document.getElementById('recording-note');
      if (note) note.classList.toggle('is-hidden', state.activeSteps.length > 0);
      list.querySelectorAll('[data-remove-live-step]').forEach(b=>b.addEventListener('click', async e=>{ e.stopPropagation(); await removeLiveRecordingStep(Number(e.currentTarget.dataset.removeLiveStep)); }));
    }
  }, 900);
}

async function removeLiveRecordingStep(index) {
  const tabId = state.recordingTabId;
  if (!tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) return;
  const r = await sendTab(tab, { type: 'REMOVE_RECORDING_STEP', index });
  if (!r?.ok) return showInline(r?.message || 'Could not remove the field from the recording.');
  state.activeSteps = r.steps || [];
  render();
}


async function startNewTestingSession() {
  if (state.recording) {
    return showInline('Stop the active recording before starting Testing Mode.');
  }
  if (state.testingSession) { state.testingLifecycleDialog = true; render(); return; }
  state.testingPasteText = '';
  state.testingPasteError = '';
  state.testingMessage = '';
  state.testingAssociatingEvidenceId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingCollapsedCases = new Set();
  state.testingExpandedEvidence = new Set();
  state.testingGeneralEvidenceExpanded = false;
  state.testingOpenMenu = null;
  state.view = 'testing-paste';
  render();
}

function closeTestingLifecycleDialog() { state.testingLifecycleDialog = false; render(); document.getElementById('startTesting')?.focus(); }

async function discardAndStartTesting() {
  const session = state.testingSession;
  const name = session?.workProduct || 'Screenshot session';
  const captures = session?.evidence?.length || 0;
  const confirmed = await requestTestingConfirm({
    title: 'Discard Testing session?',
    message: `Discard “${name}” and its ${captures} capture${captures === 1 ? '' : 's'}? This permanently deletes the saved evidence before starting a new session.`,
    confirmLabel: 'Discard session',
    danger: true
  });
  if (!confirmed) return;
  await discardTestingSession();
  await startNewTestingSession();
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
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingCollapsedCases = new Set();
  state.testingExpandedEvidence = new Set();
  state.testingGeneralEvidenceExpanded = true;
  state.testingOpenMenu = null;
  state.testingSession = createEvidenceOnlyTestingSession();
  state.testingSession.workProduct = String(name || '').trim();
  resetTestingExportState();
  await persistTestingSession();
  state.view = 'testing-workspace';
  render();
}

async function resumeTestingSession() {
  const saved = state.testingSession || await loadTestingSession().catch(() => null);
  if (!saved) return startNewTestingSession();
  state.testingSession = saved;
  if (saved.status === 'finished') { saved.status = 'active'; await persistTestingSession(); }
  await loadTestingEvidenceUrls();
  state.testingPasteError = '';
  state.testingAssociatingEvidenceId = null;
  state.testingAutofillPickerOpen = false;
  state.testingAutofillQuery = '';
  state.testingAutofillActive = false;
  state.testingAutofillBusy = false;
  state.testingCollapsedCases = new Set();
  state.testingExpandedEvidence = new Set();
  state.testingGeneralEvidenceExpanded = isEvidenceOnlyTesting(saved);
  state.testingOpenMenu = null;
  state.view = 'testing-workspace';
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

function autoResizeTestingTextareas() {
  document.querySelectorAll('.testing-editor-step-field textarea').forEach(textarea => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(42, textarea.scrollHeight)}px`;
  });
}

function toggleTestingCase(caseId) {
  if (!caseId) return;
  if (state.testingCollapsedCases.has(caseId)) state.testingCollapsedCases.delete(caseId);
  else state.testingCollapsedCases.add(caseId);
  state.testingOpenMenu = null;
  render();
}

function toggleTestingEvidence(stepId) {
  if (!stepId) return;
  if (state.testingExpandedEvidence.has(stepId)) state.testingExpandedEvidence.delete(stepId);
  else state.testingExpandedEvidence.add(stepId);
  render();
}

function addTestingStep(tcId) {
  const tc = state.testingSession?.testCases?.find(item => item.id === tcId);
  if (!tc) return;
  const nextIndex = (tc.steps || []).length ? Math.max(...tc.steps.map(s => Number(s.index) || 0)) + 1 : 1;
  const stepId = `step_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  tc.steps.push({ id: stepId, index: nextIndex, text: '' });
  state.testingCollapsedCases.delete(tcId);
  state.testingOpenMenu = null;
  persistTestingSession().catch(() => {});
  render();
  requestAnimationFrame(() => document.querySelector(`textarea[data-testing-field="stepText"][data-tc-id="${CSS.escape(tcId)}"][data-step-id="${CSS.escape(stepId)}"]`)?.focus());
}

function addTestingCase() {
  const cases = state.testingSession?.testCases || [];
  const tcId = `tc_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const stepId = `step_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const tc = {
    id: tcId,
    workProduct: state.testingSession?.workProduct || '',
    objectType: cases[0]?.objectType || 'Test Case',
    title: `TC_${cases.length + 1}: New test case`,
    steps: [{ id: stepId, index: 1, text: '' }]
  };
  state.testingSession.testCases.push(tc);
  state.testingCollapsedCases.delete(tcId);
  state.testingOpenMenu = null;
  persistTestingSession().catch(() => {});
  render();
  requestAnimationFrame(() => document.querySelector(`input[data-testing-field="title"][data-tc-id="${CSS.escape(tcId)}"]`)?.focus());
}

async function deleteTestingCase(tcId) {
  const session = state.testingSession;
  if (!session || session.testCases.length <= 1) return;
  const tc = session.testCases.find(item => item.id === tcId);
  if (!tc) return;
  const confirmed = await requestTestingConfirm({
    title: 'Delete test case?',
    message: `Delete ${tc.title || 'this test case'}? Its linked evidence will also be removed.`,
    confirmLabel: 'Delete test case',
    danger: true
  });
  if (!confirmed) return;
  const stepIds = new Set((tc.steps || []).map(step => step.id));
  const toDelete = session.evidence.filter(item => stepIds.has(item.stepId));
  session.testCases = session.testCases.filter(item => item.id !== tcId);
  session.evidence = session.evidence.filter(item => !stepIds.has(item.stepId));
  toDelete.forEach(item => { revokeTestingObjectUrl(item.id); deleteEvidenceBlob(item.imageBlobKey).catch(() => {}); });
  state.testingCollapsedCases.delete(tcId);
  state.testingOpenMenu = null;
  if (stepIds.has(session.currentEvidenceStepId)) session.currentEvidenceStepId = null;
  persistTestingSession().catch(() => {});
  render();
}

async function deleteTestingStep(tcId, stepId) {
  const session = state.testingSession;
  const tc = session?.testCases?.find(item => item.id === tcId);
  if (!tc || tc.steps.length <= 1) return;
  const confirmed = await requestTestingConfirm({
    title: 'Delete test step?',
    message: 'Delete this step? Evidence linked to it will become unassociated.',
    confirmLabel: 'Delete step',
    danger: true
  });
  if (!confirmed) return;
  tc.steps = tc.steps.filter(step => step.id !== stepId);
  tc.steps.forEach((step, index) => { step.index = index + 1; });
  session.evidence.forEach(item => {
    if (item.stepId === stepId) { item.stepId = null; item.testCaseId = null; }
  });
  if (session.currentEvidenceStepId === stepId) session.currentEvidenceStepId = null;
  state.testingOpenMenu = null;
  persistTestingSession().catch(() => {});
  render();
}

function moveTestingStep(tcId, stepId, direction) {
  const tc = state.testingSession?.testCases?.find(item => item.id === tcId);
  if (!tc) return;
  const index = tc.steps.findIndex(step => step.id === stepId);
  if (index < 0) return;
  const next = direction === 'up' ? index - 1 : index + 1;
  if (next < 0 || next >= tc.steps.length) return;
  [tc.steps[index], tc.steps[next]] = [tc.steps[next], tc.steps[index]];
  tc.steps.forEach((step, i) => { step.index = i + 1; });
  state.testingOpenMenu = null;
  persistTestingSession().catch(() => {});
  render();
}

function expandTestingAll() { state.testingCollapsedCases = new Set(); render(); }
function collapseTestingAll() { state.testingCollapsedCases = new Set((state.testingSession?.testCases || []).map(tc => tc.id)); render(); }

function testingDismissOpenMenu(event) {
  if (!state.testingOpenMenu) return;
  if (event.target.closest('.testing-context-menu') || event.target.closest('[data-testing-case-menu]') || event.target.closest('[data-testing-step-menu]')) return;
  state.testingOpenMenu = null;
  if (String(state.view || '').startsWith('testing-')) render();
}

function handleTestingEditorInput(event) {
  const el = event.currentTarget;
  const field = el.dataset.testingField;
  const tc = state.testingSession?.testCases?.find(item => item.id === el.dataset.tcId);
  if (!field || !state.testingSession) return;
  if (!tc && !['workProduct', 'globalObjectType'].includes(field)) return;
  if (field === 'workProduct') {
    state.testingSession.workProduct = String(el.value || '').trim();
    state.testingSession.testCases.forEach(item => { item.workProduct = state.testingSession.workProduct; });
  } else if (field === 'globalObjectType') {
    const value = String(el.value || '').trim() || 'Test Case';
    state.testingSession.testCases.forEach(item => { item.objectType = value; });
  } else if (field === 'objectType') {
    const value = String(el.value || '').trim() || 'Test Case';
    if (el.dataset.testingGlobal === 'true') {
      state.testingSession.testCases.forEach(item => { item.objectType = value; });
    } else {
      tc.objectType = value;
    }
  } else if (field === 'title') {
    tc.title = String(el.value || '').trim();
  } else if (field === 'stepIndex') {
    const step = tc.steps.find(item => item.id === el.dataset.stepId);
    if (step) step.index = Math.max(1, Number(el.value) || 1);
  } else if (field === 'stepText') {
    const step = tc.steps.find(item => item.id === el.dataset.stepId);
    if (step) step.text = String(el.value || '');
  }
  persistTestingSession().catch(() => {});
}

function validateTestingSessionForStart() {
  const session = state.testingSession;
  if (isEvidenceOnlyTesting(session)) return '';
  if (!session?.workProduct?.trim()) return 'Work Product is required.';
  if (!session.testCases?.length) return 'Add at least one test case.';
  for (const tc of session.testCases) {
    if (!tc.title?.trim()) return 'Every test case needs a title.';
    if (!tc.steps?.length) return `${tc.title || 'A test case'} does not contain any steps.`;
    for (const step of tc.steps) {
      if (!Number.isInteger(Number(step.index)) || Number(step.index) < 1) return `${tc.title}: Step Index must be a positive whole number.`;
      if (!String(step.text || '').trim()) return `${tc.title}: every step needs text.`;
    }
  }
  return '';
}

function downloadTestingTemplate() {
  const templatePath = 'src/test-scenarios-template.xlsx';
  fetch(chrome.runtime.getURL(templatePath))
    .then(response => {
      if (!response.ok) throw new Error(`Template unavailable (${response.status}).`);
      return response.blob();
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'test-scenarios-template.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })
    .catch(() => showInline('The Excel template could not be downloaded. Please refresh ForcePilot and try again.'));
}

async function parseTestingPasteAndPreview() {
  const value = String(document.getElementById('testingPaste')?.value || state.testingPasteText || '').trim();
  state.testingPasteText = value;
  state.testingPasteError = '';
  if (!value) {
    state.testingPasteError = 'Paste your test cases first.';
    render();
    return;
  }
  try {
    const parsed = parseTestCasePaste(value);
    state.testingSession = createTestingSession(parsed);
    await persistTestingSession();
    state.testingAssociatingEvidenceId = null;
    state.testingCollapsedCases = new Set(parsed.testCases.slice(1).map(tc => tc.id));
    state.testingExpandedEvidence = new Set();
    state.testingGeneralEvidenceExpanded = false;
    state.testingOpenMenu = null;
    resetTestingExportState();
    const settings = await getSettings();
    if (settings.skipTestCaseReview !== false) {
      await startTestingWorkspace();
      return;
    }
    state.view = 'testing-preview';
    render();
  } catch (error) {
    state.testingPasteError = error?.message || 'Could not parse the test cases.';
    render();
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
  await persistTestingSession();
  await loadTestingEvidenceUrls();
  if (!state.testingCollapsedCases?.size && (state.testingSession.testCases || []).length > 1) state.testingCollapsedCases = new Set(state.testingSession.testCases.slice(1).map(tc => tc.id));
  state.testingOpenMenu = null;
  state.view = 'testing-workspace';
  render();
}

function testingToTsv(session) {
  const rows = [['Work Product', 'Object Type', 'Test Case', 'Step Index', 'Steps']];
  for (const tc of session?.testCases || []) {
    for (const step of tc.steps || []) {
      rows.push([
        session.workProduct || '',
        tc.objectType || 'Test Case',
        tc.title || '',
        Number(step.index) || '',
        String(step.text || '')
      ]);
    }
  }
  return rows.map(row => row.map(value => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t')).join('\n');
}

function formatTestingEvidenceStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const hour24 = d.getHours();
  const hour12 = String(hour24 % 12 || 12);
  const minute = String(d.getMinutes()).padStart(2, '0');
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const dateLabel = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return { dateLabel, timeLabel: `${hour12}:${minute} ${period}` };
}

async function stampTestingEvidenceImage(blob, capturedAt = new Date()) {
  if (!blob) return blob;
  const stamp = formatTestingEvidenceStamp(capturedAt);
  if (!stamp) return blob;
  let bitmap = null;
  let objectUrl = null;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob);
    } else {
      objectUrl = URL.createObjectURL(blob);
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The screenshot could not be prepared.'));
        img.src = objectUrl;
      });
    }

    const width = Math.max(1, bitmap.width || bitmap.naturalWidth);
    const height = Math.max(1, bitmap.height || bitmap.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return blob;

    ctx.drawImage(bitmap, 0, 0, width, height);

    const scale = Math.max(1, Math.min(1.25, width / 1200));
    const timeFontSize = 11;
    const dateFontSize = 10;
    const timeLineHeight = 13;
    const dateLineHeight = 12;
    const padX = 8;
    const padY = 5;
    const gap = 1;
    const margin = 10;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `600 ${timeFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    const timeWidth = ctx.measureText(stamp.timeLabel).width;
    ctx.font = `500 ${dateFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    const dateWidth = ctx.measureText(stamp.dateLabel).width;
    const boxWidth = Math.ceil(Math.max(dateWidth, timeWidth) + padX * 2);
    const boxHeight = Math.ceil(timeLineHeight + gap + dateLineHeight + padY * 2);
    const boxX = Math.max(0, width - margin - boxWidth);
    const boxY = Math.max(0, height - margin - boxHeight);
    const radius = 7;

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.20)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, radius);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.font = `600 ${timeFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillText(stamp.timeLabel, boxX + padX, boxY + padY + timeLineHeight / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = `500 ${dateFontSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillText(stamp.dateLabel, boxX + padX, boxY + padY + timeLineHeight + gap + dateLineHeight / 2);
    ctx.restore();

    return await new Promise(resolve => {
      canvas.toBlob(result => resolve(result && result.size ? result : blob), 'image/jpeg', 0.98);
    });
  } catch {
    return blob;
  } finally {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}



async function saveTestingEvidenceBlob(inputBlob, { source = 'native', sourceTabId = null, stamp = false, toastMessage = 'Screenshot captured' } = {}) {
  if (!state.testingSession || !inputBlob) return false;
  const capturedAt = new Date();
  const evidenceBlob = stamp ? await stampTestingEvidenceImage(inputBlob, capturedAt) : inputBlob;
  const evidenceId = `evidence_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const imageBlobKey = `${state.testingSession.id}:${evidenceId}`;
  await putEvidenceBlob(imageBlobKey, evidenceBlob);
  const stepId = state.testingSession.currentEvidenceStepId || null;
  const evidence = {
    id: evidenceId,
    capturedAt: capturedAt.toISOString(),
    testCaseId: testingStepById(state.testingSession, stepId)?.testCase?.id || null,
    stepId,
    imageBlobKey,
    sourceTabId: sourceTabId || null,
    source,
    timestampApplied: !!stamp
  };
  state.testingSession.evidence.push(evidence);
  if (evidence.stepId) state.testingExpandedEvidence.add(evidence.stepId);
  if (isEvidenceOnlyTesting(state.testingSession)) state.testingGeneralEvidenceExpanded = true;
  const previewUrl = URL.createObjectURL(evidenceBlob);
  testingObjectUrls.set(evidence.id, previewUrl);
  await persistTestingSession();
  showToast(toastMessage, { type: 'success', duration: 1050, transientKey: source === 'pasted' ? 'screenshot-pasted' : 'screenshot-captured' });
  return true;
}

async function saveCapturedScreenshotData(dataUrl, { sourceTabId = null } = {}) {
  if (!dataUrl) return false;
  const capturedBlob = await (await fetch(dataUrl)).blob();
  return saveTestingEvidenceBlob(capturedBlob, { source: 'native', sourceTabId, stamp: true, toastMessage: 'Screenshot captured' });
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

async function pasteTestingScreenshot() {
  if (!state.testingSession || state.testingCaptureBusy) return;
  try {
    const blob = await readClipboardImage();
    if (!blob) {
      showToast('No screenshot found in clipboard.', { type: 'warning', duration: 2600 });
      return;
    }
    await saveTestingEvidenceBlob(blob, { source: 'pasted', stamp: false, toastMessage: 'Screenshot pasted' });
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
    await saveTestingEvidenceBlob(blob, { source: 'pasted', stamp: false, toastMessage: 'Screenshot pasted' });
    render();
  } catch (error) {
    showToast(error?.message || 'Could not paste screenshot.', { type: 'error', duration: 3200 });
  }
}

async function captureTestingEvidence(stepId = null) {
  if (!state.testingSession || state.testingCaptureBusy) return;
  state.testingCaptureBusy = true;
  if (stepId) state.testingSession.currentEvidenceStepId = stepId;
  // Render the busy state first so the click feels immediate. No storage or
  // connection round-trip happens before Chrome is asked to capture.
  render();
  const tab = await activeTab();
  if (!tab?.id) {
    testingError('No active browser tab is available for capture.');
    state.testingCaptureBusy = false;
    render();
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_TEST_SCREENSHOT', tabId: tab.id });
    if (!response?.ok || !response.dataUrl) throw new Error(response?.message || 'Chrome could not capture the current tab.');
    await saveCapturedScreenshotData(response.dataUrl, { sourceTabId: tab.id });
  } catch (error) {
    testingError(error?.message || 'Could not capture the current tab.');
    state.testingCaptureBusy = false;
    render();
    return;
  }
  state.testingCaptureBusy = false;
  render();
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
  preview.querySelector('.testing-image-preview-close')?.focus();
  preview.addEventListener('click', event => { if (event.target === preview || event.target.closest('.testing-image-preview-close')) { preview.remove(); trigger?.focus(); } });
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

async function associateTestingEvidence(evidenceId, stepId) {
  const session = state.testingSession;
  const evidence = session?.evidence?.find(item => item.id === evidenceId);
  const hit = testingStepById(session, stepId);
  if (!evidence || !hit) return;
  evidence.stepId = stepId;
  evidence.testCaseId = hit.testCase.id;
  session.currentEvidenceStepId = stepId;
  state.testingAssociatingEvidenceId = null;
  await persistTestingSession();
  showToast('Screenshot linked to step', { type: 'success', duration: 2000 });
  render();
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
  if (!session || state.testingExportBusy || state.testingZipBusy) return;
  if (!(session.evidence || []).length) {
    showToast('Capture at least one screenshot before exporting.', { type: 'warning' });
    state.testingExportError = '';
    render();
    return;
  }

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
  if (!session || state.testingZipBusy || state.testingExportBusy) return;
  if (!(session.evidence || []).length) {
    showToast('Capture at least one screenshot before exporting the ZIP.', { type: 'warning' });
    state.testingZipError = '';
    render();
    return;
  }

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
  if (isEvidenceOnlyTesting(session) && !String(session.workProduct || '').trim()) {
    openEvidenceNameDialog('finish');
    return;
  }
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
    ...(!state.testingZipCompleted ? ['Screenshots ZIP'] : [])
  ] : [];
  const name = session.workProduct || 'Screenshot session';
  const message = missingExports.length
    ? `End “${name}” and clear its ${captures} saved capture${captures === 1 ? '' : 's'}? You have not downloaded the ${missingExports.join(' and ')}. Export files you need before ending the session.`
    : `End “${name}” and clear this testing session${captures ? ` with ${captures} saved capture${captures === 1 ? '' : 's'}` : ''}? This cannot be undone.`;
  const confirmed = await requestTestingConfirm({
    title: 'End Testing session?',
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
  try {
    for (const evidence of state.testingSession?.evidence || []) revokeTestingObjectUrl(evidence.id);
    await clearTestingSession();
  } catch {}
  state.testingSession = null;
  state.testingLifecycleDialog = false;
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
  if (!fresh?.objectApiName || fresh.objectApiName === 'Salesforce') return showInline('Could not determine the current Salesforce object. Refresh the Salesforce record and try again.');
  state.context = fresh;
  const r = await sendTab(tab, { type: 'START_RECORDING' });
  if (!r?.ok) return showInline(r?.message || 'Could not start recording.');
  state.pendingRecording = null; state.pendingRecordingTabId = null; state.recordingPaused = false; state.recording = true; state.recordingTabId = tab.id; state.addingToRecordingId = null; state.context = r.context || state.context; state.activeSteps = r.steps || []; state.run = null; state.view = 'recording'; render();
  clearInterval(window.fpTimer); window.fpTimer = setGuardedInterval(async () => { const d = await sendTab(tab, { type:'GET_RECORDING_STATE' }); if (!d?.recording) return; state.activeSteps = d.steps || []; const list=document.getElementById('recording-field-list'); if(list){ list.innerHTML = renderLiveRecordingRows(state.activeSteps); const note=document.getElementById('recording-note'); if(note) note.classList.toggle('is-hidden',state.activeSteps.length>0); list.querySelectorAll('[data-remove-live-step]').forEach(b=>b.addEventListener('click',async e=>{ e.stopPropagation(); await removeLiveRecordingStep(Number(e.currentTarget.dataset.removeLiveStep)); })); } }, 900);
}

async function togglePauseRecording(){const id=state.recordingTabId;if(!id)return;const tab=await chrome.tabs.get(id).catch(()=>null);if(!tab?.id)return;const next=!state.recordingPaused;const r=await sendTab(tab,{type:next?'PAUSE_RECORDING':'RESUME_RECORDING'});if(!r?.ok)return showInline(r?.message||'Could not change recording state.');state.recordingPaused=!!r.paused;render()}

async function stopRecording() {
  clearInterval(window.fpTimer);
  const id = state.recordingTabId;
  const wasAppending = !!state.addingToRecordingId;
  const appendId = state.addingToRecordingId;
  const tab = id ? await chrome.tabs.get(id).catch(() => null) : null;
  const r = tab?.id ? await sendTab(tab, { type: 'STOP_RECORDING' }) : null;
  state.recording = false; state.recordingPaused=false; state.recordingTabId = null; state.addingToRecordingId = null;
  // If the Salesforce content script was reloaded/navigated while recording,
  // STOP_RECORDING can legitimately return NOT_RECORDING even though the Side Panel
  // still has the latest polled field list. Recover that snapshot instead of losing it.
  if (!r?.recording && Array.isArray(state.activeSteps) && state.activeSteps.length) {
    const recoveredSteps = clone(state.activeSteps);
    const context = state.context || {};
    if (wasAppending && appendId && state.recordings[appendId]) {
      state.recordings[appendId] = {
        ...state.recordings[appendId],
        context: {...state.recordings[appendId].context, ...context},
        steps: recoveredSteps,
        updatedAt: new Date().toISOString()
      };
      await saveRecordings(state.recordings);
      state.selectedId = appendId;
      state.pendingRecording = null;
      state.run = null;
      state.view = 'detail';
      if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id, windowId: state.windowId, incognito: state.incognito }); } catch {} }
      render();
      showToast('Recording stopped using the latest captured fields.', { type: 'warning', duration: 3000 });
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
    showToast('Recording stopped using the latest captured fields.', { type: 'warning', duration: 3000 });
    return;
  }
  if (r?.recording) {
    const recordedSteps = Array.isArray(r.recording.steps) ? r.recording.steps.filter(Boolean) : [];
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

async function startAutofill(onlyIndexes = null) {
  const r = state.recordings[state.selectedId]; if (!r) return;
  const tab = await activeTab(); if (!tab?.id) return showInline('Open a Salesforce page to run Autofill.');
  const ready = await ensureTabConnection(tab);
  if (!ready?.ok) { showToast(ready.message || 'Could not connect to Salesforce.', { type: 'error', duration: 3400 }); return; }
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
  try {
    const resp = await sendTab(tab, { type: 'REPLAY_RECORDING', recording: r, onlyIndexes: failed, fillOnlyBlank: false });
    clearInterval(window.fpProgressTimer);
    const retryRun = resp || { ok: false, executed: [], error: 'Salesforce did not respond.' };
    const replacements = new Map((Array.isArray(retryRun.executed) ? retryRun.executed : []).map(item => [item.index, item]));
    state.run = { ...previousRun, ...retryRun, executed: (previousRun?.executed || []).map(item => replacements.get(item.index) || item), error: retryRun.error || '' };
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

async function focusStep(i) { const r = state.recordings[state.selectedId], tab = await activeTab(); if (r && tab?.id && r.steps[i]) await sendTab(tab, { type: 'FOCUS_FIELD', target: r.steps[i].target }); }
async function focusIndex(i) { const ex = state.run?.executed?.find(x => x.index === i), tab = await activeTab(); if (ex && tab?.id) await sendTab(tab, { type: 'FOCUS_FIELD', target: ex.step.target }); }
function showInline(msg, type = 'error') { showToast(msg, { type, duration: type === 'success' ? 2200 : 3400 }); }

document.addEventListener('click', testingDismissOpenMenu);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['forcepilot.recordings.v1']) {
    getRecordings().then(next => { state.recordings = next; if (state.selectedId && !state.recordings[state.selectedId]) { state.selectedId = null; state.run = null; state.view = 'home'; state.editing = false; state.draft = null; } render(); }).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[FIRST_RUN_TOUR_KEY]) return;
  if (changes[FIRST_RUN_TOUR_KEY].newValue === false) {
    showFirstRunTour();
  }
});

watchTheme(dark=>applyTheme(dark));
initializeFirstRunTour().finally(() => refresh());


window.addEventListener('keydown', handleEvidenceNameKeydown);
window.addEventListener('paste', handleTestingImagePaste, true);
