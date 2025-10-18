const extensionApi = typeof browser !== "undefined" ? browser : chrome;

const MESSAGE_TYPES = {
  GET_STATE: "getContentState",
  UPDATE_VALUE: "saveCapturedData",
  SET_AUTO_NAVIGATE: "setAutoNavigate",
  NAVIGATE_MANUAL: "navigateManual",
  UPDATE_INPUT_VALUE: "updateInputValue",
  UPDATE_COLUMN_TRANSFORM: "updateColumnTransform",
  FOCUS_INPUT_COLUMN: "focusInputColumn",
  SAVE_AND_EXIT: "saveAndExit",
  GET_DEBUG_FLAGS: "getDebugFlags"
};

let uiRoot = null;
let shadow = null;
let state = null;
let wandActive = false;
let autoNavigate = true;
let lastHighlighted = null;
const WAND_MODES = {
  AUTO: "auto",
  MANUAL: "manual"
};
let wandMode = WAND_MODES.AUTO;
let manualSelectionPending = false;
let manualSelectionText = "";
let autoCollectService = null;
let wandColumnOverride = null;
const dragState = {
  active: false,
  pointerId: null,
  offsetX: 0,
  offsetY: 0,
  target: null,
  lastLeft: null,
  lastTop: null
};

const UI_LAYOUT_STORAGE_KEY = "mwUiLayoutState";
const DEFAULT_LAYOUT_STATE = {
  panel: { left: null, top: null },
  modal: { left: null, top: null, collapsed: false }
};

let layoutState = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_STATE));
let layoutStateLoaded = false;
let layoutPersistTimer = null;

const LUCIDE_CURSOR_COLOR = "#5c2ec9";
// Lucide wand + sparkles path (ISC license). Falling back to URI encoding if base64 isn't available.
const WAND_CURSOR_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${LUCIDE_CURSOR_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m21 3-6 6" />
    <path d="m3 21 6-6" />
    <path d="m15 9 2 2" />
    <path d="m9 15 2 2" />
    <path d="M11 7V5" />
    <path d="M13 7V5" />
    <path d="M12 6h2" />
    <path d="M12 6h-2" />
    <path d="M18 12v-2" />
    <path d="M18 12h2" />
    <path d="M4 8H2" />
    <path d="M5 9V7" />
  </svg>
`.replace(/\s+/g, " ").trim();
let WAND_CURSOR_DECL = "";
try {
  if (typeof btoa === "function") {
    WAND_CURSOR_DECL = `url("data:image/svg+xml;base64,${btoa(WAND_CURSOR_SVG)}") 10 10, crosshair`;
  }
} catch (error) {
  // Ignore and fall back to URI encoding.
}
if (!WAND_CURSOR_DECL) {
  WAND_CURSOR_DECL = `url("data:image/svg+xml,${encodeURIComponent(WAND_CURSOR_SVG)}") 10 10, crosshair`;
}
const MANUAL_CURSOR_DECL = 'url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Cpath%20fill%3D%22%23c27e1d%22%20d%3D%22M4%2024l8-8%206%206-8%208H4z%22/%3E%3Cpath%20fill%3D%22%23261b0a%22%20d%3D%22M19.8%206.2l6%206-9.6%209.6-6-6z"/%3E%3Cpath%20fill%3D%22%23f2d09f%22%20d%3D%22M24.6%2011l-3.6-3.6%202.8-2.8c.8-.8%202.1-.8%202.9%200l.7.7c.8.8.8%202.1%200%202.9z"/%3E%3C/svg%3E") 6 6, text';

const styles = `
  :host {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    font-family: "Segoe UI", Roboto, sans-serif;
    color: #1c1c28;
  }
  .mw-panel {
    background: rgba(255, 255, 255, 0.95);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
    padding: 14px;
    width: 280px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border: 1px solid rgba(93, 99, 118, 0.2);
    backdrop-filter: blur(6px);
  }
  .mw-panel-wrapper {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483646;
  }
  .mw-row-title {
    font-weight: 600;
    font-size: 15px;
    color: #3a3a47;
  }
  .mw-controls {
    display: grid;
    gap: 8px;
  }
  .mw-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(92, 46, 201, 0.1);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .mw-toggle button,
  .mw-secondary button {
    border: none;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
  }
  .mw-toggle button.primary {
    background: #5c2ec9;
    color: #fff;
  }
  .mw-toggle button.secondary {
    background: transparent;
    color: #5c2ec9;
  }
  .mw-secondary {
    display: flex;
    gap: 8px;
  }
  .mw-secondary button {
    flex: 1;
    background: rgba(92, 46, 201, 0.15);
    color: #5c2ec9;
  }
  .mw-secondary button[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .mw-danger {
    background: #c2302c;
    color: #fff;
    font-weight: 600;
  }
  .mw-danger:hover {
    background: #a22622;
  }
  .mw-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .mw-hidden {
    display: none !important;
  }
  .mw-mode {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 6px;
    border-radius: 8px;
    background: rgba(92, 46, 201, 0.1);
  }
  .mw-mode button {
    border: none;
    border-radius: 6px;
    padding: 6px 8px;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    color: #5c2ec9;
    transition: background 0.2s ease, color 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mw-mode button.active {
    background: #5c2ec9;
    color: #fff;
  }
  .mw-mode button[disabled] {
    cursor: default;
    opacity: 0.85;
  }
  .mw-toast {
    padding: 10px 12px;
    background: rgba(92, 46, 201, 0.12);
    border-radius: 8px;
    font-size: 14px;
  }
  .mw-modal {
    position: fixed;
    top: 16px;
    right: 308px;
    width: 280px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.95);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(93, 99, 118, 0.2);
    backdrop-filter: blur(6px);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
  }
  .mw-modal header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(93, 99, 118, 0.2);
    cursor: grab;
    user-select: none;
  }
  .mw-modal header h2 {
    margin: 0;
    font-size: 14px;
  }
  .mw-modal header button {
    border: none;
    background: transparent;
    cursor: pointer;
    font-weight: 600;
    color: #5c2ec9;
  }
  .mw-modal.dragging header {
    cursor: grabbing;
  }
  .mw-modal[hidden] {
    display: none;
  }
  .mw-modal .mw-body {
    padding: 12px 14px;
    overflow: auto;
    display: grid;
    gap: 10px;
  }
  .mw-collapsed {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid rgba(93, 99, 118, 0.2);
    background: rgba(92, 46, 201, 0.08);
  }
  .mw-collapsed span {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    color: #3a3a47;
  }
  .mw-collapsed button {
    border: none;
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
    background: #5c2ec9;
    color: #fff;
    font-weight: 600;
  }
  .mw-modal[data-collapsed="true"] header,
  .mw-modal[data-collapsed="true"] .mw-body {
    display: none;
  }
  .mw-modal[data-collapsed="true"] .mw-collapsed {
    display: flex;
  }
  .mw-entry {
    display: grid;
    gap: 6px;
    padding: 8px;
    border-radius: 8px;
    border: 1px solid transparent;
    transition: border-color 0.2s ease, background 0.2s ease;
  }
  .mw-entry-active {
    border-color: rgba(92, 46, 201, 0.3);
    background: rgba(92, 46, 201, 0.08);
  }
  .mw-entry-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mw-entry-label {
    font-size: 13px;
    font-weight: 600;
    color: #3a3a47;
    flex: 1;
  }
  .mw-entry textarea {
    min-height: 48px;
    border-radius: 6px;
    border: 1px solid rgba(93, 99, 118, 0.35);
    padding: 6px 8px;
    font-family: inherit;
  }
  .mw-wand-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid rgba(92, 46, 201, 0.3);
    background: rgba(92, 46, 201, 0.12);
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  .mw-wand-button:hover {
    background: rgba(92, 46, 201, 0.2);
    border-color: rgba(92, 46, 201, 0.4);
  }
  .mw-wand-button.active {
    background: #5c2ec9;
    border-color: #5c2ec9;
  }
  .mw-wand-button.active svg {
    stroke: #ffffff;
  }
  .mw-wand-button svg {
    width: 16px;
    height: 16px;
    stroke: #5c2ec9;
  }
  .mw-transform {
    margin-top: 6px;
    border: 1px solid rgba(92, 46, 201, 0.2);
    border-radius: 6px;
    background: rgba(92, 46, 201, 0.05);
  }
  .mw-transform summary {
    cursor: pointer;
    list-style: none;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 600;
    color: #5c2ec9;
  }
  .mw-transform summary::-webkit-details-marker {
    display: none;
  }
  .mw-transform[open] {
    padding-bottom: 8px;
  }
  .mw-transform-body {
    display: grid;
    gap: 6px;
    padding: 0 8px;
  }
  .mw-transform-body label {
    font-size: 12px;
    font-weight: 600;
  }
  .mw-transform-body input {
    border: 1px solid rgba(93, 99, 118, 0.35);
    border-radius: 4px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 13px;
  }
  .mw-transform-hint {
    font-size: 11px;
    color: #5c2ec9;
  }
  .mw-hint {
    font-size: 12px;
    color: #5c2ec9;
  }
  .mw-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #5c2ec9;
  }
  .mw-badge::before {
    content: "•";
    display: inline-block;
    color: #5c2ec9;
  }
  .mw-hotkey {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 999px;
    border: 1px solid rgba(92, 46, 201, 0.2);
    background: rgba(92, 46, 201, 0.15);
    color: #5c2ec9;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    cursor: help;
  }
  .mw-highlight {
    outline: 2px dashed #5c2ec9;
    background: rgba(92, 46, 201, 0.08);
    cursor: crosshair;
  }
`;

function ensureGlobalStyles() {
  if (document.getElementById("mw-global-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "mw-global-style";
  style.textContent = `
    .mw-highlight {
      outline: 2px dashed #5c2ec9 !important;
      background: rgba(92, 46, 201, 0.12) !important;
      transition: outline-color 0.1s ease;
    }
    html[data-mw-wand="auto"] {
      cursor: ${WAND_CURSOR_DECL} !important;
    }
    html[data-mw-wand="auto"] * {
      cursor: ${WAND_CURSOR_DECL} !important;
    }
    html[data-mw-wand="manual"] {
      cursor: ${MANUAL_CURSOR_DECL} !important;
    }
    html[data-mw-wand="manual"] * {
      cursor: ${MANUAL_CURSOR_DECL} !important;
    }
  `;
  const host = document.head || document.documentElement;
  host.appendChild(style);
}

function ensureUi() {
  if (uiRoot) {
    return;
  }
  ensureGlobalStyles();
  uiRoot = document.createElement("div");
  shadow = uiRoot.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = styles;
  shadow.appendChild(style);

  const panel = document.createElement("div");
  panel.className = "mw-panel";
  panel.innerHTML = `
    <div class="mw-controls">
      <div class="mw-toggle">
        <span class="mw-badge">Magic wand <span class="mw-hotkey" title="Shortcut: 3">3</span></span>
        <button id="toggle-wand" class="secondary">Disabled</button>
      </div>
      <div class="mw-toggle">
        <span class="mw-badge">Auto next</span>
        <button id="toggle-auto" class="primary">On</button>
      </div>
      <div class="mw-mode" id="mode-picker">
        <button id="mode-auto" class="active" title="Shortcut: 1">Auto click <span class="mw-hotkey" aria-hidden="true">1</span></button>
        <button id="mode-manual" title="Shortcut: 2">Manual select <span class="mw-hotkey" aria-hidden="true">2</span></button>
      </div>
      <div class="mw-secondary" id="manual-nav" hidden>
        <button id="prev-row">Prev</button>
        <button id="next-row">Next</button>
      </div>
      <button id="save-exit" class="mw-danger">Save & Exit</button>
    </div>
    <div class="mw-toast" id="row-info">Row</div>
  `;

  const panelWrapper = document.createElement("div");
  panelWrapper.className = "mw-panel-wrapper";
  panelWrapper.appendChild(panel);

  const modal = document.createElement("div");
  modal.className = "mw-modal";
  modal.innerHTML = `
    <header>
      <h2>Input data</h2>
      <button id="toggle-modal" data-state="expanded">Minimize</button>
    </header>
    <div class="mw-body" id="input-list"></div>
    <div class="mw-collapsed" id="collapsed-summary" hidden>
      <span id="collapsed-label">No input selected</span>
      <button id="expand-modal">Expand</button>
    </div>
  `;
  modal.dataset.collapsed = "false";

  shadow.appendChild(panelWrapper);
  shadow.appendChild(modal);
  document.documentElement.appendChild(uiRoot);

  initModalDrag(modal);
  initPanelDrag(panelWrapper);

  panel.querySelector("#toggle-wand").addEventListener("click", () => {
    setWandState(!wandActive);
  });

  panel.querySelector("#toggle-auto").addEventListener("click", async () => {
    await setAutoNavigateState(!autoNavigate);
  });

  panel.querySelector("#mode-auto").addEventListener("click", () => {
    setWandMode(WAND_MODES.AUTO);
  });

  panel.querySelector("#mode-manual").addEventListener("click", () => {
    setWandMode(WAND_MODES.MANUAL);
  });

  panel.querySelector("#prev-row").addEventListener("click", () => navigateManual("back"));
  panel.querySelector("#next-row").addEventListener("click", () => navigateManual("forward"));
  const saveExitButton = panel.querySelector("#save-exit");
  saveExitButton.addEventListener("click", saveAndExit);
  saveExitButton.disabled = true;

  modal.querySelector("#toggle-modal").addEventListener("click", () => {
    toggleModalCollapsed(modal);
  });

  modal.querySelector("#expand-modal").addEventListener("click", () => {
    toggleModalCollapsed(modal, false);
  });
}

function updateUi() {
  if (!shadow) {
    return;
  }
  const rowInfo = shadow.getElementById("row-info");
  const toggleWand = shadow.getElementById("toggle-wand");
  const toggleAuto = shadow.getElementById("toggle-auto");
  const modeAutoBtn = shadow.getElementById("mode-auto");
  const modeManualBtn = shadow.getElementById("mode-manual");
  const manualNav = shadow.getElementById("manual-nav");
  const prevRow = shadow.getElementById("prev-row");
  const nextRow = shadow.getElementById("next-row");
  const inputList = shadow.getElementById("input-list");
  const collapsedSummary = shadow.getElementById("collapsed-summary");
  const collapsedLabel = shadow.getElementById("collapsed-label");
  const saveExitBtn = shadow.getElementById("save-exit");
  const hintText = wandMode === WAND_MODES.AUTO
    ? "Click text in the page to capture for this field."
    : "Highlight text, then press Ctrl+C or left-click to capture.";
  const totalRows = state?.totalRows ?? 0;
  const currentRowIndex = state?.currentRowIndex ?? 0;
  const currentInputIndex = state?.currentInputIndex ?? 0;

  toggleWand.textContent = wandActive ? "Enabled" : "Disabled";
  toggleWand.classList.toggle("primary", wandActive);
  toggleWand.classList.toggle("secondary", !wandActive);

  toggleAuto.textContent = autoNavigate ? "On" : "Off";
  toggleAuto.classList.toggle("primary", autoNavigate);
  toggleAuto.classList.toggle("secondary", !autoNavigate);

  modeAutoBtn.classList.toggle("active", wandMode === WAND_MODES.AUTO);
  modeManualBtn.classList.toggle("active", wandMode === WAND_MODES.MANUAL);
  modeAutoBtn.disabled = wandMode === WAND_MODES.AUTO;
  modeManualBtn.disabled = wandMode === WAND_MODES.MANUAL;

  if (!state || autoNavigate) {
    manualNav.hidden = true;
  } else {
    manualNav.hidden = false;
  }

  prevRow.disabled = !state || currentRowIndex <= 0;
  nextRow.disabled = !state || currentRowIndex >= Math.max(totalRows - 1, 0);

  rowInfo.textContent = state?.row?.indexValue ?? "No current row";

  inputList.innerHTML = "";
  const currentInput = state?.row?.inputs?.[currentInputIndex];
  collapsedLabel.textContent = currentInput?.column ?? state?.row?.indexValue ?? "No input selected";
  const columnTransforms = state?.config?.columnTransforms ?? {};
  state?.row?.inputs?.forEach((input, index) => {
    const entry = document.createElement("div");
    entry.className = "mw-entry";

    const header = document.createElement("div");
    header.className = "mw-entry-header";

  const labelEl = document.createElement("label");
  labelEl.className = "mw-entry-label";
  const textareaId = `mw-entry-${index}`;
  labelEl.setAttribute("for", textareaId);
  labelEl.textContent = input.column;
    header.appendChild(labelEl);

    const wandButton = document.createElement("button");
    wandButton.type = "button";
    wandButton.className = "mw-wand-button";
    wandButton.title = `Use wand for ${input.column}`;
  wandButton.setAttribute("aria-label", `Use wand for ${input.column}`);
    wandButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 3-6 6"></path><path d="m3 21 6-6"></path><path d="m15 9 2 2"></path><path d="m9 15 2 2"></path><path d="M11 7V5"></path><path d="M13 7V5"></path><path d="M12 6h2"></path><path d="M12 6h-2"></path><path d="M18 12v-2"></path><path d="M18 12h2"></path><path d="M4 8H2"></path><path d="M5 9V7"></path></svg>';
    wandButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setWandState(true);
      setWandMode(WAND_MODES.AUTO);
      if (state?.currentColumn === input.column) {
        wandColumnOverride = input.column;
        return;
      }
      void focusInputColumn(input.column);
    });
    header.appendChild(wandButton);

    entry.appendChild(header);

    const textarea = document.createElement("textarea");
    textarea.dataset.index = String(index);
  textarea.id = textareaId;
    textarea.value = input.value ?? "";
    textarea.addEventListener("change", (event) => {
      updateInputValue(index, event.target.value);
    });
    entry.appendChild(textarea);

    const transformDetails = document.createElement("details");
    transformDetails.className = "mw-transform";

    const summary = document.createElement("summary");
    summary.textContent = "Auto clean options";
    transformDetails.appendChild(summary);

    const transformBody = document.createElement("div");
    transformBody.className = "mw-transform-body";

    const regexLabel = document.createElement("label");
    regexLabel.textContent = "Regex pattern";
    transformBody.appendChild(regexLabel);

    const regexInput = document.createElement("input");
    regexInput.type = "text";
    regexInput.placeholder = "Optional";
    regexInput.dataset.transform = "regex";
    transformBody.appendChild(regexInput);

    const flagsLabel = document.createElement("label");
    flagsLabel.textContent = "Regex flags";
    transformBody.appendChild(flagsLabel);

    const flagsInput = document.createElement("input");
    flagsInput.type = "text";
    flagsInput.placeholder = "e.g. i";
    flagsInput.maxLength = 6;
    flagsInput.dataset.transform = "flags";
    transformBody.appendChild(flagsInput);

    const commaLabel = document.createElement("label");
    commaLabel.textContent = "Keep comma segments";
    transformBody.appendChild(commaLabel);

    const commaInput = document.createElement("input");
    commaInput.type = "number";
    commaInput.min = "1";
    commaInput.step = "1";
    commaInput.placeholder = "Leave blank";
    commaInput.dataset.transform = "comma";
    transformBody.appendChild(commaInput);

    const transformHint = document.createElement("p");
    transformHint.className = "mw-transform-hint";
    transformHint.textContent = "Matches use the first capture group when available. Enter the number of comma-separated segments to keep (1 keeps text before the first comma).";
    transformBody.appendChild(transformHint);

    transformDetails.appendChild(transformBody);
    entry.appendChild(transformDetails);

    const hintEl = document.createElement("span");
    hintEl.className = "mw-hint";
    hintEl.textContent = hintText;
    entry.appendChild(hintEl);

    const transform = columnTransforms[input.column] ?? null;
    if (transform) {
      if (transform.regexPattern) {
        regexInput.value = transform.regexPattern;
      }
      if (transform.regexFlags) {
        flagsInput.value = transform.regexFlags;
      }
      if (typeof transform.commaLimit === "number") {
        commaInput.value = String(transform.commaLimit);
      }
      if (Object.keys(transform).length) {
        transformDetails.open = true;
      }
    }

    regexInput.addEventListener("change", (event) => {
      void updateColumnTransformSetting(input.column, { regexPattern: event.target.value });
    });
    flagsInput.addEventListener("change", (event) => {
      void updateColumnTransformSetting(input.column, { regexFlags: event.target.value });
    });
    commaInput.addEventListener("change", (event) => {
      void updateColumnTransformSetting(input.column, { commaLimit: event.target.value });
    });

    const isActive = currentInput?.column === input.column;
    if (isActive) {
      entry.classList.add("mw-entry-active");
      wandButton.classList.add("active");
    }

    inputList.appendChild(entry);
  });

  if (saveExitBtn && saveExitBtn.dataset.pending !== "true") {
    saveExitBtn.disabled = !state;
  }
}

async function navigateManual(direction) {
  autoCollectService?.handleEvent?.("manual-navigate", { direction });
  const response = await extensionApi.runtime.sendMessage({
    type: MESSAGE_TYPES.NAVIGATE_MANUAL,
    payload: { direction }
  });
  if (!response?.ok) {
    alert(response?.error ?? "Unable to navigate.");
    return;
  }
  await refreshState();
}

async function saveAndExit() {
  const button = shadow?.getElementById("save-exit");
  if (button) {
    button.disabled = true;
    button.dataset.pending = "true";
  }
  try {
    const response = await extensionApi.runtime.sendMessage({ type: MESSAGE_TYPES.SAVE_AND_EXIT });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Unable to save and exit the session.");
    }
    setWandState(false);
    if (response.state) {
      state = response.state;
      updateUi();
    } else {
      await refreshState();
    }
  } catch (error) {
    alert(error.message || "Failed to save progress.");
  } finally {
    if (button) {
      delete button.dataset.pending;
      if (!document.hidden) {
        button.disabled = !state;
      }
    }
  }
}

async function updateInputValue(index, value) {
  if (!state) {
    return;
  }
  const column = state.config.inputColumns[index];
  await extensionApi.runtime.sendMessage({
    type: MESSAGE_TYPES.UPDATE_INPUT_VALUE,
    payload: {
      rowIndex: state.currentRowIndex,
      column,
      value
    }
  });
  await refreshState();
}

async function focusInputColumn(column) {
  if (!state || !column) {
    return;
  }
  wandColumnOverride = column;
  try {
    const response = await extensionApi.runtime.sendMessage({
      type: MESSAGE_TYPES.FOCUS_INPUT_COLUMN,
      payload: {
        column,
        rowIndex: state.currentRowIndex
      }
    });
    if (response?.ok && response.state) {
      state = response.state;
      updateUi();
      autoCollectService?.handleStateUpdate?.(state);
    } else if (response && response.ok === false && response.error) {
      console.warn("Magic Wand: unable to focus column", response.error);
      wandColumnOverride = null;
    }
  } catch (error) {
    console.warn("Magic Wand: failed to focus column", error);
    wandColumnOverride = null;
  }
}

async function updateColumnTransformSetting(column, patch) {
  if (!state || !column || !patch || typeof patch !== "object") {
    return;
  }
  const existingTransforms = state.config?.columnTransforms ?? {};
  const existing = existingTransforms[column] ?? {};
  const next = { ...existing };

  if (Object.prototype.hasOwnProperty.call(patch, "regexPattern")) {
    const pattern = typeof patch.regexPattern === "string" ? patch.regexPattern.trim() : "";
    if (pattern) {
      next.regexPattern = pattern;
    } else {
      delete next.regexPattern;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "regexFlags")) {
    const flagsRaw = typeof patch.regexFlags === "string" ? patch.regexFlags.trim() : "";
    const sanitizedFlags = flagsRaw.replace(/[^dgimsuy]/gi, "").toLowerCase();
    if (sanitizedFlags && next.regexPattern) {
      next.regexFlags = sanitizedFlags;
    } else {
      delete next.regexFlags;
    }
  }

  if (!next.regexPattern) {
    delete next.regexFlags;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "commaLimit")) {
    const parsed = typeof patch.commaLimit === "string"
      ? patch.commaLimit.trim()
      : patch.commaLimit;
    const limitValue = typeof parsed === "number" ? parsed : parsed === "" ? null : Number.parseInt(parsed, 10);
    if (Number.isInteger(limitValue) && limitValue > 0) {
      next.commaLimit = limitValue;
    } else {
      delete next.commaLimit;
    }
  }

  const cleaned = Object.keys(next).length ? next : null;
  const existingSerialized = JSON.stringify(existing);
  const cleanedSerialized = JSON.stringify(cleaned ?? {});
  if (existingSerialized === cleanedSerialized) {
    return;
  }

  try {
    const response = await extensionApi.runtime.sendMessage({
      type: MESSAGE_TYPES.UPDATE_COLUMN_TRANSFORM,
      payload: {
        column,
        transform: cleaned
      }
    });
    if (response?.ok && response.state) {
      state = response.state;
      updateUi();
    } else if (response && response.ok === false && response.error) {
      console.warn("Magic Wand: transform update rejected", response.error);
    }
  } catch (error) {
    console.warn("Magic Wand: failed to update column transform", error);
  }
}

async function refreshState() {
  const response = await extensionApi.runtime.sendMessage({ type: MESSAGE_TYPES.GET_STATE });
  if (!response?.ok) {
    return;
  }
  state = response.state ?? null;
  if (state && typeof state.autoNavigate === "boolean") {
    autoNavigate = state.autoNavigate;
  }
  updateUi();
  autoCollectService?.handleStateUpdate?.(state);
}

async function setAutoNavigateState(enabled, options = {}) {
  const normalized = Boolean(enabled);
  if (!options.force && autoNavigate === normalized) {
    return;
  }
  autoNavigate = normalized;
  updateUi();
  try {
    await extensionApi.runtime.sendMessage({
      type: MESSAGE_TYPES.SET_AUTO_NAVIGATE,
      payload: { enabled: normalized }
    });
  } catch (error) {
    console.warn("Magic Wand: failed to update auto navigate flag", error);
  }
}

function setWandMode(mode) {
  if (!mode || (mode !== WAND_MODES.AUTO && mode !== WAND_MODES.MANUAL)) {
    return;
  }
  if (wandMode === mode) {
    return;
  }
  wandMode = mode;
  if (wandActive) {
    document.documentElement.setAttribute("data-mw-wand", wandMode);
  }
  if (wandMode === WAND_MODES.MANUAL) {
    clearHighlight(lastHighlighted);
    wandColumnOverride = null;
  }
  manualSelectionPending = false;
  manualSelectionText = "";
  updateUi();
  autoCollectService?.handleEvent?.("wand-mode", { mode: wandMode });
}

function setWandState(enabled) {
  if (wandActive === enabled) {
    return;
  }
  wandActive = enabled;
  if (wandActive) {
    document.documentElement.setAttribute("data-mw-wand", wandMode);
  } else {
    document.documentElement.removeAttribute("data-mw-wand");
    clearHighlight(lastHighlighted);
    manualSelectionPending = false;
    manualSelectionText = "";
    wandColumnOverride = null;
  }
  updateUi();
  autoCollectService?.handleEvent?.("wand-toggle", { enabled: wandActive });
}

function highlightElement(target) {
  if (!target || target === lastHighlighted) {
    return;
  }
  if (uiRoot && (target === uiRoot || uiRoot.contains(target))) {
    return;
  }
  clearHighlight(lastHighlighted);
  target.classList.add("mw-highlight");
  lastHighlighted = target;
}

function clearHighlight(target) {
  if (!target) {
    lastHighlighted = null;
    return;
  }
  target.classList.remove("mw-highlight");
  if (target === lastHighlighted) {
    lastHighlighted = null;
  }
}

function toggleModalCollapsed(modal, force) {
  if (!modal) {
    return;
  }
  const toggleButton = modal.querySelector("#toggle-modal");
  const shouldCollapse = typeof force === "boolean"
    ? force
    : modal.dataset.collapsed !== "true";
  if (shouldCollapse) {
    modal.dataset.collapsed = "true";
    toggleButton.textContent = "Expand";
    toggleButton.dataset.state = "collapsed";
  } else {
    modal.dataset.collapsed = "false";
    toggleButton.textContent = "Minimize";
    toggleButton.dataset.state = "expanded";
  }
  if (layoutState.modal.collapsed !== shouldCollapse) {
    updateLayoutState("modal", { collapsed: shouldCollapse });
  }
  updateUi();
}

function clampPosition(left, top, element) {
  const width = element?.offsetWidth ?? 0;
  const height = element?.offsetHeight ?? 0;
  const maxLeft = Math.max(0, window.innerWidth - width);
  const maxTop = Math.max(0, window.innerHeight - height);
  const normalizedLeft = Number.isFinite(left) ? left : 0;
  const normalizedTop = Number.isFinite(top) ? top : 0;
  return {
    left: Math.min(Math.max(0, Math.round(normalizedLeft)), maxLeft),
    top: Math.min(Math.max(0, Math.round(normalizedTop)), maxTop)
  };
}

function scheduleLayoutPersist() {
  if (!layoutStateLoaded || !extensionApi?.storage?.local?.set) {
    return;
  }
  if (layoutPersistTimer) {
    clearTimeout(layoutPersistTimer);
  }
  layoutPersistTimer = setTimeout(() => {
    layoutPersistTimer = null;
    if (!extensionApi?.storage?.local?.set) {
      return;
    }
    extensionApi.storage.local
      .set({ [UI_LAYOUT_STORAGE_KEY]: layoutState })
      .catch((error) => {
        console.warn("Magic Wand: unable to persist UI layout", error);
      });
  }, 150);
}

function updateLayoutState(section, patch) {
  if (!layoutState[section]) {
    layoutState[section] = {};
  }
  const target = layoutState[section];
  let changed = false;
  Object.entries(patch).forEach(([key, rawValue]) => {
    let value = rawValue;
    if (typeof value === "number") {
      value = Math.round(value);
    }
    if (value === undefined) {
      return;
    }
    if (value === null) {
      if (key in target) {
        delete target[key];
        changed = true;
      }
      return;
    }
    if (target[key] !== value) {
      target[key] = value;
      changed = true;
    }
  });
  if (changed) {
    scheduleLayoutPersist();
  }
}

function storePanelPosition(left, top) {
  updateLayoutState("panel", { left, top });
}

function storeModalPosition(left, top) {
  updateLayoutState("modal", { left, top });
}

async function loadLayoutState() {
  if (!extensionApi?.storage?.local?.get) {
    layoutState = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_STATE));
    layoutStateLoaded = true;
    return;
  }
  try {
    const stored = await extensionApi.storage.local.get(UI_LAYOUT_STORAGE_KEY);
    const value = stored?.[UI_LAYOUT_STORAGE_KEY];
    if (value && typeof value === "object") {
      layoutState = {
        panel: { ...DEFAULT_LAYOUT_STATE.panel, ...(value.panel ?? {}) },
        modal: { ...DEFAULT_LAYOUT_STATE.modal, ...(value.modal ?? {}) }
      };
      const panelLeft = layoutState.panel.left;
      if (panelLeft !== null && panelLeft !== undefined) {
        const parsed = Number(panelLeft);
        layoutState.panel.left = Number.isFinite(parsed) ? Math.round(parsed) : null;
      }
      const panelTop = layoutState.panel.top;
      if (panelTop !== null && panelTop !== undefined) {
        const parsed = Number(panelTop);
        layoutState.panel.top = Number.isFinite(parsed) ? Math.round(parsed) : null;
      }
      const modalLeft = layoutState.modal.left;
      if (modalLeft !== null && modalLeft !== undefined) {
        const parsed = Number(modalLeft);
        layoutState.modal.left = Number.isFinite(parsed) ? Math.round(parsed) : null;
      }
      const modalTop = layoutState.modal.top;
      if (modalTop !== null && modalTop !== undefined) {
        const parsed = Number(modalTop);
        layoutState.modal.top = Number.isFinite(parsed) ? Math.round(parsed) : null;
      }
      layoutState.modal.collapsed = Boolean(layoutState.modal.collapsed);
    } else {
      layoutState = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_STATE));
    }
  } catch (error) {
    console.warn("Magic Wand: unable to load UI layout", error);
    layoutState = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_STATE));
  }
  layoutStateLoaded = true;
}

function applyLayoutState() {
  if (!shadow || !layoutStateLoaded) {
    return;
  }
  const panelWrapper = shadow.querySelector(".mw-panel-wrapper");
  if (panelWrapper && typeof layoutState.panel.left === "number" && typeof layoutState.panel.top === "number") {
    panelWrapper.style.right = "auto";
    const { left, top } = clampPosition(layoutState.panel.left, layoutState.panel.top, panelWrapper);
    if (layoutState.panel.left !== left || layoutState.panel.top !== top) {
      updateLayoutState("panel", { left, top });
    }
    panelWrapper.style.left = `${left}px`;
    panelWrapper.style.top = `${top}px`;
  }
  const modal = shadow.querySelector(".mw-modal");
  if (modal) {
    if (typeof layoutState.modal.left === "number" && typeof layoutState.modal.top === "number") {
      modal.style.right = "auto";
      const { left, top } = clampPosition(layoutState.modal.left, layoutState.modal.top, modal);
      if (layoutState.modal.left !== left || layoutState.modal.top !== top) {
        updateLayoutState("modal", { left, top });
      }
      modal.style.left = `${left}px`;
      modal.style.top = `${top}px`;
    }
    if (typeof layoutState.modal.collapsed === "boolean") {
      toggleModalCollapsed(modal, layoutState.modal.collapsed === true);
    }
  }
}

function applyColumnTransforms(value, column) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!column || !state?.config?.columnTransforms) {
    return text;
  }
  const transforms = state.config.columnTransforms[column];
  if (!transforms || typeof transforms !== "object") {
    return text;
  }
  let output = text;
  if (transforms.regexPattern) {
    try {
      const flags = typeof transforms.regexFlags === "string" ? transforms.regexFlags : "";
      const regex = new RegExp(transforms.regexPattern, flags);
      const match = output.match(regex);
      if (match) {
        output = match.length > 1 && match[1] !== undefined ? match[1] : match[0];
      }
    } catch (error) {
      console.warn("Magic Wand: invalid regex for column", column, error);
    }
  }
  const commaLimit = Number.isInteger(transforms.commaLimit)
    ? transforms.commaLimit
    : Number.parseInt(transforms.commaLimit, 10);
  if (Number.isInteger(commaLimit) && commaLimit > 0) {
    const segments = output.split(",");
    const keep = Math.min(commaLimit, segments.length);
    output = segments.slice(0, keep).join(",");
  }
  return typeof output === "string" ? output : String(output ?? "");
}

async function captureValue(value, context = {}) {
  const previousState = state
    ? {
        rowIndex: state.currentRowIndex,
        column: state.currentColumn,
        domain: getCurrentRowDomain(state),
        url: state.row?.url ?? null
      }
    : null;
  const targetColumn = context.column ?? wandColumnOverride ?? previousState?.column ?? state?.currentColumn ?? null;
  const cleaned = applyColumnTransforms(value, targetColumn).trim();
  if (!cleaned) {
    return;
  }
  try {
    const payload = { value: cleaned };
    if (typeof targetColumn === "string" && targetColumn) {
      payload.column = targetColumn;
    }
    const response = await extensionApi.runtime.sendMessage({
      type: MESSAGE_TYPES.UPDATE_VALUE,
      payload
    });
    if (response?.ok) {
      if (!context.skipAutoCollectRecord) {
        autoCollectService?.handleEvent?.("capture-success", {
          value: cleaned,
          column: targetColumn ?? null,
          context,
          stateBefore: previousState
        });
      }
      await refreshState();
      wandColumnOverride = null;
    }
  } catch (error) {
    // Surface capture issues in the console without disrupting the page.
    console.warn("Magic Wand: failed to capture value", error);
  }
}

function extractTargetText(target) {
  if (!target) {
    return "";
  }
  const tagName = target.tagName?.toLowerCase();
  if (tagName === "input" || tagName === "textarea") {
    return target.value?.trim() ?? "";
  }
  if (target.isContentEditable) {
    return target.innerText?.trim() ?? target.textContent?.trim() ?? "";
  }
  const text = target.innerText ?? target.textContent ?? "";
  return typeof text === "string" ? text.trim() : "";
}

function getSelectedText() {
  const selection = window.getSelection();
  if (selection) {
    const text = selection.toString();
    if (text && text.trim()) {
      return text.trim();
    }
  }
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      return active.value.slice(start, end).trim();
    }
  }
  return "";
}

function resolveElementFromNode(node) {
  if (!node) {
    return null;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return node;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.parentElement ?? null;
  }
  return null;
}

function resolveElementFromSelection(selection) {
  if (!selection) {
    return null;
  }
  const anchorElement = resolveElementFromNode(selection.anchorNode);
  if (anchorElement) {
    return anchorElement;
  }
  const focusElement = resolveElementFromNode(selection.focusNode);
  if (focusElement) {
    return focusElement;
  }
  return null;
}

function getCurrentRowDomain(currentState = state) {
  const url = currentState?.row?.url;
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname ?? null;
  } catch (error) {
    return null;
  }
}

function clearCurrentSelection() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    selection.removeAllRanges();
  }
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    const end = active.selectionEnd ?? active.value.length;
    try {
      active.setSelectionRange(end, end);
    } catch (error) {
      // Ignore selection reset issues for unsupported input types.
    }
  }
}

function resetManualSelection() {
  manualSelectionPending = false;
  manualSelectionText = "";
}

function isNodeInsideOverlay(node) {
  if (!uiRoot || !node) {
    return false;
  }
  if (node === uiRoot || node === shadow) {
    return true;
  }
  const root = node.getRootNode ? node.getRootNode() : null;
  if (root && root === shadow) {
    return true;
  }
  let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current) {
    if (current === uiRoot) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function handleSelectionChange() {
  if (!wandActive || wandMode !== WAND_MODES.MANUAL) {
    resetManualSelection();
    return;
  }
  const selection = window.getSelection();
  if (selection) {
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (isNodeInsideOverlay(anchor) || isNodeInsideOverlay(focus)) {
      resetManualSelection();
      return;
    }
  }
  const text = getSelectedText();
  manualSelectionPending = Boolean(text);
  manualSelectionText = text;
}

function handleManualCopy(event) {
  if (!wandActive || wandMode !== WAND_MODES.MANUAL) {
    return;
  }
  const selection = window.getSelection();
  let element = null;
  if (selection) {
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (isNodeInsideOverlay(anchor) || isNodeInsideOverlay(focus)) {
      return;
    }
    element = resolveElementFromSelection(selection);
  }
  const text = getSelectedText();
  if (!text) {
    resetManualSelection();
    return;
  }
  if (!element) {
    element = resolveElementFromNode(document.activeElement);
  }
  captureValue(text, {
    source: "manualCopy",
    element: element ?? null
  });
  manualSelectionPending = false;
  manualSelectionText = "";
}

function handleKeydown(event) {
  if (event.defaultPrevented) {
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  if (event.target?.tagName === "INPUT" || event.target?.tagName === "TEXTAREA") {
    return;
  }
  if (event.target?.isContentEditable) {
    return;
  }
  if (event.key === "1") {
    setWandMode(WAND_MODES.AUTO);
    event.preventDefault();
    return;
  }
  if (event.key === "2") {
    setWandMode(WAND_MODES.MANUAL);
    event.preventDefault();
    return;
  }
  if (event.key === "3") {
    setWandState(!wandActive);
    event.preventDefault();
  }
}

function handleMouseMove(event) {
  if (!wandActive) {
    return;
  }
  if (wandMode !== WAND_MODES.AUTO) {
    clearHighlight(lastHighlighted);
    return;
  }
  const target = event.target;
  if (!target || target === document || target === window) {
    clearHighlight(lastHighlighted);
    return;
  }
  if (target === document.documentElement || target === document.body) {
    clearHighlight(lastHighlighted);
    return;
  }
  if (uiRoot && (target === uiRoot || uiRoot.contains(target))) {
    clearHighlight(lastHighlighted);
    return;
  }
  highlightElement(target);
}

async function handleClick(event) {
  const target = event.target;
  if (uiRoot && (target === uiRoot || uiRoot.contains(target))) {
    return;
  }
  if (!wandActive) {
    return;
  }

  if (wandMode === WAND_MODES.AUTO) {
    event.preventDefault();
    event.stopPropagation();
    const text = extractTargetText(target);
    if (!text) {
      return;
    }
    await captureValue(text, {
      source: "autoClick",
      element: target instanceof Element ? target : null
    });
    return;
  }

  if (wandMode === WAND_MODES.MANUAL) {
    if (!manualSelectionPending) {
      manualSelectionText = "";
      return;
    }
    const text = manualSelectionText || getSelectedText();
    if (!text) {
      resetManualSelection();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    const element = selection ? resolveElementFromSelection(selection) : null;
    await captureValue(text, {
      source: "manualSelection",
      element: element ?? (target instanceof Element ? target : null)
    });
    clearCurrentSelection();
    resetManualSelection();
  }
}

function attachListeners() {
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("copy", handleManualCopy, true);
  document.addEventListener("selectionchange", handleSelectionChange, true);
  document.addEventListener("keydown", handleKeydown, true);
}

function initModalDrag(modal) {
  const header = modal.querySelector("header");
  const collapsed = modal.querySelector(".mw-collapsed");
  if (!header || !collapsed) {
    return;
  }

  const endDrag = (event) => {
    if (!dragState.active || event.pointerId !== dragState.pointerId) {
      return;
    }
    const finalRect = modal.getBoundingClientRect();
    const finalLeft = typeof dragState.lastLeft === "number" ? dragState.lastLeft : finalRect.left;
    const finalTop = typeof dragState.lastTop === "number" ? dragState.lastTop : finalRect.top;
    dragState.active = false;
    dragState.pointerId = null;
    dragState.target = null;
    dragState.lastLeft = null;
    dragState.lastTop = null;
    modal.classList.remove("dragging");
    try {
      header.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Ignore release errors.
    }
    try {
      collapsed.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Ignore release errors.
    }
    storeModalPosition(finalLeft, finalTop);
  };

  const startDrag = (event, source) => {
    if (event.button !== 0) {
      return;
    }
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      return;
    }
    if (event.target && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    const rect = modal.getBoundingClientRect();
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.offsetX = event.clientX - rect.left;
    dragState.offsetY = event.clientY - rect.top;
    dragState.target = modal;
    dragState.lastLeft = rect.left;
    dragState.lastTop = rect.top;
    modal.style.right = "auto";
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    modal.classList.add("dragging");
    source.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event) => {
    if (!dragState.active || event.pointerId !== dragState.pointerId || dragState.target !== modal) {
      return;
    }
    const maxLeft = Math.max(0, window.innerWidth - modal.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - modal.offsetHeight);
    const left = Math.min(Math.max(0, event.clientX - dragState.offsetX), maxLeft);
    const top = Math.min(Math.max(0, event.clientY - dragState.offsetY), maxTop);
    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
    dragState.lastLeft = left;
    dragState.lastTop = top;
  };

  const attachDragHandlers = (source) => {
    source.addEventListener("pointerdown", (event) => startDrag(event, source));
    source.addEventListener("pointermove", moveDrag);
    source.addEventListener("pointerup", endDrag);
    source.addEventListener("pointercancel", endDrag);
  };

  attachDragHandlers(header);
  attachDragHandlers(collapsed);
}

function initPanelDrag(wrapper) {
  if (!wrapper) {
    return;
  }
  const panel = wrapper.querySelector(".mw-panel");
  if (!panel) {
    return;
  }

  const startDrag = (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      return;
    }
    const target = event.target;
    if (target && (target.tagName === "BUTTON" || target.closest("button"))) {
      return;
    }
    event.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.offsetX = event.clientX - rect.left;
    dragState.offsetY = event.clientY - rect.top;
    dragState.target = wrapper;
    dragState.lastLeft = rect.left;
    dragState.lastTop = rect.top;
    wrapper.style.right = "auto";
    wrapper.style.left = `${rect.left}px`;
    wrapper.style.top = `${rect.top}px`;
    panel.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event) => {
    if (!dragState.active || event.pointerId !== dragState.pointerId || dragState.target !== wrapper) {
      return;
    }
    const maxLeft = Math.max(0, window.innerWidth - wrapper.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - wrapper.offsetHeight);
    const left = Math.min(Math.max(0, event.clientX - dragState.offsetX), maxLeft);
    const top = Math.min(Math.max(0, event.clientY - dragState.offsetY), maxTop);
    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    dragState.lastLeft = left;
    dragState.lastTop = top;
  };

  const endDrag = (event) => {
    if (!dragState.active || event.pointerId !== dragState.pointerId) {
      return;
    }
    const finalRect = wrapper.getBoundingClientRect();
    const finalLeft = typeof dragState.lastLeft === "number" ? dragState.lastLeft : finalRect.left;
    const finalTop = typeof dragState.lastTop === "number" ? dragState.lastTop : finalRect.top;
    dragState.active = false;
    dragState.pointerId = null;
    dragState.target = null;
    dragState.lastLeft = null;
    dragState.lastTop = null;
    try {
      panel.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Ignore release errors.
    }
    storePanelPosition(finalLeft, finalTop);
  };

  panel.addEventListener("pointerdown", startDrag);
  panel.addEventListener("pointermove", moveDrag);
  panel.addEventListener("pointerup", endDrag);
  panel.addEventListener("pointercancel", endDrag);
}

async function initAutoCollectFeature() {
  try {
    const response = await extensionApi.runtime.sendMessage({ type: MESSAGE_TYPES.GET_DEBUG_FLAGS });
    if (!response?.ok || !response.flags?.autoCollect) {
      return;
    }
    const moduleUrl = extensionApi.runtime.getURL("content/autoCollectService.js");
    const autoCollectModule = await import(moduleUrl);
    if (!autoCollectModule?.initAutoCollectService) {
      console.warn("Magic Wand: auto-collect service module missing init function");
      return;
    }
    const context = {
      extensionApi,
      shadowRoot: shadow,
      getState: () => state,
      getCurrentDomain: () => getCurrentRowDomain(state),
      captureValue: (value, metadata = {}) =>
        captureValue(value, { ...metadata, skipAutoCollectRecord: true }),
      refreshState,
      setAutoNavigate: setAutoNavigateState,
      navigateNext: () => navigateManual("forward"),
      navigatePrev: () => navigateManual("back"),
      setWandState,
      setWandMode,
      highlightElement,
      extractTextFromElement: extractTargetText,
      resolveElementFromNode,
      resolveElementFromSelection,
      getSelectedText,
      getUiRoot: () => uiRoot,
      getPanelWrapper: () => shadow?.querySelector(".mw-panel-wrapper") ?? null,
      getPanel: () => shadow?.querySelector(".mw-panel") ?? null,
      getControlsContainer: () => shadow?.querySelector(".mw-controls") ?? null
    };
    autoCollectService = await autoCollectModule.initAutoCollectService(context);
    if (state) {
      autoCollectService?.handleStateUpdate?.(state);
    }
  } catch (error) {
    console.warn("Magic Wand: failed to initialize auto-collect debug service", error);
  }
}

async function bootstrap() {
  await loadLayoutState();
  ensureUi();
  applyLayoutState();
  attachListeners();
  await initAutoCollectFeature();
  await refreshState();
}

void bootstrap();
