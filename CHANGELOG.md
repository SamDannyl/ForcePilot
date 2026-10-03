# Changelog

All notable changes to ForcePilot are documented here.
## [2.0.0] — Major Testing, UX & Reliability Update

ForcePilot 2.0 brings a more complete testing workflow, faster Salesforce interaction, improved evidence handling, new launcher options, and a cleaner overall experience.

### Testing & Test Cases

* Added a more structured Testing workspace with **collapsible test cases and steps**.
* Added **Start Testing, Resume Testing, Finish Testing, and End Session** workflows.
* Added expand/collapse controls for test cases and steps.
* Added sticky **Screenshot** and **Autofill** actions during testing.
* Improved Testing Complete and session-resume experiences.
* Testing sessions now reopen with test cases and steps expanded by default.
* Simplified the Testing workspace and reduced unnecessary scrolling.

### Evidence & Screenshots

* Added **Paste Screenshot** and **Ctrl+V** support for Testing Evidence.
* Added timestamp overlays to native ForcePilot screenshots with date and 12-hour time.
* Pasted screenshots remain unchanged and do not receive ForcePilot timestamps.
* Added clearer screenshot-capture and clipboard-copy feedback.
* Improved screenshot capture on extension and restricted pages.
* Added **Screenshot ZIP export**, with timestamp-based image filenames for easier attachment to external workflows.

### Word & Evidence Export

* Added configurable **image quality** for Word and Screenshot ZIP exports.
* Improved export image quality while reducing unnecessary file size.
* Duplicate evidence images are now automatically reused instead of being stored repeatedly.
* Word and ZIP exports use optimized evidence images while keeping the original evidence available for preview and other actions.

### Salesforce Reliability

* Added **Alt + X** to open and close the ForcePilot Side Panel.
* Improved Salesforce record and object detection after navigation and refresh.
* Fixed recordings using stale Salesforce record context after moving between records.
* Improved recording reliability when Salesforce pages change, reload, or lose extension state.
* Improved Autofill and recording recovery across Salesforce navigation and page changes.
* Improved Salesforce page performance by loading the full recording engine only when needed.

### Launcher

* Added three launcher modes: **Bubble, Edge, and Off**.
* Added a visual launcher selector in Options.
* Added a compact **Edge** launcher with a frosted-glass appearance.
* Improved Bubble launcher sizing and appearance.
* Launcher preferences are preserved through settings import/export.
* Added the launcher tooltip showing the **Alt + X** shortcut.

### UI & Experience

* Introduced a more consistent typography, spacing, button, focus, and scrollbar system across ForcePilot.
* Added support for Dark mode.
* Refined the Side Panel, Popup, Options, Testing, Evidence, and confirmation dialogs.
* Reduced unnecessary vertical space across frequently used controls.
* Added clearer global notifications for recording, testing, export, Autofill, and Salesforce actions.
* Replaced remaining browser-native confirmation prompts with ForcePilot dialogs.
* Improved keyboard focus and accessibility throughout the extension.

### Reliability & Recovery

* Improved recording session handling across tabs and browser contexts.
* Added recovery when the Salesforce content script is reloaded or loses state.
* Improved screenshot recovery and actionable messages when capture requires browser-level access.
* Improved handling of stale sessions and extension context changes.

### Packaging & Performance

* Optimized branding images and the DOCX template to reduce extension size.
* Improved overall runtime performance and reduced unnecessary Salesforce-page work.
* Removed obsolete legacy launcher and bridge paths.

## \[1.5.0] — Consolidated Public Release

This release consolidates the field-engine, recording reliability, autofill, and Material-inspired UI work developed after the 1.3 baseline. Intermediate internal iterations are folded into this release instead of being published as separate versions.

### Salesforce Field Engine

* Added stable Salesforce field identity using object context, `data-target-selection-name`, field IDs, API/field paths, and object-scoped metadata.
* Added record-type-aware picklist metadata resolution with UI API/REST fallbacks.
* Preserved canonical picklist values while storing the selected display label for reliable replay.
* Hardened standard picklist replay so the live Salesforce control remains authoritative.
* Added deterministic dual-listbox handling for multi-select picklists and stronger selected-value verification, including all-selected states.
* Added semantic datatable and inline-edit field context.
* Added replay preflight and target repair so stale control types can be repaired at execution time instead of blocking valid fields.
* Preserved Currency, Percent, Decimal, Number, Date, Date/Time, Time, Lookup, Address, and Multi-select behavior.
* Normalized numeric display values including currency symbols, commas, decimal values, percentages, `.5`, `-.5`, and `2.00%`.

### Recording Reliability

* Recording no longer saves a field that was only clicked or focused without an actual value being entered or selected.
* Empty recorded steps are removed before a recording is saved.
* Unchecked Boolean/Checkbox values (`false`) are treated as empty for recording capture and **Fill empty fields only**.
* Currency/Percent `0` and `0.00` remain eligible for overwrite when **Fill empty fields only** is enabled.
* Salesforce picklist `--None--` / `-None-` placeholders are treated as empty, while a legitimate picklist value named `None` remains filled.
* Existing Multi-select picklist empty-value behavior remains unchanged.
* Added Pause/Resume recording state handling and recording-session safeguards.
* Improved recording state isolation across tabs, windows, and incognito contexts.
* Hardened stale session and extension-context handling.
* Recording finalization is now tied to actual Salesforce save outcomes rather than a Save-button click alone.

### Autofill and Multi-select Handling

* Lookup replay now targets the real Salesforce `input\[role="combobox"]\[data-value="lookup"]` control when available.
* Uses the lookup input's `aria-controls` relationship to find the live suggestion container.
* Types recorded lookup values through the live input event sequence so Salesforce can render suggestions normally.
* Selects lookup suggestions using exact recorded display text or recorded Salesforce record ID, with direct option-click and keyboard fallback.
* Avoids fuzzy lookup matching that could select the wrong record.
* Retains the page-bridge lookup path as a fallback for Lightning implementations that hide the interactive control.
* Improved multi-select verification after Salesforce finishes moving values between Available and Selected lists, including all-selected states.
* Improved skipped-field value reuse so only the selected field is executed instead of replaying the full recording flow.

### Material-inspired UI / UX

* Reworked Sidebar, Popup, and Options surfaces around a shared Material-inspired design language while remaining a vanilla-JS Manifest V3 extension.
* Added consistent local Material SVG icons, icon-button sizing, focus states, hover states, and typography.
* Fixed Import/Export icon semantics and normalized their icon sizing.
* Added consistent More, Refresh, Edit, Save, Cancel, Delete, Retry, Add Field, Play, Pause, and chevron icons.
* Replaced browser-native confirmation dialogs with in-page ForcePilot modal confirmations.
* Added Salesforce field highlighting with a 2px blue border and a subtle 2px blue focus ring without changing page layout.
* Flattened Saved Recordings into a compact Material-style list instead of stacked cards.
* Aligned recording search, row text, metadata, status, field type, and trailing chevrons to consistent margins.
* Polished Autofill Results into a compact layout with a dedicated aligned status/type column.
* Refined skipped Autofill result rows so the recorded value can be used directly without a separate helper-message interaction.
* Made status pills fit their text naturally.
* Standardized typography across Sidebar, Popup, Options, and confirmation dialogs.
* Tightened relative-date editor controls so Today, `+/-` direction, two-digit offsets, and days remain readable.
* Options field metadata now displays only the field API name rather than the object prefix.
* Removed redundant Options helper text and unnecessary nested card/border treatments.
* Updated the Delete All Recordings action to match the Import/Export button height while keeping the full label visible.

### Reliability and Maintainability

* Centralized recording and settings storage and schema normalization.
* Added schema version 5 migration targeting backward compatibility for legacy target keys.
* Hardened extension message routing, runtime-context handling, field caches, and replay target resolution.
* Removed browser-native `confirm`, `prompt`, and `alert` flows from the published extension UI.
* Kept the project as a no-build-step Manifest V3 extension for direct GitHub/unpacked installation.

## \[1.3.0]

### Baseline

The 1.3 baseline provided:

* Salesforce field recording and replay/autofill.
* Side Panel workflow.
* Recording management and editing.
* **Fill empty fields only** mode.
* Autofill verification and retry.
* Picklist and Multi-select picklist support.
* Lookup and Address support.
* Date, Date/Time, Time, and relative-date handling.
* JSON import/export.
* Launcher and settings controls.
* Local browser storage.
