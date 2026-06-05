# Known Issues

## Context Is Text-Only

Reader AI currently reads Zotero metadata, abstract, notes, annotations, and indexed attachment text. It does not directly see PDF page images or figures. Figure explanations are based on captions and nearby indexed text unless the user supplies image input.

## Full Text Depends on Zotero Indexing

If Zotero has not indexed a PDF, Reader AI may only see metadata and the abstract. The UI now reports indexed full-text character counts and warnings, but it still depends on Zotero exposing attachment text.

Token estimates are approximate and are meant only as a quick context-size signal.

After changing Zotero indexing state, use **Refresh** before **Preview** or sending again.

## Current Page Awareness Is Limited

The plugin does not yet reliably know the exact current visible PDF page. Selected text is currently the best way to anchor a question to a precise passage.

## Context Retrieval Is Still Simple

The current retriever uses keyword, section-heading, selected-passage, and figure-caption matching over chunks. It is not yet a full embedding/RAG system.

## Notes Are Basic

`Save answer` and `Save thread` create Zotero child notes and include context metadata/chunk excerpts. They do not yet link back to exact PDF annotation anchors.

## UI Is Functional but Early

The chat panel has lightweight message rendering and controls. Streaming, stop, richer markdown tables, and image-based figure analysis are not implemented yet.

## Provider Compatibility Varies

Reader AI gives diagnostics for common provider errors, but OpenAI-compatible gateways can still differ in supported parameters, model names, and response shapes.

Use **Copy debug** in Settings to share provider/context state without exposing the API key when troubleshooting.
