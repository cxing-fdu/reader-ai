# Reader AI for Zotero

Reader AI adds a document-aware AI chat section to the Zotero 7/8/9 item pane and PDF reader side pane.

Publisher: cxing-fdu

## What it does

- Adds an **AI Chat** section to Zotero's right-side item pane.
- Uses the current Zotero item metadata, abstract, notes, annotations, and indexed attachment text as chat context.
- Adds a **Quote in chat** button to the PDF text-selection popup.
- Supports OpenAI-compatible APIs through `Base URL`, `API Key`, and `Model`.
- Saves the latest answer or the whole conversation as Zotero child notes.
- Shows latest request context usage, warnings, selected passage priority, and actual chunk excerpts through the **Context** panel.
- Shows rough context token estimates to help distinguish missing text from oversized context.
- Records model/API metadata in the Context panel and saved notes.
- Lets you copy the full request context from the **Context** panel for debugging or inspection.
- Lets you refresh cached context for the current item after Zotero indexing changes.
- Uses lightweight section-aware and figure-caption-aware retrieval for common paper-reading questions.
- Shows lightweight follow-up chips after answers to keep reading conversations moving.
- Renders common assistant markdown structures including headings, quotes, lists, code blocks, and simple table rows.
- Provides provider settings and a small model test from the settings panel.
- Gives provider/model/API diagnostics when a request fails, including likely fixes for wrong model names, Base URL issues, key problems, and quota/rate limits.
- Provides a sanitized **Copy debug** report in settings for troubleshooting without exposing your API key.
- Exposes temperature and maximum context size controls, and keeps unsent drafts per Zotero item while the panel is open.
- Lets you stop an in-flight model request from the chat controls.
- Keeps toolbar controls usable in narrow Zotero side panes.
- Handles transient Zotero panel refresh states more defensively.

The in-app controls are localized in Chinese for daily use.

## API setup

Open the **AI Chat** section, click **Settings**, and fill:

- `Base URL`: for example `https://api.openai.com/v1`
- `API Key`: your provider key
- `Model`: for example `gpt-4.1-mini`, or a model exposed by your OpenAI-compatible provider

The plugin cannot read the login/API configuration used by Codex or ChatGPT Desktop. If you use a proxy or gateway, paste that gateway's OpenAI-compatible API settings here.

## Build

```bash
npm run check
npm run build
```

The versioned `.xpi` file and `dist/reader-ai-latest.xpi` will be created under `dist/`. `npm run build` also runs the check script first and rebuilds the current outputs cleanly.

## Install in Zotero

In Zotero, go to **Tools -> Add-ons**, click the gear icon, choose **Install Add-on From File...**, and select `dist/reader-ai-latest.xpi` or the versioned `.xpi`.

## Notes

Zotero must have indexed the PDF full text before Reader AI can use the document body. Metadata and abstracts are still available even when full text is not indexed. Use **Preview** or **Context** to see whether Zotero exposed full text for the current attachment.

See `ROADMAP.md` and `KNOWN_ISSUES.md` for the active development plan.
