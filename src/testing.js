/*
 * ForcePilot Testing Mode data + persistence helpers.
 * Phase 1: durable multi-session testing, session-scoped evidence, and migration
 * from the previous single-session implementation.
 */

export const TESTING_SESSION_KEY = 'forcepilot.testing.session.v1';
export const TESTING_SESSIONS_KEY = 'forcepilot.testing.sessions.v2';
export const TESTING_SESSIONS_INDEX_KEY = 'forcepilot.testing.sessions.index.v1';
export const TESTING_SCHEMA_VERSION = 3;
export const TESTING_UI_STATE_KEY = 'forcepilot.testing.ui-state.v1';

const TESTING_DB_NAME = 'forcepilot.testing.v1';
const TESTING_DB_VERSION = 1;
const TESTING_STORE = 'evidence';

const uid = prefix => {
  try { return `${prefix}_${crypto.randomUUID()}`; } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
};

const normalizeHeader = value => String(value ?? '')
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .replace(/[\s_\-]+/g, ' ')
  .replace(/[^a-z0-9 ]/g, '')
  .replace(/\s+/g, ' ');

function canonicalHeader(value) {
  const header = normalizeHeader(value);
  const aliases = {
    'work product': 'work product', 'workproduct': 'work product', 'us': 'work product', 'user story': 'work product',
    'object type': 'object type', 'record type': 'object type',
    'test case': 'test case', 'testcase': 'test case', 'test case name': 'test case name', 'testcase name': 'test case name',
    'name': 'name', 'test name': 'test case name', 'test case title': 'title', 'test title': 'title', 'test scenario': 'title', 'title': 'title', 'scenario': 'title', 'scenario name': 'title',
    'step index': 'step index', 'step number': 'step index', 'step no': 'step index',
    'steps': 'steps', 'step': 'steps', 'input': 'input', 'expected result': 'expected result', 'expected outcome': 'expected result'
  };
  return aliases[header] || header;
}

function stripCodeFence(text) {
  return String(text ?? '').trim()
    .replace(/^```(?:text|tsv|markdown|md|csv)?\s*/i, '')
    .replace(/\s*```$/i, '').trim();
}

function splitPipeRow(line) {
  let value = String(line ?? '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  const cells = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length && (value[i + 1] === '|' || value[i + 1] === '\\')) {
      current += value[++i];
      continue;
    }
    if (ch === '|') { cells.push(current.trim()); current = ''; }
    else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function looksLikeMarkdownSeparator(cells) {
  return cells.length >= 2 && cells.every(cell => /^:?-{2,}:?$/.test(String(cell).trim()));
}

function tableRowsFromText(source) {
  const lines = source.split(/\r?\n/).filter(line => String(line).trim() && !/^```/.test(String(line).trim()));
  if (!lines.length) return null;
  const hasPipeRows = lines.some(line => String(line).trim().startsWith('|') && String(line).includes('|'));
  const hasTsv = lines.some(line => String(line).includes('\t'));
  const recognizedHeaders = new Set(['work product', 'object type', 'test case', 'test case name', 'test case title', 'test name', 'name', 'title', 'step index', 'steps', 'input', 'expected result', 'scenario name', 'test scenario']);
  const hasCsv = !hasPipeRows && !hasTsv && lines.some(line => {
    const cells = String(line).split(',').map(canonicalHeader);
    return String(line).includes(',') && cells.filter(cell => recognizedHeaders.has(cell)).length >= 2;
  });
  if (!hasPipeRows && !hasTsv && !hasCsv) return null;
  const delimiter = hasPipeRows ? 'pipe' : hasTsv ? 'tab' : 'csv';
  const rows = lines.map(line => {
    if (delimiter === 'pipe') return splitPipeRow(line);
    if (delimiter === 'tab') return String(line).split('\t').map(cell => cell.trim());
    // Minimal CSV reader supporting commas inside quoted cells.
    const cells = []; let value = ''; let quoted = false;
    const lineText = String(line);
    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];
      if (ch === '"' && lineText[i + 1] === '"' && quoted) { value += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(value.trim()); value = ''; }
      else value += ch;
    }
    cells.push(value.trim()); return cells;
  });
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    if (looksLikeMarkdownSeparator(rows[i])) rows.splice(i--, 1);
  }
  const headerAt = rows.findIndex(row => row.map(canonicalHeader).some(h => ['work product', 'object type', 'test case', 'test case name', 'test case title', 'test name', 'name', 'title', 'scenario name', 'test scenario', 'step index'].includes(h)));
  if (headerAt < 0) return null;
  return { rows, headerAt, delimiter };
}

function parseHeaderlessOneColumnMarkdown(source) {
  const lines = String(source || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || !lines.some(line => line.startsWith('|') && line.endsWith('|'))) return null;
  const rows = [];
  for (const line of lines) {
    if (/^```/.test(line)) continue;
    if (!line.startsWith('|') || !line.endsWith('|')) return null;
    const cells = splitPipeRow(line);
    if (cells.every(cell => /^:?-{2,}:?$/.test(String(cell).trim()))) continue;
    if (cells.length !== 1) return null;
    const cell = cleanTitle(cells[0]);
    if (cell) rows.push(cell);
  }
  if (!rows.length) return null;
  const knownHeaders = new Set(['work product', 'object type', 'test case', 'test case name', 'test case title', 'test name', 'name', 'title', 'scenario name', 'test scenario']);
  const titles = rows.filter((row, index) => !(index === 0 && knownHeaders.has(canonicalHeader(row))));
  if (!titles.length) return null;
  return { testCases: titles.map((title, index) => ({ title, rowIndex: index + 1, ambiguous: false })), workProducts: [], warnings: [], format: 'headerless-one-column-table', sourceRowCount: titles.length, ignoredStepRows: [] };
}

function findHeaderIndex(headers, wanted) {
  return headers.findIndex(header => wanted.includes(header));
}

function cleanTitle(value) {
  return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/\u00a0/g, ' ').trim();
}

// Old builds accidentally exposed the import-review panel as scenario titles in
// persisted sessions. Recognize only that panel's fixed UI copy so real titles
// (including Step1, duplicate titles, and ordinary phrases) remain untouched.
function normalizeReviewText(value) {
  return cleanTitle(value).replace(/<[^>]+>/g, ' ').replace(/[*_]{1,3}/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isLegacyImportReviewArtifact(value) {
  const text = normalizeReviewText(value);
  return text === 'review import'
    || /^\d+\s+line\(s\) beginning with step\s+1,?\s*step\s+2,?\s*etc\. were excluded as likely procedural steps\.?$/.test(text)
    || /^\d+\s+exact duplicate title\(s\) were found\./.test(text)
    || /^\d+\s+possible instruction lines skipped\.?$/.test(text)
    || text.startsWith('these lines look like execution instructions.')
    || text === 'import as scenario';
}

function isLegacyReviewDump(values) {
  const texts = (values || []).map(normalizeReviewText);
  return texts.some(text => text === 'review import')
    || texts.some(text => /^\d+\s+line\(s\) beginning with step/.test(text))
    || texts.some(text => /^\d+\s+exact duplicate title\(s\) were found/.test(text))
    || texts.some(text => /^\d+\s+possible instruction lines skipped/.test(text))
    || texts.some(text => text.startsWith('these lines look like execution instructions.'));
}

function isLegacyReviewUiLabel(value) {
  const text = normalizeReviewText(value);
  return /^\d+\s+scenarios?$/.test(text)
    || /^scenario\s+\d+(?:\s*[·•-]\s*selected)?$/.test(text);
}

function isLegacyImportWarning(value) {
  const text = normalizeReviewText(value);
  return isLegacyImportReviewArtifact(text)
    || /^\d+\s+line\(s\) beginning with step/.test(text)
    || /^\d+\s+exact duplicate title\(s\) were found/.test(text)
    || /^\d+\s+possible instruction lines skipped/.test(text);
}

function parseStructuredTable(source) {
  const table = tableRowsFromText(source);
  if (!table) return null;
  const headers = table.rows[table.headerAt].map(canonicalHeader);
  const productIndex = findHeaderIndex(headers, ['work product']);
  const objectIndex = findHeaderIndex(headers, ['object type']);
  const stepIndex = findHeaderIndex(headers, ['step index']);
  const stepTextIndex = findHeaderIndex(headers, ['steps', 'input']);
  const expectedIndex = findHeaderIndex(headers, ['expected result']);
  const nameIndex = findHeaderIndex(headers, ['name', 'test case name', 'title', 'scenario name', 'test scenario']);
  const testCaseIndex = findHeaderIndex(headers, ['test case']);
  // Do not assume a title column globally: some exports put the title in Name,
  // while other layouts put it in Test Case. Resolve it per row using the row type.
  const titleIndexes = [nameIndex, testCaseIndex].filter(index => index >= 0);
  if (!titleIndexes.length) return null;

  const workProducts = [];
  const cases = [];
  const ignoredStepRows = [];
  const rows = table.rows.slice(table.headerAt + 1);
  rows.forEach((cells, offset) => {
    const objectType = objectIndex >= 0 ? String(cells[objectIndex] ?? '').trim().toLowerCase() : '';
    const stepValue = stepIndex >= 0 ? String(cells[stepIndex] ?? '').trim() : '';
    const stepText = stepTextIndex >= 0 ? String(cells[stepTextIndex] ?? '').trim() : '';
    const expected = expectedIndex >= 0 ? String(cells[expectedIndex] ?? '').trim() : '';
    const wp = productIndex >= 0 ? String(cells[productIndex] ?? '').trim() : '';
    if (wp && !workProducts.includes(wp)) workProducts.push(wp);

    const compactObjectType = objectType.replace(/[\s_-]+/g, '');
    const rawTitleValues = titleIndexes.map(index => cleanTitle(cells[index])).filter(Boolean);
    const isLineReferenceOnly = rawTitleValues.length > 0 && rawTitleValues.every(value => /^line\s*\[\d+\]$/i.test(value));
    if (['testcasestep', 'testcasesteps'].includes(compactObjectType) || (stepValue && !rawTitleValues.length && (stepText || expected)) || (stepValue && isLineReferenceOnly && (stepText || expected))) {
      ignoredStepRows.push(offset + table.headerAt + 2); return;
    }

    const nameTitle = nameIndex >= 0 ? cleanTitle(cells[nameIndex]) : '';
    const testCaseTitle = testCaseIndex >= 0 ? cleanTitle(cells[testCaseIndex]) : '';
    // Salesforce Test Case rows use Name. Other formats with a populated
    // Test Case column use that explicit title cell, even if Step Index is 1.
    let title = '';
    if ((objectType === 'test case' || objectType === 'testcase') && nameTitle) title = nameTitle;
    else if (testCaseTitle) title = testCaseTitle;
    else if (nameTitle) title = nameTitle;
    if (!title) return;
    cases.push({ title, rowIndex: offset + table.headerAt + 2, ambiguous: false });
  });
  if (!cases.length) return { testCases: [], workProducts, warnings: ['No scenario titles could be detected in this table. Check the title column.'], format: 'table', sourceRowCount: rows.length, ignoredStepRows };
  return { testCases: cases, workProducts, warnings: [], format: 'table', sourceRowCount: rows.length, ignoredStepRows };
}

function unquoteOuter(text) {
  const value = String(text ?? '').trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1).trim();
  return value;
}

function parsePlainText(source) {
  const lines = String(source ?? '').replace(/\r/g, '').split('\n');
  const containsLegacyReviewDump = isLegacyReviewDump(lines);
  const candidates = [];
  let i = 0;
  while (i < lines.length) {
    let raw = String(lines[i] ?? '').trim();
    const lineNumber = i + 1;
    i++;
    if (!raw || /^```/.test(raw) || /^\|?\s*:?-{2,}:?\s*\|?$/.test(raw)) continue;

    // An explicitly quoted, multiline entry is one title, not several cases.
    const quote = raw[0] === '"' ? '"' : raw[0] === "'" ? "'" : null;
    if (quote && !(raw.length > 1 && raw.endsWith(quote))) {
      const parts = [raw.slice(1)];
      let closed = false;
      while (i < lines.length) {
        const next = String(lines[i] ?? '').trim(); i++;
        if (next.endsWith(quote)) { parts.push(next.slice(0, -1)); closed = true; break; }
        parts.push(next);
      }
      raw = parts.join('\n').trim();
      if (!closed) raw = `${quote}${raw}`;
    } else raw = unquoteOuter(raw);

    // Bullets and ordinary numbered-list markers are formatting, not the title.
    raw = raw.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
    if (!raw) continue;
    // If the input was copied from the broken old review UI, remove that UI's
    // generated labels/warnings but preserve all actual scenario lines such as
    // Step1..Step6 and preserve intentional duplicates.
    if (containsLegacyReviewDump && (isLegacyImportReviewArtifact(raw) || isLegacyReviewUiLabel(raw))) continue;
    // Plain-text mode has no reliable way to distinguish a scenario title from
    // a procedural-looking line. Preserve every non-empty line as supplied.
    if (new Set(['work product','object type','test case','test case name','test case title','test name','name','title','scenario name','test scenario']).has(canonicalHeader(raw))) continue;
    if (/^\|?\s*(?:work product|object type|test case|test case name|test case title|test name|test scenario|name|title)\s*\|/i.test(raw)) continue;
    candidates.push({ title: cleanTitle(raw), rowIndex: lineNumber, ambiguous: false });
  }
  if (!candidates.length) throw new Error('No scenario titles were detected. Paste a table or a list with one scenario title per line.');
  // Do not filter Step1/Step 1 lines and do not warn about exact duplicates.
  // In plain text, the user's intent cannot be inferred reliably; preserve all
  // entries and let the standard optional scenario editor handle corrections.
  return { testCases: candidates, workProducts: [], warnings: [], format: 'plain-text', sourceRowCount: candidates.length, ignoredStepRows: [] };
}

export function parseTestCasePaste(text) {
  const source = stripCodeFence(text);
  if (!source) throw new Error('Paste your scenarios first.');
  let parsed = parseStructuredTable(source);
  if (!parsed) parsed = parseHeaderlessOneColumnMarkdown(source);
  if (!parsed) parsed = parsePlainText(source);
  const workProducts = [...new Set((parsed.workProducts || []).map(value => String(value || '').trim()).filter(Boolean))];
  const workProduct = workProducts.length === 1 ? workProducts[0] : '';
  // Import review warnings were removed: procedural-looking lines and exact
  // duplicate titles are valid input. A missing/ambiguous Work Product is
  // handled by the session-name dialog at import time instead of a warning.
  const warnings = [];
  if (!parsed.testCases?.length) throw new Error('No scenario titles were detected. Check the pasted content and try again.');
  // Exact duplicate titles are allowed and imported as separate scenarios.
  const testCases = parsed.testCases.map(item => ({
    id: uid('tc'), title: String(item.title || '').trim(), status: 'not-marked', statusSource: 'none',
    ...(item.ambiguous ? { importWarning: 'This title appeared on a row that also contained a step index. Please verify it.' } : {})
  }));
  return {
    workProduct,
    workProducts,
    warnings,
    format: parsed.format,
    sourceRowCount: parsed.sourceRowCount || testCases.length,
    excludedLines: Array.isArray(parsed.excludedLines) ? parsed.excludedLines : [],
    testCases
  };
}

function normalizeTestCase(testCase, workProduct = '') {
  const tc = testCase && typeof testCase === 'object' ? testCase : {};
  const rawStatus = String(tc.status ?? tc.result ?? '').toLowerCase();
  const status = ['pass', 'fail', 'blocked', 'not-marked'].includes(rawStatus) ? rawStatus : 'not-marked';
  const rawSources = [tc.statusSource, tc.resultSource].map(value => String(value || '').toLowerCase());
  let source = rawSources.some(value => ['automatic', 'auto'].includes(value)) ? 'automatic'
    : rawSources.includes('manual') ? 'manual'
    : rawSources.includes('none') ? 'none'
    : (status === 'not-marked' ? 'none' : 'manual');
  // Screenshot presence is not proof of a passed test. Older builds used
  // resultSource: 'auto' (and sometimes result: 'PASS') for evidence-driven passes.
  const normalizedStatus = source === 'automatic' ? 'not-marked' : status;
  if (source === 'automatic') source = 'none';
  const normalized = {
    id: tc.id || uid('tc'),
    workProduct: String(tc.workProduct || workProduct || '').trim(),
    title: String(tc.title ?? ''),
    status: normalizedStatus,
    statusSource: source
  };
  if (tc.importWarning) normalized.importWarning = String(tc.importWarning);
  return normalized;
}

function normalizeSession(rawSession) {
  if (!rawSession || typeof rawSession !== 'object') return null;
  const session = rawSession;
  session.id = session.id || uid('session');
  session.version = TESTING_SCHEMA_VERSION;
  session.mode = session.mode === 'evidence-only' ? 'evidence-only' : 'test-cases';
  session.workProduct = String(session.workProduct || '').trim();
  session.exportFilename = String(session.exportFilename || '').trim();
  session.sessionName = String(session.sessionName || session.workProduct || session.exportFilename || '').trim();
  session.createdAt = session.createdAt || new Date().toISOString();
  session.updatedAt = session.updatedAt || session.createdAt;
  session.status = session.status === 'finished' ? 'finished' : 'active';
  const rawCases = Array.isArray(session.testCases) ? session.testCases : [];
  const stepToCase = new Map();
  for (const tc of rawCases) for (const step of (Array.isArray(tc?.steps) ? tc.steps : [])) if (step?.id && tc?.id) stepToCase.set(step.id, tc.id);

  // Repair sessions created by the broken v2.2.5 import-review flow. The
  // panel's static labels were mistakenly saved as scenarios. Remove only the
  // known generated strings, while retaining Step1..StepN and duplicates.
  const rawTitles = rawCases.map(tc => tc?.title ?? '');
  const legacyReviewDump = isLegacyReviewDump(rawTitles);
  const cleanedRawCases = legacyReviewDump
    ? rawCases.filter(tc => !isLegacyImportReviewArtifact(tc?.title) && !isLegacyReviewUiLabel(tc?.title))
    : rawCases;
  session.testCases = cleanedRawCases.map(tc => normalizeTestCase(tc, session.workProduct));
  const validCaseIds = new Set(session.testCases.map(tc => tc.id));

  // The review-warning panel is obsolete; all warning copy from old imports
  // should be cleared. Missing or multiple Work Products are handled by the
  // filename/session-name prompt instead.
  session.importWarnings = [];

  session.evidence = Array.isArray(session.evidence) ? session.evidence.map(item => {
    const existingCaseId = item?.testCaseId || stepToCase.get(item?.stepId) || null;
    const evidence = {
      ...item,
      id: item?.id || uid('evidence'),
      sessionId: item?.sessionId || session.id,
      // Never drop an image because its former scenario was corrupt; leave it
      // unassigned if the linked scenario was one of the removed UI artefacts.
      testCaseId: existingCaseId && validCaseIds.has(existingCaseId) ? existingCaseId : null,
      imageBlobKey: item?.imageBlobKey || `${session.id}:${item?.id || uid('evidence')}`,
      capturedAt: item?.capturedAt || new Date().toISOString(),
      note: item?.note ? String(item.note) : null
    };
    delete evidence.stepId;
    return evidence;
  }) : [];
  delete session.currentEvidenceStepId;
  delete session.stepCount;
  delete session.completedStepCount;
  return session;
}

export function createTestingSession(parsed) {
  const now = new Date().toISOString();
  return normalizeSession({
    id: uid('session'),
    version: TESTING_SCHEMA_VERSION,
    mode: 'test-cases',
    workProduct: String(parsed?.workProduct || '').trim(),
    sessionName: String(parsed?.workProduct || '').trim(),
    createdAt: now,
    updatedAt: now,
    status: 'active',
    testCases: clone(parsed?.testCases || []),
    evidence: [],
    importWarnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
    sourceWorkProducts: Array.isArray(parsed?.workProducts) ? parsed.workProducts : [],
    importFormat: String(parsed?.format || 'unknown')
  });
}

export function createEvidenceOnlyTestingSession() {
  const now = new Date().toISOString();
  return normalizeSession({
    id: uid('session'),
    version: TESTING_SCHEMA_VERSION,
    mode: 'evidence-only',
    workProduct: '',
    sessionName: '',
    exportFilename: '',
    createdAt: now,
    updatedAt: now,
    status: 'active',
    testCases: [],
    evidence: [],
  });
}

export function cloneTestingSession(session) {
  return session ? JSON.parse(JSON.stringify(session)) : null;
}

async function getStoredSessionsMap() {
  try {
    const data = await chrome.storage.local.get(TESTING_SESSIONS_KEY);
    const raw = data?.[TESTING_SESSIONS_KEY];
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return {};
}

async function setStoredSessionsMap(map) {
  await chrome.storage.local.set({ [TESTING_SESSIONS_KEY]: map });
  const index = Object.values(map || {}).map(summarizeTestingSession).filter(Boolean).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  await chrome.storage.local.set({ [TESTING_SESSIONS_INDEX_KEY]: index });
}

async function migrateLegacyTestingSession() {
  let legacy = null;
  try {
    const localData = await chrome.storage.local.get(TESTING_SESSION_KEY);
    legacy = localData?.[TESTING_SESSION_KEY] || null;
  } catch {}
  if (!legacy) {
    try {
      const sessionData = await chrome.storage.session.get(TESTING_SESSION_KEY);
      legacy = sessionData?.[TESTING_SESSION_KEY] || null;
    } catch {}
  }
  if (!legacy) return null;

  const migrated = normalizeSession(legacy);
  migrated.status = 'active';
  const map = await getStoredSessionsMap();
  if (!map[migrated.id]) map[migrated.id] = migrated;
  await setStoredSessionsMap(map);
  try { await chrome.storage.local.remove(TESTING_SESSION_KEY); } catch {}
  try { await chrome.storage.session.remove(TESTING_SESSION_KEY); } catch {}
  return migrated;
}

export async function loadTestingSessions() {
  await migrateLegacyTestingSession();
  const map = await getStoredSessionsMap();
  // Keep a serialized snapshot before normalization: normalizeSession mutates
  // the in-memory record, so comparing it to the same map afterward would hide
  // schema changes and could leave step-linked records in persistent storage.
  const before = JSON.stringify(map);
  const sessions = Object.values(map)
    .map(normalizeSession)
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const normalizedMap = Object.fromEntries(sessions.map(session => [session.id, session]));
  if (JSON.stringify(normalizedMap) !== before) {
    try { await setStoredSessionsMap(normalizedMap); } catch {}
  }
  return sessions;
}

export function summarizeTestingSession(session) {
  const normalized = normalizeSession(session);
  if (!normalized) return null;
  return {
    id: normalized.id,
    version: normalized.version,
    mode: normalized.mode,
    workProduct: normalized.workProduct,
    sessionName: normalized.sessionName,
    exportFilename: normalized.exportFilename,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    status: normalized.status,
    testCaseCount: normalized.testCases.length,
    evidenceCount: normalized.evidence.length
  };
}

export async function loadTestingSessionById(sessionId) {
  const id = String(sessionId || '');
  if (!id) return null;
  const map = await getStoredSessionsMap();
  if (!map[id]) return null;
  const before = JSON.stringify(map[id]);
  const normalized = normalizeSession(map[id]);
  if (normalized && JSON.stringify(normalized) !== before) {
    map[id] = normalized;
    try { await setStoredSessionsMap(map); } catch {}
  }
  return normalized;
}

export async function loadTestingSessionSummaries() {
  // Rebuild from canonical session storage. This also guarantees summaries for
  // pre-v3 sessions do not expose cached step counts after schema migration.
  const sessions = await loadTestingSessions();
  const index = sessions.map(summarizeTestingSession).filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  try { await chrome.storage.local.set({ [TESTING_SESSIONS_INDEX_KEY]: index }); } catch {}
  return index;
}

export async function saveTestingSession(session) {
  const normalized = normalizeSession(cloneTestingSession(session));
  if (!normalized) return null;
  normalized.updatedAt = new Date().toISOString();
  const map = await getStoredSessionsMap();
  map[normalized.id] = normalized;
  await setStoredSessionsMap(map);
  try { await chrome.storage.local.remove(TESTING_SESSION_KEY); } catch {}
  try { await chrome.storage.session.remove(TESTING_SESSION_KEY); } catch {}
  return normalized;
}

export async function deleteTestingSession(sessionIdOrSession) {
  const id = typeof sessionIdOrSession === 'string' ? sessionIdOrSession : sessionIdOrSession?.id;
  if (!id) return;
  const storedSession = await loadTestingSessionById(id);
  const session = storedSession || (typeof sessionIdOrSession === 'object' ? normalizeSession(sessionIdOrSession) : null);
  const map = await getStoredSessionsMap();
  delete map[id];
  await setStoredSessionsMap(map);
  if (session) await deleteEvidenceBlobsForSession(session);
}

export async function clearTestingSession(sessionOrId) {
  const session = typeof sessionOrId === 'string'
    ? await loadTestingSessionById(sessionOrId)
    : normalizeSession(sessionOrId);
  if (!session?.id) return;
  await deleteTestingSession(session);
}

async function migrateSingleSessionFallback() {
  const sessions = await loadTestingSessions();
  return sessions[0] || null;
}

// Backward-compatible helper for older callers. It intentionally returns the
// first (most recently updated) resumable session rather than a global singleton.
export async function loadTestingSession() {
  return migrateSingleSessionFallback();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TESTING_DB_NAME, TESTING_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TESTING_STORE)) db.createObjectStore(TESTING_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open Testing evidence storage.'));
  });
}

async function withStore(mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TESTING_STORE, mode);
    const store = tx.objectStore(TESTING_STORE);
    let result;
    try { result = callback(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => {
      try { db.close(); } catch {}
      resolve(result);
    };
    tx.onerror = () => {
      try { db.close(); } catch {}
      reject(tx.error || new Error('Testing evidence storage operation failed.'));
    };
    tx.onabort = () => {
      try { db.close(); } catch {}
      reject(tx.error || new Error('Testing evidence storage operation aborted.'));
    };
  });
}

export async function putEvidenceBlob(key, blob) {
  if (!key || !blob) throw new Error('Evidence image is unavailable.');
  return withStore('readwrite', store => store.put(blob, key));
}

export async function getEvidenceBlob(key) {
  if (!key) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TESTING_STORE, 'readonly');
    const request = tx.objectStore(TESTING_STORE).get(key);
    request.onsuccess = () => {
      try { db.close(); } catch {}
      resolve(request.result || null);
    };
    request.onerror = () => {
      try { db.close(); } catch {}
      reject(request.error || new Error('Could not load evidence image.'));
    };
  });
}

export async function deleteEvidenceBlob(key) {
  if (!key) return;
  return withStore('readwrite', store => store.delete(key));
}

export async function deleteEvidenceBlobsForSession(session) {
  const keys = [...new Set((session?.evidence || []).map(item => item?.imageBlobKey).filter(Boolean))];
  if (!keys.length) return;
  return withStore('readwrite', store => keys.forEach(key => store.delete(key)));
}

export async function clearAllEvidenceBlobs() {
  try { return await withStore('readwrite', store => store.clear()); } catch {}
}
