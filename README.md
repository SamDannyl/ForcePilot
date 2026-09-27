<div align="center">

# ForcePilot

**Record Salesforce field data once. Reuse it everywhere.**

A Chrome and Microsoft Edge extension that captures field changes on a Salesforce Lightning record and autofills them back onto comparable records of the same Salesforce object — built for QA, testing, troubleshooting, and anyone tired of re-entering the same setup data.

<nobr>
<img src="https://img.shields.io/badge/Manifest-V3-4A90D9" alt="Manifest V3">
<img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-4285F4" alt="Platform">
<img src="https://img.shields.io/badge/Version-1.5-1976D2" alt="Version 1.5">
<img src="https://img.shields.io/badge/License-MIT-lightgrey" alt="License">
</nobr>

</div>

---

## What ForcePilot does

ForcePilot records Salesforce field changes once, stores the field identity and value metadata, and lets you reuse that setup later through the Side Panel or Options page.

The replay engine is designed around Salesforce Lightning controls rather than generic browser automation. It handles standard text/number/date fields, checkboxes, picklists, multi-select picklists, addresses, and relative dates.

## 1.5 highlights

- Reliable Salesforce field identity and object-aware replay.
- Record-type-aware picklist metadata and stronger picklist verification.
- Multi-select picklist support with improved verification, including all-selected states.
- Recording cleanup so click-only or empty field interactions are not saved.
- `false` checkbox handling and `0` / `0.00` **Fill empty fields only** semantics.
- Material-inspired UI across Side Panel, Popup, and Options using local SVG icons.
- Compact Saved Recordings and Autofill Results screens.
- In-page ForcePilot confirmation dialogs instead of browser-native confirmations.
- Salesforce field highlighting with a 2px blue border and subtle 2px blue focus ring.
- Faster reuse of skipped recorded values while preserving the normal autofill execution path.
- Import/export, retry failed fields, relative dates, recording editing, and organization workflows preserved.

## Core workflow

```text
Open Salesforce record
        ↓
Start recording
        ↓
Change fields / select values
        ↓
Stop and save the recording
        ↓
Open another compatible record
        ↓
Run the recording
        ↓
Review Autofill Results
```

## Supported field types

Text · Textarea · Number · Currency · Percent · Checkbox · Date · Date/Time · Time · Picklist · Multi-select picklist · Address

Support can vary on heavily customized Lightning components or managed-package components.

## Main features

| Feature | Description |
|---|---|
| **Record & replay** | Capture field changes and save them as named recordings. |
| **Smart Autofill** | Fill empty fields only or overwrite existing values. |
| **Relative dates** | Store values such as `Today + 7 days` instead of a fixed date. |
| **Picklists** | Resolve canonical Salesforce values and display labels. |
| **Multi-select picklists** | Select and verify multiple values through Salesforce dual-listboxes. |
| **Retry** | Retry only failed fields from an Autofill run. |
| **Import / export** | Move recordings between browser profiles as JSON. |
| **Recording editor** | Rename recordings, edit values, enable/disable fields, and remove fields. |
| **Side Panel** | Record, browse, focus, and run recordings without leaving Salesforce. |

## Installation

ForcePilot is distributed as an unpacked Manifest V3 extension.

### Chrome

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the ForcePilot folder containing `manifest.json`.
6. Open Salesforce and launch ForcePilot from the extension icon or Salesforce launcher.

### Microsoft Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the ForcePilot folder containing `manifest.json`.
6. Open Salesforce and launch ForcePilot.

### Supported Salesforce domains

```text
*.salesforce.com
*.lightning.force.com
*.my.salesforce.com
*.visualforce.com
*.vf.force.com
```

## Settings

ForcePilot includes controls for:

- Fill empty fields only
- Verify values after autofill
- Stop on first failure
- Show/hide the Salesforce launcher
- Relative date behavior

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
│   ├── material-icons.js
│   ├── shared.js
│   └── shared-module.js
├── icons/
└── branding/
```

## Development

ForcePilot has no build step. The source can be loaded directly into Chrome or Microsoft Edge as an unpacked extension.

After a code change:

1. Save the files.
2. Reload ForcePilot from the browser extension page.
3. Refresh the Salesforce tab.
4. Test the affected recording/autofill path.

## Privacy & data

ForcePilot does not require a separate ForcePilot account or Salesforce credentials. It uses the Salesforce session already authenticated in the browser.

Recordings and settings are stored in the browser's extension storage. Exported recordings can contain values entered into Salesforce, so treat them as potentially sensitive.

Do not commit customer data, credentials, access tokens, session tokens, or other confidential Salesforce information to this repository.

## Reporting issues

When opening an issue, include the Salesforce object/field type, the action you were trying to perform, what happened, your browser version, and any relevant console error that can be shared safely.

Remove customer, production, credential, and other confidential Salesforce information before posting screenshots or logs.

## Contributing

Bug reports, feature ideas, and pull requests are welcome through GitHub Issues and Pull Requests.

## Versioning

The published extension version is defined by `manifest.json`. This repository is prepared as the **1.5 consolidated release**, with the historical 1.3 baseline retained in `CHANGELOG.md`.

## License

ForcePilot is licensed under the **MIT License**.

See [`LICENSE`](LICENSE) for the full license text.

---

<div align="center">

<sub>ForcePilot is an independent project and is not affiliated with, endorsed by, or sponsored by Salesforce, Inc. Salesforce and related marks are trademarks of Salesforce, Inc.</sub>

</div>
