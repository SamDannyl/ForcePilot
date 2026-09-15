/*
 * ForcePilot - Salesforce Record Autofill
 * Copyright © 2026 Sam Daniel
 *
 * Licensed under the MIT License. See LICENSE for details.
 * Not affiliated with Salesforce, Inc.
 */

import { getRecordings, getSettings, saveRecordings, saveSettings } from './src/shared-module.js';

const app = document.getElementById('app');
const LAST_RUN_KEY = 'forcepilot.lastRun.v1';
const state = {
  context: null,
  tabId: null,
  recordings: {},
  selectedId: null,
  recording: false,
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
};

const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clone = v => JSON.parse(JSON.stringify(v));
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
const objectLabel = c => {
  const raw=String(c?.objectLabel||c?.label||c?.objectApiName||'Salesforce').trim();
  const api=String(c?.objectApiName||'').trim();
  const humanizeApi=x=>x.replace(/__c$/i,'').replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim();
  const derived=api?humanizeApi(api):'';
  const pluralOf=x=>{if(!x)return'';if(/[^aeiou]y$/i.test(x))return x.slice(0,-1)+'ies';if(/(s|x|z|ch|sh)$/i.test(x))return x+'es';return x+'s'};
  if(raw===api||/__[A-Za-z0-9]+$/.test(raw)||/^.+__.+__c$/i.test(raw))return derived||raw||'Salesforce';
  if(derived && raw.toLowerCase()===pluralOf(derived).toLowerCase())return derived;
  return raw||derived||'Salesforce';
};
const recordingTitle = r => String(r?.name || r?.context?.objectApiName || 'Recording').trim();
const recordingMeta = r => `${r?.steps?.length || 0} field${r?.steps?.length===1?'':'s'}`;

function render() {
  const recs = Object.values(state.recordings)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter(r => `${recordingTitle(r)} ${r.name || ''} ${r.context?.objectApiName || ''}`.toLowerCase().includes(state.filter.toLowerCase()));
  const selected = state.selectedId ? state.recordings[state.selectedId] : null;
  const body = state.view === 'recording' || state.recording
    ? renderRecording()
    : state.view === 'save-name' && state.pendingRecording
      ? renderSaveNamePrompt()
      : state.view === 'running'
        ? renderRunning()
        : state.view === 'result' && state.run
          ? renderResult()
          : state.view === 'detail' && selected
            ? renderDetail(selected)
            : renderHome(recs);
  app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><img class="brandmark" src="branding/forcepilot-icon.png" alt="ForcePilot"><img class="wordmark" src="branding/forcepilot-wordmark.png" alt="ForcePilot"></div><div class="header-actions"><button class="iconbtn refresh-btn${state.refreshing ? ' is-loading' : ''}" id="refreshHeader" title="Refresh ForcePilot" aria-label="Refresh ForcePilot" ${state.refreshing ? 'disabled aria-busy="true"' : ''}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.4 7.1A7 7 0 1 0 19 12" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M17.4 4.9V7.1H15.2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="iconbtn settings-btn" id="settings" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.2 7.2 0 0 0-1.7-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42L9.12 5.07c-.61.25-1.18.58-1.7.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.11.19.34.27.55.19l2.49-1c.52.4 1.09.73 1.7.98l.38 2.65c.03.24.24.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.25 1.18-.58 1.7-.98l2.49 1c.21.08.44 0 .55-.19l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg></button></div></header><main class="content">${body}</main></div>`;
  bind();
}

function renderHome(recs) {
  const c = state.context;
  const other = state.recordingTabId && state.recordingTabId !== state.tabId;
  const hasRecordings = recs.length > 0;
  return `<section class="context-card">
    <div class="eyebrow">Current Salesforce page</div>
    <div class="context-title">${esc(c?.objectApiName || 'Salesforce')}</div>
  </section>
  ${state.inlineMessage ? `<div class="inline-message error" role="alert">${esc(state.inlineMessage)}</div>` : ''}
  ${!c ? '<div class="error"><strong>Salesforce is not connected.</strong><span>Refresh the page and try again.</span></div>' : ''}
  ${other ? '<div class="notice"><strong>Recording is active in another tab.</strong><span>Use that tab to stop the recording.</span></div>' : ''}
  <div class="home-actions actions"><button class="primary full-action" id="record" ${(!c || other) ? 'disabled' : ''}><span class="button-icon">●</span>Record</button></div>
  <section class="section recent-section">
    <div class="section-title-row"><h2>Saved recordings</h2><span class="section-count">${recs.length}</span></div>
    ${hasRecordings ? `<input class="search" id="search" placeholder="Search recordings…" value="${esc(state.filter)}"><div class="list">${recs.slice(0,12).map(r => `<button class="recording-row" data-id="${esc(r.id)}"><span class="row-main"><span class="recording-name">${esc(recordingTitle(r))}</span><span class="row-meta">${esc(recordingMeta(r))}</span></span><span class="row-chevron">›</span></button>`).join('')}</div>` : `<div class="empty-state"><strong>No recordings yet</strong><span>Record a Salesforce form to create one.</span></div>`}
  </section>`;
}

function renderLiveRecordingRows(steps) {
  return (steps || []).map((s, i) => `<div class="field-row recording-live-row"><span class="step-number">${i + 1}</span><span class="field-main"><span class="field-name">${esc(s.target.label)}</span><span class="field-detail"><span class="field-value">${esc(fmtStepValue(s))}</span><span class="field-type">${esc(fieldTypeLabel(s))}</span></span></span><button class="live-remove-field" type="button" data-remove-live-step="${i}" title="Remove field from recording" aria-label="Remove ${esc(s.target.label)} from recording"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l1 2h3v2H3V5h3l1-2Zm-2 5h10l-.7 9H5.7L5 8Zm3 2v5h1v-5H8Zm3 0v5h1v-5h-1Z"/></svg></button></div>`).join('') || '<div class="empty-state"><strong>Nothing recorded yet</strong></div>';
}

function renderRecording() {
  const adding = !!state.addingToRecordingId;
  const title = adding ? recordingTitle(state.recordings[state.addingToRecordingId]) : 'New recording';
  const hasSteps = state.activeSteps.length > 0;
  return `<section class="recording-top sticky-action ${adding ? 'recording-top-append' : ''}">
    <div class="recording-state"><span class="recording-dot" aria-hidden="true"></span><div><strong>${adding ? 'Adding field' : 'Recording'}</strong><span id="recording-object">${esc(adding ? title : (state.context?.objectLabel || state.context?.objectApiName || 'Salesforce'))}</span></div></div>
    <button class="stop-button" id="stop" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.2 5.2h7.6v9.6H6.2z"/></svg><span>${adding ? 'Done adding' : 'Stop recording'}</span></button>
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
      <label class="recording-name-editor"><span>Recording name</span><input class="edit-control ${state.saveNameError ? 'has-error' : ''}" id="pendingRecordingName" maxlength="200" value="${esc(suggested)}" placeholder="Recording name" aria-invalid="${state.saveNameError ? 'true' : 'false'}"><span class="name-error" role="alert" ${state.saveNameError ? '' : 'hidden'}>${esc(state.saveNameError || '')}</span></label>
      <div class="save-tip"><strong>*Tip:</strong> Use Object + status (e.g., Project – Scoping)</div>
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
    return `<select class="edit-control" data-edit-value="${i}">${typeOptions(s).map(o => `<option value="${esc(o.value)}" ${(String(v) === String(o.value) || String(v) === String(o.displayValue)) ? 'selected' : ''}>${esc(o.displayValue || o.value)}</option>`).join('')}</select>`;
  }
  if (t === 'Multipicklist' && typeOptions(s).length) {
    return `<div class="multi-editor">${typeOptions(s).map(o => {
      const on = valuesArray(v).some(x => String(x).toLowerCase() === String(o.value).toLowerCase() || String(x).toLowerCase() === String(o.displayValue).toLowerCase());
      return `<label><input type="checkbox" data-multi-index="${i}" data-multi-value="${esc(o.value)}" ${on ? 'checked' : ''}><span>${esc(o.displayValue || o.value)}</span></label>`;
    }).join('')}</div>`;
  }
  if (t === 'Date') return `<input class="edit-control" type="text" data-edit-value="${i}" value="${esc(dateFieldDisplay(s))}" placeholder="Today, Today + 3 days, Today - 2 days">`;
  return `<input class="edit-control" type="text" data-edit-value="${i}" value="${esc(Array.isArray(v) ? v.join('; ') : v && typeof v === 'object' && 'displayValue' in v ? v.displayValue : String(v ?? ''))}" placeholder="Recorded value">`;
}

function renderDetail(r) {
  const x = state.editing && state.draft ? state.draft : r;
  return `<section class="detail-page">${backButton('Back', 'backHome')}
  <section class="recording-header"><h1>${esc(recordingTitle(x))}</h1><div class="context-sub">${esc(recordingMeta(x))}</div></section>
  ${state.editing ? `<label class="recording-name-editor">Recording name<input class="edit-control" id="recordingName" value="${esc(x.name||recordingTitle(x))}" placeholder="Recording name"></label>` : ''}
  <div class="actions detail-actions">${state.editing ? '<button class="secondary action-button" id="cancelEdit">Cancel</button><button class="primary action-button" id="saveInline">Save changes</button>' : '<button class="primary autofill-button action-button" id="autofill"><span class="button-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M11.3 1.8 4.4 10h4.3l-.9 6.7 7-9.2h-4.4z"/></svg></span>Autofill</button><button class="secondary action-button" id="edit">Edit</button>'}</div>
  ${!state.editing ? `<div class="setting-row"><div class="setting-copy"><strong>Fill empty fields only</strong><span>Existing Salesforce values won't be changed.</span></div><label class="switch"><input type="checkbox" id="fillEmptyOnly" ${state.fillEmptyOnly ? 'checked' : ''}><span class="slider"></span></label></div>` : ''}
  <section class="detail-field-section"><div class="section-title-row detail-fields-title"><h2>Recorded fields</h2>${!state.editing ? '<button class="add-field-button" id="addField" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M9 4h2v5h5v2h-5v5H9v-5H4V9h5V4Z"/></svg><span>Add field</span></button>' : ''}</div>
  <div class="field-list detail-fields">${x.steps.map((s, i) => `<div class="field-row ${state.editing ? 'editing' : 'clickable'}" ${state.editing ? '' : `data-focus-step="${i}"`}>
    <span class="step-number">${i + 1}</span><span class="field-main"><span class="field-name">${esc(s.target.label)}</span>${state.editing ? `<span class="edit-wrap">${renderEditField(s, i)}<button class="delete-step" data-delete-step="${i}" title="Remove field" aria-label="Remove field"><svg viewBox="0 0 20 20"><path d="M7 3h6l1 2h3v2H3V5h3l1-2Zm-2 5h10l-.7 9H5.7L5 8Zm3 2v5h1v-5H8Zm3 0v5h1v-5h-1Z"/></svg></button></span>` : `<span class="field-detail"><span class="field-value">${esc(fmtStepValue(s))}</span><span class="field-type">${esc(fieldTypeLabel(s))}</span></span>`}</span>${state.editing ? '' : '<span class="row-chevron">›</span>'}</div>`).join('')}</div></section></section>`;
}

function renderRunning() {
  const total = state.progress.total || (state.recordings[state.selectedId]?.steps?.length || 0);
  const current = Math.min(state.progress.current || 0, total);
  const fieldName = state.progress.fieldName || (state.recordings[state.selectedId]?.steps?.[current]?.target?.label || 'Starting…');
  return `<section class="progress-page">${backButton('Back', 'backToDetail')}<div class="progress-header"><div class="eyebrow">Autofill</div><h1>${state.isRetrying ? 'Retrying failed fields…' : 'Filling fields…'}</h1><p>${state.isRetrying ? 'Retrying the fields that failed.' : `Applying ${total} recorded value${total === 1 ? '' : 's'}.`}</p></div><div class="progress-card"><div class="spinner"></div><div class="progress-current-field"><span>Current field</span><strong id="progress-field">${esc(fieldName)}</strong></div><strong id="progress-count">${current} of ${total}</strong><div class="progress-track"><span id="progress-bar" style="width:${total ? Math.round((current / total) * 100) : 0}%"></span></div></div></section>`;
}

function renderResult() {
  const r = state.recordings[state.selectedId];
  const exec = Array.isArray(state.run?.executed) ? state.run.executed : [];
  const counts = { filled: exec.filter(x => statusOf(x) === 'filled').length, skipped: exec.filter(x => statusOf(x) === 'skipped').length, failed: exec.filter(x => statusOf(x) === 'failed').length };
  const filter = ['all','filled','skipped','failed'].includes(state.resultTab) ? state.resultTab : 'all';
  const statusOrder = { failed: 0, skipped: 1, filled: 2 };
  const list = (filter === 'all' ? exec : exec.filter(x => statusOf(x) === filter)).slice().sort((a, b) => (statusOrder[statusOf(a)] ?? 9) - (statusOrder[statusOf(b)] ?? 9));
  const labels = { all: 'All', filled: 'Filled', skipped: 'Skipped', failed: 'Failed' };
  const icons = { filled: '✓', skipped: '—', failed: '!' };
  return `<section class="result-page"><div class="page-nav">${backButton('Back', 'backToDetail')}</div>
  ${(() => {
    const total = exec.length;
    const success = total > 0 && counts.failed === 0 && counts.skipped === 0;
    const summary = total === 0
      ? (state.run?.error ? 'No fields were autofilled' : 'No fields were processed')
      : success
        ? `All ${total} field${total === 1 ? '' : 's'} filled successfully`
        : counts.failed
        ? `${counts.failed} field${counts.failed === 1 ? '' : 's'} failed`
        : `${counts.skipped} field${counts.skipped === 1 ? '' : 's'} skipped`;
    const summaryClass = success ? 'result-success-message' : counts.failed ? 'result-failure-message' : 'result-neutral-message';
    return `<section class="result-header"><div class="eyebrow">Autofill results</div><h1>${esc(r?.name || 'Autofill')}</h1><div class="${summaryClass}" role="status" aria-live="polite">${esc(summary)}</div>${state.run?.error ? `<div class="result-error"><strong>Autofill could not complete</strong><span>${esc(state.run.error)}</span></div>` : ''}</section>`;
  })()}
  <section class="result-section"><div class="section-title-row result-fields-title"><h2>Fields</h2>${counts.failed ? '<button class="primary retry-inline" id="retryFailed"><span class="retry-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 4a6 6 0 1 1-5.2 3H3l2.8-3L8.6 7H7a4 4 0 1 0 3-1.3V4Z"/></svg></span>Retry</button>' : ''}</div><div class="result-tabs">${[['all',exec.length],['filled',counts.filled],['skipped',counts.skipped],['failed',counts.failed]].map(([k,n]) => `<button class="result-tab ${filter === k ? 'active' : ''}" data-result-tab="${k}">${labels[k]} ${n}</button>`).join('')}</div>
  <div class="result-list">${list.map(x => { const st = statusOf(x); const reason = st === 'filled' ? 'Filled' : st === 'skipped' ? (x.result?.message || 'Skipped') : (x.result?.message || 'Could not fill'); const overwrite = st === 'skipped' ? `<button class="result-overwrite" type="button" data-overwrite-index="${x.index}">Use recorded value</button>` : ''; return `<div class="result-row ${st}" data-focus-index="${x.index}" role="button" tabindex="0"><span class="result-status-icon">${icons[st] || '•'}</span><span class="result-row-main"><span class="result-row-title">${esc(x.step.target.label)}</span><span class="result-row-meta"><span>${esc(fmtStepValue(x.step))}</span><span class="result-type">${esc(fieldTypeLabel(x.step))}</span></span><span class="result-row-reason">${esc(reason)}</span>${overwrite}</span><span class="result-chevron">›</span></div>`; }).join('') || `<div class="result-empty"><strong>${filter === 'failed' ? 'No failed fields' : filter === 'skipped' ? 'No skipped fields' : filter === 'filled' ? 'No filled fields' : 'No results'}</strong></div>`}</div></section>
  </section>`;
}

function backButton(label = 'Back', id = 'backHome') {
  return `<button class="backtop" id="${id}" type="button"><span class="back-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M12.6 4.6 7.2 10l5.4 5.4-1.4 1.4L4.4 10l6.8-6.8 1.4 1.4Z"/></svg></span><span>${label}</span></button>`;
}

function bind() {
  document.getElementById('record')?.addEventListener('click', startRecording);
  document.getElementById('stop')?.addEventListener('click', stopRecording);
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
  document.getElementById('addField')?.addEventListener('click', startAddField);
  document.getElementById('edit')?.addEventListener('click', async () => { state.draft = clone(state.recordings[state.selectedId]); state.editing = true; render(); await hydrateDraftPicklists(state.draft); render(); });
  document.getElementById('cancelEdit')?.addEventListener('click', () => { state.editing = false; state.draft = null; render(); });
  document.getElementById('saveInline')?.addEventListener('click', saveInline);
  document.getElementById('fillEmptyOnly')?.addEventListener('change', async e => { state.fillEmptyOnly = e.target.checked; await saveSettings({...await getSettings(), fillEmptyOnly: state.fillEmptyOnly}); });
  document.getElementById('refreshHeader')?.addEventListener('click', refresh);
  document.getElementById('settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('backHome')?.addEventListener('click', async () => {
    state.run = null; state.resultTab = 'all'; state.editing = false; state.draft = null; state.addingToRecordingId = null; state.view = 'home';
    try { await chrome.storage.session.remove(LAST_RUN_KEY); } catch {}
    render();
  });
  document.getElementById('backToDetail')?.addEventListener('click', async () => {
    state.run = state.view === 'result' ? state.run : null; state.resultTab = state.view === 'result' ? state.resultTab : 'all'; state.editing = false; state.draft = null; state.addingToRecordingId = null;
    if (state.selectedId && state.recordings[state.selectedId]) state.view = 'detail'; else state.view = 'home';
    if (state.view !== 'result') { try { await chrome.storage.session.remove(LAST_RUN_KEY); } catch {} }
    render();
  });
  document.getElementById('retryFailed')?.addEventListener('click', retryFailed);
  document.getElementById('search')?.addEventListener('input', e => { state.filter = e.target.value; clearTimeout(window.fpSearchTimer); window.fpSearchTimer = setTimeout(render, 150); });
  document.querySelectorAll('.recording-row[data-id]').forEach(b => b.addEventListener('click', () => { state.selectedId = b.dataset.id; state.run = null; state.view = 'detail'; state.editing = false; render(); }));
  document.querySelectorAll('[data-result-tab]').forEach(b => b.addEventListener('click', () => { state.resultTab = b.dataset.resultTab; render(); }));
  document.querySelectorAll('[data-focus-step]').forEach(b => b.addEventListener('click', e => focusStep(Number(e.currentTarget.dataset.focusStep))));
  document.querySelectorAll('[data-remove-live-step]').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); await removeLiveRecordingStep(Number(e.currentTarget.dataset.removeLiveStep)); }));
  document.querySelectorAll('[data-focus-index]').forEach(b => { b.addEventListener('click', e => { if (e.target.closest('[data-overwrite-index]')) return; focusIndex(Number(e.currentTarget.dataset.focusIndex)); }); b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-overwrite-index]')) { e.preventDefault(); focusIndex(Number(e.currentTarget.dataset.focusIndex)); } }); });
  document.querySelectorAll('[data-overwrite-index]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); overwriteSkipped(Number(e.currentTarget.dataset.overwriteIndex)); }));
  document.querySelectorAll('[data-delete-step]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); state.draft.steps.splice(Number(e.currentTarget.dataset.deleteStep), 1); state.draft.steps.forEach((s, i) => s.sequence = i + 1); render(); }));
}

async function saveInline() {
  if (!state.draft) return;
  const settings = await getSettings();
  const relativeDateMode = settings.dateRelativeToToday !== false;
  state.draft.steps.forEach((s, i) => {
    const t = fieldTypeLabel(s);
    const bool = document.querySelector(`[data-edit-bool="${i}"]`);
    if (bool) s.value = bool.checked;
    else if (t === 'Multipicklist' && typeOptions(s).length) {
      s.value = [...document.querySelectorAll(`[data-multi-index="${i}"]:checked`)]
        .map(x => x.dataset.multiValue).filter(Boolean);
    } else {
      const el = document.querySelector(`[data-edit-value="${i}"]`);
      if (el) {
        if (t === 'Date') {
          const input = String(el.value || '').trim();
          const recordingDate = s.meta?.dateRecordedOn || state.draft?.recordingDate || localDateISO();
          const relativeOffset = parseRelativeDate(input);
          const relativeMode = relativeDateMode;
          if (relativeMode) {
            if (relativeOffset !== null) {
              s.value = shiftDateFrom(recordingDate, relativeOffset);
              s.meta = { ...(s.meta || {}), dateRecordedOn: recordingDate, dateOffsetDays: relativeOffset, dateExpression: dateOffsetLabel(relativeOffset), dateMode: 'relative' };
            } else {
              const normalized = input.replace(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/, '$3-$1-$2');
              const offset = dateOffsetDays(recordingDate, normalized);
              if (offset !== null && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
                s.value = normalized;
                s.meta = { ...(s.meta || {}), dateRecordedOn: recordingDate, dateOffsetDays: offset, dateExpression: dateOffsetLabel(offset), dateMode: 'relative' };
              } else {
                s.value = input;
                if (s.meta) { delete s.meta.dateExpression; delete s.meta.dateOffsetDays; delete s.meta.dateMode; }
              }
            }
          } else {
            let normalized = input.replace(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/, '$3-$1-$2');
            if (relativeOffset !== null) normalized = shiftDateFrom(recordingDate, relativeOffset);
            s.value = normalized;
            if (s.meta) { delete s.meta.dateExpression; delete s.meta.dateOffsetDays; delete s.meta.dateMode; }
          }
        } else {
          s.value = cleanEditedValue(s, el.value);
        }
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
  render();
}

async function refresh() {
  if (state.refreshing) return;
  const previousView = state.view;
  const previousSelected = state.selectedId;
  const previousRun = state.run;
  const previousResultTab = state.resultTab;
  const previousEditing = state.editing;
  const previousDraft = state.draft;
  const previousRecording = state.recording;
  state.refreshing = true;
  render();
  try {
    const tab = await activeTab();
    const [recs, settings, active, lock] = await Promise.all([
      getRecordings(), getSettings(),
      chrome.runtime.sendMessage({ type:'GET_ACTIVE_CONTEXT' }).catch(() => ({})),
      chrome.runtime.sendMessage({ type:'GET_RECORDING_LOCK' }).catch(() => ({}))
    ]);
    state.recordings = recs || {};
    state.tabId = active?.tabId || tab?.id || null;
    state.context = active?.context || null;
    state.recordingTabId = lock?.recordingTabId ?? null;
    state.recording = previousRecording || (!!state.recordingTabId && state.recordingTabId === state.tabId);
    state.fillEmptyOnly = settings.fillEmptyOnly !== false;
    state.selectedId = previousSelected && state.recordings[previousSelected] ? previousSelected : (state.recordings[state.selectedId] ? state.selectedId : null);
    state.run = previousRun;
    state.resultTab = previousResultTab;
    state.editing = previousEditing;
    state.draft = previousDraft;
    if (tab?.id) {
      const d = await chrome.tabs.sendMessage(tab.id, { type:'GET_RECORDING_STATE' }).catch(() => null);
      if (d?.recording) state.activeSteps = d.steps || state.activeSteps;
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
    if (state.pendingRecording) state.view = 'save-name';
    else if (previousView === 'recording' && state.recording) state.view = 'recording';
    else if (previousView === 'result' && state.run && state.selectedId) state.view = 'result';
    else if (previousView === 'detail' && state.selectedId) state.view = 'detail';
    else if (previousView === 'running') state.view = 'running';
    else state.view = 'home';
  } finally {
    state.refreshing = false;
    render();
  }
}

async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null; }
async function ensureTabConnection(tab) { if (!tab?.id) return { ok: false, message: 'Open a Salesforce page first.' }; return chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPTS', tabId: tab.id }).catch(e => ({ ok: false, message: e?.message || 'Could not connect to Salesforce.' })); }
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
  try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: releaseTabId }); } catch {}
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
  try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: releaseTabId }); } catch {}
  render();
}

async function startAddField() {
  const recording = state.recordings[state.selectedId];
  if (!recording) return;
  const tab = await activeTab();
  if (!tab?.id) return showInline('Open the Salesforce record where you want to add a field.');
  const ready = await ensureTabConnection(tab);
  if (!ready?.ok) return showInline(ready.message || 'Could not connect to Salesforce.');
  const currentContext = state.context || {};
  if (recording.context?.objectApiName && currentContext.objectApiName && recording.context.objectApiName !== currentContext.objectApiName) {
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
  window.fpTimer = setInterval(async () => {
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

async function startRecording() {
  const tab = await activeTab(); if (!tab?.id) return;
  const ready = await ensureTabConnection(tab); if (!ready?.ok) return showInline(ready.message || 'Could not connect to Salesforce.');
  const r = await sendTab(tab, { type: 'START_RECORDING' });
  if (!r?.ok) return showInline(r?.message || 'Could not start recording.');
  state.pendingRecording = null; state.pendingRecordingTabId = null; state.recording = true; state.recordingTabId = tab.id; state.addingToRecordingId = null; state.context = r.context || state.context; state.activeSteps = r.steps || []; state.run = null; state.view = 'recording'; render();
  clearInterval(window.fpTimer); window.fpTimer = setInterval(async () => { const d = await sendTab(tab, { type:'GET_RECORDING_STATE' }); if (!d?.recording) return; state.activeSteps = d.steps || []; const list=document.getElementById('recording-field-list'); if(list){ list.innerHTML = renderLiveRecordingRows(state.activeSteps); const note=document.getElementById('recording-note'); if(note) note.classList.toggle('is-hidden',state.activeSteps.length>0); list.querySelectorAll('[data-remove-live-step]').forEach(b=>b.addEventListener('click',async e=>{ e.stopPropagation(); await removeLiveRecordingStep(Number(e.currentTarget.dataset.removeLiveStep)); })); } }, 900);
}

async function stopRecording() {
  clearInterval(window.fpTimer);
  const id = state.recordingTabId;
  const tab = id ? await chrome.tabs.get(id).catch(() => null) : null;
  const r = tab?.id ? await sendTab(tab, { type: 'STOP_RECORDING' }) : null;
  state.recording = false; state.recordingTabId = null; state.addingToRecordingId = null;
  if (r?.recording) {
    const recordedSteps = Array.isArray(r.recording.steps) ? r.recording.steps.filter(Boolean) : [];
    if (recordedSteps.length === 0) {
      const pendingTabId = state.pendingRecordingTabId || id;
      state.pendingRecording = null;
      state.pendingRecordingTabId = null;
      state.selectedId = null;      state.run = null;
      state.view = 'home';
      await clearPendingRecordingInTab(pendingTabId);
      if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id }); } catch {} }
      render();
      showInline('No Salesforce fields were recorded, so the recording was not saved.');
      return;
    }
    if (r.pendingSave) {
      await receivePendingRecording(r.recording, { sourceTabId: id });
      if (id) { try { await chrome.runtime.sendMessage({ type: 'RELEASE_RECORDING_LOCK', tabId: id }); } catch {} }
    } else {
      state.recordings[r.recording.id] = r.recording;
      state.selectedId = r.recording.id;
      state.pendingRecording = null;
      state.run = null;
      state.view = 'detail';
    }
  } else showInline(r?.message || 'Recording could not be stopped.');
  render();
}

async function startAutofill() {
  const r = state.recordings[state.selectedId]; if (!r) return;
  const tab = await activeTab(); if (!tab?.id) return showInline('Open a Salesforce page to run Autofill.');
  const ready = await ensureTabConnection(tab);
  if (!ready?.ok) { state.run = { ok: false, executed: [], error: ready.message || 'Could not connect to Salesforce.' }; state.resultTab = 'all'; state.view = 'result'; render(); return; }
  const totalSteps = Array.isArray(r.steps) ? r.steps.length : 0;
  if (!totalSteps) {
    state.run = { ok: false, executed: [], error: 'This recording has no fields to autofill.' };
    state.resultTab = 'all'; state.view = 'result'; render();
    return;
  }
  // Keep explicit per-field Autofill settings, but recover older recordings
  // whose fields were all marked disabled by an earlier build.
  let runRecording = {...r, steps: r.steps.filter(Boolean)};
  const enabledSteps = runRecording.steps.filter(s => s?.enabled !== false);
  if (!enabledSteps.length && runRecording.steps.length) runRecording = {...runRecording, steps: runRecording.steps.map(s => ({...s, enabled: true}))};
  state.run = null; state.isRetrying = false; state.progress = { current: 0, total: runRecording.steps.length, fieldName: runRecording.steps[0]?.target?.label || 'Starting…' }; state.view = 'running'; render();
  clearInterval(window.fpProgressTimer);
  window.fpProgressTimer = setInterval(async () => { const d = await sendTab(tab, { type:'GET_RECORDING_STATE' }); const idx = Number.isFinite(d?.currentStepIndex) ? d.currentStepIndex : -1; if (idx >= 0) { state.progress.current = Math.min(idx + 1, runRecording.steps.length); const count=document.getElementById('progress-count'); const bar=document.getElementById('progress-bar'); if(count) count.textContent=`${state.progress.current} of ${runRecording.steps.length}`; if(bar) bar.style.width=`${runRecording.steps.length ? Math.round((state.progress.current/runRecording.steps.length)*100) : 0}%`; const field=document.getElementById('progress-field'); if(field) field.textContent=runRecording.steps[idx]?.target?.label||'Starting…'; } }, 350);
  const resp = await sendTab(tab, { type: 'REPLAY_RECORDING', recording: runRecording, fillOnlyBlank: state.fillEmptyOnly });
  clearInterval(window.fpProgressTimer);
  state.run = resp || { ok: false, executed: [], error: 'Salesforce did not respond.' };
  if (!Array.isArray(state.run.executed)) state.run.executed = [];
  state.progress.current = state.run.executed.length; state.resultTab = 'all'; state.view = 'result';
  try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: r.id, run: state.run, resultTab: 'all' } }); } catch {}
  render();
}

async function retryFailed() {
  const r = state.recordings[state.selectedId]; const failed = (state.run?.executed || []).filter(x => statusOf(x) === 'failed').map(x => x.index); if (!r || !failed.length) return;
  const tab = await activeTab(); if (!tab?.id) return;
  const ready = await ensureTabConnection(tab); if (!ready?.ok) return showInline(ready.message || 'Could not connect to Salesforce.');
  state.run = null; state.isRetrying = true; state.progress = { current: 0, total: failed.length, fieldName: r.steps[failed[0]]?.target?.label || 'Starting…' }; state.view = 'running'; render();
  const resp = await sendTab(tab, { type: 'REPLAY_RECORDING', recording: r, onlyIndexes: failed, fillOnlyBlank: false });
  state.run = resp || { ok: false, executed: [], error: 'Salesforce did not respond.' }; if (!Array.isArray(state.run.executed)) state.run.executed = []; state.isRetrying = false;
  state.resultTab = 'all'; state.view = 'result'; try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: r.id, run: state.run, resultTab: 'all' } }); } catch {} render();
}

async function overwriteSkipped(index) {
  const r = state.recordings[state.selectedId]; const current = state.run?.executed?.find(x => x.index === index); if (!r || !current || statusOf(current) !== 'skipped') return;
  const tab = await activeTab(); if (!tab?.id) return;
  const ready = await ensureTabConnection(tab); if (!ready?.ok) return showInline(ready.message || 'Could not connect to Salesforce.');
  const button = document.querySelector(`[data-overwrite-index="${index}"]`); if (button) { button.disabled = true; button.textContent = 'Filling…'; }
  const resp = await sendTab(tab, { type: 'OVERWRITE_STEP', recording: r, index });
  const replacement = Array.isArray(resp?.executed) ? resp.executed.find(x => x.index === index) : null;
  if (replacement) { state.run.executed = state.run.executed.map(x => x.index === index ? replacement : x); state.run.ok = !state.run.executed.some(x => statusOf(x) === 'failed'); }
  try { await chrome.storage.session.set({ [LAST_RUN_KEY]: { recordingId: r.id, run: state.run, resultTab: state.resultTab } }); } catch {}
  render();
}

async function focusStep(i) { const r = state.recordings[state.selectedId], tab = await activeTab(); if (r && tab?.id && r.steps[i]) await sendTab(tab, { type: 'FOCUS_FIELD', target: r.steps[i].target }); }
async function focusIndex(i) { const ex = state.run?.executed?.find(x => x.index === i), tab = await activeTab(); if (ex && tab?.id) await sendTab(tab, { type: 'FOCUS_FIELD', target: ex.step.target }); }
function showInline(msg) { state.inlineMessage = String(msg || ''); if (state.view !== 'home' && !state.recording) state.view = 'home'; render(); clearTimeout(window.fpInlineMessageTimer); window.fpInlineMessageTimer = setTimeout(() => { state.inlineMessage = ''; render(); }, 3000); }

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'RECORDING_AUTO_STOPPED' && msg.recording) {
    receivePendingRecording(msg.recording, { auto: true, pendingSave: msg.pendingSave !== false, sourceTabId: sender?.tab?.id || null });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes['forcepilot.recordings.v1']) return;
  getRecordings().then(next => { state.recordings = next; if (state.selectedId && !state.recordings[state.selectedId]) { state.selectedId = null; state.run = null; state.view = 'home'; state.editing = false; state.draft = null; } render(); }).catch(() => {});
});

refresh();
