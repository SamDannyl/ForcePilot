/*
 * ForcePilot Testing Mode data + persistence helpers.
 * Phase 1 only: test case parsing, session metadata, and evidence blob storage.
 */

export const TESTING_SESSION_KEY = 'forcepilot.testing.session.v1';
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
  .replace(/\s+/g, ' ');

const EXPECTED_HEADERS = ['work product', 'object type', 'test case', 'step index', 'steps'];

function stripCodeFence(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  return value.replace(/^```(?:text|tsv|markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function splitPipeRow(line) {
  let value = String(line ?? '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  const cells = [];
  let current = '';
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (escaped) current += '\\';
  cells.push(current.trim());
  return cells;
}

function looksLikeMarkdownSeparator(cells) {
  return cells.length >= 5 && cells.every(cell => /^:?-{2,}:?$/.test(String(cell).trim()));
}

function detectDelimiter(lines) {
  const header = lines.find(line => String(line).trim() && !/^```/.test(String(line).trim()));
  if (!header) return '\t';
  return String(header).includes('\t') ? '\t' : '|';
}

function parseRows(text) {
  const source = stripCodeFence(text);
  const lines = source.split(/\r?\n/).filter(line => String(line).trim());
  if (!lines.length) throw new Error('Paste your test cases first.');

  const delimiter = detectDelimiter(lines);
  const rows = lines.map(line => delimiter === '\t' ? String(line).split('\t').map(x => x.trim()) : splitPipeRow(line));
  if (rows.length < 2) throw new Error('Include the header row and at least one test step.');

  if (looksLikeMarkdownSeparator(rows[1])) rows.splice(1, 1);
  const headerRow = rows[0].map(normalizeHeader);
  const indexes = EXPECTED_HEADERS.map(name => headerRow.indexOf(name));

  if (indexes.some(index => index < 0)) {
    throw new Error('Use the five ForcePilot columns: Work Product, Object Type, Test Case, Step Index, Steps.');
  }

  return rows.slice(1).map((cells, rowIndex) => ({
    rowIndex: rowIndex + 2,
    workProduct: cells[indexes[0]] ?? '',
    objectType: cells[indexes[1]] ?? '',
    title: cells[indexes[2]] ?? '',
    index: cells[indexes[3]] ?? '',
    text: cells[indexes[4]] ?? ''
  }));
}

function normalizeRows(rows) {
  const normalized = [];
  let workProduct = '';
  let objectType = '';
  let title = '';

  for (const row of rows) {
    if (row.workProduct) workProduct = row.workProduct.trim();
    if (row.objectType) objectType = row.objectType.trim();
    if (row.title) title = row.title.trim();

    if (!workProduct) throw new Error(`Row ${row.rowIndex}: Work Product is missing.`);
    if (!objectType) objectType = 'Test Case';
    if (!title) throw new Error(`Row ${row.rowIndex}: Test Case is missing.`);
    if (!String(row.index).trim()) throw new Error(`Row ${row.rowIndex}: Step Index is missing.`);
    const index = Number(String(row.index).trim());
    if (!Number.isInteger(index) || index < 1) throw new Error(`Row ${row.rowIndex}: Step Index must be a positive whole number.`);
    if (!String(row.text).trim()) throw new Error(`Row ${row.rowIndex}: Steps cannot be blank.`);

    normalized.push({
      workProduct,
      objectType,
      title,
      index,
      text: String(row.text).trim(),
      rowIndex: row.rowIndex
    });
  }
  if (!normalized.length) throw new Error('No test steps were found.');
  const products = [...new Set(normalized.map(row => row.workProduct))];
  if (products.length !== 1) throw new Error('A testing session must contain one Work Product / US number.');
  return normalized;
}

export function parseTestCasePaste(text) {
  const normalized = normalizeRows(parseRows(text));
  const sessionWorkProduct = normalized[0].workProduct;
  const groups = new Map();
  const order = [];

  for (const row of normalized) {
    let tc = groups.get(row.title);
    if (!tc) {
      tc = {
        id: uid('tc'),
        workProduct: sessionWorkProduct,
        objectType: row.objectType || 'Test Case',
        title: row.title,
        steps: []
      };
      groups.set(row.title, tc);
      order.push(tc);
    }
    tc.steps.push({
      id: uid('step'),
      index: row.index,
      text: row.text
    });
  }

  for (const tc of order) {
    tc.steps.sort((a, b) => Number(a.index) - Number(b.index));
  }

  return {
    workProduct: sessionWorkProduct,
    testCases: order,
    sourceRowCount: normalized.length
  };
}

export function createTestingSession(parsed) {
  const now = new Date().toISOString();
  return {
    id: uid('session'),
    version: 1,
    mode: 'test-cases',
    workProduct: String(parsed?.workProduct || '').trim(),
    createdAt: now,
    updatedAt: now,
    testCases: clone(parsed?.testCases || []),
    evidence: [],
    currentEvidenceStepId: null
  };
}

export function createEvidenceOnlyTestingSession() {
  const now = new Date().toISOString();
  return {
    id: uid('session'),
    version: 1,
    mode: 'evidence-only',
    workProduct: '',
    createdAt: now,
    updatedAt: now,
    testCases: [],
    evidence: [],
    currentEvidenceStepId: null
  };
}

export function cloneTestingSession(session) {
  return session ? JSON.parse(JSON.stringify(session)) : null;
}

export async function saveTestingSession(session) {
  if (!session) return;
  await chrome.storage.session.set({ [TESTING_SESSION_KEY]: session });
}

export async function loadTestingSession() {
  try {
    const data = await chrome.storage.session.get(TESTING_SESSION_KEY);
    return data?.[TESTING_SESSION_KEY] || null;
  } catch {
    return null;
  }
}

export async function clearTestingSession() {
  try { await chrome.storage.session.remove(TESTING_SESSION_KEY); } catch {}
  await clearAllEvidenceBlobs();
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

export async function clearAllEvidenceBlobs() {
  try { return await withStore('readwrite', store => store.clear()); } catch {}
}
