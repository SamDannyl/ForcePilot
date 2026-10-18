# ForcePilot — Salesforce Autofill & Testing

**Test faster. Document better.**

ForcePilot is a Chrome extension that helps Salesforce QA teams reduce repetitive record setup, generate test data, manage testing sessions, capture evidence, and export test documentation.

[Explore the interactive product tour](https://samdannyl.github.io/ForcePilot/marketing/) · [Report an issue](https://github.com/SamDannyl/ForcePilot/issues)

## Features

### Record and autofill fields
- Save reusable recordings of Salesforce field values.
- Reuse recorded values on similar records and forms.
- Select specific fields or autofill a full recording.
- Enable **Fill empty fields only** to avoid overwriting existing values.
- Review field-level results and retry unsuccessful fields.

### Generate test data
- Generate values for supported text, email, phone, URL, number, currency, percent, date/time, picklist, multi-select picklist, checkbox, and address fields.
- Use **Custom Text + Unique ID** for recognizable, unique test values.
- Generate dates relative to today or within a date range.
- Select a random valid picklist option or choose from specific values.

### Capture and export testing evidence
- Start, save, resume, and finish testing sessions.
- Import scenario titles from Excel/TSV, Markdown tables, or plain-text lists. Other columns are ignored.
- Track **Pass**, **Fail**, and **Blocked** scenario outcomes.
- Capture screenshots, assign them to scenarios, and review unassigned captures.
- Export a Word document and a ZIP archive of screenshots.

### Built for QA workflows
- Work from the Chrome side panel and switch between light and dark themes.
- Press **Alt+S** to capture a screenshot in the active testing session.
- Press **Alt+X** to open ForcePilot on the current Salesforce tab.

## Product tour

The [interactive product tour](https://samdannyl.github.io/ForcePilot/marketing/) covers these areas in order: Saved recordings, Randomization, Recorded fields, Autofill results, Testing sessions, Testing workspace, and Evidence export.

## Install locally

1. Clone or download this repository and extract the files.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the folder containing `manifest.json`.
5. Open a supported Salesforce page and launch ForcePilot from the toolbar or side panel.

After changing files, return to `chrome://extensions` and reload the extension.

## Typical workflows

**Reuse a recording:** Start recording on a Salesforce page, make the desired field changes, save the recording, then open a similar record and run Autofill. Review the selected fields and results before applying or retrying values.

**Run a testing session:** Start a session, optionally import scenario titles, capture screenshots, assign captures to scenarios, record outcomes, then finish testing and export the Word document and/or screenshots ZIP.

## Repository layout

- `manifest.json` — Chrome extension configuration
- `background.js`, `page_bridge.js` — background and Salesforce page integration
- `popup.*`, `sidepanel.*`, `options.*` — extension interfaces
- `src/` — autofill, randomization, testing, export, and shared modules
- `branding/`, `icons/` — brand and extension icons
- `docs/marketing/` — interactive product tour and its assets
- `docs/PUBLISHING_WEBSITE.md` — GitHub Pages setup
- `CHANGELOG.md` — release notes

## Publish the product tour

In GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select the default branch and `/docs` folder, then save. The tour will be published at [samdannyl.github.io/ForcePilot/marketing](https://samdannyl.github.io/ForcePilot/marketing/) once deployment completes. See [`docs/PUBLISHING_WEBSITE.md`](docs/PUBLISHING_WEBSITE.md) for details.

## Safe use

Autofill can change values on the active Salesforce page. Review selected and generated values before applying them, and use a Salesforce sandbox/test environment for QA whenever possible. Scenario imports currently use scenario titles only.

## Release

See [`CHANGELOG.md`](CHANGELOG.md) for version **2.3.0**.

---

ForcePilot is an independent project and is not affiliated with or endorsed by Salesforce, Inc.
