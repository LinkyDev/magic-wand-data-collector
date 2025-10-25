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
  MANUAL: "manual",
  LINK: "link"
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

const COLUMN_INPUT_TYPES = {
  TEXTAREA: "textarea",
  PRESETS: "presets",
  LINK_HREF: "linkHref"
};

const PRESET_SELECTION_MODES = {
  SINGLE: "single",
  MULTIPLE: "multiple"
};

const UI_LAYOUT_STORAGE_KEY = "mwUiLayoutState";
const DEFAULT_LAYOUT_STATE = {
  panel: { left: null, top: null },
  modal: { left: null, top: null, collapsed: false }
};

let layoutState = JSON.parse(JSON.stringify(DEFAULT_LAYOUT_STATE));
let layoutStateLoaded = false;
let layoutPersistTimer = null;
let lucideModulesPromise = null;
const lucideIconPromises = new Map();

const LUCIDE_CURSOR_COLOR = "#5c2ec9";
const FALLBACK_WAND_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${LUCIDE_CURSOR_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
    <path d="m14 7 3 3" />
    <path d="M5 6v4" />
    <path d="M19 14v4" />
    <path d="M10 2v2" />
    <path d="M7 8H3" />
    <path d="M21 16h-4" />
    <path d="M11 3H9" />
  </svg>
`.replace(/\s+/g, " ").trim();

function buildCursorDataUri(svgMarkup) {
  if (!svgMarkup) {
    return "crosshair";
  }
  try {
    if (typeof btoa === "function") {
      return `url("data:image/svg+xml;base64,${btoa(svgMarkup)}") 10 10, crosshair`;
    }
  } catch (error) {
    // Ignore encoding issues and fall back to URI encoding.
  }
  return `url("data:image/svg+xml,${encodeURIComponent(svgMarkup)}") 10 10, crosshair`;
}

let WAND_CURSOR_DECL = buildCursorDataUri(FALLBACK_WAND_SVG);
const MANUAL_CURSOR_DECL = 'url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Cpath%20fill%3D%22%23c27e1d%22%20d%3D%22M4%2024l8-8%206%206-8%208H4z%22/%3E%3Cpath%20fill%3D%22%23261b0a%22%20d%3D%22M19.8%206.2l6%206-9.6%209.6-6-6z"/%3E%3Cpath%20fill%3D%22%23f2d09f%22%20d%3D%22M24.6%2011l-3.6-3.6%202.8-2.8c.8-.8%202.1-.8%202.9%200l.7.7c.8.8.8%202.1%200%202.9z"/%3E%3C/svg%3E") 6 6, text';

function buildGlobalStylesContent() {
  return `
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
    html[data-mw-wand="link"] {
      cursor: ${WAND_CURSOR_DECL} !important;
    }
    html[data-mw-wand="link"] * {
      cursor: ${WAND_CURSOR_DECL} !important;
    }
    html[data-mw-wand="manual"] {
      cursor: ${MANUAL_CURSOR_DECL} !important;
    }
    html[data-mw-wand="manual"] * {
      cursor: ${MANUAL_CURSOR_DECL} !important;
    }
  `;
}

function refreshGlobalStyles() {
  const style = document.getElementById("mw-global-style");
  if (style) {
    style.textContent = buildGlobalStylesContent();
  }
}

async function loadLucideModules() {
  if (lucideModulesPromise) {
    return lucideModulesPromise;
  }
  if (!extensionApi?.runtime?.getURL) {
    lucideModulesPromise = Promise.resolve(null);
    return lucideModulesPromise;
  }
  lucideModulesPromise = (async () => {
    try {
      const createElementUrl = extensionApi.runtime.getURL("node_modules/lucide/dist/esm/createElement.js");
      const wandIconUrl = extensionApi.runtime.getURL("node_modules/lucide/dist/esm/icons/wand-sparkles.js");
      const [createElementModule, wandIconModule] = await Promise.all([
        import(createElementUrl),
        import(wandIconUrl)
      ]);
      return {
        createElement: createElementModule?.default,
        icons: {
          "wand-sparkles": wandIconModule?.default ?? null
        }
      };
    } catch (error) {
      console.warn("Magic Wand: unable to load Lucide modules", error);
      return null;
    }
  })();
  return lucideModulesPromise;
}

async function ensureLucideIcon(modules, iconName) {
  if (!modules || !iconName) {
    return null;
  }
  modules.icons = modules.icons ?? {};
  if (modules.icons[iconName]) {
    return modules.icons[iconName];
  }
  if (lucideIconPromises.has(iconName)) {
    return lucideIconPromises.get(iconName);
  }
  if (!extensionApi?.runtime?.getURL) {
    return null;
  }
  const loadPromise = (async () => {
    try {
      const iconUrl = extensionApi.runtime.getURL(`node_modules/lucide/dist/esm/icons/${iconName}.js`);
      const iconModule = await import(iconUrl);
      const iconNode = iconModule?.default ?? null;
      if (iconNode) {
        modules.icons[iconName] = iconNode;
      }
      return iconNode;
    } catch (error) {
      console.warn(`Magic Wand: unable to load Lucide icon "${iconName}"`, error);
      return null;
    } finally {
      lucideIconPromises.delete(iconName);
    }
  })();
  lucideIconPromises.set(iconName, loadPromise);
  return loadPromise;
}

function renderLucideIcon(target, iconNode, createElement, options = {}) {
  if (!target || !iconNode || typeof createElement !== "function") {
    return null;
  }
  const size = Number.parseInt(target.dataset?.lucideSize ?? "", 10);
  const strokeWidth = Number.parseFloat(target.dataset?.lucideStrokeWidth ?? "");
  const svg = createElement(iconNode, {
    width: Number.isFinite(size) && size > 0 ? size : 16,
    height: Number.isFinite(size) && size > 0 ? size : 16,
    stroke: options.color ?? LUCIDE_CURSOR_COLOR,
    "stroke-width": Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 2,
    "aria-hidden": "true"
  });
  if (!(svg instanceof SVGElement)) {
    return null;
  }
  svg.classList.add("mw-lucide-icon");
  const existingClasses = Array.from(target.classList ?? []);
  existingClasses.forEach((cls) => {
    if (cls !== "mw-lucide-placeholder") {
      svg.classList.add(cls);
    }
  });
  if (target.id) {
    svg.id = target.id;
  }
  if (target.getAttribute("role")) {
    svg.setAttribute("role", target.getAttribute("role"));
  }
  target.replaceWith(svg);
  return svg;
}

async function refreshCursorWithLucide(modules) {
  if (!modules?.createElement || !modules.icons?.["wand-sparkles"]) {
    return;
  }
  try {
    const svgElement = modules.createElement(modules.icons["wand-sparkles"], {
      width: 24,
      height: 24,
      stroke: LUCIDE_CURSOR_COLOR,
      "stroke-width": 2
    });
    if (!(svgElement instanceof SVGElement)) {
      return;
    }
    const serialized = new XMLSerializer().serializeToString(svgElement);
    const nextCursor = buildCursorDataUri(serialized);
    if (nextCursor && nextCursor !== WAND_CURSOR_DECL) {
      WAND_CURSOR_DECL = nextCursor;
      refreshGlobalStyles();
    }
  } catch (error) {
    console.warn("Magic Wand: unable to refresh wand cursor", error);
  }
}

async function ensureWandIcon() {
  const modules = await loadLucideModules();
  if (!modules?.createElement) {
    return;
  }
  const scope = shadow ?? document;
  const placeholders = scope.querySelectorAll?.("[data-lucide]") ?? [];
  for (const placeholder of placeholders) {
    if (placeholder.tagName?.toLowerCase() === "svg") {
      continue;
    }
    const iconName = placeholder.getAttribute("data-lucide");
    let iconNode = modules.icons?.[iconName] ?? null;
    if (!iconNode) {
      iconNode = await ensureLucideIcon(modules, iconName);
    }
    if (!iconNode) {
      continue;
    }
    renderLucideIcon(placeholder, iconNode, modules.createElement);
  }
  await refreshCursorWithLucide(modules);
}

function normalizePresetValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function splitPresetValues(value) {
  const normalized = normalizePresetValue(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function joinPresetValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "";
  }
  return values
    .map((part) => normalizePresetValue(part))
    .filter((part) => part.length > 0)
    .join(";");
}

function buildPresetDefinitions(rawPresets) {
  if (!Array.isArray(rawPresets)) {
    return [];
  }
  const result = [];
  rawPresets.forEach((preset) => {
    if (!preset || typeof preset !== "object") {
      return;
    }
    const title = normalizePresetValue(preset.title);
    const value = normalizePresetValue(preset.value || preset.title);
    if (!value) {
      return;
    }
    result.push({
      id: preset.id ?? value,
      title: title || value,
      value,
      linked: Boolean(preset.linked),
      isDefault: Boolean(preset.isDefault)
    });
  });
  return result;
}

function buildPresetLabelMap(presets) {
  const map = new Map();
  presets.forEach((preset) => {
    const value = normalizePresetValue(preset.value);
    if (value) {
      map.set(value, preset.title || value);
    }
  });
  return map;
}

function getColumnConfig(column, currentState = state) {
  if (!column || !currentState?.config?.inputColumnSettings) {
    return null;
  }
  return currentState.config.inputColumnSettings[column] ?? null;
}

function isLinkCaptureColumn(column, currentState = state) {
  const config = getColumnConfig(column, currentState);
  return config?.type === COLUMN_INPUT_TYPES.LINK_HREF;
}

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
  .mw-progress {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(92, 46, 201, 0.12);
  }
  .mw-progress-primary {
    font-size: 14px;
    font-weight: 700;
    color: #3a3a47;
  }
  .mw-progress-secondary {
    font-size: 12px;
    color: #5c2ec9;
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
  .mw-entry-presets {
    gap: 10px;
  }
  .mw-preset-container {
    display: grid;
    gap: 10px;
  }
  .mw-preset-options {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .mw-preset-button {
    border: 1px solid rgba(92, 46, 201, 0.3);
    background: rgba(92, 46, 201, 0.12);
    color: #5c2ec9;
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
  }
  .mw-preset-button:hover {
    background: rgba(92, 46, 201, 0.18);
    border-color: rgba(92, 46, 201, 0.4);
  }
  .mw-preset-button.selected {
    background: #5c2ec9;
    border-color: #5c2ec9;
    color: #ffffff;
  }
  .mw-preset-button[data-default="true"]::after {
    content: " (default)";
    font-size: 11px;
    font-weight: 600;
  }
  .mw-preset-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 12px;
    color: #5c2ec9;
  }
  .mw-preset-summary-text {
    flex: 1;
    min-width: 0;
  }
  .mw-preset-clear {
    border: 1px solid rgba(92, 46, 201, 0.3);
    background: transparent;
    color: #5c2ec9;
    border-radius: 6px;
    padding: 4px 10px;
    font-weight: 600;
    cursor: pointer;
  }
  .mw-preset-clear:hover {
    background: rgba(92, 46, 201, 0.16);
  }
  .mw-preset-clear:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    background: transparent;
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
  const existing = document.getElementById("mw-global-style");
  if (existing) {
    refreshGlobalStyles();
    return;
  }
  const style = document.createElement("style");
  style.id = "mw-global-style";
  style.textContent = buildGlobalStylesContent();
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
    <div class="mw-progress">
      <span class="mw-progress-primary" id="row-progress-value">Product 0 of 0</span>
      <span class="mw-progress-secondary" id="domain-progress-value">Domain block: not available</span>
    </div>
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
        <button id="mode-link" title="Shortcut: 4">Link URL <span class="mw-hotkey" aria-hidden="true">4</span></button>
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

  panel.querySelector("#mode-link").addEventListener("click", () => {
    setWandMode(WAND_MODES.LINK);
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
  const rowProgressValue = shadow.getElementById("row-progress-value");
  const domainProgressValue = shadow.getElementById("domain-progress-value");
  const rowInfo = shadow.getElementById("row-info");
  const toggleWand = shadow.getElementById("toggle-wand");
  const toggleAuto = shadow.getElementById("toggle-auto");
  const modeAutoBtn = shadow.getElementById("mode-auto");
  const modeLinkBtn = shadow.getElementById("mode-link");
  const modeManualBtn = shadow.getElementById("mode-manual");
  const manualNav = shadow.getElementById("manual-nav");
  const prevRow = shadow.getElementById("prev-row");
  const nextRow = shadow.getElementById("next-row");
  const inputList = shadow.getElementById("input-list");
  const collapsedSummary = shadow.getElementById("collapsed-summary");
  const collapsedLabel = shadow.getElementById("collapsed-label");
  const saveExitBtn = shadow.getElementById("save-exit");
  let hintText;
  if (wandMode === WAND_MODES.AUTO) {
    hintText = "Click text in the page to capture for this field.";
  } else if (wandMode === WAND_MODES.LINK) {
    hintText = "Click a link to capture its URL.";
  } else {
    hintText = "Highlight text, then press Ctrl+C or left-click to capture.";
  }
  const totalRows = state?.totalRows ?? 0;
  const currentRowIndex = state?.currentRowIndex ?? 0;
  const currentInputIndex = state?.currentInputIndex ?? 0;
  const rowProgress = state?.rowProgress ?? null;
  const domainProgress = state?.domainProgress ?? null;

  if (rowProgressValue) {
    const currentNumber = rowProgress?.current ?? (state ? currentRowIndex + 1 : 0);
    const totalNumber = rowProgress?.total ?? totalRows;
    if (state && totalNumber > 0) {
      rowProgressValue.textContent = `Product ${currentNumber} of ${totalNumber}`;
    } else {
      rowProgressValue.textContent = "Product 0 of 0";
    }
  }

  if (domainProgressValue) {
    if (state && domainProgress?.domain && domainProgress.total > 0) {
      domainProgressValue.textContent = `${domainProgress.domain} block: ${domainProgress.current} of ${domainProgress.total}`;
    } else if (state && domainProgress?.domain) {
      domainProgressValue.textContent = `${domainProgress.domain} block: 0 of 0`;
    } else {
      domainProgressValue.textContent = "Domain block: not available";
    }
  }

  toggleWand.textContent = wandActive ? "Enabled" : "Disabled";
  toggleWand.classList.toggle("primary", wandActive);
  toggleWand.classList.toggle("secondary", !wandActive);

  toggleAuto.textContent = autoNavigate ? "On" : "Off";
  toggleAuto.classList.toggle("primary", autoNavigate);
  toggleAuto.classList.toggle("secondary", !autoNavigate);

  if (modeAutoBtn) {
    modeAutoBtn.classList.toggle("active", wandMode === WAND_MODES.AUTO);
    modeAutoBtn.disabled = wandMode === WAND_MODES.AUTO;
  }
  if (modeLinkBtn) {
    modeLinkBtn.classList.toggle("active", wandMode === WAND_MODES.LINK);
    modeLinkBtn.disabled = wandMode === WAND_MODES.LINK;
  }
  if (modeManualBtn) {
    modeManualBtn.classList.toggle("active", wandMode === WAND_MODES.MANUAL);
    modeManualBtn.disabled = wandMode === WAND_MODES.MANUAL;
  }

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
    labelEl.textContent = input.column;
    header.appendChild(labelEl);

    const wandButton = document.createElement("button");
    wandButton.type = "button";
    wandButton.className = "mw-wand-button";
    wandButton.title = `Use wand for ${input.column}`;
    wandButton.setAttribute("aria-label", `Use wand for ${input.column}`);
    const wandIconPlaceholder = document.createElement("span");
    wandIconPlaceholder.className = "mw-lucide-placeholder";
    wandIconPlaceholder.dataset.lucide = "wand-sparkles";
    wandIconPlaceholder.dataset.lucideSize = "18";
    wandButton.appendChild(wandIconPlaceholder);
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

    const columnConfig = state?.config?.inputColumnSettings?.[input.column] ?? null;
    const presetDefinitions = buildPresetDefinitions(columnConfig?.presets);
    const selectionMode = columnConfig?.selectionMode === PRESET_SELECTION_MODES.MULTIPLE
      ? PRESET_SELECTION_MODES.MULTIPLE
      : PRESET_SELECTION_MODES.SINGLE;
    const usePresets = columnConfig?.type === COLUMN_INPUT_TYPES.PRESETS && presetDefinitions.length > 0;

    let hintMessage = hintText;

    if (usePresets) {
      entry.classList.add("mw-entry-presets");

      const allowDefault = selectionMode === PRESET_SELECTION_MODES.SINGLE;
      const defaultPreset = allowDefault ? presetDefinitions.find((preset) => preset.isDefault) ?? null : null;
      const hasExplicitNonePreset = presetDefinitions.some((preset) => preset.value.toLowerCase() === "none");
      const initialValueNormalized = normalizePresetValue(input.value ?? "");
      let currentValue = initialValueNormalized;
      let selectedValues = splitPresetValues(currentValue);
      let hasStoredNone = currentValue.toLowerCase() === "none";

      if (!hasExplicitNonePreset && selectedValues.length === 1 && selectedValues[0].toLowerCase() === "none") {
        selectedValues = [];
      }

      if (selectionMode === PRESET_SELECTION_MODES.SINGLE && selectedValues.length > 1) {
        selectedValues = [selectedValues[0]];
        currentValue = joinPresetValues(selectedValues);
      }

      let shouldApplyDefault = false;
      if (!currentValue && defaultPreset) {
        const normalizedDefault = normalizePresetValue(defaultPreset.value);
        if (normalizedDefault) {
          selectedValues = [normalizedDefault];
          currentValue = normalizedDefault;
          hasStoredNone = false;
          shouldApplyDefault = true;
        }
      }

      const needsSanitizedPersist = currentValue !== initialValueNormalized && !shouldApplyDefault;
      if (needsSanitizedPersist) {
        void updateInputValue(index, currentValue);
      }

      const labelMap = buildPresetLabelMap(presetDefinitions);
      const presetContainer = document.createElement("div");
      presetContainer.className = "mw-preset-container";

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "mw-preset-options";
      presetContainer.appendChild(optionsWrap);

      const summary = document.createElement("div");
      summary.className = "mw-preset-summary";
      const summaryText = document.createElement("span");
      summaryText.className = "mw-preset-summary-text";
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "mw-preset-clear";
      clearButton.textContent = "Clear";
      summary.appendChild(summaryText);
      summary.appendChild(clearButton);
      presetContainer.appendChild(summary);

      const presetButtons = [];
      let interactionPending = false;

      const computeDisplayLabels = (values) => values.map((value) => labelMap.get(value) ?? value);

      const syncPresetUi = () => {
        const selectedSet = new Set(selectedValues);
        presetButtons.forEach((button) => {
          const value = button.dataset.value ?? "";
          const isSelected = selectionMode === PRESET_SELECTION_MODES.SINGLE
            ? selectedValues.length === 1 && selectedValues[0] === value
            : selectedSet.has(value);
          button.classList.toggle("selected", isSelected);
          button.setAttribute("aria-pressed", isSelected ? "true" : "false");
        });
        if (selectedValues.length) {
          const display = computeDisplayLabels(selectedValues);
          summaryText.textContent = `Selected: ${display.join(", ")}`;
          clearButton.disabled = false;
        } else if (hasStoredNone) {
          summaryText.textContent = "Selected: none";
          clearButton.disabled = false;
        } else {
          summaryText.textContent = "No option selected.";
          clearButton.disabled = true;
        }
      };

      const commitPresetValues = async (nextValues) => {
        const nextList = Array.isArray(nextValues) ? nextValues.map((value) => normalizePresetValue(value)).filter(Boolean) : [];
        if (selectionMode === PRESET_SELECTION_MODES.SINGLE && nextList.length > 1) {
          nextList.splice(1);
        }
        const storageList = nextList.length > 0 ? nextList : ["none"];
        const nextSerialized = joinPresetValues(storageList);
        if (interactionPending) {
          return;
        }
        if (nextSerialized === currentValue) {
          selectedValues = nextList;
          hasStoredNone = storageList.length === 1 && storageList[0].toLowerCase() === "none";
          syncPresetUi();
          return;
        }
        interactionPending = true;
        selectedValues = nextList;
        currentValue = nextSerialized;
        hasStoredNone = storageList.length === 1 && storageList[0].toLowerCase() === "none";
        syncPresetUi();
        try {
          await updateInputValue(index, currentValue);
        } catch (error) {
          console.warn("Magic Wand: failed to persist preset selection", error);
        } finally {
          interactionPending = false;
        }
      };

      presetDefinitions.forEach((preset) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mw-preset-button";
        button.dataset.value = preset.value;
        button.textContent = preset.title || preset.value;
        button.setAttribute("aria-pressed", "false");
        if (preset.isDefault) {
          button.dataset.default = "true";
          if (!button.title) {
            button.title = "Default option";
          }
        }
        button.addEventListener("click", () => {
          const value = button.dataset.value ?? "";
          if (!value || interactionPending) {
            return;
          }
          if (selectionMode === PRESET_SELECTION_MODES.MULTIPLE) {
            const nextValues = [...selectedValues];
            const existingIndex = nextValues.indexOf(value);
            if (existingIndex === -1) {
              nextValues.push(value);
            } else {
              nextValues.splice(existingIndex, 1);
            }
            void commitPresetValues(nextValues);
          } else {
            const isSelected = selectedValues.length === 1 && selectedValues[0] === value;
            void commitPresetValues(isSelected ? [] : [value]);
          }
        });
        presetButtons.push(button);
        optionsWrap.appendChild(button);
      });

      clearButton.addEventListener("click", () => {
        if (interactionPending) {
          return;
        }
        void commitPresetValues([]);
      });

      entry.appendChild(presetContainer);
      syncPresetUi();

      if (shouldApplyDefault) {
        void commitPresetValues([defaultPreset.value]);
      } else if (!initialValueNormalized && !hasStoredNone) {
        void commitPresetValues([]);
      }

      hintMessage = selectionMode === PRESET_SELECTION_MODES.MULTIPLE
        ? "Toggle multiple buttons to save values separated by ;"
        : "Click a button to fill this field.";
    } else {
      const textareaId = `mw-entry-${index}`;
      labelEl.setAttribute("for", textareaId);

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

      if (columnConfig?.type === COLUMN_INPUT_TYPES.LINK_HREF) {
        hintMessage = "Click a link to capture its URL.";
      }
    }

    const hintEl = document.createElement("span");
    hintEl.className = "mw-hint";
    hintEl.textContent = hintMessage;
    entry.appendChild(hintEl);

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

  void ensureWandIcon();
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
  if (response.state) {
    applyState(response.state);
  } else {
    await refreshState();
  }
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
      applyState(response.state);
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
  const columnConfig = getColumnConfig(column, state);
  const rawValue = typeof value === "string" ? value : value == null ? "" : String(value);
  const shouldTransform = column && columnConfig?.type !== COLUMN_INPUT_TYPES.PRESETS;
  const cleanedValue = shouldTransform ? applyColumnTransforms(rawValue, column) : rawValue;
  const finalValue = typeof cleanedValue === "string" ? cleanedValue.trim() : String(cleanedValue ?? "");
  try {
    const response = await extensionApi.runtime.sendMessage({
      type: MESSAGE_TYPES.UPDATE_INPUT_VALUE,
      payload: {
        rowIndex: state.currentRowIndex,
        column,
        value: finalValue
      }
    });
    if (response?.ok) {
      if (response.state) {
        applyState(response.state);
      } else {
        await refreshState();
      }
    } else if (response?.error) {
      console.warn("Magic Wand: update rejected", response.error);
    }
  } catch (error) {
    console.warn("Magic Wand: failed to update input value", error);
  }
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
      applyState(response.state);
    } else if (response?.ok) {
      await refreshState();
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
      applyState(response.state);
    } else if (response?.ok) {
      await refreshState();
    } else if (response && response.ok === false && response.error) {
      console.warn("Magic Wand: transform update rejected", response.error);
    }
  } catch (error) {
    console.warn("Magic Wand: failed to update column transform", error);
  }
}

function applyState(nextState) {
  state = nextState ?? null;
  if (state && typeof state.autoNavigate === "boolean") {
    autoNavigate = state.autoNavigate;
  } else if (!state) {
    autoNavigate = true;
  }
  updateUi();
  autoCollectService?.handleStateUpdate?.(state);
}

async function refreshState() {
  const response = await extensionApi.runtime.sendMessage({ type: MESSAGE_TYPES.GET_STATE });
  if (!response?.ok) {
    return;
  }
  applyState(response.state ?? null);
}

async function setAutoNavigateState(enabled, options = {}) {
  const normalized = Boolean(enabled);
  if (!options.force && autoNavigate === normalized) {
    return;
  }
  autoNavigate = normalized;
  updateUi();
  try {
    const response = await extensionApi.runtime.sendMessage({
      type: MESSAGE_TYPES.SET_AUTO_NAVIGATE,
      payload: { enabled: normalized }
    });
    if (response?.ok && response.state) {
      applyState(response.state);
    } else if (response?.ok === false) {
      console.warn("Magic Wand: auto navigate update rejected", response.error);
      await refreshState();
    }
  } catch (error) {
    console.warn("Magic Wand: failed to update auto navigate flag", error);
    await refreshState();
  }
}

function setWandMode(mode) {
  const validModes = Object.values(WAND_MODES);
  if (!mode || !validModes.includes(mode)) {
    return;
  }
  const previousMode = wandMode;
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
  } else if (previousMode === WAND_MODES.MANUAL) {
    clearHighlight(lastHighlighted);
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
  const stateSnapshot = state;
  const metadata = { ...context };
  const previousState = stateSnapshot
    ? {
        rowIndex: stateSnapshot.currentRowIndex,
        column: stateSnapshot.currentColumn,
        domain: getCurrentRowDomain(stateSnapshot),
        url: stateSnapshot.row?.url ?? null
      }
    : null;
  const targetColumn = metadata.column
    ?? wandColumnOverride
    ?? previousState?.column
    ?? stateSnapshot?.currentColumn
    ?? null;
  if (typeof targetColumn === "string" && targetColumn && !metadata.column) {
    metadata.column = targetColumn;
  }
  const resolvedValue = resolveColumnCaptureValue(value, metadata, targetColumn, stateSnapshot);
  const cleaned = applyColumnTransforms(resolvedValue, targetColumn).trim();
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
      if (!metadata.skipAutoCollectRecord) {
        autoCollectService?.handleEvent?.("capture-success", {
          value: cleaned,
          column: targetColumn ?? null,
          context: metadata,
          stateBefore: previousState
        });
      }
      if (response.state) {
        applyState(response.state);
      } else {
        await refreshState();
      }
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

function extractTargetHref(target) {
  if (!target) {
    return "";
  }
  const element = target instanceof Element ? target : resolveElementFromNode(target);
  if (!(element instanceof Element)) {
    return "";
  }
  const anchor = element.closest?.("a[href], area[href], [href]") ?? element;
  if (!(anchor instanceof Element)) {
    return "";
  }
  if (!anchor.hasAttribute("href") && element.hasAttribute?.("href")) {
    const propertyHref = typeof element.href === "string" ? element.href.trim() : "";
    if (propertyHref) {
      return propertyHref;
    }
    const attributeHref = element.getAttribute("href");
    return typeof attributeHref === "string" ? attributeHref.trim() : "";
  }
  if (!anchor.hasAttribute("href")) {
    return "";
  }
  const propertyHref = typeof anchor.href === "string" ? anchor.href.trim() : "";
  if (propertyHref) {
    return propertyHref;
  }
  const attributeHref = anchor.getAttribute("href");
  return typeof attributeHref === "string" ? attributeHref.trim() : "";
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

function resolveColumnCaptureValue(rawValue, metadata, column, stateSnapshot = state) {
  const baseValue = rawValue == null ? "" : String(rawValue);
  if (metadata?.attribute === "href") {
    const explicit = baseValue.trim();
    if (explicit) {
      return explicit;
    }
    const element = metadata.element instanceof Element
      ? metadata.element
      : resolveElementFromNode(metadata.element ?? null);
    const hrefValue = extractTargetHref(element);
    if (hrefValue) {
      return hrefValue;
    }
    return baseValue;
  }
  if (!column) {
    return baseValue;
  }
  const columnConfig = getColumnConfig(column, stateSnapshot);
  if (!columnConfig) {
    return baseValue;
  }
  if (columnConfig.type === COLUMN_INPUT_TYPES.LINK_HREF) {
    const element = metadata?.element instanceof Element
      ? metadata.element
      : resolveElementFromNode(metadata?.element ?? null);
    const hrefValue = extractTargetHref(element);
    if (hrefValue) {
      metadata.attribute = "href";
      return hrefValue;
    }
    return baseValue;
  }
  return baseValue;
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
  const targetColumn = wandColumnOverride ?? state?.currentColumn ?? null;
  const expectsHref = isLinkCaptureColumn(targetColumn);
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
  if (!text && !expectsHref) {
    resetManualSelection();
    return;
  }
  if (!element) {
    element = resolveElementFromNode(document.activeElement);
  }
  captureValue(text, {
    source: "manualCopy",
    element: element ?? null,
    column: targetColumn ?? undefined
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
  if (event.key === "4") {
    setWandMode(WAND_MODES.LINK);
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
  const shouldHighlight = wandMode === WAND_MODES.AUTO || wandMode === WAND_MODES.LINK;
  if (!shouldHighlight) {
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
    const targetColumn = wandColumnOverride ?? state?.currentColumn ?? null;
    const expectsHref = isLinkCaptureColumn(targetColumn);
    const text = extractTargetText(target);
    if (!text && !expectsHref) {
      return;
    }
    await captureValue(text, {
      source: "autoClick",
      element: target instanceof Element ? target : null,
      column: targetColumn ?? undefined
    });
    return;
  }

  if (wandMode === WAND_MODES.LINK) {
    event.preventDefault();
    event.stopPropagation();
    const targetColumn = wandColumnOverride ?? state?.currentColumn ?? null;
    const element = target instanceof Element ? target : resolveElementFromNode(target);
    const hrefValue = extractTargetHref(element);
    if (!hrefValue) {
      return;
    }
    await captureValue(hrefValue, {
      source: "linkClick",
      element: element ?? null,
      attribute: "href",
      column: targetColumn ?? undefined
    });
    return;
  }

  if (wandMode === WAND_MODES.MANUAL) {
    const targetColumn = wandColumnOverride ?? state?.currentColumn ?? null;
    const expectsHref = isLinkCaptureColumn(targetColumn);
    if (!manualSelectionPending && !expectsHref) {
      manualSelectionText = "";
      return;
    }
  const text = (manualSelectionPending ? manualSelectionText : "") || getSelectedText();
    if (!text && !expectsHref) {
      resetManualSelection();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    const element = selection ? resolveElementFromSelection(selection) : null;
    await captureValue(text, {
      source: "manualSelection",
      element: element ?? (target instanceof Element ? target : null),
      column: targetColumn ?? undefined
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
  await ensureWandIcon();
  applyLayoutState();
  attachListeners();
  await initAutoCollectFeature();
  await refreshState();
}

void bootstrap();
