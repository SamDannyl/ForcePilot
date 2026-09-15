<div align="center">

<nobr>
<img src="branding/forcepilot-icon.png" alt="ForcePilot Logo" width="90">
<img src="branding/forcepilot-wordmark.png" alt="ForcePilot" width="260">
</nobr>

**Record Salesforce field data once. Reuse it everywhere.**

A Chrome and Microsoft Edge extension that captures field changes on a Salesforce Lightning record and autofills them back on any other record of the same type — built for QA, testing, and anyone tired of re-typing the same setup data.

<nobr>
<img src="https://img.shields.io/badge/Manifest-V3-4A90D9" alt="Manifest V3">
<img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-4285F4" alt="Platform">
<img src="https://img.shields.io/badge/License-MIT-lightgrey" alt="License">
</nobr>

</div>

---

## Why ForcePilot

Setting up test data in Salesforce usually means the same tedious loop: open a record, fill in the same 10–20 fields, save, repeat on the next record.

ForcePilot breaks that loop.

Record the fields once, give the recording a name, and run it on any comparable record afterward. It handles field matching, relative dates, empty-field-only fills, and retries on failure — so the same setup that took five minutes the first time can take seconds the next.

## How it works

```text
Open record → Start recording → Change fields → Save
                                                   ↓
                       Open another record → Run recording → Review results
```

ForcePilot stores each recording along with metadata about the Salesforce fields it captured, including API names, labels, and field types. This allows it to reliably locate matching fields the next time you use the recording, even on a different record.

## Features

| Feature | Description |
|---|---|
| **Record & replay** | Capture field changes while working normally in Salesforce; save and reuse them as a named recording |
| **Smart autofill** | Fill empty fields only, or overwrite existing values — your choice per run |
| **Relative dates** | Store dates such as `Today + 7 days` instead of a fixed date so recordings don't become stale |
| **Retry on failure** | Re-run only the fields that failed instead of repeating the entire recording |
| **Import / export** | Move recordings between machines or browser profiles as JSON |
| **Recording management** | Rename recordings, edit fields, enable or disable individual fields, or add new fields |
| **Side panel workflow** | Record, browse, and run recordings without leaving the Salesforce tab |

## Supported field types

Text · Textarea · Number · Currency · Percent · Checkbox · Date · Date/Time · Time · Picklist · Multi-select picklist · Address

Support may vary on heavily customized Lightning components or managed-package components.

## Installation

ForcePilot currently runs as an unpacked browser extension.

### Chrome

1. Download or clone this repository.
2. Extract the repository if downloaded as a ZIP.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the ForcePilot folder containing `manifest.json`.
7. Open Salesforce and launch ForcePilot from the extension icon or Salesforce launcher.

### Microsoft Edge

1. Download or clone this repository.
2. Extract the repository if downloaded as a ZIP.
3. Open `edge://extensions` in Edge.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the ForcePilot folder containing `manifest.json`.
7. Open Salesforce and launch ForcePilot from the extension icon or Salesforce launcher.

### Supported Salesforce domains

```text
*.salesforce.com
*.lightning.force.com
*.my.salesforce.com
*.visualforce.com
*.vf.force.com
```

## Settings

ForcePilot provides configuration options for:

- **Fill empty fields only**
- **Verify values after autofill**
- **Stop on first failure**
- **Show or hide the ForcePilot launcher in Salesforce**
- **Relative date behavior**

## Use cases

ForcePilot is designed for workflows such as:

- Salesforce regression testing
- Repeated QA scenarios
- Troubleshooting and reproduction
- Repeating the same record configuration across multiple records

## Project structure

```text
ForcePilot/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── popup.css
├── sidepanel.html
├── sidepanel.js
├── sidepanel.css
├── options.html
├── options.js
├── options.css
├── page_bridge.js
├── src/
│   ├── content.js
│   ├── shared.js
│   └── shared-module.js
├── icons/
└── branding/
```

## Development

ForcePilot is a Manifest V3 browser extension with no build step. The source can be edited and loaded directly into Chrome or Microsoft Edge.

After making changes:

1. Save your edits.
2. Open `chrome://extensions` or `edge://extensions`.
3. Click **Reload** on ForcePilot.
4. Refresh the open Salesforce tab.
5. Test the changed functionality.

## Built with AI

ForcePilot was **vibe-coded with ChatGPT** 🤖

Built iteratively through prompts, debugging, testing, and real-world Salesforce QA use.

## Privacy & data

ForcePilot does not require a ForcePilot account or separate Salesforce credentials. It operates using your existing Salesforce browser session.

Recordings and settings are stored in the browser's local extension storage.

A recording may contain real values entered into Salesforce. Treat exported recordings as potentially sensitive and avoid sharing recordings that contain:

- Customer data
- Production data
- Credentials
- Tokens
- Other confidential Salesforce information

Before sharing screenshots, logs, or exported recordings publicly, remove any customer or confidential information.

## Security

ForcePilot is intended to operate within the Salesforce session already authenticated in your browser.

Report suspected security issues responsibly rather than posting sensitive details publicly in a GitHub Issue.

## Reporting an issue

Open a GitHub Issue with as much of the following information as you can safely share:

- Salesforce object and field type
- What you were trying to do
- What happened instead
- Chrome or Microsoft Edge version
- ForcePilot version
- Relevant console errors, if available

Please remove all customer, production, credential, or other confidential Salesforce information from screenshots and logs before posting.

## Contributing

Bug reports and feature suggestions are welcome through GitHub Issues.

Pull requests are welcome. For larger changes, please open an issue first so the proposed approach can be discussed.

## Versioning

ForcePilot versions are tracked using the version defined in `manifest.json`.

Released versions may be published through GitHub Releases as the project evolves.

## License

ForcePilot is licensed under the **MIT License**.

See the [`LICENSE`](LICENSE) file for the full license text.

---

<div align="center">

<sub>ForcePilot is an independent project and is not affiliated with, endorsed by, or sponsored by Salesforce, Inc. Salesforce and related marks are trademarks of Salesforce, Inc.</sub>

</div>
