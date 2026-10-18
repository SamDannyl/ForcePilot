# Changelog

Notable changes for each release are documented here.

## [2.3.0] — 2026-10-18

### Added

- Testing sessions that can be started, saved, resumed, and finished.
- Scenario title import from Excel/TSV, Markdown tables, and plain-text lists.
- Scenario outcome tracking with Pass, Fail, and Blocked states.
- Screenshot evidence capture, scenario assignment, and an unassigned-screenshots view.
- Evidence export to a Word document and a ZIP archive of screenshots.
- A standalone interactive product tour published from `docs/marketing/` and a screenshot gallery in the repository README.

### Improved

- Randomization labels and defaults for date, picklist, and text fields:
  - Dates default to **Relative to current Date**, with a date-range strategy also available.
  - Picklists default to **Select a Random Option**, with **Select randomly from specific values** available for choosing explicit values.
  - Text fields default to **Custom Text + Unique ID**, with the input labeled **Custom Text**.
- Compact relative-date controls to better match the height and width of other inputs.
- Autofill workflow clarity through recorded-field selection, fill-empty-fields-only behavior, results, and retry actions.
- Testing workspace spacing, scrolling, status-menu positioning, and focus styling so scenario content is less likely to be hidden by fixed controls.
- Evidence count labels and compact metadata readability.
- Product naming and extension description to cover both Salesforce autofill and testing workflows.

### Fixed

- Scenario status menus being clipped at the edges of the scrolling scenario list.
- Sticky testing controls obscuring scenario content at the top or bottom of long lists.
- Truncated helper text in the evidence-session naming dialog.
- Repeated completion messaging and inconsistent screenshot/evidence count wording.

### Notes

- Scenario imports use scenario titles; other columns in an imported table are ignored.
- This repository version is identified as `2.3.0` in `manifest.json` and the product-tour site.
