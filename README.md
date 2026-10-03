<div align="center">

# ForcePilot

**Record Salesforce field data once. Reuse it everywhere.**

A Chrome and Microsoft Edge extension that captures field changes on a Salesforce Lightning record and autofills them back onto comparable records of the same Salesforce object — built for QA, testing, troubleshooting, and anyone tired of re-entering the same setup data.

<nobr>
<img src="https://img.shields.io/badge/Manifest-V3-4A90D9" alt="Manifest V3">
<img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-4285F4" alt="Platform">
<img src="https://img.shields.io/badge/Version-2.0-1976D2" alt="Version 2.0">
<img src="https://img.shields.io/badge/License-MIT-lightgrey" alt="License">
</nobr>

</div>

---

# ForcePilot

ForcePilot is a browser extension for recording and reusing Salesforce field changes.

Record a Salesforce setup once, save it as a named recording, and reuse it on compatible records through the ForcePilot Side Panel.

ForcePilot works with Salesforce Lightning controls and supports common Salesforce field types including text, numbers, dates, checkboxes, picklists, multi-select picklists, addresses, and relative dates.

## 2.0 Highlights

ForcePilot 2.0 adds a more complete testing workflow, improved Salesforce reliability, better evidence handling, new launcher options, and a cleaner interface.

* **Alt + X shortcut** to quickly open and close the ForcePilot Side Panel.
* **Dark mode Support**
* **Bubble, Edge, or Off** launcher modes.
* **Testing workspace** with test cases, steps, screenshots, Autofill, Resume Testing, and session completion.
* **Screenshot evidence** with timestamp overlays and clipboard paste support.
* **Screenshot ZIP export** for workflows that require multiple image files.
* **Improved Word and ZIP exports** with better image quality and smaller file sizes.
* **Better Salesforce record and object detection** after navigation and refresh.
* **More reliable recording and Autofill recovery** when Salesforce pages change or reload.
* **Cleaner and more compact UI** across Side Panel, Popup, Options, Testing, and dialogs.
* **Improved notifications and error recovery** throughout recording, testing, Autofill, and export workflows.

## What ForcePilot does

The basic workflow is simple:

1. Open a Salesforce record.
2. Start a recording.
3. Change the fields you want to reuse.
4. Stop and save the recording.
5. Open another compatible record.
6. Run the recording.
7. Review the Autofill Results.

Recordings preserve Salesforce field identity and value information so they can be reused reliably across compatible records.

## Core Workflow

```text
Open Salesforce record
        ↓
Start recording
        ↓
Change fields / select values
        ↓
Stop and save recording
        ↓
Open another compatible record
        ↓
Run recording
        ↓
Review Autofill Results
```

## Supported Field Types

Text · Textarea · Number · Currency · Percent · Checkbox · Date · Date/Time · Time · Picklist · Multi-select picklist · Address

Relative-date values are also supported, allowing dates such as `Today + 7 days` instead of storing a fixed date.

Support can vary for heavily customized Lightning components or managed-package components.

## Main Features

| Feature                    | Description                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| **Record & Replay**        | Capture field changes and save them as named recordings.                                      |
| **Smart Autofill**         | Fill empty fields only or overwrite existing values.                                          |
| **Relative Dates**         | Reuse values such as `Today + 7 days` instead of fixed dates.                                 |
| **Picklists**              | Reuse Salesforce picklist values reliably.                                                    |
| **Multi-select Picklists** | Select and verify multiple values through Salesforce dual-listboxes.                          |
| **Retry Failed**           | Retry only the fields that failed during Autofill.                                            |
| **Import / Export**        | Move recordings between browser profiles as JSON.                                             |
| **Recording Editor**       | Rename recordings, edit values, enable or disable fields, and remove fields.                  |
| **Side Panel**             | Browse, record, review, and run recordings without leaving Salesforce.                        |
| **Testing**                | Organize test cases and steps, capture evidence, run Autofill, and complete testing sessions. |
| **Evidence Export**        | Export testing evidence to Word or a screenshot-only ZIP.                                     |

## Testing & Evidence

ForcePilot includes a dedicated Testing workflow for Salesforce QA activities.

Testing sessions can include:

* Test cases and individual test steps
* Screenshots and evidence
* Autofill actions
* Resume Testing
* Session completion and review
* Word evidence export
* Screenshot-only ZIP export

### Screenshot Evidence

Testing Evidence supports screenshots captured directly through ForcePilot as well as screenshots pasted from the clipboard, including Windows Snipping Tool.

Native ForcePilot screenshots include a timestamp overlay.

Pasted screenshots remain unchanged and are not timestamped.

### Evidence Exports

Testing sessions can export:

**Microsoft Word**

A structured evidence document suitable for sharing or documentation.

**Screenshot ZIP**

A ZIP containing timestamp-named screenshots for workflows where individual image files need to be attached separately, such as legacy Confluence/Data Center workflows.

Exports use optimized image copies so the original stored evidence remains available for preview and other actions.

## Launcher

ForcePilot can appear on Salesforce pages using one of three launcher styles:

* **Bubble** — compact floating launcher
* **Edge** — right-edge frosted-glass launcher
* **Off** — no Salesforce launcher

You can change the launcher style from Options.

You can also use:

```text
Alt + X
```

to open or close the ForcePilot Side Panel.

## Installation

ForcePilot is distributed as an unpacked Manifest V3 extension.

### Chrome

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the ForcePilot folder containing `manifest.json`.
6. Open Salesforce and launch ForcePilot from the extension icon or Salesforce launcher.

### Microsoft Edge

1. Clone or download this repository.
2. Open `edge://extensions/`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the ForcePilot folder containing `manifest.json`.
6. Open Salesforce and launch ForcePilot.

### Supported Salesforce Domains

```text
*.salesforce.com
*.lightning.force.com
*.my.salesforce.com
*.visualforce.com
*.vf.force.com
```

## Settings

ForcePilot includes settings for:

* Fill empty fields only
* Verify values after Autofill
* Stop on first failure
* Salesforce launcher visibility/style
* Relative-date behavior
* Word and Screenshot ZIP image quality

Export image quality can be configured from **70%–95%**, with **88%** as the default.

## Project Structure

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

After making a code change:

1. Save the files.
2. Reload ForcePilot from the browser extension page.
3. Refresh the Salesforce tab.
4. Test the affected recording, Autofill, or Testing workflow.

## Privacy & Data

ForcePilot does not require a separate ForcePilot account or Salesforce credentials.

It uses the Salesforce session already authenticated in the browser.

Recordings and settings are stored in the browser's extension storage.

Exported recordings and testing evidence can contain Salesforce data entered or captured by the user, so treat them as potentially sensitive.

Do not commit customer data, credentials, access tokens, session tokens, or other confidential Salesforce information to this repository.

## Reporting Issues

When opening an issue, include:

* Salesforce object and field type
* Action you were performing
* What happened
* Browser version
* Relevant console error, when safe to share

Remove customer, production, credential, and other confidential Salesforce information before posting screenshots or logs.

## Contributing

Bug reports, feature ideas, and pull requests are welcome through GitHub Issues and Pull Requests.

## Versioning

The published extension version is defined in `manifest.json`.

This repository is prepared as the **2.0 release**.

See [`CHANGELOG.md`](CHANGELOG.md) for the release history and detailed changes.

## License

ForcePilot is licensed under the **MIT License**.

See [`LICENSE`](LICENSE) for the full license text.

---

<div align="center">

<sub>ForcePilot is an independent project and is not affiliated with, endorsed by, or sponsored by Salesforce, Inc. Salesforce and related marks are trademarks of Salesforce, Inc.</sub>

</div>
