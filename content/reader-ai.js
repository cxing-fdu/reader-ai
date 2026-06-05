var ReaderAI = {
  pluginID: null,
  rootURI: null,
  sectionID: null,
  textSelectionHandler: null,
  viewByItemID: new Map(),
  historyByItemID: new Map(),
  contextInfoByItemID: new Map(),
  contextTextByItemID: new Map(),
  textCache: new Map(),
  lastRequestByItemID: new Map(),
  draftByItemID: new Map(),
  abortByItemID: new Map(),

  init({ id, rootURI }) {
    this.pluginID = id;
    this.rootURI = rootURI;
    this.registerSection();
    this.registerReaderSelectionButton();
  },

  shutdown() {
    if (this.sectionID && Zotero.ItemPaneManager?.unregisterSection) {
      Zotero.ItemPaneManager.unregisterSection(this.sectionID);
    }
    if (this.textSelectionHandler && Zotero.Reader?.unregisterEventListener) {
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this.textSelectionHandler);
    }
    for (let controller of this.abortByItemID.values()) {
      controller.abort();
    }
    this.viewByItemID.clear();
    this.historyByItemID.clear();
    this.contextInfoByItemID.clear();
    this.contextTextByItemID.clear();
    this.textCache.clear();
    this.lastRequestByItemID.clear();
    this.draftByItemID.clear();
    this.abortByItemID.clear();
    this.sectionID = null;
    this.textSelectionHandler = null;
  },

  registerSection() {
    if (!Zotero.ItemPaneManager?.registerSection) {
      Zotero.debug("Reader AI: Zotero.ItemPaneManager.registerSection is unavailable");
      return;
    }

    this.sectionID = Zotero.ItemPaneManager.registerSection({
      paneID: "reader-ai-chat",
      pluginID: this.pluginID,
      header: {
        l10nID: "reader-ai-section-header",
        icon: this.rootURI + "icons/reader-ai.svg",
      },
      sidenav: {
        l10nID: "reader-ai-section-sidenav",
        icon: this.rootURI + "icons/reader-ai.svg",
      },
      onRender: ({ body, item, tabType }) => {
        this.render(body, item, tabType).catch(error => this.logError(error));
      },
    });
  },

  registerReaderSelectionButton() {
    if (!Zotero.Reader?.registerEventListener) {
      return;
    }

    this.textSelectionHandler = event => {
      let { reader, doc, params, append } = event;
      let selectedText = params?.annotation?.text || params?.text || "";
      if (!selectedText.trim()) {
        return;
      }

      let button = this.html(doc, "button");
      button.className = "reader-ai-selection-button";
      button.textContent = "引用到对话";
      button.addEventListener("click", () => {
        this.receiveSelection(reader, selectedText);
      });
      append(button);
    };

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      this.textSelectionHandler,
      this.pluginID
    );
  },

  async render(body, item, tabType) {
    if (!body || !item) {
      return;
    }

    this.injectStyles(body.ownerDocument);
    body.replaceChildren();

    let root = this.html(body.ownerDocument, "div");
    root.className = "reader-ai-root";
    body.append(root);

    let context = await this.getContextItems(item);
    let itemID = context.item?.id || item.id;
    let title = context.item?.getField("title") || item.getField?.("title") || "当前条目";
    let history = this.historyByItemID.get(itemID) || [
      {
        role: "system",
        content: "已就绪。你可以直接问这篇文献的思路、方法、图表、结果、局限，或者引用选中的段落来讨论。",
      },
    ];
    this.historyByItemID.set(itemID, history);

    let view = { itemID, item: context.item, attachment: context.attachment, root };
    this.viewByItemID.set(itemID, view);

    root.append(
      this.createToolbar(root.ownerDocument, title),
      this.createSettings(root.ownerDocument),
      this.createContextPanel(root.ownerDocument),
      this.createMessages(root.ownerDocument, history),
      this.createComposer(root.ownerDocument, view),
      this.createStatus(root.ownerDocument)
    );
  },

  createToolbar(doc, title) {
    let toolbar = this.html(doc, "div");
    toolbar.className = "reader-ai-toolbar";

    let label = this.html(doc, "div");
    label.className = "reader-ai-title";
    label.textContent = title;

    let actions = this.html(doc, "div");
    actions.className = "reader-ai-actions";

    let settings = this.button(doc, "设置", () => {
      let panel = toolbar.parentElement.querySelector(".reader-ai-settings");
      panel?.classList.toggle("open");
    });
    settings.title = "配置模型、API 和上下文行为";

    let context = this.button(doc, "上下文", () => {
      let panel = toolbar.parentElement.querySelector(".reader-ai-context-panel");
      let view = this.findViewForRoot(toolbar.parentElement);
      this.updateContextPanel(toolbar.parentElement, view ? this.contextInfoByItemID.get(view.itemID) : null);
      panel?.classList.toggle("open");
    });
    context.title = "查看最近一次回答使用了哪些文献上下文";

    let preview = this.button(doc, "预览", async () => {
      let root = toolbar.parentElement;
      let view = this.findViewForRoot(root);
      if (!view) {
        return;
      }
      let input = root.querySelector(".reader-ai-input");
      let question = input?.value?.trim() || "请预览这篇文献现在可用的上下文。";
      this.setStatus(root, "正在预览文献上下文...");
      try {
        let paperContext = await this.buildPaperContext(view.item, view.attachment, question);
        this.contextInfoByItemID.set(view.itemID, paperContext.info);
        this.contextTextByItemID.set(view.itemID, paperContext.text);
        this.updateContextPanel(root, paperContext.info);
        root.querySelector(".reader-ai-context-panel")?.classList.add("open");
        this.setStatus(root, this.formatContextStatus(paperContext.info));
      }
      catch (error) {
        this.setStatus(root, `预览失败：${error.message || error}`);
        this.logError(error);
      }
    });
    preview.title = "预览当前问题会发送给模型的文献上下文";

    let refresh = this.button(doc, "刷新", () => {
      let root = toolbar.parentElement;
      let view = this.findViewForRoot(root);
      if (!view) {
        return;
      }
      this.clearContextCache(view);
    });
    refresh.title = "清除当前条目的附件全文和上下文缓存";

    let clear = this.button(doc, "清空", () => {
      let root = toolbar.parentElement;
      let itemID = this.findViewForRoot(root)?.itemID;
      if (itemID) {
        this.historyByItemID.set(itemID, [
          {
            role: "system",
            content: "新对话。直接自然提问即可；需要时我会自动拉取文献上下文。",
          },
        ]);
      }
      let messages = root.querySelector(".reader-ai-messages");
      messages?.replaceChildren();
      messages?.append(this.messageNode(root.ownerDocument, "system", "新对话。直接自然提问即可；需要时我会自动拉取文献上下文。"));
    });

    actions.append(context, preview, refresh, settings, clear);
    toolbar.append(label, actions);
    return toolbar;
  },

  createContextPanel(doc) {
    let panel = this.html(doc, "div");
    panel.className = "reader-ai-context-panel";

    let head = this.html(doc, "div");
    head.className = "reader-ai-context-head";

    let title = this.html(doc, "div");
    title.className = "reader-ai-context-title";
    title.textContent = "上下文";

    let copy = this.button(doc, "复制完整上下文", () => this.copyContextFromPanel(panel));
    copy.title = "复制最近一次请求或预览发送给模型的完整文献上下文";
    head.append(title, copy);

    let body = this.html(doc, "div");
    body.className = "reader-ai-context-body";
    body.textContent = "还没有发送请求。";

    panel.append(head, body);
    return panel;
  },

  updateContextPanel(root, info) {
    let body = root.querySelector(".reader-ai-context-body");
    if (!body) {
      return;
    }
    if (!info) {
      body.textContent = "还没有发送请求。";
      return;
    }
    let doc = body.ownerDocument;
    body.replaceChildren();
    let summary = [
      ["模型", info.model || "未设置"],
      ["接口类型", info.apiType || "responses"],
      ["模式", info.mode],
      ["文献片段", info.chunks],
      ["上下文字符", info.chars],
      ["估算 tokens", info.estimatedTokens || 0],
      ["附件", info.hasAttachment ? (info.attachmentTitle || "有") : "无"],
      ["全文", info.fullTextSkipped ? "本次已跳过" : (info.fullTextChars ? `已索引 ${info.fullTextChars} 字符` : "不可用")],
    ];
    for (let [label, value] of summary) {
      let row = this.html(doc, "div");
      row.className = "reader-ai-context-row";
      let key = this.html(doc, "span");
      key.textContent = label;
      let val = this.html(doc, "strong");
      val.textContent = String(value);
      row.append(key, val);
      body.append(row);
    }

    for (let warning of info.warnings || []) {
      let node = this.html(doc, "div");
      node.className = "reader-ai-context-warning";
      node.textContent = warning;
      body.append(node);
    }

    if (info.anchoredExcerpt) {
      let anchored = this.html(doc, "div");
      anchored.className = "reader-ai-context-excerpt anchored";
      let label = this.html(doc, "div");
      label.className = "reader-ai-context-excerpt-label";
      label.textContent = "选中/引用内容";
      let text = this.html(doc, "div");
      text.textContent = info.anchoredExcerpt;
      anchored.append(label, text);
      body.append(anchored);
    }

    if (info.captionSnippets?.length) {
      let title = this.html(doc, "div");
      title.className = "reader-ai-context-subtitle";
      title.textContent = "图表证据";
      body.append(title);
      for (let snippet of info.captionSnippets) {
        let node = this.html(doc, "div");
        node.className = "reader-ai-context-excerpt figure";
        let label = this.html(doc, "div");
        label.className = "reader-ai-context-excerpt-label";
        label.textContent = snippet.label;
        let text = this.html(doc, "div");
        text.textContent = snippet.text;
        node.append(label, text);
        body.append(node);
      }
    }

    if (info.excerpts?.length) {
      let title = this.html(doc, "div");
      title.className = "reader-ai-context-subtitle";
      title.textContent = "已发送片段";
      body.append(title);
      for (let excerpt of info.excerpts) {
        let node = this.html(doc, "div");
        node.className = "reader-ai-context-excerpt";
        let label = this.html(doc, "div");
        label.className = "reader-ai-context-excerpt-label";
        label.textContent = excerpt.label;
        let text = this.html(doc, "div");
        text.textContent = excerpt.text;
        node.append(label, text);
        body.append(node);
      }
    }
  },

  createSettings(doc) {
    let settings = this.html(doc, "div");
    settings.className = "reader-ai-settings";

    let grid = this.html(doc, "div");
    grid.className = "reader-ai-settings-grid";

    let providerPreset = this.selectField(doc, "服务预设", "reader-ai-provider-preset", "custom", [
      ["custom", "自定义"],
      ["openai", "OpenAI"],
    ]);
    let baseURL = this.field(doc, "API 地址", "reader-ai-base-url", this.pref("baseURL"));
    let apiType = this.selectField(doc, "接口类型", "reader-ai-api-type", this.pref("apiType") || "responses", [
      ["responses", "Responses"],
      ["chat_completions", "Chat Completions"],
    ]);
    let apiKey = this.field(doc, "API 密钥", "reader-ai-api-key", this.pref("apiKey"), "password");
    let model = this.field(doc, "模型", "reader-ai-model", this.pref("model"));
    let temperature = this.field(doc, "温度", "reader-ai-temperature", this.pref("temperature"));
    temperature.querySelector("input").title = "数值越低越稳定，越高越发散。";
    let maxContextChars = this.field(doc, "最大上下文字符", "reader-ai-max-context", this.pref("maxContextChars"));
    maxContextChars.querySelector("input").title = "发送给模型的文献上下文上限。";
    let contextMode = this.selectField(doc, "上下文模式", "reader-ai-context-mode", this.pref("contextMode") || "auto", [
      ["auto", "自动"],
      ["light", "轻量"],
      ["deep", "深度"],
    ]);
    contextMode.querySelector("select").title = "自动：闲聊少发上下文；轻量：少发片段；深度：发送更多文献文本。";
    let systemPrompt = this.field(
      doc,
      "系统提示词",
      "reader-ai-system-prompt",
      this.pref("systemPrompt"),
      "textarea"
    );

    let applyPreset = this.button(doc, "应用预设", () => {
      let preset = providerPreset.querySelector("select").value;
      if (preset == "openai") {
        baseURL.querySelector("input").value = "https://api.openai.com/v1";
        apiType.querySelector("select").value = "responses";
        model.querySelector("input").value = "gpt-4.1-mini";
      }
      this.setStatus(settings, "预设已填入。开始聊天前请保存设置。");
    });

    let save = this.button(doc, "保存设置", () => {
      this.setPref("baseURL", baseURL.querySelector("input").value.trim());
      this.setPref("apiType", apiType.querySelector("select").value);
      this.setPref("apiKey", apiKey.querySelector("input").value.trim());
      this.setPref("model", model.querySelector("input").value.trim());
      this.setPref("temperature", this.cleanNumberPref(temperature.querySelector("input").value, "0.2"));
      this.setPref("maxContextChars", this.cleanNumberPref(maxContextChars.querySelector("input").value, "24000"));
      this.setPref("contextMode", contextMode.querySelector("select").value);
      this.setPref("systemPrompt", systemPrompt.querySelector("textarea").value.trim());
      this.setStatus(settings, "设置已保存。");
    }, "primary");

    let test = this.button(doc, "测试模型", async () => {
      this.setPref("baseURL", baseURL.querySelector("input").value.trim());
      this.setPref("apiType", apiType.querySelector("select").value);
      this.setPref("apiKey", apiKey.querySelector("input").value.trim());
      this.setPref("model", model.querySelector("input").value.trim());
      this.setPref("temperature", this.cleanNumberPref(temperature.querySelector("input").value, "0.2"));
      this.setPref("maxContextChars", this.cleanNumberPref(maxContextChars.querySelector("input").value, "24000"));
      this.setStatus(settings, "正在测试模型...");
      try {
        let answer = await this.callModel([
          { role: "system", content: "请用一句简短中文回复。" },
          { role: "user", content: "Reader AI 设置测试。如果你能读到这句话，请说模型连接正常。" },
        ]);
        this.setStatus(settings, `模型正常：${this.trimTo(this.plainText(answer), 120)}`);
      }
      catch (error) {
        this.setStatus(settings, `模型测试失败：${error.message || error}`);
        this.logError(error);
      }
    });

    let debug = this.button(doc, "复制排障信息", () => this.copyDebugReport(settings));
    debug.title = "复制不包含 API 密钥的设置和上下文排障报告";

    let settingsActions = this.html(doc, "div");
    settingsActions.className = "reader-ai-settings-actions";
    settingsActions.append(applyPreset, save, test, debug);

    grid.append(providerPreset, baseURL, apiType, apiKey, model, temperature, maxContextChars, contextMode, systemPrompt, settingsActions);
    settings.append(grid);
    return settings;
  },

  createMessages(doc, history) {
    let messages = this.html(doc, "div");
    messages.className = "reader-ai-messages";
    for (let message of history) {
      messages.append(this.messageNode(doc, message.role, message.content));
    }
    return messages;
  },

  createComposer(doc, view) {
    let wrap = this.html(doc, "div");
    wrap.className = "reader-ai-composer";

    let input = this.html(doc, "textarea");
    input.className = "reader-ai-input";
    input.placeholder = "直接问这篇文献...";
    input.value = this.draftByItemID.get(view.itemID) || "";
    input.addEventListener("input", () => {
      this.draftByItemID.set(view.itemID, input.value);
    });
    input.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        send.click();
      }
    });

    let side = this.html(doc, "div");
    side.className = "reader-ai-actions";
    side.style.flexDirection = "column";

    let send = this.button(doc, "发送", () => this.send(view, input), "primary");
    send.classList.add("reader-ai-send");
    let stop = this.button(doc, "停止", () => this.stopRequest(view));
    stop.classList.add("reader-ai-stop");
    stop.disabled = true;
    stop.title = "停止当前模型请求";
    let regenerate = this.button(doc, "重答", () => this.regenerateLastAnswer(view));
    regenerate.title = "让模型重新回答最近一个问题";
    let copy = this.button(doc, "复制回答", () => this.copyLastAssistantMessage(view));
    copy.title = "复制最近一条回答";
    let note = this.button(doc, "保存回答", () => this.saveLastAssistantMessage(view));
    note.title = "把最近一问一答和上下文摘要保存为 Zotero 子笔记";
    let thread = this.button(doc, "保存对话", () => this.saveConversationNote(view));
    thread.title = "把当前完整对话保存为 Zotero 子笔记";
    side.append(send, stop, regenerate, copy, note, thread);
    wrap.append(input, side);
    return wrap;
  },

  createStatus(doc) {
    let status = this.html(doc, "div");
    status.className = "reader-ai-status";
    return status;
  },

  async send(view, input) {
    let question = input.value.trim();
    if (!question) {
      return;
    }
    await this.sendQuestion(view, question, { input, appendUser: true });
  },

  async sendQuestion(view, question, options = {}) {
    let appendUser = options.appendUser !== false;

    let root = view.root;
    let messagesEl = root.querySelector(".reader-ai-messages");
    let sendButton = root.querySelector(".reader-ai-send");
    let stopButton = root.querySelector(".reader-ai-stop");
    let history = this.historyByItemID.get(view.itemID) || [];
    let controller = null;
    let pendingNode = null;

    try {
      if (appendUser) {
        history.push({ role: "user", content: question });
        messagesEl.append(this.messageNode(root.ownerDocument, "user", question));
      }
      if (options.input) {
        options.input.value = "";
        this.draftByItemID.delete(view.itemID);
      }

      pendingNode = this.messageNode(root.ownerDocument, "assistant", "正在思考...");
      pendingNode.classList.add("pending");
      messagesEl.append(pendingNode);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      controller = this.createAbortController();
      if (controller) {
        this.abortByItemID.set(view.itemID, controller);
      }
      if (sendButton) {
        sendButton.disabled = true;
      }
      if (stopButton) {
        stopButton.disabled = !controller;
      }
      this.setStatus(root, "正在构建文献上下文...");

      let paperContext = await this.buildPaperContext(view.item, view.attachment, question);
      this.contextInfoByItemID.set(view.itemID, paperContext.info);
      this.contextTextByItemID.set(view.itemID, paperContext.text);
      this.lastRequestByItemID.set(view.itemID, {
        question,
        contextInfo: paperContext.info,
      });
      let requestMessages = [
        { role: "system", content: this.pref("systemPrompt") },
        { role: "system", content: this.runtimeContext() },
        { role: "system", content: paperContext.text },
        ...history.filter(message => message.role !== "system").slice(-10),
      ];

      this.setStatus(root, "正在调用模型...");
      if (pendingNode?.isConnected) {
        pendingNode.replaceChildren();
        this.renderAssistantText(pendingNode, "正在等待模型返回...");
      }
      let answer = await this.callModel(requestMessages, { signal: controller?.signal });
      history.push({ role: "assistant", content: answer });
      this.historyByItemID.set(view.itemID, history);
      let answerNode = this.messageNode(root.ownerDocument, "assistant", answer);
      if (pendingNode?.isConnected) {
        pendingNode.replaceWith(answerNode);
      }
      else {
        messagesEl.append(answerNode);
      }
      messagesEl.append(this.followupNode(root.ownerDocument, view, question, answer, paperContext.info));
      messagesEl.scrollTop = messagesEl.scrollHeight;
      this.updateContextPanel(root, paperContext.info);
      this.setStatus(root, this.formatContextStatus(paperContext.info));
    }
    catch (error) {
      if (this.isAbortError(error)) {
        let stopped = "请求已停止。";
        let stoppedNode = this.messageNode(root.ownerDocument, "system", stopped);
        if (pendingNode?.isConnected) {
          pendingNode.replaceWith(stoppedNode);
        }
        else {
          messagesEl.append(stoppedNode);
        }
        this.setStatus(root, stopped);
        return;
      }
      let text = this.describeRuntimeError(error);
      history.push({ role: "assistant", content: text });
      let errorNode = this.messageNode(root.ownerDocument, "assistant", text);
      errorNode.classList.add("error");
      if (pendingNode?.isConnected) {
        pendingNode.replaceWith(errorNode);
      }
      else {
        messagesEl.append(errorNode);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      this.setStatus(root, text);
      this.logError(error);
    }
    finally {
      if (controller && this.abortByItemID.get(view.itemID) == controller) {
        this.abortByItemID.delete(view.itemID);
      }
      if (sendButton) {
        sendButton.disabled = false;
      }
      if (stopButton) {
        stopButton.disabled = true;
      }
    }
  },

  stopRequest(view) {
    let controller = this.abortByItemID.get(view.itemID);
    if (!controller) {
      this.setStatus(view.root, "当前没有正在进行的请求。");
      return;
    }
    controller.abort();
    this.setStatus(view.root, "正在停止请求...");
  },

  clearContextCache(view) {
    this.textCache.delete(this.contextCacheKey(view.item, view.attachment));
    this.contextInfoByItemID.delete(view.itemID);
    this.contextTextByItemID.delete(view.itemID);
    this.updateContextPanel(view.root, null);
    this.setStatus(view.root, "上下文缓存已清除。请点击预览或重新发送问题来从 Zotero 重建上下文。");
  },

  isAbortError(error) {
    return error?.name == "AbortError" || /abort|stopped/i.test(error?.message || "");
  },

  createAbortController() {
    try {
      return typeof AbortController == "function" ? new AbortController() : null;
    }
    catch (error) {
      this.logError(error);
      return null;
    }
  },

  followupNode(doc, view, question, answer, info) {
    let wrap = this.html(doc, "div");
    wrap.className = "reader-ai-followups";
    for (let followup of this.suggestFollowups(question, answer, info)) {
      let button = this.button(doc, followup.label, () => {
        let input = view.root.querySelector(".reader-ai-input");
        if (!input) {
          return;
        }
        input.value = followup.prompt;
        this.draftByItemID.set(view.itemID, input.value);
        view.root.querySelector(".reader-ai-send")?.click();
      }, "subtle");
      button.title = followup.prompt;
      wrap.append(button);
    }
    return wrap;
  },

  suggestFollowups(question, answer, info) {
    let suggestions = [
      {
        label: "证据在哪",
        prompt: "你刚才的判断主要依据哪些原文片段？请按摘要、标注、chunk 或 figure evidence 分开说明，不要泛泛而谈。",
      },
    ];
    if (info?.captionSnippets?.length) {
      suggestions.push({
        label: "顺着图讲",
        prompt: "沿着刚才抓到的 figure evidence，帮我解释这些图在论文论证中的作用，以及我读图时最该看哪几个细节。",
      });
    }
    if (/方法|method|algorithm|pipeline|怎么做/i.test(question + "\n" + answer)) {
      suggestions.push({
        label: "为什么这样做",
        prompt: "这些方法设计背后的动机是什么？如果换一种常见做法，会损失什么或带来什么问题？",
      });
    }
    suggestions.push(
      {
        label: "挑局限",
        prompt: "基于这篇文章目前给出的证据，帮我挑最值得警惕的局限、隐含假设和可能的反例。",
      },
      {
        label: "接我的课题",
        prompt: "如果我要把这篇文章接到自己的研究里，最自然的切入点是什么？请给我几个可以继续追的方向。",
      }
    );
    return suggestions.slice(0, 4);
  },

  async regenerateLastAnswer(view) {
    let history = this.historyByItemID.get(view.itemID) || [];
    let lastUserIndex = history.map(message => message.role).lastIndexOf("user");
    if (lastUserIndex < 0) {
      this.setStatus(view.root, "还没有可以重答的问题。");
      return;
    }
    let question = history[lastUserIndex].content;
    let trimmed = history.slice(0, lastUserIndex + 1);
    this.historyByItemID.set(view.itemID, trimmed);
    this.renderMessages(view.root, trimmed);
    await this.sendQuestion(view, question, { appendUser: false });
  },

  async buildPaperContext(item, attachment, question) {
    let metadata = this.formatMetadata(item);
    let notes = await this.formatNotesAndAnnotations(item, attachment);
    let contextMode = this.pref("contextMode") || "auto";
    let casual = contextMode != "deep" && this.isCasualQuestion(question);
    let anchoredText = this.extractAnchoredPassage(question);
    let retrieval = casual
      ? { chunks: [], fullTextInfo: this.getAttachmentInfo(item, attachment, true) }
      : await this.getRelevantChunks(item, attachment, question, anchoredText);
    let chunks = retrieval.chunks || [];
    let captionSnippets = retrieval.captionSnippets || [];
    let fullTextInfo = retrieval.fullTextInfo || { text: "", attachments: [] };
    let maxChars = Number(this.pref("maxContextChars")) || 24000;
    if (contextMode == "light") {
      maxChars = Math.min(maxChars, 10000);
    }
    else if (contextMode == "deep") {
      maxChars = Math.max(maxChars, 42000);
    }

    let parts = [
      "# Reader AI Context Rules",
      "The assistant can read Zotero metadata, abstract, notes, annotations, and indexed attachment text. It cannot directly see raster PDF figures unless their captions/text are present in the indexed text or the user provides an image/description.",
      "# Current Zotero Item",
      metadata,
      anchoredText ? "# User-Selected Or Quoted Passage\n" + this.trimTo(anchoredText, 5000) : "",
      notes ? "# Notes and Annotations\n" + notes : "",
      captionSnippets.length ? "# Figure Captions And Nearby Mentions\n" + captionSnippets.map(snippet => `[${snippet.label}]\n${snippet.text}`).join("\n\n") : "",
      chunks.length ? "# Relevant Full Text Chunks\n" + chunks.map(chunk => `[Chunk ${chunk.index + 1}]\n${chunk.text}`).join("\n\n") : "# Relevant Full Text Chunks\nNo indexed full text was available or no chunks matched this question.",
    ].filter(Boolean);

    if (casual) {
      parts = [
        "# Reader AI Context Rules",
        "This appears to be a casual or configuration question, so full paper chunks were skipped to save tokens.",
        "# Current Zotero Item",
        metadata,
        anchoredText ? "# User-Selected Or Quoted Passage\n" + this.trimTo(anchoredText, 5000) : "",
      ].filter(Boolean);
    }

    let text = this.trimTo(parts.join("\n\n"), maxChars);
    let warnings = this.contextWarnings({
      casual,
      attachment,
      fullTextInfo,
      chunks,
      anchoredText,
    });
    return {
      text,
      info: {
        model: this.pref("model") || "",
        apiType: this.pref("apiType") || "responses",
        createdAt: new Date().toLocaleString(),
        mode: contextMode,
        casual,
        chunks: chunks.length,
        chars: text.length,
        estimatedTokens: this.estimateTokens(text),
        hasAttachment: !!attachment,
        attachmentTitle: attachment?.getField?.("title") || attachment?.attachmentFilename || "",
        attachmentCount: fullTextInfo.attachments?.length || 0,
        fullTextChars: fullTextInfo.text?.length || 0,
        fullTextSkipped: !!fullTextInfo.skipped,
        warnings,
        anchoredExcerpt: anchoredText ? this.trimTo(this.plainText(anchoredText), 900) : "",
        excerpts: chunks.slice(0, 8).map(chunk => ({
          label: this.chunkLabel(chunk),
          text: this.trimTo(this.plainText(chunk.text), 900),
        })),
        captionSnippets: captionSnippets.slice(0, 6).map(snippet => ({
          label: snippet.label,
          text: this.trimTo(this.plainText(snippet.text), 900),
        })),
        sectionHits: retrieval.sectionHits || [],
      },
    };
  },

  runtimeContext() {
    return [
      "# Reader AI Runtime",
      `Configured model: ${this.pref("model") || "not set"}`,
      `API type: ${this.pref("apiType") || "responses"}`,
      "If the user asks what model or provider is being used, answer from this configured model field and mention that the upstream gateway may route it internally.",
    ].join("\n");
  },

  contextWarnings({ casual, attachment, fullTextInfo, chunks, anchoredText }) {
    let warnings = [];
    if (casual) {
      warnings.push("Full-text chunks were skipped because this looked like a casual or configuration question.");
    }
    if (!attachment) {
      warnings.push("No attachment was detected for this Zotero item, so answers may only use metadata, abstract, notes, and annotations.");
    }
    else if (!casual && !fullTextInfo?.text) {
      warnings.push("No indexed full text was available from Zotero. Open Zotero's search/index settings or re-index the PDF if this paper should have body text.");
    }
    else if (!chunks.length && !casual) {
      warnings.push("Full text exists, but no relevant chunks were selected for this question. Try selecting a passage or switching Context Mode to Deep.");
    }
    if (anchoredText) {
      warnings.push("Your selected or quoted passage was pinned as high-priority context.");
    }
    for (let source of fullTextInfo?.attachments || []) {
      if (source.error) {
        warnings.push(`Could not read ${source.title || "an attachment"}: ${source.error}`);
      }
    }
    return warnings;
  },

  isCasualQuestion(question) {
    let q = this.plainText(question).toLowerCase();
    if (q.length > 80) {
      return false;
    }
    return /^(你好|您好|hi|hello|hey|在吗|你是谁|你是什么|什么模型|模型|who are you|what model|test|测试)[\s？?。!！]*$/.test(q);
  },

  formatContextStatus(info) {
    if (!info) {
      return "完成。";
    }
    if (info.casual) {
      return "完成。本次问题偏闲聊/配置，已跳过全文片段。";
    }
    if (!info.chunks) {
      return "完成。没有可用的全文索引片段。";
    }
    return `完成。已使用 ${info.chunks} 个文献片段（${info.mode} 模式）。`;
  },

  formatMetadata(item) {
    if (!item) {
      return "No item metadata available.";
    }
    let creators = [];
    try {
      creators = item.getCreators()
        .map(creator => `${creator.firstName || ""} ${creator.lastName || ""}`.trim())
        .filter(Boolean);
    }
    catch (error) {}

    let fields = [
      ["Title", item.getField("title")],
      ["Authors", creators.join("; ")],
      ["Date", item.getField("date")],
      ["Publication", item.getField("publicationTitle") || item.getField("proceedingsTitle")],
      ["DOI", item.getField("DOI")],
      ["URL", item.getField("url")],
      ["Abstract", item.getField("abstractNote")],
    ];
    return fields
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${this.plainText(value)}`)
      .join("\n");
  },

  async formatNotesAndAnnotations(item, attachment) {
    let lines = [];

    try {
      let noteIDs = item?.getNotes?.() || [];
      for (let id of noteIDs.slice(0, 8)) {
        let note = Zotero.Items.get(id);
        lines.push(`[Note] ${this.plainText(note.getNote()).slice(0, 1200)}`);
      }
    }
    catch (error) {}

    try {
      let annotations = attachment?.getAnnotations?.() || [];
      for (let annotation of annotations.slice(0, 24)) {
        let text = annotation.annotationText || "";
        let comment = annotation.annotationComment || "";
        if (text || comment) {
          lines.push(`[Annotation p.${annotation.annotationPageLabel || annotation.annotationPageIndex || "?"}] ${this.plainText(text)} ${this.plainText(comment)}`.trim());
        }
      }
    }
    catch (error) {}

    return lines.join("\n");
  },

  async getRelevantChunks(item, attachment, question, anchoredText = "") {
    let fullTextInfo = await this.getFullTextInfo(item, attachment);
    let text = fullTextInfo.text;
    if (!text) {
      return { chunks: [], fullTextInfo, terms: [], figureRefs: [], captionSnippets: [], sectionHits: [] };
    }

    let chunks = this.chunkText(text, 1500, 220);
    let lowerQuestion = question.toLowerCase();
    let contextMode = this.pref("contextMode") || "auto";
    let summaryQuestion = /总结|概括|summary|overview|contribution|贡献|方法|method|limitation|局限/i.test(question);
    let figureRefs = this.extractFigureRefs(question);
    let captionSnippets = this.extractFigureSnippets(text, figureRefs, question);
    let sectionHints = this.sectionHintsForQuestion(question);

    let scored = chunks.map((text, index) => ({
      index,
      text,
      score: summaryQuestion && index < 6 ? 10 - index : 0,
      reasons: summaryQuestion && index < 6 ? ["early paper context"] : [],
    }));

    let termText = `${lowerQuestion}\n${anchoredText.toLowerCase()}`;
    let terms = Array.from(new Set(termText.match(/[\p{L}\p{N}_-]{2,}/gu) || []))
      .filter(term => !["this", "that", "with", "from", "paper", "article", "what", "how", "一下", "这个", "那个", "文献", "文章"].includes(term));
    let anchorNeedles = this.anchorNeedles(anchoredText);
    for (let chunk of scored) {
      let haystack = chunk.text.toLowerCase();
      for (let term of terms) {
        if (haystack.includes(term)) {
          chunk.score += term.length > 6 ? 3 : 1;
          if (chunk.reasons.length < 4) {
            chunk.reasons.push(`matched "${term}"`);
          }
        }
      }
      for (let ref of figureRefs) {
        if (this.chunkMentionsFigure(haystack, ref)) {
          chunk.score += 18;
          chunk.reasons.push(`mentions Figure ${ref}`);
        }
      }
      for (let needle of anchorNeedles) {
        if (haystack.includes(needle)) {
          chunk.score += 35;
          chunk.reasons.push("contains selected passage");
        }
      }
      for (let hint of sectionHints) {
        if (hint.pattern.test(haystack)) {
          chunk.score += hint.score;
          chunk.reasons.push(hint.label);
        }
      }
      if (this.looksLikeFigureQuestion(question) && /(?:fig(?:ure)?\.?|图)\s*\d+[a-z]?/i.test(chunk.text)) {
        chunk.score += 8;
        chunk.reasons.push("figure mention");
      }
    }

    let scoredByIndex = new Map(scored.map(chunk => [chunk.index, chunk]));
    let limit = contextMode == "deep" ? 14 : contextMode == "light" ? 5 : 9;
    let selectedIndexes = new Set(scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map(chunk => chunk.index));

    for (let index of Array.from(selectedIndexes)) {
      if (figureRefs.length || contextMode == "deep") {
        if (index > 0) {
          selectedIndexes.add(index - 1);
        }
        if (index < chunks.length - 1) {
          selectedIndexes.add(index + 1);
        }
      }
    }

    let selected = Array.from(selectedIndexes)
      .sort((a, b) => a - b)
      .slice(0, contextMode == "deep" ? 22 : 12)
      .map(index => ({
        index,
        text: chunks[index],
        score: scoredByIndex.get(index)?.score || 0,
        reasons: Array.from(new Set(scoredByIndex.get(index)?.reasons || [])).slice(0, 4),
      }))
      .sort((a, b) => a.index - b.index);
    let sectionHits = Array.from(new Set(selected.flatMap(chunk => chunk.reasons || [])
      .filter(reason => /section|method|discussion|conclusion|limitation|result|abstract|introduction/i.test(reason))))
      .slice(0, 6);
    return { chunks: selected, fullTextInfo, terms, figureRefs, captionSnippets, sectionHits };
  },

  chunkLabel(chunk) {
    let reasons = (chunk.reasons || []).filter(Boolean).slice(0, 2);
    return reasons.length
      ? `Chunk ${chunk.index + 1} · ${reasons.join(", ")}`
      : `Chunk ${chunk.index + 1}`;
  },

  sectionHintsForQuestion(question) {
    let q = this.plainText(question).toLowerCase();
    let hints = [];
    if (/总结|概括|summary|overview|contribution|贡献|主线|框架|what is this paper/i.test(q)) {
      hints.push(
        { label: "abstract/introduction section", pattern: /\b(abstract|introduction|background)\b/i, score: 14 },
        { label: "result/discussion section", pattern: /\b(results?|discussion|conclusion|concluding remarks)\b/i, score: 12 }
      );
    }
    if (/方法|method|algorithm|模型|实验设计|怎么做|pipeline|implementation/i.test(q)) {
      hints.push(
        { label: "method section", pattern: /\b(methods?|methodology|materials and methods|approach|algorithm|implementation|experimental setup)\b/i, score: 18 }
      );
    }
    if (/局限|limitation|缺陷|不足|future|assumption|假设|discussion/i.test(q)) {
      hints.push(
        { label: "limitation/discussion section", pattern: /\b(limitations?|discussion|future work|conclusion|caveats?|assumptions?)\b/i, score: 20 }
      );
    }
    if (/结果|result|实验|evaluation|ablation|消融|性能/i.test(q)) {
      hints.push(
        { label: "result/evaluation section", pattern: /\b(results?|evaluation|experiments?|ablation|performance)\b/i, score: 16 }
      );
    }
    return hints;
  },

  looksLikeFigureQuestion(question) {
    return /图|fig(?:ure)?\.?|panel|caption|subplot|曲线|表/i.test(question);
  },

  extractFigureSnippets(text, figureRefs, question) {
    if (!this.looksLikeFigureQuestion(question) && !figureRefs.length) {
      return [];
    }
    let normalized = this.plainText(text);
    let refs = figureRefs.length ? figureRefs : [];
    let patterns = refs.length
      ? refs.flatMap(ref => {
        let escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return [
          new RegExp(`\\bfig(?:ure)?\\.?\\s*${escaped}\\b`, "ig"),
          new RegExp(`图\\s*${escaped}\\b`, "ig"),
        ];
      })
      : [/\bfig(?:ure)?\.?\s*\d+[a-z]?\b/ig, /图\s*\d+[a-z]?\b/ig];
    let snippets = [];
    let seen = [];
    for (let pattern of patterns) {
      let match;
      while ((match = pattern.exec(normalized)) && snippets.length < 8) {
        let index = match.index;
        if (seen.some(existing => Math.abs(existing - index) < 240)) {
          continue;
        }
        seen.push(index);
        let start = Math.max(0, index - 180);
        let end = Math.min(normalized.length, index + 900);
        let snippet = normalized.slice(start, end).trim();
        snippets.push({
          label: match[0].replace(/\s+/g, " "),
          text: this.trimTo(snippet, 1000),
        });
      }
    }
    return snippets;
  },

  extractAnchoredPassage(question) {
    let quoteLines = String(question || "")
      .split(/\n/)
      .filter(line => /^>\s*/.test(line))
      .map(line => line.replace(/^>\s*/, "").trim())
      .filter(Boolean);
    return quoteLines.join("\n");
  },

  anchorNeedles(text) {
    let normalized = this.plainText(text).toLowerCase();
    if (!normalized) {
      return [];
    }
    let needles = [];
    for (let length of [160, 100, 60]) {
      if (normalized.length >= length) {
        needles.push(normalized.slice(0, length));
      }
    }
    return Array.from(new Set(needles));
  },

  extractFigureRefs(question) {
    let refs = [];
    let patterns = [
      /(?:fig(?:ure)?\.?\s*)(\d+[a-z]?)/gi,
      /图\s*(\d+[a-z]?)/gi,
      /figure\s*(\d+[a-z]?)/gi,
    ];
    for (let pattern of patterns) {
      let match;
      while ((match = pattern.exec(question))) {
        refs.push(match[1].toLowerCase());
      }
    }
    return Array.from(new Set(refs));
  },

  chunkMentionsFigure(haystack, ref) {
    let escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(fig(?:ure)?\\.?\\s*${escaped}|图\\s*${escaped}|figure\\s*${escaped})`, "i").test(haystack);
  },

  async getFullText(item, attachment) {
    return (await this.getFullTextInfo(item, attachment)).text;
  },

  async getFullTextInfo(item, attachment) {
    let cacheKey = this.contextCacheKey(item, attachment);
    if (this.textCache.has(cacheKey)) {
      return this.textCache.get(cacheKey);
    }

    let texts = [];
    let attachments = [];
    if (attachment) {
      attachments.push(attachment);
    }
    else if (item?.isRegularItem?.()) {
      attachments = item.getAttachments()
        .map(id => Zotero.Items.get(id))
        .filter(candidate => candidate?.isAttachment?.());
    }

    let sources = [];
    for (let candidate of attachments) {
      let source = {
        id: candidate.id,
        title: candidate.getField?.("title") || candidate.attachmentFilename || "",
        contentType: candidate.attachmentContentType || "",
        chars: 0,
      };
      if (candidate.attachmentContentType == "application/pdf"
        || candidate.attachmentContentType == "text/html"
        || candidate.attachmentContentType?.startsWith("text/")) {
        try {
          let text = await candidate.attachmentText;
          if (text) {
            texts.push(text);
            source.chars = text.length;
          }
        }
        catch (error) {
          source.error = error.message || String(error);
          this.logError(error);
        }
      }
      sources.push(source);
    }

    let fullText = texts.join("\n\n");
    let info = { text: fullText, attachments: sources };
    this.textCache.set(cacheKey, info);
    return info;
  },

  contextCacheKey(item, attachment) {
    return `${item?.id || "none"}:${attachment?.id || "none"}`;
  },

  getAttachmentInfo(item, attachment, skipped = false) {
    let attachments = [];
    if (attachment) {
      attachments.push(attachment);
    }
    else if (item?.isRegularItem?.()) {
      attachments = item.getAttachments()
        .map(id => Zotero.Items.get(id))
        .filter(candidate => candidate?.isAttachment?.());
    }
    return {
      text: "",
      skipped,
      attachments: attachments.map(candidate => ({
        id: candidate.id,
        title: candidate.getField?.("title") || candidate.attachmentFilename || "",
        contentType: candidate.attachmentContentType || "",
        chars: 0,
      })),
    };
  },

  async callModel(messages, options = {}) {
    let baseURL = this.pref("baseURL").replace(/\/+$/, "");
    let apiType = this.pref("apiType") || "responses";
    let apiKey = this.pref("apiKey");
    let model = this.pref("model");
    if (!baseURL || !model) {
      throw new Error("Please configure Base URL and Model in Settings.");
    }
    if (!apiKey) {
      throw new Error("Please configure API Key in Settings.");
    }

    let endpoint;
    let payload;
    if (apiType == "responses") {
      endpoint = baseURL.endsWith("/responses")
        ? baseURL
        : baseURL + "/responses";
      payload = this.buildResponsesPayload(model, messages);
    }
    else {
      endpoint = baseURL.endsWith("/chat/completions")
        ? baseURL
        : baseURL + "/chat/completions";
      payload = {
        model,
        messages,
        temperature: Number(this.pref("temperature")) || 0.2,
        stream: false,
      };
    }

    let response = await this.fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    let text = await response.text();
    if (!response.ok && apiType == "responses" && /temperature/i.test(text)) {
      delete payload.temperature;
      response = await this.fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      text = await response.text();
    }
    let json = null;
    try {
      json = JSON.parse(text);
    }
    catch (error) {}
    if (!response.ok) {
      throw new Error(this.describeAPIError({
        status: response.status,
        statusText: response.statusText,
        endpoint,
        apiType,
        model,
        json,
        text,
      }));
    }
    let content = apiType == "responses"
      ? this.extractResponsesText(json)
      : this.extractChatText(json);
    if (!content) {
      throw new Error(this.describeEmptyModelResponse({ endpoint, apiType, model, text }));
    }
    return content;
  },

  async fetchWithTimeout(endpoint, init, timeoutMs = 90000) {
    if (typeof fetch != "function") {
      throw new Error("当前 Zotero 环境没有可用的 fetch，无法发送 API 请求。请升级 Zotero 或反馈这个排障信息。");
    }

    if (typeof AbortController != "function") {
      return Promise.race([
        fetch(endpoint, init),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回。请检查网络、API 地址或服务商状态。`)), timeoutMs);
        }),
      ]);
    }

    let externalSignal = init?.signal;
    let controller = new AbortController();
    let timedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let abortFromExternal = () => controller.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      }
      else {
        externalSignal.addEventListener("abort", abortFromExternal, { once: true });
      }
    }

    try {
      return await fetch(endpoint, { ...init, signal: controller.signal });
    }
    catch (error) {
      if (timedOut && this.isAbortError(error)) {
        throw new Error(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回。请检查网络、API 地址或服务商状态。`);
      }
      throw error;
    }
    finally {
      clearTimeout(timer);
      if (externalSignal?.removeEventListener) {
        externalSignal.removeEventListener("abort", abortFromExternal);
      }
    }
  },

  buildResponsesPayload(model, messages) {
    let system = messages
      .filter(message => message.role == "system")
      .map(message => message.content)
      .join("\n\n");
    let input = messages
      .filter(message => message.role != "system")
      .map(message => `${message.role == "assistant" ? "Assistant" : "User"}:\n${message.content}`)
      .join("\n\n");

    let payload = {
      model,
      input,
      stream: false,
      temperature: Number(this.pref("temperature")) || 0.2,
    };
    if (system) {
      payload.instructions = system;
    }
    return payload;
  },

  describeAPIError({ status, statusText, endpoint, apiType, model, json, text }) {
    let message = json?.error?.message || json?.message || text || statusText || `HTTP ${status}`;
    message = this.trimTo(this.plainText(message), 1000);
    let lower = message.toLowerCase();
    let hints = [];

    if (status == 401 || status == 403 || /unauthorized|forbidden|invalid api key|api key/i.test(message)) {
      hints.push("API key or account permission looks wrong. Recheck the key and whether this gateway allows the selected model.");
    }
    if (status == 404 || /not found|unknown endpoint|cannot post/i.test(message)) {
      hints.push("The Base URL or API Type may be wrong. Check whether your provider expects Responses or Chat Completions, and whether the endpoint already includes /responses or /chat/completions.");
    }
    if (/model.*(not found|does not exist|不存在|不存在的|unknown|retired)|unsupported model|invalid model/i.test(message)) {
      hints.push(`The provider does not appear to expose model "${model}". Try the provider's exact public model name.`);
    }
    if (status == 429 || /rate limit|quota|余额|额度|insufficient/i.test(message)) {
      hints.push("This looks like quota, balance, or rate limiting rather than a plugin bug.");
    }
    if (/input_text|content block|unsupported.*input|invalid.*input/i.test(message)) {
      hints.push("This gateway may reject structured Responses content blocks. Reader AI is already using plain string input for Responses mode; if this persists, try Chat Completions mode.");
    }
    if (!hints.length) {
      hints.push("Use Test model after saving settings; if it fails the same way, the issue is likely provider configuration rather than paper context.");
    }

    return [
      `Provider error (${status || "unknown"}): ${message}`,
      `Endpoint: ${endpoint}`,
      `API Type: ${apiType}`,
      `Model: ${model}`,
      `Next: ${hints.join(" ")}`,
    ].join("\n");
  },

  describeEmptyModelResponse({ endpoint, apiType, model, text }) {
    return [
      "Provider returned successfully, but Reader AI could not find answer text in the response.",
      `Endpoint: ${endpoint}`,
      `API Type: ${apiType}`,
      `Model: ${model}`,
      `Raw response: ${this.trimTo(this.plainText(text), 1000)}`,
    ].join("\n");
  },

  describeRuntimeError(error) {
    let message = error?.message || String(error);
    if (/Please configure API Key/i.test(message)) {
      return "还没有配置 API 密钥。请打开“设置”，填入 API 密钥后点击“保存设置”，再点“测试模型”。";
    }
    if (/Please configure Base URL and Model/i.test(message)) {
      return "还没有配置 API 地址或模型。请打开“设置”，填好 API 地址、接口类型和模型后保存。";
    }
    if (/Failed to fetch|NetworkError|Load failed|Network request failed|ECONN|ENOTFOUND|ETIMEDOUT|timed out|超过 \d+ 秒/i.test(message)) {
      return [
        "模型请求没有成功返回。",
        message,
        "请先在“设置”里点“测试模型”。如果测试也失败，优先检查 API 地址、接口类型、网络代理和服务商状态。",
      ].join("\n");
    }
    if (/Provider error|Provider returned/i.test(message)) {
      return message;
    }
    return `发生错误：${message}\n\n请打开“设置”点“复制排障信息”，把不含密钥的内容发给我继续定位。`;
  },

  extractChatText(json) {
    return json?.choices?.[0]?.message?.content?.trim()
      || json?.choices?.[0]?.text?.trim()
      || "";
  },

  extractResponsesText(json) {
    if (!json) {
      return "";
    }
    if (typeof json.output_text == "string" && json.output_text.trim()) {
      return json.output_text.trim();
    }
    let texts = [];
    for (let item of json.output || []) {
      for (let content of item.content || []) {
        if (typeof content.text == "string") {
          texts.push(content.text);
        }
        else if (typeof content.output_text == "string") {
          texts.push(content.output_text);
        }
      }
    }
    return texts.join("\n").trim();
  },

  async getContextItems(item) {
    if (item?.isAttachment?.()) {
      let parent = item.parentItemID ? await Zotero.Items.getAsync(item.parentItemID) : item;
      return { item: parent || item, attachment: item };
    }

    let attachment = null;
    if (item?.isRegularItem?.()) {
      let attachmentIDs = item.getAttachments();
      for (let id of attachmentIDs) {
        let candidate = Zotero.Items.get(id);
        if (candidate?.attachmentContentType == "application/pdf") {
          attachment = candidate;
          break;
        }
      }
      if (!attachment && attachmentIDs.length) {
        attachment = Zotero.Items.get(attachmentIDs[0]);
      }
    }

    return { item, attachment };
  },

  receiveSelection(reader, selectedText) {
    let itemID = reader?.itemID || reader?._itemID || reader?.item?.id;
    let attachment = itemID ? Zotero.Items.get(itemID) : null;
    let parentID = attachment?.parentItemID || itemID;
    let view = this.viewByItemID.get(parentID);
    if (!view) {
      return;
    }

    let input = view.root.querySelector(".reader-ai-input");
    if (!input) {
      return;
    }

    let quote = selectedText.trim()
      .split(/\n+/)
      .map(line => `> ${line}`)
      .join("\n");
    let prefix = input.value.trim() ? input.value.trim() + "\n\n" : "";
    input.value = `${prefix}我想讨论这段选中的内容：\n\n${quote}\n\n`;
    this.draftByItemID.set(view.itemID, input.value);
    input.focus();
    this.setStatus(view.root, "选中文本已引用到输入框。");
  },

  async saveLastAssistantMessage(view) {
    let history = this.historyByItemID.get(view.itemID) || [];
    let lastIndex = history.map(message => message.role).lastIndexOf("assistant");
    let last = lastIndex >= 0 ? history[lastIndex] : null;
    if (!last) {
      this.setStatus(view.root, "还没有可保存的回答。");
      return;
    }
    let question = "";
    for (let i = lastIndex - 1; i >= 0; i--) {
      if (history[i].role == "user") {
        question = history[i].content;
        break;
      }
    }

    let note = new Zotero.Item("note");
    note.libraryID = view.item.libraryID;
    note.parentID = view.item.id;
    note.setNote(this.answerToNoteHTML(question, last.content, this.contextInfoByItemID.get(view.itemID)));
    await note.saveTx();
    this.setStatus(view.root, "最近一问一答已保存为 Zotero 子笔记。");
  },

  async saveConversationNote(view) {
    let history = (this.historyByItemID.get(view.itemID) || [])
      .filter(message => message.role != "system");
    if (!history.length) {
      this.setStatus(view.root, "还没有可保存的对话。");
      return;
    }

    let timestamp = new Date().toLocaleString();
    let parts = [
      "<h2>Reader AI Conversation</h2>",
      `<p><small>${this.escapeHTML(timestamp)}</small></p>`,
    ];
    for (let message of history) {
      let label = message.role == "assistant" ? "Assistant" : "You";
      parts.push(`<h3>${label}</h3><p>${this.blockToNoteHTML(message.content)}</p>`);
    }
    let contextHTML = this.contextInfoToNoteHTML(this.contextInfoByItemID.get(view.itemID));
    if (contextHTML) {
      parts.push(contextHTML);
    }

    let note = new Zotero.Item("note");
    note.libraryID = view.item.libraryID;
    note.parentID = view.item.id;
    note.setNote(parts.join(""));
    await note.saveTx();
    this.setStatus(view.root, "完整对话已保存为 Zotero 子笔记。");
  },

  async copyLastAssistantMessage(view) {
    let history = this.historyByItemID.get(view.itemID) || [];
    let last = [...history].reverse().find(message => message.role == "assistant");
    if (!last) {
      this.setStatus(view.root, "还没有可复制的回答。");
      return;
    }
    if (await this.copyText(last.content)) {
      this.setStatus(view.root, "已复制最近回答。");
    }
    else {
      this.setStatus(view.root, "无法自动复制；请手动选择回答文本。");
    }
  },

  async copyContextFromPanel(panel) {
    let root = panel.closest(".reader-ai-root");
    let view = this.findViewForRoot(root);
    let text = view ? this.contextTextByItemID.get(view.itemID) : "";
    if (!text) {
      this.setStatus(root, "还没有完整上下文可复制。请先点击预览或发送问题。");
      return;
    }
    if (await this.copyText(text)) {
      this.setStatus(root, "已复制完整请求上下文。");
    }
    else {
      this.setStatus(root, "无法自动复制上下文。");
    }
  },

  async copyDebugReport(settings) {
    let root = settings.closest(".reader-ai-root");
    let view = this.findViewForRoot(root);
    let report = this.debugReport(view);
    if (await this.copyText(report)) {
      this.setStatus(root, "已复制不含密钥的排障信息。");
    }
    else {
      this.setStatus(root, "无法自动复制排障信息。");
    }
  },

  debugReport(view) {
    let info = view ? this.contextInfoByItemID.get(view.itemID) : null;
    let itemTitle = view?.item?.getField?.("title") || "";
    let lines = [
      "Reader AI Debug Report",
      `Plugin ID: ${this.pluginID || ""}`,
      `Item ID: ${view?.itemID || ""}`,
      `Item title: ${itemTitle}`,
      `Base URL: ${this.pref("baseURL") || ""}`,
      `API Type: ${this.pref("apiType") || "responses"}`,
      `Model: ${this.pref("model") || ""}`,
      `API Key configured: ${this.pref("apiKey") ? "yes" : "no"}`,
      `Context Mode: ${this.pref("contextMode") || "auto"}`,
      `Max context chars: ${this.pref("maxContextChars") || ""}`,
      `Temperature: ${this.pref("temperature") || ""}`,
      `Last context mode: ${info?.mode || ""}`,
      `Last context chars: ${info?.chars || 0}`,
      `Last estimated tokens: ${info?.estimatedTokens || 0}`,
      `Last chunks: ${info?.chunks || 0}`,
      `Last full text chars: ${info?.fullTextChars || 0}`,
      `Last full text skipped: ${info?.fullTextSkipped ? "yes" : "no"}`,
      `Last attachment: ${info?.attachmentTitle || ""}`,
      `Warnings: ${(info?.warnings || []).join(" | ")}`,
    ];
    return lines.join("\n");
  },

  async copyText(text) {
    try {
      await Zotero.Utilities.Internal.copyTextToClipboard(text);
      return true;
    }
    catch (error) {}

    try {
      Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper)
        .copyString(text);
      return true;
    }
    catch (error) {
      this.logError(error);
      return false;
    }
  },

  answerToNoteHTML(question, answer, contextInfo) {
    let timestamp = new Date().toLocaleString();
    let questionHTML = question
      ? `<h3>Question</h3><p>${this.blockToNoteHTML(question)}</p>`
      : "";
    return `<h2>Reader AI Answer</h2><p><small>${this.escapeHTML(timestamp)}</small></p>${questionHTML}<h3>Answer</h3><p>${this.blockToNoteHTML(answer)}</p>${this.contextInfoToNoteHTML(contextInfo)}`;
  },

  contextInfoToNoteHTML(info) {
    if (!info) {
      return "";
    }
    let rows = [
      `Model: ${info.model || "not set"}`,
      `API Type: ${info.apiType || "responses"}`,
      `Created: ${info.createdAt || ""}`,
      `Mode: ${info.mode}`,
      `Chunks: ${info.chunks}`,
      `Context chars: ${info.chars}`,
      `Estimated tokens: ${info.estimatedTokens || 0}`,
      `Full text chars: ${info.fullTextChars || 0}`,
    ];
    let warnings = (info.warnings || [])
      .map(warning => `<li>${this.escapeHTML(warning)}</li>`)
      .join("");
    let excerpts = (info.excerpts || [])
      .map(excerpt => `<h4>${this.escapeHTML(excerpt.label)}</h4><p>${this.blockToNoteHTML(excerpt.text)}</p>`)
      .join("");
    let figureSnippets = (info.captionSnippets || [])
      .map(snippet => `<h4>${this.escapeHTML(snippet.label)}</h4><p>${this.blockToNoteHTML(snippet.text)}</p>`)
      .join("");
    return [
      "<h3>Context Used</h3>",
      `<p>${rows.map(row => this.escapeHTML(row)).join("<br/>")}</p>`,
      warnings ? `<ul>${warnings}</ul>` : "",
      info.anchoredExcerpt ? `<h4>Selected / quoted passage</h4><p>${this.blockToNoteHTML(info.anchoredExcerpt)}</p>` : "",
      figureSnippets ? `<h3>Figure Evidence</h3>${figureSnippets}` : "",
      excerpts,
    ].join("");
  },

  blockToNoteHTML(text) {
    return this.escapeHTML(text)
      .replace(/\n{2,}/g, "</p><p>")
      .replace(/\n/g, "<br/>");
  },

  injectStyles(doc) {
    if (doc.getElementById("reader-ai-stylesheet")) {
      return;
    }
    let link = this.html(doc, "link");
    link.id = "reader-ai-stylesheet";
    link.rel = "stylesheet";
    link.href = this.rootURI + "content/reader-ai.css";
    doc.documentElement.append(link);
  },

  button(doc, label, onClick, variant) {
    let button = this.html(doc, "button");
    button.className = "reader-ai-button" + (variant ? ` ${variant}` : "");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", event => {
      try {
        let result = onClick?.(event);
        if (result?.catch) {
          result.catch(error => this.reportButtonError(button, error));
        }
      }
      catch (error) {
        this.reportButtonError(button, error);
      }
    });
    return button;
  },

  reportButtonError(button, error) {
    this.logError(error);
    let root = button.closest?.(".reader-ai-root");
    let text = this.describeRuntimeError(error);
    this.setStatus(root || button, text);
    let messages = root?.querySelector?.(".reader-ai-messages");
    if (messages) {
      let node = this.messageNode(button.ownerDocument, "assistant", text);
      node.classList.add("error");
      messages.append(node);
      messages.scrollTop = messages.scrollHeight;
    }
  },

  field(doc, labelText, id, value, type = "text") {
    let wrap = this.html(doc, "div");
    wrap.className = "reader-ai-field";
    let label = this.html(doc, "label");
    label.setAttribute("for", id);
    label.textContent = labelText;
    let input = type == "textarea" ? this.html(doc, "textarea") : this.html(doc, "input");
    input.id = id;
    if (type != "textarea") {
      input.type = type;
    }
    input.value = value || "";
    wrap.append(label, input);
    return wrap;
  },

  selectField(doc, labelText, id, value, options) {
    let wrap = this.html(doc, "div");
    wrap.className = "reader-ai-field";
    let label = this.html(doc, "label");
    label.setAttribute("for", id);
    label.textContent = labelText;
    let select = this.html(doc, "select");
    select.id = id;
    for (let [optionValue, optionLabel] of options) {
      let option = this.html(doc, "option");
      option.value = optionValue;
      option.textContent = optionLabel;
      option.selected = optionValue == value;
      select.append(option);
    }
    wrap.append(label, select);
    return wrap;
  },

  messageNode(doc, role, content) {
    let node = this.html(doc, "div");
    node.className = `reader-ai-message ${role}`;
    if (role == "assistant") {
      this.renderAssistantText(node, content);
    }
    else {
      node.textContent = content;
    }
    return node;
  },

  renderMessages(root, history) {
    let messages = root.querySelector(".reader-ai-messages");
    if (!messages) {
      return;
    }
    messages.replaceChildren();
    for (let message of history) {
      messages.append(this.messageNode(root.ownerDocument, message.role, message.content));
    }
    messages.scrollTop = messages.scrollHeight;
  },

  renderAssistantText(node, content) {
    let doc = node.ownerDocument;
    let lines = String(content || "").split(/\n/);
    let paragraph = [];
    let code = [];
    let inCode = false;
    let flushParagraph = () => {
      if (!paragraph.length) {
        return;
      }
      let p = this.html(doc, "p");
      p.textContent = paragraph.join(" ");
      node.append(p);
      paragraph = [];
    };
    let flushCode = () => {
      if (!code.length) {
        return;
      }
      let pre = this.html(doc, "pre");
      let codeNode = this.html(doc, "code");
      codeNode.textContent = code.join("\n");
      pre.append(codeNode);
      node.append(pre);
      code = [];
    };

    for (let rawLine of lines) {
      let line = rawLine.trim();
      if (/^```/.test(line)) {
        if (inCode) {
          flushCode();
          inCode = false;
        }
        else {
          flushParagraph();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(rawLine);
        continue;
      }
      if (!line || line == "---") {
        flushParagraph();
        continue;
      }
      let heading = line.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        flushParagraph();
        let h = this.html(doc, "div");
        h.className = "reader-ai-heading";
        h.textContent = heading[1];
        node.append(h);
        continue;
      }
      if (/^>\s*/.test(line)) {
        flushParagraph();
        let quote = this.html(doc, "blockquote");
        quote.textContent = this.cleanInlineText(line.replace(/^>\s*/, ""));
        node.append(quote);
        continue;
      }
      if (this.isMarkdownTableSeparator(line)) {
        flushParagraph();
        continue;
      }
      if (this.isMarkdownTableRow(line)) {
        flushParagraph();
        node.append(this.tableRowNode(doc, line));
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        flushParagraph();
        let item = this.html(doc, "div");
        item.className = "reader-ai-list-item";
        item.textContent = this.cleanInlineText(line.replace(/^[-*]\s+/, ""));
        node.append(item);
        continue;
      }
      if (/^\d+[.)]\s+/.test(line)) {
        flushParagraph();
        let item = this.html(doc, "div");
        item.className = "reader-ai-list-item ordered";
        item.textContent = this.cleanInlineText(line);
        node.append(item);
        continue;
      }
      paragraph.push(this.cleanInlineText(line));
    }
    flushCode();
    flushParagraph();
  },

  isMarkdownTableRow(line) {
    return /^\|.+\|$/.test(line) && line.split("|").filter(cell => cell.trim()).length >= 2;
  },

  isMarkdownTableSeparator(line) {
    return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
  },

  tableRowNode(doc, line) {
    let row = this.html(doc, "div");
    row.className = "reader-ai-table-row";
    let cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(cell => this.cleanInlineText(cell.trim()));
    for (let cellText of cells) {
      let cell = this.html(doc, "span");
      cell.textContent = cellText;
      row.append(cell);
    }
    return row;
  },

  cleanInlineText(text) {
    return String(text || "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  },

  findViewForRoot(root) {
    if (!root) {
      return null;
    }
    for (let view of this.viewByItemID.values()) {
      if (view.root == root) {
        return view;
      }
    }
    return null;
  },

  setStatus(rootOrChild, text) {
    if (!rootOrChild) {
      return;
    }
    let root = rootOrChild.classList?.contains("reader-ai-root")
      ? rootOrChild
      : rootOrChild.closest?.(".reader-ai-root") || rootOrChild.parentElement?.closest?.(".reader-ai-root");
    let status = root?.querySelector?.(".reader-ai-status");
    if (status) {
      status.textContent = text;
    }
  },

  pref(key) {
    return Zotero.Prefs.get(`extensions.reader-ai.${key}`) || "";
  },

  setPref(key, value) {
    Zotero.Prefs.set(`extensions.reader-ai.${key}`, value);
  },

  cleanNumberPref(value, fallback) {
    let number = Number(String(value || "").trim());
    if (!Number.isFinite(number) || number < 0) {
      return fallback;
    }
    return String(number);
  },

  estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text || "").length / 4));
  },

  chunkText(text, size, overlap = 0) {
    let normalized = this.plainText(text).replace(/\s+/g, " ").trim();
    let chunks = [];
    let step = Math.max(1, size - overlap);
    for (let start = 0; start < normalized.length; start += step) {
      chunks.push(normalized.slice(start, start + size));
    }
    return chunks;
  },

  trimTo(text, maxChars) {
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + "\n\n[Context truncated.]";
  },

  plainText(value) {
    return String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  },

  escapeHTML(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  html(doc, tag) {
    return doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  },

  logError(error) {
    Zotero.debug(`Reader AI error: ${error?.stack || error}`);
  },
};
