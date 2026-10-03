/*
 * ForcePilot Testing Mode — DOCX export.
 *
 * The exporter intentionally starts from a known-good OOXML template rather
 * than constructing a DOCX package from scratch. This keeps package parts,
 * styles, section properties and namespaces stable while we only add the
 * document content and evidence image relationships that the session needs.
 *
 * Runtime dependency: JSZip is loaded locally by sidepanel.html as
 * src/vendor/jszip.min.js and exposed as window.JSZip.
 */

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const IMAGE_REL_TYPE = `${OFFICE_REL_NS}/image`;
import { prepareEvidenceImageForWord } from './evidence-image.js';
const DOC_REL_TYPE = `${OFFICE_REL_NS}/officeDocument`;
const MAX_WIDTH_IN = 6.7;
const MAX_HEIGHT_IN = 8.35;
const EMU_PER_IN = 914400;

const IMAGE_PARAGRAPH_TEMPLATE = `<w:p><w:pPr><w:pStyle w:val="ForcePilotEvidence"/><w:keepNext w:val="0"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="forcepilot-placeholder.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

let templatePromise = null;

function getZipCtor() {
  const ctor = globalThis.JSZip;
  if (!ctor) throw new Error('DOCX exporter is unavailable because its local ZIP engine did not load.');
  return ctor;
}

function escXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textRunXml(text, preserve = true, bold = false) {
  const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  const value = escXmlText(String(text ?? ''));
  return `<w:r>${rPr}<w:t${preserve ? ' xml:space="preserve"' : ''}>${value}</w:t></w:r>`;
}

function textRunsWithBreaks(text) {
  const parts = String(text ?? '').split(/\r?\n/);
  return parts.map((part, index) => `${textRunXml(part, true, false)}${index < parts.length - 1 ? '<w:br/>' : ''}`).join('');
}

function paragraphXml({ style, children, keepNext = false, pageBreakBefore = false, before = 0, after = 0, align = '' }) {
  const pPrParts = [];
  if (style) pPrParts.push(`<w:pStyle w:val="${escXml(style)}"/>`);
  if (keepNext) pPrParts.push('<w:keepNext/>');
  if (pageBreakBefore) pPrParts.push('<w:pageBreakBefore/>');
  if (before || after) pPrParts.push(`<w:spacing w:before="${before}" w:after="${after}"/>`);
  if (align) pPrParts.push(`<w:jc w:val="${escXml(align)}"/>`);
  return `<w:p>${pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : ''}${children}</w:p>`;
}

function buildTestCaseHeading(title) {
  return paragraphXml({ style: 'ForcePilotTestCase', children: textRunXml(title, true, false), keepNext: true, before: 80, after: 120 });
}

function buildStepParagraph(index, text) {
  return paragraphXml({
    style: 'ForcePilotStep',
    children: `${textRunXml(`Step ${index}`, true, true)}${textRunsWithBreaks(`  ${String(text ?? '')}`)}`,
    keepNext: true,
    after: 70
  });
}

function buildSimpleHeading(text, options = {}) {
  return paragraphXml({ style: 'ForcePilotTestCase', children: textRunXml(text, true, false), keepNext: true, before: 80, after: 120, ...options });
}

function buildEmptyParagraph() {
  return paragraphXml({ children: '<w:r><w:t xml:space="preserve"> </w:t></w:r>', after: 20 });
}

function parseImageDimensions(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return {
      width: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
      height: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 1 >= bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && offset + 7 < bytes.length) {
        return {
          height: (bytes[offset + 3] << 8) | bytes[offset + 4],
          width: (bytes[offset + 5] << 8) | bytes[offset + 6]
        };
      }
      offset += length;
    }
  }
  return { width: 1, height: 1 };
}

function imageSizeEmu(buffer) {
  const dimensions = parseImageDimensions(buffer);
  const width = Math.max(1, dimensions.width || 1);
  const height = Math.max(1, dimensions.height || 1);
  const scale = Math.min(MAX_WIDTH_IN / (width / height || 1), MAX_HEIGHT_IN / (height / width || 1));
  let widthIn = width / 96;
  let heightIn = height / 96;
  // Browser screenshots are CSS-pixel sized. Use the actual aspect ratio and
  // a document-safe maximum rather than assuming a fixed DPI.
  const widthScale = MAX_WIDTH_IN / Math.max(widthIn, 1e-6);
  const heightScale = MAX_HEIGHT_IN / Math.max(heightIn, 1e-6);
  const applied = Math.min(1, widthScale, heightScale);
  widthIn *= applied;
  heightIn *= applied;
  return {
    width: Math.max(1, Math.round(widthIn * EMU_PER_IN)),
    height: Math.max(1, Math.round(heightIn * EMU_PER_IN))
  };
}

function buildImageParagraph(buffer, relId, index, fileName) {
  const { width, height } = imageSizeEmu(buffer);
  return IMAGE_PARAGRAPH_TEMPLATE
    .replace(/rId9/g, relId)
    .replace(/cx="914400" cy="914400"/g, `cx="${width}" cy="${height}"`)
    .replace(/<a:ext cx="914400" cy="914400"\/>/g, `<a:ext cx="${width}" cy="${height}"/>`)
    .replace(/<wp:docPr id="1" name="Picture 1"\/>/, `<wp:docPr id="${1000 + index}" name="Evidence ${index}" descr="Captured Salesforce evidence"/>`)
    .replace(/<pic:cNvPr id="0" name="forcepilot-placeholder\.jpg"\/>/, `<pic:cNvPr id="${1000 + index}" name="${escXml(fileName)}" descr="Captured Salesforce evidence"/>`);
}

function getExtensionAndContentType(blob) {
  const type = String(blob?.type || '').toLowerCase();
  if (type === 'image/png') return { extension: 'png', contentType: 'image/png' };
  return { extension: 'jpg', contentType: 'image/jpeg' };
}

async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function prepareEvidenceMap(evidenceMap, { quality = 0.88 } = {}) {
  const prepared = new Map();
  const uniqueByFingerprint = new Map();
  for (const [key, value] of evidenceMap.entries()) {
    const fingerprint = await sha256Hex(value.buffer);
    let optimized = uniqueByFingerprint.get(fingerprint);
    if (!optimized) {
      optimized = await prepareEvidenceImageForWord(value.blob, {
        maxDimension: 1920,
        quality
      });
      optimized = { ...optimized, fingerprint };
      uniqueByFingerprint.set(fingerprint, optimized);
    }
    prepared.set(key, optimized);
  }
  return prepared;
}

function stripTemplateImageRelationship(relsXml) {
  return relsXml.replace(/<Relationship\b[^>]*Type="[^\"]*\/image"[^>]*\/>/g, '');
}

function appendRelationships(relsXml, relationships) {
  const closing = '</Relationships>';
  if (!relsXml.includes(closing)) throw new Error('The DOCX template has an invalid relationship part.');
  const body = relationships.join('');
  return relsXml.replace(closing, `${body}${closing}`);
}

function replaceBody(documentXml, bodyContent) {
  const bodyStart = documentXml.indexOf('<w:body>');
  const bodyEnd = documentXml.indexOf('</w:body>');
  if (bodyStart < 0 || bodyEnd < 0 || bodyEnd <= bodyStart) throw new Error('The DOCX template has no valid Word document body.');
  const bodyInner = documentXml.slice(bodyStart + '<w:body>'.length, bodyEnd);
  const sectStart = bodyInner.indexOf('<w:sectPr');
  if (sectStart < 0) throw new Error('The DOCX template is missing its section properties.');
  const sectPr = bodyInner.slice(sectStart);
  return `${documentXml.slice(0, bodyStart)}<w:body>${bodyContent}${sectPr}</w:body>${documentXml.slice(bodyEnd + '</w:body>'.length)}`;
}

function patchCoreProperties(coreXml, title) {
  const now = new Date().toISOString();
  let xml = String(coreXml || '');
  xml = xml.replace(/<dc:title\/>/, `<dc:title>${escXmlText(title)}</dc:title>`);
  xml = xml.replace(/<dc:creator>[^<]*<\/dc:creator>/, '<dc:creator>ForcePilot</dc:creator>');
  xml = xml.replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/, `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`);
  return xml;
}

function ensureContentTypeDefaults(contentTypesXml, requiredTypes) {
  let xml = String(contentTypesXml || '');
  for (const type of requiredTypes) {
    const extension = type.extension.toLowerCase();
    const escapedExt = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasDefault = new RegExp(`<Default\\b[^>]*\\bExtension=\"${escapedExt}\"`, 'i').test(xml);
    const hasOverride = new RegExp(`<Override\\b[^>]*\\bPartName=\"/word/media/[^\"]+\\.${escapedExt}\"`, 'i').test(xml);
    if (!hasDefault && !hasOverride) {
      const marker = '</Types>';
      xml = xml.replace(marker, `<Default Extension=\"${extension}\" ContentType=\"${type.contentType}\"/>${marker}`);
    }
  }
  return xml;
}

async function getTemplateArrayBuffer() {
  if (!templatePromise) {
    templatePromise = fetch(chrome.runtime.getURL('src/forcepilot-docx-template.docx')).then(async response => {
      if (!response.ok) throw new Error(`Could not load the Word template (${response.status}).`);
      return response.arrayBuffer();
    });
  }
  return templatePromise;
}

function normalizeEvidenceMap(evidenceBlobs) {
  if (evidenceBlobs instanceof Map) return evidenceBlobs;
  const map = new Map();
  for (const [key, value] of Object.entries(evidenceBlobs || {})) map.set(key, value);
  return map;
}

function buildBodyXml(session, evidenceBlobs) {
  const chunks = [];
  const allEvidence = Array.isArray(session?.evidence) ? session.evidence : [];
  const usedEvidence = new Set();
  let imageCounter = 0;
  let drawingCounter = 0;
  const rels = [];
  const imageParts = [];
  const assetsByFingerprint = new Map();

  const addEvidenceImages = evidenceItems => {
    for (const evidence of evidenceItems) {
      const prepared = evidenceBlobs.get(evidence.imageBlobKey);
      if (!prepared) throw new Error('A captured evidence image is unavailable. Capture it again before exporting.');
      const fingerprint = prepared.fingerprint || `key:${evidence.imageBlobKey}`;
      let asset = assetsByFingerprint.get(fingerprint);
      if (!asset) {
        imageCounter += 1;
        const { extension } = getExtensionAndContentType(prepared.blob);
        const fileName = `image${imageCounter}.${extension}`;
        const relId = `rIdFPImage${imageCounter}`;
        rels.push(`<Relationship Id="${relId}" Type="${IMAGE_REL_TYPE}" Target="media/${fileName}"/>`);
        asset = { fileName, relId, buffer: prepared.buffer, extension };
        assetsByFingerprint.set(fingerprint, asset);
        imageParts.push({ fileName, data: prepared.blob, buffer: prepared.buffer, extension, fingerprint });
      }
      drawingCounter += 1;
      chunks.push(buildImageParagraph(asset.buffer, asset.relId, drawingCounter, asset.fileName));
    }
  };

  if (isEvidenceOnlySession(session)) {
    chunks.push(buildSimpleHeading('Captured Evidence'));
    if (!allEvidence.length) {
      chunks.push(paragraphXml({ style: 'ForcePilotMeta', children: textRunXml('No screenshots were captured.', true, false), keepNext: false, after: 0 }));
    } else {
      addEvidenceImages(allEvidence);
    }
    return { bodyXml: chunks.join(''), relationships: rels, imageParts };
  }

  for (const tc of session?.testCases || []) {
    chunks.push(buildTestCaseHeading(String(tc.title || '').trim() || 'Test case'));
    for (const [stepPosition, step] of (tc.steps || []).entries()) {
      const stepIndex = Number(step?.index) || (stepPosition + 1);
      chunks.push(buildStepParagraph(stepIndex, step?.text || ''));
      const stepEvidence = allEvidence.filter(item => item.stepId === step.id);
      stepEvidence.forEach(item => usedEvidence.add(item.id));
      addEvidenceImages(stepEvidence);
    }
  }

  const unassociated = allEvidence.filter(item => !usedEvidence.has(item.id));
  if (unassociated.length) {
    chunks.push(buildSimpleHeading('Additional captured evidence', { pageBreakBefore: true }));
    addEvidenceImages(unassociated);
  }

  if (!chunks.length) chunks.push(paragraphXml({ style: 'ForcePilotMeta', children: textRunXml('No testing content was available.', true, false), after: 0 }));
  return { bodyXml: chunks.join(''), relationships: rels, imageParts };
}

function isEvidenceOnlySession(session) {
  return String(session?.mode || '').toLowerCase() === 'evidence-only' || (!session?.testCases?.length && session?.mode !== 'test-cases');
}

async function blobToArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (value && typeof value.arrayBuffer === 'function') return value.arrayBuffer();
  throw new Error('Evidence image is not a readable binary blob.');
}

export async function buildTestingDocx(session, evidenceBlobs, { onProgress, templateBytes, validate = true, imageQuality = 0.88 } = {}) {
  const Zip = getZipCtor();
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  progress({ stage: 'template', message: 'Preparing Word document…' });
  const template = templateBytes || await getTemplateArrayBuffer();
  const zip = await Zip.loadAsync(template);
  const documentFile = zip.file('word/document.xml');
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const coreFile = zip.file('docProps/core.xml');
  if (!documentFile || !relsFile || !coreFile) throw new Error('The Word template is incomplete.');

  const evidenceMap = normalizeEvidenceMap(evidenceBlobs);
  const sourceEvidence = new Map();
  for (const [key, value] of evidenceMap.entries()) {
    const buffer = await blobToArrayBuffer(value);
    const blob = value instanceof Blob ? value : new Blob([buffer], { type: value?.type || 'image/jpeg' });
    sourceEvidence.set(key, { blob, buffer });
  }
  progress({ stage: 'compress', message: 'Optimizing evidence images for Word…' });
  const preparedEvidence = await prepareEvidenceMap(sourceEvidence, { quality: Math.min(0.95, Math.max(0.70, Number(imageQuality) || 0.88)) });
  const { bodyXml, relationships, imageParts } = buildBodyXml(session, preparedEvidence);
  progress({ stage: 'content', message: 'Adding captured evidence…' });

  let documentXml = await documentFile.async('text');
  documentXml = replaceBody(documentXml, bodyXml);
  zip.file('word/document.xml', documentXml);

  let relsXml = await relsFile.async('text');
  relsXml = stripTemplateImageRelationship(relsXml);
  relsXml = appendRelationships(relsXml, relationships);
  zip.file('word/_rels/document.xml.rels', relsXml);

  if (coreFile) {
    const coreXml = await coreFile.async('text');
    const coreTitle = String(session?.workProduct || '').trim() || 'ForcePilot Test Evidence';
    zip.file('docProps/core.xml', patchCoreProperties(coreXml, coreTitle));
  }

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!contentTypesFile) throw new Error('The Word template is missing [Content_Types].xml.');
  const requiredImageTypes = [];
  for (const part of imageParts) {
    if (!requiredImageTypes.some(type => type.extension === part.extension)) {
      requiredImageTypes.push(part.extension === 'png' ? { extension: 'png', contentType: 'image/png' } : { extension: part.extension, contentType: 'image/jpeg' });
    }
  }
  if (requiredImageTypes.length) {
    const contentTypesXml = await contentTypesFile.async('text');
    zip.file('[Content_Types].xml', ensureContentTypeDefaults(contentTypesXml, requiredImageTypes));
  }

  zip.remove('word/media/image1.jpg');
  for (const part of imageParts) {
    // Store raw bytes in the package. ArrayBuffer/Uint8Array keeps browser and Node
    // validation deterministic and avoids Blob conversion differences.
    zip.file(`word/media/${part.fileName}`, part.buffer, { binary: true, compression: 'STORE' });
  }

  progress({ stage: 'package', message: 'Finalizing Word package…' });
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE', compressionOptions: { level: 3 } });
  const validation = validate ? await validateDocxBlob(blob) : { ok: true, errors: [] };
  if (validate) progress({ stage: 'validate', message: 'Validating Word package…' });
  if (validate && !validation.ok) throw new Error(`The Word document failed validation: ${validation.errors[0]}`);
  return { blob, validation, imageCount: imageParts.length };
}

function resolveTarget(sourcePart, target) {
  const targetValue = String(target || '');
  if (!targetValue || targetValue.startsWith('#')) return null;
  if (targetValue.startsWith('/')) return targetValue.slice(1);
  const base = sourcePart.split('/').slice(0, -1);
  const combined = [...base, ...targetValue.split('/')];
  const normalized = [];
  for (const part of combined) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

function parseXml(text, label) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(text || ''), 'application/xml');
  if (!doc || doc.querySelector('parsererror')) throw new Error(`${label} is not valid XML.`);
  return doc;
}

export async function validateDocxBlob(blob) {
  const Zip = getZipCtor();
  const errors = [];
  let zip;
  try {
    zip = await Zip.loadAsync(await blob.arrayBuffer());
  } catch (error) {
    return { ok: false, errors: [`DOCX package could not be opened as a ZIP: ${error?.message || error}`] };
  }

  const required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels'];
  for (const path of required) if (!zip.file(path)) errors.push(`Missing required package part: ${path}`);
  if (errors.length) return { ok: false, errors };

  let rootRels, documentRels, documentXml, contentTypes;
  try {
    rootRels = parseXml(await zip.file('_rels/.rels').async('text'), 'Package relationships');
    documentRels = parseXml(await zip.file('word/_rels/document.xml.rels').async('text'), 'Document relationships');
    documentXml = parseXml(await zip.file('word/document.xml').async('text'), 'Document XML');
    contentTypes = parseXml(await zip.file('[Content_Types].xml').async('text'), 'Content types');
  } catch (error) {
    return { ok: false, errors: [error?.message || String(error)] };
  }

  // Parse every XML/rels part, not just the core document. A single malformed
  // package part can still trigger Word's repair/unreadable-content dialog.
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir || !/\.(?:xml|rels)$/i.test(path)) continue;
    try {
      parseXml(await zip.file(path).async('text'), path);
    } catch (error) {
      errors.push(error?.message || `Invalid XML part: ${path}`);
    }
  }

  const rootRelNodes = [...rootRels.getElementsByTagNameNS(REL_NS, 'Relationship')];
  const officeRel = rootRelNodes.find(rel => rel.getAttribute('Type') === DOC_REL_TYPE);
  if (!officeRel) errors.push('Package has no officeDocument relationship.');
  else if (resolveTarget('', officeRel.getAttribute('Target')) !== 'word/document.xml') errors.push('The package officeDocument relationship does not target word/document.xml.');

  const documentRelNodes = [...documentRels.getElementsByTagNameNS(REL_NS, 'Relationship')];
  const relMap = new Map();
  for (const rel of documentRelNodes) {
    const id = rel.getAttribute('Id');
    if (!id) errors.push('Document relationship is missing its Id.');
    else if (relMap.has(id)) errors.push(`Duplicate document relationship Id: ${id}.`);
    else relMap.set(id, rel);
  }

  // Validate every internal relationship part in the package. This catches
  // relationship targets that are wrong even when they are unrelated to images.
  const relPartPaths = Object.keys(zip.files).filter(path => /(^|\/)_[^/]+$/.test(path) ? false : /(^|\/)\_rels\/[^/]+\.rels$/i.test(path) || path === '_rels/.rels');
  const relationshipPartEntries = [...new Set(['_rels/.rels', ...relPartPaths])].filter(path => zip.file(path));
  for (const relsPath of relationshipPartEntries) {
    const relDoc = relsPath === '_rels/.rels' ? rootRels : parseXml(await zip.file(relsPath).async('text'), relsPath);
    const sourcePart = relsPath === '_rels/.rels'
      ? ''
      : relsPath.replace(/(^|\/)\_rels\/([^/]+)\.rels$/i, '$1$2');
    for (const rel of [...relDoc.getElementsByTagNameNS(REL_NS, 'Relationship')]) {
      if (rel.getAttribute('TargetMode') === 'External') continue;
      const target = resolveTarget(sourcePart, rel.getAttribute('Target'));
      if (target && !zip.file(target)) errors.push(`Relationship ${rel.getAttribute('Id') || '(missing Id)'} in ${relsPath} targets a missing part: ${target}.`);
    }
  }

  const mediaEntries = Object.keys(zip.files).filter(path => /^word\/media\//i.test(path) && !zip.files[path].dir);

  const blips = [...documentXml.getElementsByTagNameNS(DRAWING_NS, 'blip')];
  const referencedMedia = new Set();
  for (const blip of blips) {
    const rid = blip.getAttributeNS(OFFICE_REL_NS, 'embed');
    if (!rid) { errors.push('An image reference is missing its relationship ID.'); continue; }
    const rel = relMap.get(rid);
    if (!rel) { errors.push(`Image relationship ${rid} is missing.`); continue; }
    if (rel.getAttribute('Type') !== IMAGE_REL_TYPE) { errors.push(`Relationship ${rid} is not an image relationship.`); continue; }
    const target = resolveTarget('word/document.xml', rel.getAttribute('Target'));
    if (!target || !zip.file(target)) { errors.push(`Image relationship ${rid} targets a missing part: ${target || '(empty target)'}.`); continue; }
    referencedMedia.add(target);
    const bytes = new Uint8Array(await zip.file(target).async('arraybuffer'));
    if (!bytes.length) errors.push(`Referenced image part is empty: ${target}.`);
    if (!/\.(?:jpe?g|png)$/i.test(target)) errors.push(`Unsupported image type in DOCX: ${target}.`);
  }
  for (const media of mediaEntries) if (!referencedMedia.has(media)) errors.push(`Orphan image part is not referenced by document.xml: ${media}.`);

  for (const rel of documentRelNodes) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const target = resolveTarget('word/document.xml', rel.getAttribute('Target'));
    if (target && !zip.file(target)) errors.push(`Document relationship ${rel.getAttribute('Id')} targets a missing part: ${target}.`);
  }

  const body = documentXml.getElementsByTagNameNS(WORD_NS, 'body')[0];
  const sectPr = documentXml.getElementsByTagNameNS(WORD_NS, 'sectPr')[0];
  if (!body) errors.push('word/document.xml has no w:body.');
  if (!sectPr) errors.push('word/document.xml has no section properties.');

  const defaults = [...contentTypes.getElementsByTagNameNS(CONTENT_TYPES_NS, 'Default')];
  const overrides = [...contentTypes.getElementsByTagNameNS(CONTENT_TYPES_NS, 'Override')];
  const defaultsMap = new Map(defaults.map(node => [String(node.getAttribute('Extension') || '').toLowerCase(), node.getAttribute('ContentType')]));
  const overridesMap = new Map(overrides.map(node => [String(node.getAttribute('PartName') || ''), node.getAttribute('ContentType')]));
  for (const media of mediaEntries) {
    const extension = media.split('.').pop().toLowerCase();
    const contentType = overridesMap.get(`/${media}`) || defaultsMap.get(extension);
    if (!contentType) errors.push(`No content type is declared for media part ${media}.`);
    if (/\.(?:jpe?g|png)$/i.test(media)) {
      const expected = /\.png$/i.test(media) ? 'image/png' : 'image/jpeg';
      if (contentType && contentType !== expected) errors.push(`Content type for ${media} is ${contentType}, expected ${expected}.`);
    }
  }

  // All package parts with an extension must resolve to a declared default or
  // override content type. This catches missing [Content_Types] entries before
  // a generated file reaches Word.
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir || path === '[Content_Types].xml' || path.startsWith('_rels/')) continue;
    const contentType = overridesMap.get(`/${path}`) || defaultsMap.get(path.includes('.') ? path.split('.').pop().toLowerCase() : '');
    if (path.includes('.') && !contentType) errors.push(`Package part has no declared content type: ${path}.`);
  }

  const bodyChildren = body ? [...body.childNodes].filter(node => node.nodeType === 1) : [];
  if (body && bodyChildren.length && bodyChildren[bodyChildren.length - 1].localName !== 'sectPr') errors.push('Section properties are not the last element in w:body.');

  const docPrIds = new Set();
  for (const docPr of documentXml.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')) {
    const id = docPr.getAttribute('id');
    if (id && docPrIds.has(id)) errors.push(`Duplicate wp:docPr id: ${id}.`);
    if (id) docPrIds.add(id);
  }

  return { ok: errors.length === 0, errors };
}

export function getTestingDocxFilename(session) {
  const raw = String(session?.workProduct || '').trim();
  const safe = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim();
  if (safe) return `${safe}.docx`;
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return `ForcePilot-Test-Evidence-${stamp}.docx`;
}

export function downloadTestingDocx(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
