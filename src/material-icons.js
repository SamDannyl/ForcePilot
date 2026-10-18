/* Local Material icon paths — Material Icons visual language, no external font/CDN dependency. */
const PATHS={
  add:'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  fileUpload:'M9 16h6v-6h4l-7-7-7 7h4v6H9zM5 18h14v2H5v-2z',
  fileDownload:'M9 3h6v6h4l-7 7-7-7h4V3zM5 19h14v2H5v-2z',
  archive:'M20.54 5.23l-1.39-1.68A2 2 0 0 0 17.61 3H6.39a2 2 0 0 0-1.54.77L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27ZM6.6 5h10.8l.83 1H5.77l.83-1ZM12 18l-4-4h3v-4h2v4h3l-4 4Z',
  upload:'M9 16h6v-6h4l-7-7-7 7h4v6H9zM5 18h14v2H5v-2z',
  download:'M9 3h6v6h4l-7 7-7-7h4V3zM5 19h14v2H5v-2z',
  more:'M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  delete:'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4z',
  edit:'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.03 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z',
  save:'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zM6 8V5h9v3H6z',
  close:'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.7 4.29 4.29 10.59 10.6 16.89 4.29z',
  refresh:'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  settings:'M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.2 7.2 0 0 0-1.7-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42L9.12 5.07c-.61.25-1.18.58-1.7.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.11.19.34.27.55.19l2.49-1c.52.4 1.09.73 1.7.98l.38 2.65c.03.24.24.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.25 1.18-.58 1.7-.98l2.49 1c.21.08.44 0 .55-.19l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z',
  play:'M8 5v14l11-7L8 5z',
  pause:'M6 5h4v14H6V5zm8 0h4v14h-4V5z',
  stop:'M6 6h12v12H6z',
  folder:'M10 4H2c-1.1 0-1.99.9-1.99 2L0 18c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-10l-2-2z',
  search:'M9.5 3a6.5 6.5 0 1 0 3.98 11.64l4.44 4.44 1.41-1.41-4.44-4.44A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
  arrowRight:'M10 17l5-5-5-5v10z',
  chevron:'M9 6.5 14.5 12 9 17.5 10.5 19l7-7-7-7L9 6.5z',
  arrowBack:'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  bolt:'M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.84 0 .5.8.49.83C12.97 17.33 11 21 11 21z',
  check:'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  checklist:'M9 7h11v2H9V7zm0 4h11v2H9v-2zm0 4h11v2H9v-2zM4 7h2v2H4V7zm0 4h2v2H4v-2zm0 4h2v2H4v-2z',
  warning:'M1 21h22L12 2 1 21zm12-3h-2v2h2v-2zm0-2h-2v-5h2v5z',
  darkMode:'M9.37 5.51A7 7 0 0 0 15.5 18.5 7.5 7.5 0 1 1 9.37 5.51z',
  camera:'M9 2h6l1.5 2H20a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5L9 2zm3 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-2.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z',
  contentCopy:'M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  contentPaste:'M19 2h-4.18C14.4 0.84 13.3 0 12 0s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z',
  noteAdd:'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h8v-2H6V4h7v5h5v5h2V8l-6-6zm5 14h-2v-2h-2v2h-2v2h2v2h2v-2h2v-2z',
  link:'M3.9 12c0-1.7 1.3-3 3-3h4V7H6.9C4.2 7 2 9.2 2 12s2.2 5 4.9 5H11v-2H6.9c-1.7 0-3-1.3-3-3zm3-1v2h10v-2H6.9zm10.2-4H13v2h4.1c1.7 0 3 1.3 3 3s-1.3 3-3 3H13v2h4.1c2.7 0 4.9-2.2 4.9-5s-2.2-5-4.9-5z'
};
const VIEWBOX={more:'0 0 20 20'};
let darkModeIconSequence = 0;
export function icon(name,label=''){
  if (name === 'darkMode') {
    const clipId = `fp-dark-mode-clip-${++darkModeIconSequence}`;
    const title = label ? `<title>${String(label).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}</title>` : '';
    return `<svg class="fp-icon fp-dark-mode-icon" viewBox="0 0 512 512" width="24" height="24" fill="none" aria-hidden="${label?'false':'true'}"${label?' role="img"':''}>${title}<g stroke="currentColor" stroke-width="32" stroke-linecap="round" fill="none"><path d="M256 48V80 M109 109L131 131 M381 109L403 131 M48 256H80 M432 256H464 M109 403L131 381 M381 381L403 403 M256 432V464" fill="none"/></g><defs><clipPath id="${clipId}"><circle cx="256" cy="256" r="144"/></clipPath></defs><circle cx="256" cy="256" r="128" stroke="currentColor" stroke-width="32" fill="none"/><circle cx="292" cy="220" r="108" fill="currentColor" clip-path="url(#${clipId})"/></svg>`;
  }
  const path=PATHS[name]||PATHS.more;
  const viewBox=VIEWBOX[name]||'0 0 24 24';
  const title=label?`<title>${String(label).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}</title>`:'';
  return `<svg class="fp-icon" viewBox="${viewBox}" aria-hidden="${label?'false':'true'}"${label?' role="img"':''}>${title}<path d="${path}"/></svg>`;
}
