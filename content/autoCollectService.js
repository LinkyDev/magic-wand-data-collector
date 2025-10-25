const AUTO_COLLECT_STORAGE_KEY = "mwAutoCollectTemplates";
const AUTO_COLLECT_SETTINGS_KEY = "mwAutoCollectSettings";
const MAX_PREVIEW_LENGTH = 160;
const DEFAULT_SETTINGS = {
  autoPlay: false,
  autoApprove: false,
  autoApproveDomain: null
};
const AUTO_COLLECT_STYLES = `
  .mw-autocollect {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px dashed rgba(92, 46, 201, 0.35);
    background: rgba(92, 46, 201, 0.08);
  }
  .mw-autocollect h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #3a3a47;
  }
  .mw-autocollect-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .mw-autocollect-buttons button {
    padding: 8px 12px;
    border-radius: 6px;
    border: none;
    background: rgba(92, 46, 201, 0.2);
    color: #5c2ec9;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease;
  }
  .mw-autocollect-buttons button:hover:not([disabled]) {
    background: rgba(92, 46, 201, 0.3);
  }
  .mw-autocollect-buttons button[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .mw-autocollect-status {
    font-size: 12px;
    line-height: 1.4;
    color: #3a3a47;
  }
  .mw-autocollect-status.info {
    color: #3a3a47;
  }
  .mw-autocollect-status.warn {
    color: #b25b28;
  }
  .mw-autocollect-status.success {
    color: #227a3b;
  }
  .mw-autocollect-approval {
    border-top: 1px solid rgba(92, 46, 201, 0.2);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: #3a3a47;
  }
  .mw-autocollect-approval[hidden] {
    display: none;
  }
  .mw-autocollect-approval-actions {
    display: flex;
    gap: 8px;
  }
  .mw-autocollect-approval-actions button {
    padding: 6px 12px;
    border-radius: 6px;
    border: none;
    font-weight: 600;
    cursor: pointer;
  }
  .mw-autocollect-approval-actions button[data-approve="true"] {
    background: #5c2ec9;
    color: #ffffff;
  }
  .mw-autocollect-approval-actions button[data-approve="false"] {
    background: rgba(92, 46, 201, 0.15);
    color: #5c2ec9;
  }
`;

function sanitizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function truncatePreview(value) {
  const normalized = sanitizeText(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_PREVIEW_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PREVIEW_LENGTH)}…`;
}

function cssEscapeIdent(value) {
  if (!value && value !== 0) {
    return "";
  }
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/(["\\#.:;])/g, "\\$1");
}

function computeDomSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  if (element.id) {
    return `#${cssEscapeIdent(element.id)}`;
  }
  const segments = [];
  let current = element;
  let depth = 0;
  while (current && current.nodeType === Node.ELEMENT_NODE && depth < 10) {
    let segment = current.tagName.toLowerCase();
    if (current.id) {
      segment = `#${cssEscapeIdent(current.id)}`;
      segments.unshift(segment);
      break;
    }
    if (current.classList?.length) {
      const classes = Array.from(current.classList)
        .filter((name) => name && !/^(mw-|mw_)/.test(name))
        .slice(0, 2)
        .map((name) => `.${cssEscapeIdent(name)}`)
        .join("");
      if (classes) {
        segment += classes;
      }
    }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    segment += `:nth-of-type(${index})`;
    segments.unshift(segment);
    current = current.parentElement;
    depth += 1;
    if (current && current.id) {
      segments.unshift(`@${cssEscapeIdent(current.id)}`);
      break;
    }
  }
  return segments.join(" > ");
}

function determineExtractionMode(element) {
  if (!element) {
    return "text";
  }
  const tagName = element.tagName?.toLowerCase() ?? "";
  if (tagName === "input" || tagName === "textarea") {
    return "value";
  }
  if (element.isContentEditable) {
    return "text";
  }
  return "text";
}

function extractFromElement(element, mode, fallback) {
  if (!element) {
    return "";
  }
  if (mode === "value") {
    return sanitizeText(element.value ?? element.textContent);
  }
  if (mode === "attribute" && fallback?.attribute) {
    return sanitizeText(element.getAttribute(fallback.attribute));
  }
  if (typeof fallback?.extractText === "function") {
    return sanitizeText(fallback.extractText(element));
  }
  const text = element.innerText ?? element.textContent ?? "";
  return sanitizeText(text);
}

function cloneActions(actions) {
  return actions.map((action) => ({ ...action }));
}

export async function initAutoCollectService(context) {
  const service = new AutoCollectService(context);
  await service.init();
  return service;
}

class AutoCollectService {
  constructor(context) {
    this.context = context;
    this.storage = context?.extensionApi?.storage?.local ?? null;
    this.templates = {};
    this.template = null;
    this.state = null;
    this.currentDomain = null;
    this.recording = false;
    this.recordingMeta = null;
    this.actions = [];
    this.pendingTemplate = null;
    this.playbackActive = false;
    this.playbackSession = null;
    this.root = null;
    this.statusEl = null;
    this.approvalEl = null;
    this.approvalResolver = null;
    this.buttons = {
      record: null,
      stop: null,
      play: null,
      rerecord: null,
      autoplay: null,
      autoApprove: null
    };
    this.settings = { ...DEFAULT_SETTINGS };
    this.autoPlayEnabled = Boolean(DEFAULT_SETTINGS.autoPlay);
    this.autoApproveEnabled = Boolean(DEFAULT_SETTINGS.autoApprove);
    this.autoApproveDomain = null;
    this.autoPlayLastRowKey = null;
    this.recordingOriginalAuto = null;
    this.recordingApprovalPending = false;
    this.recordingApprovalSatisfied = false;
    this.recordingAdvanceInProgress = false;
    this.recordingCompletionSignature = null;
    this.defaultApprovalMessage = "Approve the auto-filled values for this product?";
    this.approvalMessageEl = null;
  }

  async init() {
    await this.loadTemplates();
    await this.loadSettings();
    this.injectUi();
    this.applySettings();
    this.updateUi();
    return this;
  }

  async loadTemplates() {
    if (!this.storage) {
      this.templates = {};
      return;
    }
    try {
      const stored = await this.storage.get(AUTO_COLLECT_STORAGE_KEY);
      const value = stored?.[AUTO_COLLECT_STORAGE_KEY];
      if (value && typeof value === "object") {
        this.templates = value;
      }
    } catch (error) {
      console.warn("Magic Wand: unable to load auto-collect templates", error);
      this.templates = {};
    }
  }

  async persistTemplates() {
    if (!this.storage) {
      return;
    }
    try {
      await this.storage.set({ [AUTO_COLLECT_STORAGE_KEY]: this.templates });
    } catch (error) {
      console.warn("Magic Wand: unable to persist auto-collect templates", error);
    }
  }

  async loadSettings() {
    if (!this.storage) {
      this.settings = { ...DEFAULT_SETTINGS };
      this.autoPlayEnabled = Boolean(this.settings.autoPlay);
      return;
    }
    try {
      const stored = await this.storage.get(AUTO_COLLECT_SETTINGS_KEY);
      const value = stored?.[AUTO_COLLECT_SETTINGS_KEY];
      if (value && typeof value === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...value };
      } else {
        this.settings = { ...DEFAULT_SETTINGS };
      }
    } catch (error) {
      console.warn("Magic Wand: unable to load auto-collect settings", error);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.autoPlayEnabled = Boolean(this.settings.autoPlay);
  }

  async persistSettings() {
    if (!this.storage) {
      return;
    }
    try {
      await this.storage.set({ [AUTO_COLLECT_SETTINGS_KEY]: this.settings });
    } catch (error) {
      console.warn("Magic Wand: unable to persist auto-collect settings", error);
    }
  }

  applySettings() {
    this.autoPlayEnabled = Boolean(this.settings.autoPlay);
    if (!this.autoPlayEnabled) {
      this.autoPlayLastRowKey = null;
    }
    this.autoApproveEnabled = Boolean(this.settings.autoApprove);
    this.autoApproveDomain = this.settings.autoApproveDomain ?? null;
    let settingsChanged = false;
    if (!this.autoApproveEnabled || !this.autoApproveDomain) {
      if (this.settings.autoApprove || this.settings.autoApproveDomain) {
        settingsChanged = true;
      }
      this.autoApproveEnabled = false;
      this.autoApproveDomain = null;
      this.settings.autoApprove = false;
      this.settings.autoApproveDomain = null;
    } else if (this.currentDomain && this.currentDomain !== this.autoApproveDomain) {
      settingsChanged = true;
      this.autoApproveEnabled = false;
      this.autoApproveDomain = null;
      this.settings.autoApprove = false;
      this.settings.autoApproveDomain = null;
    }
    if (settingsChanged) {
      void this.persistSettings();
    }
  }

  async toggleAutoplay() {
    await this.setAutoPlayEnabled(!this.autoPlayEnabled);
  }

  async setAutoPlayEnabled(enabled) {
    const normalized = Boolean(enabled);
    if (this.autoPlayEnabled === normalized) {
      return;
    }
    this.autoPlayEnabled = normalized;
    this.settings.autoPlay = normalized;
    if (!normalized) {
      this.autoPlayLastRowKey = null;
    }
    await this.persistSettings();
    this.updateUi();
    if (normalized) {
      this.setStatus("Autoplay enabled. Recorded steps will run automatically on the next product.", "info");
      this.maybeAutoPlay();
    } else {
      this.setStatus("Autoplay disabled.", "info");
    }
  }

  async toggleAutoApprove() {
    await this.setAutoApproveEnabled(!this.autoApproveEnabled);
  }

  async setAutoApproveEnabled(enabled, options = {}) {
    const previousDomain = this.autoApproveDomain;
    const normalized = Boolean(enabled);
    if (normalized) {
      if (!this.template) {
        this.setStatus("Record actions before enabling auto approve.", "warn");
        return;
      }
      const domain = options.domain ?? this.template?.domain ?? this.currentDomain ?? null;
      if (!domain) {
        this.setStatus("Auto approve requires an active product domain.", "warn");
        return;
      }
      if (this.autoApproveEnabled && this.autoApproveDomain === domain) {
        return;
      }
      this.autoApproveDomain = domain;
    } else {
      if (!this.autoApproveEnabled && !this.settings.autoApprove) {
        return;
      }
      this.autoApproveDomain = null;
    }

    this.autoApproveEnabled = normalized;
    this.settings.autoApprove = normalized;
    this.settings.autoApproveDomain = normalized ? this.autoApproveDomain : null;
    await this.persistSettings();

    if (normalized || !this.approvalResolver || options.reason === "domain-change") {
      this.hideApprovalPrompt();
    }
    this.updateUi();

    if (!options.silent) {
      if (normalized) {
        this.setStatus(`Auto approve enabled for ${this.autoApproveDomain}.`, "info");
      } else if (options.reason === "domain-change") {
        const domainLabel = previousDomain ? ` (${previousDomain})` : "";
        this.setStatus(`Auto approve disabled: domain changed${domainLabel}.`, "warn");
      } else {
        this.setStatus("Auto approve disabled.", "info");
      }
    }

    if (normalized && this.approvalResolver) {
      this.resolveApproval(true);
    }

    if (normalized) {
      this.maybeAutoPlay();
    }
  }

  injectUi() {
    if (!this.context?.shadowRoot) {
      throw new Error("AutoCollectService requires shadow root");
    }
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot.getElementById("mw-autocollect-style")) {
      const style = document.createElement("style");
      style.id = "mw-autocollect-style";
      style.textContent = AUTO_COLLECT_STYLES;
      shadowRoot.appendChild(style);
    }
    const controls = this.context.getControlsContainer?.();
    if (!controls) {
      console.warn("Magic Wand: auto-collect controls container missing");
      return;
    }
    if (shadowRoot.getElementById("mw-autocollect-root")) {
      this.root = shadowRoot.getElementById("mw-autocollect-root");
      this.cacheUiElements();
      return;
    }

    const container = document.createElement("div");
    container.id = "mw-autocollect-root";
    container.className = "mw-autocollect";
    container.innerHTML = `
      <div class="mw-autocollect-buttons">
        <button type="button" data-action="record">Record</button>
        <button type="button" data-action="stop">Stop</button>
        <button type="button" data-action="play">Play</button>
        <button type="button" data-action="re-record">Re-record</button>
        <button type="button" data-action="toggle-autoplay">Autoplay: Off</button>
        <button type="button" data-action="toggle-autoapprove">Auto approve: Off</button>
      </div>
      <div class="mw-autocollect-status info" data-role="status">Auto-collect debug ready.</div>
      <div class="mw-autocollect-approval" data-role="approval" hidden>
        <div data-role="approval-message">Approve the auto-filled values for this product?</div>
        <div class="mw-autocollect-approval-actions">
          <button type="button" data-approve="true">Approve</button>
          <button type="button" data-approve="false">Cancel</button>
        </div>
      </div>
    `;

    const saveButton = shadowRoot.getElementById("save-exit");
    if (saveButton && saveButton.parentElement === controls) {
      controls.insertBefore(container, saveButton);
    } else {
      controls.appendChild(container);
    }

    this.root = container;
    this.cacheUiElements();
    this.bindUiEvents();
  }

  cacheUiElements() {
    if (!this.root) {
      return;
    }
    this.buttons.record = this.root.querySelector('[data-action="record"]');
    this.buttons.stop = this.root.querySelector('[data-action="stop"]');
    this.buttons.play = this.root.querySelector('[data-action="play"]');
    this.buttons.rerecord = this.root.querySelector('[data-action="re-record"]');
    this.buttons.autoplay = this.root.querySelector('[data-action="toggle-autoplay"]');
  this.buttons.autoApprove = this.root.querySelector('[data-action="toggle-autoapprove"]');
    this.statusEl = this.root.querySelector('[data-role="status"]');
    this.approvalEl = this.root.querySelector('[data-role="approval"]');
    this.approvalMessageEl = this.root.querySelector('[data-role="approval-message"]');
  }

  bindUiEvents() {
    if (!this.root) {
      return;
    }
    this.buttons.record?.addEventListener("click", () => {
      void this.startRecording();
    });
    this.buttons.stop?.addEventListener("click", () => {
      if (this.playbackActive) {
        this.stopPlayback("Auto-collect stopped.");
      } else if (this.recording) {
        void this.completeRecording();
      }
    });
    this.buttons.play?.addEventListener("click", () => {
      this.playTemplate();
    });
    this.buttons.rerecord?.addEventListener("click", () => {
      void this.startRecording({ reRecord: true });
    });
    this.buttons.autoplay?.addEventListener("click", () => {
      void this.toggleAutoplay();
    });
    this.buttons.autoApprove?.addEventListener("click", () => {
      void this.toggleAutoApprove();
    });
    const approveBtn = this.approvalEl?.querySelector('[data-approve="true"]');
    const cancelBtn = this.approvalEl?.querySelector('[data-approve="false"]');
    approveBtn?.addEventListener("click", () => {
      this.resolveApproval(true);
    });
    cancelBtn?.addEventListener("click", () => {
      this.resolveApproval(false);
    });
  }

  updateUi() {
    if (!this.root) {
      return;
    }
    const hasTemplate = Boolean(this.template);
    if (this.buttons.record) {
      this.buttons.record.hidden = this.recording || this.playbackActive;
    }
    if (this.buttons.stop) {
      this.buttons.stop.hidden = !(this.recording || this.playbackActive);
    }
    if (this.buttons.play) {
      this.buttons.play.hidden = !hasTemplate || this.recording || this.playbackActive;
      this.buttons.play.disabled = !hasTemplate || this.recording || this.playbackActive;
    }
    if (this.buttons.rerecord) {
      this.buttons.rerecord.hidden = !hasTemplate || this.recording || this.playbackActive;
      this.buttons.rerecord.disabled = this.recording || this.playbackActive;
    }
    if (this.buttons.autoplay) {
      this.buttons.autoplay.hidden = false;
      this.buttons.autoplay.textContent = this.autoPlayEnabled ? "Autoplay: On" : "Autoplay: Off";
      this.buttons.autoplay.setAttribute("aria-pressed", this.autoPlayEnabled ? "true" : "false");
    }
    if (this.buttons.autoApprove) {
      this.buttons.autoApprove.hidden = false;
      const labelDomain = this.autoApproveEnabled && this.autoApproveDomain
        ? ` (${this.autoApproveDomain})`
        : "";
      this.buttons.autoApprove.textContent = this.autoApproveEnabled
        ? `Auto approve: On${labelDomain}`
        : "Auto approve: Off";
      this.buttons.autoApprove.setAttribute("aria-pressed", this.autoApproveEnabled ? "true" : "false");
    }
  }

  setStatus(message, level = "info") {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.textContent = message;
    this.statusEl.classList.remove("info", "warn", "success");
    this.statusEl.classList.add(level);
  }

  handleStateUpdate(state) {
    const previousState = this.state;
    this.state = state ?? null;
    const prevRowKey = this.getRowKey(previousState);
    const newRowKey = this.getRowKey(this.state);
    if (prevRowKey !== newRowKey) {
      this.autoPlayLastRowKey = null;
    }
    const newDomain = this.extractDomain(state?.row?.url ?? null);
    if (
      this.autoApproveEnabled &&
      this.autoApproveDomain &&
      newDomain &&
      newDomain !== this.autoApproveDomain
    ) {
      void this.setAutoApproveEnabled(false, { silent: false, reason: "domain-change" });
    }
    if (this.autoApproveEnabled && !newDomain) {
      void this.setAutoApproveEnabled(false, { silent: true });
    }
    if (this.recording && this.recordingMeta?.domain && newDomain && newDomain !== this.recordingMeta.domain) {
      void this.cancelRecording("Domain changed; recording cancelled.");
    }
    if (this.playbackActive && this.playbackSession?.domain && newDomain && newDomain !== this.playbackSession.domain) {
      this.stopPlayback("Domain changed; auto-collect paused.");
    }
    if (newDomain !== this.currentDomain) {
      this.currentDomain = newDomain;
      this.template = newDomain ? this.templates?.[newDomain] ?? null : null;
      if (!this.recording && !this.playbackActive) {
        if (this.template) {
          this.setStatus(`Auto-collect ready for ${newDomain}.`, "info");
        } else if (newDomain) {
          this.setStatus(`No recording for ${newDomain}. Click Record to capture actions.`, "warn");
        } else {
          this.setStatus("Auto-collect idle.", "info");
        }
      }
    }
    if (
      this.recording &&
      state?.autoNavigate &&
      typeof this.context?.setAutoNavigate === "function"
    ) {
      if (typeof this.recordingOriginalAuto !== "boolean") {
        this.recordingOriginalAuto = true;
      }
      void this.context.setAutoNavigate(false, { force: true });
    }
    if (
      this.recording &&
      this.recordingMeta &&
      !this.recordingApprovalPending &&
      !this.recordingAdvanceInProgress
    ) {
      const sameRow = (state?.currentRowIndex ?? null) === this.recordingMeta.rowIndex;
      if (sameRow && this.isRowComplete(state) && !this.recordingApprovalSatisfied) {
        const signature = this.getRowSignature(state) ?? "";
        if (signature !== this.recordingCompletionSignature) {
          this.recordingCompletionSignature = signature;
          this.recordingApprovalPending = true;
          void this.promptRecordingAdvance();
        }
      }
    }
    this.updateUi();
    this.maybeAutoPlay();
  }

  handleEvent(type, payload) {
    if (type === "capture-success") {
      this.handleCapture(payload);
    }
  }

  handleCapture(payload) {
    if (!this.recording || !payload) {
      return;
    }
    const element = payload.context?.element;
    if (!(element instanceof Element)) {
      return;
    }
    if (!element.isConnected) {
      return;
    }
    const selector = computeDomSelector(element);
    if (!selector) {
      return;
    }
    let extractionMode = determineExtractionMode(element);
    let attribute = null;
    const contextAttribute = payload.context?.attribute;
    if (contextAttribute === "href") {
      extractionMode = "attribute";
      attribute = "href";
    } else if (payload.column) {
      const columnConfig = this.state?.config?.inputColumnSettings?.[payload.column] ?? null;
      if (columnConfig?.type === "linkHref") {
        extractionMode = "attribute";
        attribute = "href";
      }
    }
    const action = {
      type: "capture",
      selector,
      extractionMode,
      column: payload.column ?? null,
      source: payload.context?.source ?? "unknown",
      preview: truncatePreview(payload.value ?? ""),
      timestamp: Date.now()
    };
    if (attribute) {
      action.attribute = attribute;
    }
    this.actions.push(action);
    this.recordingApprovalSatisfied = false;
    this.recordingCompletionSignature = null;
    if (this.recordingMeta?.columnPreviews && action.column) {
      this.recordingMeta.columnPreviews[action.column] = sanitizeText(payload.value);
    }
    this.setStatus(`Recording ${this.recordingMeta?.domain ?? ""}: captured ${this.actions.length} step(s). Click Stop when done.`, "info");
  }

  async promptRecordingAdvance() {
    this.recordingAdvanceInProgress = true;
    try {
      this.setStatus("Recording complete. Approve to move to the next product.", "info");
      const approved = await this.promptApproval("Recording complete. Move to the next product?", {
        bypassAutoApprove: true
      });
      this.recordingApprovalPending = false;
      if (!this.recording) {
        return;
      }
      if (approved) {
        this.recordingApprovalSatisfied = true;
        try {
          if (this.state && (this.state.currentRowIndex ?? null) === this.recordingMeta?.rowIndex) {
            if (typeof this.context.navigateNext === "function") {
              await this.context.navigateNext();
            }
            if (typeof this.context.refreshState === "function") {
              await this.context.refreshState();
            }
          }
          this.setStatus("Moved to next product. Continue recording or click Stop to save.", "success");
          this.recordingCompletionSignature = null;
        } catch (error) {
          console.warn("Magic Wand: unable to advance to next product after recording", error);
          this.setStatus("Unable to navigate automatically. Use Next to continue.", "warn");
        }
      } else {
        this.recordingApprovalSatisfied = false;
        this.setStatus("Recording paused. Adjust the captured values before moving on.", "warn");
      }
    } finally {
      this.recordingAdvanceInProgress = false;
      this.recordingApprovalPending = false;
    }
  }

  async startRecording(options = {}) {
    const state = this.state;
    if (!state) {
      this.setStatus("Cannot record without an active product.", "warn");
      return;
    }
    const domain = this.extractDomain(state.row?.url ?? null);
    if (!domain) {
      this.setStatus("Current row has no valid URL domain.", "warn");
      return;
    }
    if (this.recording) {
      return;
    }
    if (this.playbackActive) {
      this.stopPlayback();
    }
    if (options.reRecord && this.template) {
      this.pendingTemplate = this.template;
    } else {
      this.pendingTemplate = null;
    }
    this.recordingOriginalAuto = typeof state.autoNavigate === "boolean" ? state.autoNavigate : null;
    try {
      if (typeof this.context.setAutoNavigate === "function") {
        await this.context.setAutoNavigate(false, { force: true });
      }
    } catch (error) {
      console.warn("Magic Wand: unable to disable auto navigate during recording", error);
    }
    this.recording = true;
    this.actions = [];
    this.recordingMeta = {
      domain,
      rowIndex: state.currentRowIndex ?? 0,
      rowUrl: state.row?.url ?? null,
      columnPreviews: {}
    };
    this.recordingApprovalSatisfied = false;
    this.recordingApprovalPending = false;
    this.recordingAdvanceInProgress = false;
    this.recordingCompletionSignature = null;
    this.setStatus(`Recording actions for ${domain}. Capture data for this product, then click Stop.`, "info");
    this.updateUi();
  }

  async restoreRecordingAutoNavigate() {
    if (typeof this.recordingOriginalAuto === "boolean") {
      try {
        if (typeof this.context.setAutoNavigate === "function") {
          await this.context.setAutoNavigate(this.recordingOriginalAuto, { force: true });
        }
      } catch (error) {
        console.warn("Magic Wand: unable to restore auto navigate", error);
      }
    }
    this.recordingOriginalAuto = null;
  }

  async cancelRecording(message) {
    if (!this.recording) {
      return;
    }
    this.recording = false;
    this.actions = [];
    if (this.pendingTemplate) {
      this.template = this.pendingTemplate;
    }
    this.pendingTemplate = null;
    this.recordingMeta = null;
    this.recordingApprovalPending = false;
    this.recordingApprovalSatisfied = false;
    this.recordingAdvanceInProgress = false;
    this.recordingCompletionSignature = null;
    await this.restoreRecordingAutoNavigate();
    this.hideApprovalPrompt();
    if (message) {
      this.setStatus(message, "warn");
    }
    this.updateUi();
  }

  async completeRecording() {
    if (!this.recording) {
      return;
    }
    this.recording = false;
    const meta = this.recordingMeta;
    this.recordingMeta = null;
    this.recordingApprovalPending = false;
    this.recordingAdvanceInProgress = false;
    this.recordingApprovalSatisfied = false;
    this.recordingCompletionSignature = null;
    await this.restoreRecordingAutoNavigate();
    if (!meta) {
      this.actions = [];
      this.updateUi();
      return;
    }
    if (!this.actions.length) {
      this.actions = [];
      if (this.pendingTemplate) {
        this.template = this.pendingTemplate;
      }
      this.pendingTemplate = null;
      this.setStatus("No actions captured. Recording discarded.", "warn");
      this.updateUi();
      return;
    }
    const template = {
      domain: meta.domain,
      recordedAt: new Date().toISOString(),
      actions: cloneActions(this.actions),
      rowIndex: meta.rowIndex ?? 0,
      rowUrl: meta.rowUrl ?? null,
      previews: { ...meta.columnPreviews }
    };
    this.actions = [];
    this.templates[template.domain] = template;
    await this.persistTemplates();
    this.template = template;
    this.pendingTemplate = null;
    this.setStatus(`Recorded ${template.actions.length} actions for ${template.domain}.`, "success");
    this.updateUi();
  }

  async playTemplate(options = {}) {
    const autoTriggered = Boolean(options.autoTriggered);
    const incomingRowKey = typeof options.rowKey === "string" ? options.rowKey : null;
    if (!this.template) {
      this.setStatus("Record actions before playing auto-collect.", "warn");
      return;
    }
    if (this.recording || this.playbackActive) {
      return;
    }
    const state = this.state;
    const resolvedRowKey = incomingRowKey ?? this.getRowKey(state);
    if (autoTriggered && resolvedRowKey && resolvedRowKey === this.autoPlayLastRowKey) {
      return;
    }
    if (!state || !state.row) {
      this.setStatus("No active product to auto-collect.", "warn");
      return;
    }
    const domain = this.extractDomain(state.row.url);
    if (!domain || domain !== this.template.domain) {
      this.setStatus("Recorded actions do not match this domain. Record a new template.", "warn");
      return;
    }
    if (state.currentRowIndex <= this.template.rowIndex) {
      this.setStatus("Move to the next product before playing auto-collect.", "warn");
      return;
    }
    if (this.doesRowMatchTemplate(state)) {
      this.setStatus("Current product matches the recorded one. Move to a fresh product first.", "warn");
      return;
    }
    if (autoTriggered && resolvedRowKey) {
      this.autoPlayLastRowKey = resolvedRowKey;
    }
    this.playbackActive = true;
    this.playbackSession = {
      domain,
      originalAuto: Boolean(state.autoNavigate)
    };
    this.setStatus(`Auto-collect running for ${domain}.`, "info");
    this.updateUi();
    try {
      if (this.playbackSession.originalAuto) {
        await this.context.setAutoNavigate(false);
      }
      for (const action of this.template.actions) {
        if (!this.playbackActive) {
          break;
        }
        if (action.type !== "capture") {
          continue;
        }
        const element = this.findElement(action.selector);
        if (!element) {
          await this.stopPlayback(`Unable to locate recorded element (${action.selector}).`);
          return;
        }
        const value = extractFromElement(element, action.extractionMode, {
          attribute: action.attribute,
          extractText: this.context.extractTextFromElement
        });
        if (!value) {
          await this.stopPlayback("Recorded element returned empty data. Auto-collect paused.");
          return;
        }
        await this.context.captureValue(value, {
          source: "autoCollectPlayback",
          element,
          column: action.column ?? null,
          attribute: action.attribute ?? undefined
        });
      }
      if (!this.playbackActive) {
        await this.restoreAutoNavigate();
        return;
      }
  const approved = await this.promptApproval();
      if (!approved) {
        await this.stopPlayback("Auto-collect waiting for manual intervention.");
        return;
      }
      await this.context.navigateNext();
      await this.context.refreshState();
      this.playbackActive = false;
      await this.restoreAutoNavigate();
      this.playbackSession = null;
      this.setStatus("Auto-collect completed. Proceeding to next product.", "success");
      this.updateUi();
    } catch (error) {
      console.warn("Magic Wand: auto-collect playback error", error);
      await this.stopPlayback("Auto-collect encountered an error. Check console for details.");
    }
  }

  async stopPlayback(message) {
    if (!this.playbackActive && !this.playbackSession) {
      return;
    }
    this.playbackActive = false;
    await this.restoreAutoNavigate();
    this.playbackSession = null;
    if (this.approvalResolver) {
      this.resolveApproval(false);
    } else {
      this.hideApprovalPrompt();
    }
    if (message) {
      this.setStatus(message, "warn");
    } else {
      this.setStatus("Auto-collect paused.", "warn");
    }
    this.updateUi();
  }

  async restoreAutoNavigate() {
    if (!this.playbackSession) {
      return;
    }
    if (typeof this.playbackSession.originalAuto === "boolean") {
      if (typeof this.context.setAutoNavigate === "function") {
          await this.context.setAutoNavigate(this.playbackSession.originalAuto, { force: true });
      }
    }
  }

  findElement(selector) {
    if (!selector) {
      return null;
    }
    if (selector.startsWith("@")) {
      const [anchor, ...rest] = selector.split(" > ");
      const anchorId = anchor.slice(1);
      const anchorElement = document.getElementById(anchorId);
      if (!anchorElement) {
        return null;
      }
      if (!rest.length) {
        return anchorElement;
      }
      return anchorElement.querySelector(rest.join(" > "));
    }
    try {
      return document.querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  getRowKey(state) {
    if (!state) {
      return null;
    }
    const index = state.currentRowIndex;
    const url = state.row?.url ?? "";
    return `${index ?? ""}|${url}`;
  }

  doesRowMatchTemplate(state) {
    if (!state?.row?.inputs || !this.template?.previews) {
      return false;
    }
    const previewMap = this.template.previews;
    let matchCount = 0;
    Object.entries(previewMap).forEach(([column, previewValue]) => {
      const input = state.row.inputs.find((entry) => entry.column === column);
      if (!input) {
        return;
      }
      if (sanitizeText(input.value) === sanitizeText(previewValue)) {
        matchCount += 1;
      }
    });
    if (!matchCount) {
      return false;
    }
    return matchCount === Object.keys(previewMap).length;
  }

  isRowComplete(state) {
    if (!state?.config?.inputColumns?.length || !state?.row?.inputs?.length) {
      return false;
    }
    return state.config.inputColumns.every((column) => {
      const entry = state.row.inputs.find((item) => item.column === column);
      if (!entry) {
        return false;
      }
      return Boolean(sanitizeText(entry.value));
    });
  }

  getRowSignature(state) {
    if (!state?.config?.inputColumns?.length || !state?.row?.inputs?.length) {
      return null;
    }
    const parts = state.config.inputColumns.map((column) => {
      const entry = state.row.inputs.find((item) => item.column === column);
      const value = entry ? sanitizeText(entry.value) : "";
      return `${column}:${value}`;
    });
    return parts.join("|");
  }

  maybeAutoPlay() {
    if (!this.autoPlayEnabled || this.recording || this.playbackActive) {
      return;
    }
    if (!this.state || !this.state.row || !this.template) {
      return;
    }
    const domain = this.extractDomain(this.state.row.url);
    if (!domain || domain !== this.template.domain) {
      return;
    }
    if (this.state.currentRowIndex <= this.template.rowIndex) {
      return;
    }
    if (this.doesRowMatchTemplate(this.state)) {
      return;
    }
    const rowKey = this.getRowKey(this.state);
    if (rowKey && rowKey === this.autoPlayLastRowKey) {
      return;
    }
    this.playTemplate({ autoTriggered: true, rowKey });
  }

  extractDomain(url) {
    if (!url) {
      return null;
    }
    try {
      return new URL(url).hostname;
    } catch (error) {
      return null;
    }
  }

  promptApproval(message, options = {}) {
    if (this.autoApproveEnabled && !options.bypassAutoApprove) {
      this.hideApprovalPrompt();
      return Promise.resolve(true);
    }
    if (!this.approvalEl) {
      return Promise.resolve(true);
    }
    if (this.approvalMessageEl) {
      this.approvalMessageEl.textContent = message ?? this.defaultApprovalMessage;
    }
    this.approvalEl.hidden = false;
    return new Promise((resolve) => {
      this.approvalResolver = resolve;
    });
  }

  resolveApproval(result) {
    if (this.approvalResolver) {
      this.approvalResolver(Boolean(result));
      this.approvalResolver = null;
    }
    this.hideApprovalPrompt();
  }

  hideApprovalPrompt() {
    if (this.approvalEl) {
      this.approvalEl.hidden = true;
    }
    if (this.approvalMessageEl) {
      this.approvalMessageEl.textContent = this.defaultApprovalMessage;
    }
  }
}
