# Changelog

## 0.1.2

- Uses Zotero's native HTTP request API before falling back to browser `fetch`, improving compatibility with Zotero's plugin network environment.
- Improves diagnostics for network-layer failures that appear as `NetworkError when attempting to fetch resource`.
- Retries Responses requests with list-style input when a provider rejects string input with `Input must be a list`.
- Detects provider error envelopes returned inside successful HTTP responses.

## 0.1.1

- Fixes a chat-send failure mode where the user message could appear without any visible assistant response.
- Adds an in-chat thinking placeholder while Reader AI builds context and waits for the provider.
- Adds clearer Chinese diagnostics for setup, network, provider, and timeout failures.
- Adds a 90-second model request timeout so stalled provider calls no longer leave the chat looking frozen.

## 0.1.0

- Initial public GitHub release.
- Adds a Zotero side-pane paper-reading chat interface.
- Supports configurable OpenAI-compatible providers through Base URL, API type, API key, and model.
- Provides document-aware context from Zotero metadata, abstracts, notes, annotations, and indexed attachment text.
- Adds context preview, cache refresh, full-context copy, sanitized debug reports, and rough token estimates.
- Adds answer/thread saving as Zotero child notes with context metadata.
- Adds stop, regenerate, copy-answer, and contextual follow-up controls.
- Adds lightweight rendering for headings, quotes, lists, code blocks, and simple table rows.
- Adds `npm run check`, clean XPI packaging, and `reader-ai-latest.xpi` generation.
