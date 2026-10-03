/* ForcePilot theme helper. Explicit user preference only; light is the default. */
export const THEME_ATTRIBUTE = 'data-theme';
export const applyTheme = darkMode => {
  const theme = darkMode === true ? 'dark' : 'light';
  const root = document.documentElement;
  root.setAttribute(THEME_ATTRIBUTE, theme);
  root.style.colorScheme = theme;
  if (document.body) document.body.setAttribute(THEME_ATTRIBUTE, theme);
  return theme;
};
export const watchTheme = onChange => {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes['forcepilot.settings.v1']) return;
    const next = changes['forcepilot.settings.v1'].newValue;
    const dark = next && typeof next === 'object' && next.darkMode === true;
    applyTheme(dark);
    if (typeof onChange === 'function') onChange(dark, next);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
};
