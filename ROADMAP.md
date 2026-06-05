# Reader AI Roadmap

Reader AI should become a Zotero-native research reading companion, not just a chat box.

## 0.2 Context Reliability

- Show whether Zotero indexed full text is available for the current attachment. Done in 0.2.1.
- Show which text chunks were sent to the model for the latest answer. Done in 0.2.1.
- Allow copying the full built request context. Done in 0.2.8.
- Allow refreshing cached context after indexing changes. Done in 0.2.16.
- Prioritize selected text, current item metadata, annotations, figure captions, and nearby paragraphs. Selected text priority landed in 0.2.1; caption retrieval still needs refinement.
- Improve figure matching for `Fig. 1`, `Figure 1a`, `图 1`, and caption-heavy papers. Caption/nearby mention snippets landed in 0.2.4; image understanding still needs multimodal input.
- Add a lightweight context preview before sending. Done in 0.2.1.

## 0.3 Conversation Experience

- Add streaming responses if the selected API supports it.
- Add regenerate, stop, copy answer, and save whole thread actions. Regenerate, copy, and save thread landed in 0.2.1; non-streaming stop landed in 0.2.6; streaming remains future work.
- Make quick prompts editable and less template-like.
- Add contextual follow-up affordances after answers. Landed in 0.2.9.
- Improve markdown rendering for code, math-like text, tables, and numbered lists. Code, numbered lists, and lightweight table rows are in place; richer math/table rendering remains future work.
- Add clearer empty states and error recovery.

## 0.4 Notes and Knowledge Capture

- Save answer, selected passage, and cited chunks into a structured Zotero child note. Context excerpts and model/API metadata are included as of 0.2.12.
- Save the whole conversation as a note. Done in 0.2.1, with context metadata added later.
- Create note templates for summary, figure explanation, method breakdown, and review notes.
- Link saved notes back to source annotations when possible.

## 0.5 Visual Reading

- Capture current PDF page or selected screen region for multimodal models.
- Send figure screenshots to compatible APIs.
- Combine image analysis with text captions and nearby paragraphs.
- Clearly label when an answer is based on image input versus text-only context.

## 0.6 Provider and Model Layer

- Support Responses and Chat Completions robustly.
- Support generic OpenAI-compatible APIs without baking in private provider details.
- Add model validation and a small test request.
- Add token/cost-aware context controls.

## Release Discipline

- One focused theme per minor release.
- Keep the XPI installable after every release.
- Update `CHANGELOG.md` and `KNOWN_ISSUES.md` before packaging.
- Run `npm run check` before packaging. Added in 0.2.7 and now runs automatically before `npm run build`.
- Keep a stable latest artifact path for install testing. Added `dist/reader-ai-latest.xpi` in 0.2.11.
- Avoid stale archive entries in rebuilt XPI files. Clean current-output packaging added in 0.2.13.
