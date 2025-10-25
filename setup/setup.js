import { parseCsv, buildRowObjects } from "../common/csv.js";

const extensionApi = typeof browser !== "undefined" ? browser : chrome;

const uploadInput = document.getElementById("csv-file");
const fileNameLabel = document.getElementById("file-name");
const previewContainer = document.getElementById("preview");
const previewTable = document.getElementById("preview-table");
const columnsCard = document.getElementById("columns-card");
const configCard = document.getElementById("config-card");
const sessionCard = document.getElementById("session-card");
const configForm = document.getElementById("config-form");
const indexColumnSelect = document.getElementById("index-column");
const urlColumnSelect = document.getElementById("url-column");
const startRowSelect = document.getElementById("start-row");
const inputColumnsList = document.getElementById("input-columns-list");
const skipFilledCheckbox = document.getElementById("skip-filled");
const saveToNewCheckbox = document.getElementById("save-to-new");
const outputNameWrapper = document.getElementById("output-name-wrapper");
const outputNameInput = document.getElementById("output-name");
const configError = document.getElementById("config-error");
const startButton = document.getElementById("start-button");
const sessionSummary = document.getElementById("session-summary");
const resumeButton = document.getElementById("resume-button");
const exportButton = document.getElementById("export-button");
const resetButton = document.getElementById("reset-button");
const historyCard = document.getElementById("history-card");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");

let csvState = null;
let parsedCsv = null;

const COLUMN_INPUT_TYPES = {
  TEXTAREA: "textarea",
  PRESETS: "presets",
  LINK_HREF: "linkHref"
};

const SELECTION_MODES = {
  SINGLE: "single",
  MULTIPLE: "multiple"
};

let columnStates = new Map();
let columnElements = new Map();
let headerOrder = [];
let presetIdCounter = 0;
let columnIdCounter = 0;
let lastSelectedColumn = null;
let lucideModulesPromise = null;
const lucideIconPromises = new Map();

function resetUi() {
  csvState = null;
  parsedCsv = null;
  previewContainer.hidden = true;
  if (columnsCard) {
    columnsCard.hidden = true;
  }
  configCard.hidden = true;
  sessionCard.hidden = true;
  fileNameLabel.hidden = true;
  configError.hidden = true;
  configForm.reset();
  indexColumnSelect.innerHTML = "";
  urlColumnSelect.innerHTML = "";
  startRowSelect.innerHTML = "";
  columnStates = new Map();
  columnElements = new Map();
  headerOrder = [];
  presetIdCounter = 0;
  columnIdCounter = 0;
  lastSelectedColumn = null;
  inputColumnsList.innerHTML = "";
  resumeButton.disabled = true;
  exportButton.disabled = true;
  resetButton.disabled = true;
}

function populateSelect(selectEl, options, { placeholder, multiple } = {}) {
  selectEl.innerHTML = "";
  if (placeholder && !multiple) {
    selectEl.appendChild(new Option(placeholder, "", true, true));
  }
  options.forEach((option) => {
    const item = new Option(option.label ?? option.value, option.value, false, false);
    selectEl.appendChild(item);
  });
}

function createPresetOption(initialValue = "") {
  presetIdCounter += 1;
  const normalized = typeof initialValue === "string" ? initialValue : String(initialValue ?? "");
  return {
    id: `preset-${presetIdCounter}`,
    title: normalized,
    value: normalized,
    linked: true,
    isDefault: false
  };
}

function createDefaultColumnState(columnName) {
  columnIdCounter += 1;
  const safeColumn = typeof columnName === "string" ? columnName : "column";
  return {
    uid: `column-${columnIdCounter}`,
    column: safeColumn,
    selected: false,
    open: false,
    type: COLUMN_INPUT_TYPES.TEXTAREA,
    selectionMode: SELECTION_MODES.SINGLE,
    presets: [createPresetOption("")],
    pendingFocusPresetId: null
  };
}

function getColumnState(column) {
  if (!columnStates.has(column)) {
    columnStates.set(column, createDefaultColumnState(column));
  }
  return columnStates.get(column);
}

function createIconPlaceholder(name, size = 16) {
  const span = document.createElement("span");
  span.className = "lucide-placeholder";
  span.dataset.lucide = name;
  span.dataset.lucideSize = String(size);
  return span;
}

function escapeForSelector(value) {
  const stringValue = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(stringValue);
  }
  let escaped = "";
  for (let i = 0; i < stringValue.length; i += 1) {
    const char = stringValue[i];
    if (/^[a-zA-Z0-9_-]$/.test(char)) {
      escaped += char;
    } else {
      escaped += `\\${char}`;
    }
  }
  return escaped;
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
      const createElementModule = await import(createElementUrl);
      return {
        createElement: createElementModule?.default,
        icons: {}
      };
    } catch (error) {
      console.warn("Setup: unable to load Lucide modules", error);
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
      console.warn(`Setup: unable to load Lucide icon "${iconName}"`, error);
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
    stroke: options.color ?? "currentColor",
    "stroke-width": Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 2,
    "aria-hidden": "true"
  });
  if (!(svg instanceof SVGElement)) {
    return null;
  }
  svg.classList.add("lucide-icon");
  const existingClasses = Array.from(target.classList ?? []);
  existingClasses.forEach((cls) => {
    if (cls !== "lucide-placeholder") {
      svg.classList.add(cls);
    }
  });
  if (target.id) {
    svg.id = target.id;
  }
  target.replaceWith(svg);
  return svg;
}

async function ensureLucideIcons(root = document) {
  const modules = await loadLucideModules();
  if (!modules?.createElement || !root) {
    return;
  }
  const placeholders = root.querySelectorAll?.("[data-lucide]") ?? [];
  for (const placeholder of placeholders) {
    if (placeholder.tagName?.toLowerCase() === "svg") {
      continue;
    }
    const iconName = placeholder.getAttribute("data-lucide");
    if (!iconName) {
      continue;
    }
    let iconNode = modules.icons?.[iconName] ?? null;
    if (!iconNode) {
      iconNode = await ensureLucideIcon(modules, iconName);
    }
    if (iconNode) {
      renderLucideIcon(placeholder, iconNode, modules.createElement);
    }
  }
}

function renderInputColumnsList(headers) {
  if (!inputColumnsList) {
    return;
  }
  headerOrder = Array.isArray(headers) ? [...headers] : [];
  columnStates = new Map();
  columnElements = new Map();
  presetIdCounter = 0;
  columnIdCounter = 0;
  lastSelectedColumn = null;
  inputColumnsList.innerHTML = "";
  headerOrder.forEach((header) => {
    const state = createDefaultColumnState(header);
    columnStates.set(header, state);
    const element = buildColumnItem(header);
    columnElements.set(header, element);
    inputColumnsList.appendChild(element);
  });
  void ensureLucideIcons(inputColumnsList);
}

function buildColumnItem(column) {
  const state = getColumnState(column);
  const item = document.createElement("div");
  item.className = "column-item";
  item.dataset.column = column;
  if (state.selected) {
    item.classList.add("selected");
  }
  if (state.open) {
    item.classList.add("config-open");
  }

  const headerRow = document.createElement("div");
  headerRow.className = "column-item-header";

  const checkboxLabel = document.createElement("label");
  checkboxLabel.className = "column-checkbox";

  const panelId = `${state.uid}-panel`;
  let panel = null;
  let configButton = null;

  const focusPendingPreset = () => {
    if (!state.pendingFocusPresetId || !item.isConnected) {
      return;
    }
    const targetId = state.pendingFocusPresetId;
    requestAnimationFrame(() => {
      const focusTarget = item.querySelector(`.preset-row[data-preset-id="${escapeForSelector(targetId)}"] input[data-role="title"]`);
      if (focusTarget) {
        focusTarget.focus();
        state.pendingFocusPresetId = null;
      }
    });
  };

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(state.selected);
  checkbox.addEventListener("click", (event) => {
    const shouldSelect = event.target.checked;
    if (event.shiftKey && lastSelectedColumn && lastSelectedColumn !== column) {
      bulkSelectColumns(lastSelectedColumn, column, shouldSelect);
      if (!shouldSelect && panel) {
        panel.remove();
        panel = null;
      }
    }
    lastSelectedColumn = column;
  });
  checkbox.addEventListener("change", (event) => {
    state.selected = event.target.checked;
    item.classList.toggle("selected", state.selected);
    if (!state.selected) {
      state.open = false;
      item.classList.remove("config-open");
      if (configButton) {
        configButton.setAttribute("aria-expanded", "false");
      }
      if (panel) {
        panel.remove();
        panel = null;
      }
    }
    lastSelectedColumn = column;
  });

  const nameSpan = document.createElement("span");
  nameSpan.textContent = column;

  checkboxLabel.appendChild(checkbox);
  checkboxLabel.appendChild(nameSpan);

  configButton = document.createElement("button");
  configButton.type = "button";
  configButton.className = "column-config-btn";
  configButton.title = `Configure input options for ${column}`;
  configButton.appendChild(createIconPlaceholder("square-pen", 18));
  configButton.setAttribute("aria-expanded", state.open ? "true" : "false");
  configButton.setAttribute("aria-controls", panelId);

  configButton.addEventListener("click", () => {
    if (!state.selected) {
      state.selected = true;
      checkbox.checked = true;
      item.classList.add("selected");
    }

    const panelAttached = panel && item.contains(panel);
    state.open = !state.open;
    item.classList.toggle("config-open", state.open);
    configButton.setAttribute("aria-expanded", state.open ? "true" : "false");

    if (state.open) {
      if (!panelAttached) {
        panel = buildColumnConfigPanel(column, state);
        panel.setAttribute("role", "region");
        panel.setAttribute("aria-label", `Input options for ${column}`);
        panel.id = panelId;
        item.appendChild(panel);
      }
      if (panel) {
        panel.hidden = false;
        void ensureLucideIcons(panel);
        focusPendingPreset();
      }
    } else if (panelAttached) {
      panel.remove();
      panel = null;
    }
  });

  headerRow.appendChild(checkboxLabel);
  headerRow.appendChild(configButton);
  item.appendChild(headerRow);

  if (state.open) {
    panel = buildColumnConfigPanel(column, state);
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", `Input options for ${column}`);
    panel.id = panelId;
    item.appendChild(panel);
    void ensureLucideIcons(panel);
  }

  focusPendingPreset();
  void ensureLucideIcons(item);
  return item;
}

function bulkSelectColumns(fromColumn, toColumn, shouldSelect) {
  if (!headerOrder.length) {
    return;
  }
  const startIndex = headerOrder.indexOf(fromColumn);
  const endIndex = headerOrder.indexOf(toColumn);
  if (startIndex === -1 || endIndex === -1) {
    return;
  }
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  for (let index = from; index <= to; index += 1) {
    const targetColumn = headerOrder[index];
    const state = getColumnState(targetColumn);
    state.selected = shouldSelect;
    const element = columnElements.get(targetColumn);
    if (!element) {
      continue;
    }
    element.classList.toggle("selected", shouldSelect);
    const checkbox = element.querySelector('input[type="checkbox"]');
    if (checkbox && checkbox.checked !== shouldSelect) {
      checkbox.checked = shouldSelect;
    }
    if (!shouldSelect) {
      state.open = false;
      element.classList.remove("config-open");
      const button = element.querySelector(".column-config-btn");
      if (button) {
        button.setAttribute("aria-expanded", "false");
      }
      const panel = element.querySelector(".column-config-panel");
      if (panel) {
        panel.remove();
      }
    }
  }
}

function buildColumnConfigPanel(column, state) {
  const panel = document.createElement("div");
  panel.className = "column-config-panel";

  const description = document.createElement("p");
  description.className = "config-description";
  description.textContent = "Choose how this column captures values.";
  panel.appendChild(description);

  const typeGroup = document.createElement("div");
  typeGroup.className = "config-button-group";

  const textButton = document.createElement("button");
  textButton.type = "button";
  textButton.className = "config-button";
  textButton.textContent = "Input area";
  if (state.type === COLUMN_INPUT_TYPES.TEXTAREA) {
    textButton.classList.add("active");
  }
  textButton.addEventListener("click", () => {
    setColumnType(column, COLUMN_INPUT_TYPES.TEXTAREA);
  });

  const linkButton = document.createElement("button");
  linkButton.type = "button";
  linkButton.className = "config-button";
  linkButton.appendChild(createIconPlaceholder("link", 16));
  linkButton.appendChild(document.createTextNode("Link URL"));
  if (state.type === COLUMN_INPUT_TYPES.LINK_HREF) {
    linkButton.classList.add("active");
  }
  linkButton.addEventListener("click", () => {
    setColumnType(column, COLUMN_INPUT_TYPES.LINK_HREF);
  });

  const presetsButton = document.createElement("button");
  presetsButton.type = "button";
  presetsButton.className = "config-button";
  presetsButton.appendChild(createIconPlaceholder("list-checks", 16));
  presetsButton.appendChild(document.createTextNode("Preset buttons"));
  if (state.type === COLUMN_INPUT_TYPES.PRESETS) {
    presetsButton.classList.add("active");
  }
  presetsButton.addEventListener("click", () => {
    setColumnType(column, COLUMN_INPUT_TYPES.PRESETS);
  });

  typeGroup.appendChild(textButton);
  typeGroup.appendChild(linkButton);
  typeGroup.appendChild(presetsButton);
  panel.appendChild(typeGroup);

  const presetsSection = document.createElement("div");
  presetsSection.className = "column-presets";
  presetsSection.hidden = state.type !== COLUMN_INPUT_TYPES.PRESETS;

  const selectionToggle = document.createElement("div");
  selectionToggle.className = "selection-toggle";

  const selectionLabel = document.createElement("span");
  selectionLabel.className = "selection-toggle-label";
  selectionLabel.textContent = "Selection mode";

  const singleButton = document.createElement("button");
  singleButton.type = "button";
  singleButton.appendChild(createIconPlaceholder("circle-dot", 16));
  singleButton.appendChild(document.createTextNode("Single select"));
  if (state.selectionMode === SELECTION_MODES.SINGLE) {
    singleButton.classList.add("active");
  }
  singleButton.addEventListener("click", () => {
    setSelectionMode(column, SELECTION_MODES.SINGLE);
  });

  const multiButton = document.createElement("button");
  multiButton.type = "button";
  multiButton.appendChild(createIconPlaceholder("check-square", 16));
  multiButton.appendChild(document.createTextNode("Multi select"));
  if (state.selectionMode === SELECTION_MODES.MULTIPLE) {
    multiButton.classList.add("active");
  }
  multiButton.addEventListener("click", () => {
    setSelectionMode(column, SELECTION_MODES.MULTIPLE);
  });

  selectionToggle.appendChild(selectionLabel);
  selectionToggle.appendChild(singleButton);
  selectionToggle.appendChild(multiButton);
  presetsSection.appendChild(selectionToggle);

  const presetList = document.createElement("div");
  presetList.className = "preset-list";
  if (!Array.isArray(state.presets) || !state.presets.length) {
    state.presets = [createPresetOption("")];
  }
  state.presets.forEach((preset) => {
    presetList.appendChild(buildPresetRow(column, state, preset));
  });
  presetsSection.appendChild(presetList);

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "add-preset";
  addButton.appendChild(createIconPlaceholder("plus", 16));
  addButton.appendChild(document.createTextNode("Add option"));
  addButton.addEventListener("click", () => {
    addPresetOption(column);
  });
  presetsSection.appendChild(addButton);

  const multiHint = document.createElement("span");
  multiHint.className = "preset-hint";
  multiHint.textContent = "When multi select is enabled, selected values will be saved separated by ;";
  presetsSection.appendChild(multiHint);

  panel.appendChild(presetsSection);
  return panel;
}

function buildPresetRow(column, state, preset) {
  const row = document.createElement("div");
  row.className = "preset-row";
  row.dataset.presetId = preset.id;

  const main = document.createElement("div");
  main.className = "preset-main";

  const titleField = document.createElement("label");
  titleField.className = "preset-field";
  const titleLabel = document.createElement("span");
  titleLabel.textContent = "Button title";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.dataset.role = "title";
  titleInput.placeholder = "Shown to collectors";
  titleInput.value = preset.title ?? preset.value ?? "";
  titleInput.addEventListener("input", (event) => {
    preset.title = event.target.value;
    if (preset.linked) {
      preset.value = event.target.value;
      const valueInput = row.querySelector('input[data-role="value"]');
      if (valueInput && valueInput.value !== preset.value) {
        valueInput.value = preset.value;
      }
    }
  });
  titleField.appendChild(titleLabel);
  titleField.appendChild(titleInput);

  const linkButton = document.createElement("button");
  linkButton.type = "button";
  linkButton.className = "link-toggle";
  linkButton.setAttribute("aria-pressed", preset.linked ? "true" : "false");
  linkButton.title = preset.linked ? "Unlink title and value" : "Link title and value";
  linkButton.setAttribute("aria-label", preset.linked ? "Unlink title and value" : "Link title and value");
  linkButton.dataset.presetId = preset.id;
  linkButton.appendChild(createIconPlaceholder(preset.linked ? "link-2" : "link-2-off", 18));
  linkButton.addEventListener("click", () => {
    togglePresetLink(column, preset.id);
  });

  const defaultButton = document.createElement("button");
  defaultButton.type = "button";
  defaultButton.className = "preset-default";
  defaultButton.setAttribute("aria-pressed", preset.isDefault ? "true" : "false");
  defaultButton.title = preset.isDefault ? "Unset default option" : "Mark as default option";
  defaultButton.setAttribute("aria-label", preset.isDefault ? "Unset default option" : "Mark as default option");
  defaultButton.dataset.presetId = preset.id;
  defaultButton.appendChild(createIconPlaceholder(preset.isDefault ? "star" : "star-off", 18));
  defaultButton.addEventListener("click", () => {
    setPresetDefault(column, preset.id);
  });

  const valueField = document.createElement("label");
  valueField.className = "preset-field";
  const valueLabel = document.createElement("span");
  valueLabel.textContent = "Value";
  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.dataset.role = "value";
  valueInput.placeholder = preset.linked ? "Linked to title" : "Saved to CSV";
  valueInput.value = preset.value ?? preset.title ?? "";
  valueInput.disabled = Boolean(preset.linked);
  valueInput.addEventListener("input", (event) => {
    preset.value = event.target.value;
    if (preset.linked) {
      preset.title = event.target.value;
      if (titleInput.value !== preset.title) {
        titleInput.value = preset.title;
      }
    }
  });
  valueField.appendChild(valueLabel);
  valueField.appendChild(valueInput);

  main.appendChild(titleField);
  main.appendChild(linkButton);
  main.appendChild(defaultButton);
  main.appendChild(valueField);
  row.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "preset-actions";

  const hint = document.createElement("span");
  hint.className = "preset-hint";
  hint.textContent = preset.linked ? "Value matches the title." : "Value is saved exactly as typed.";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "preset-remove";
  removeButton.appendChild(createIconPlaceholder("trash-2", 16));
  removeButton.appendChild(document.createTextNode("Remove"));
  removeButton.disabled = state.presets.length <= 1;
  removeButton.addEventListener("click", () => {
    removePresetOption(column, preset.id);
  });

  actions.appendChild(hint);
  actions.appendChild(removeButton);
  row.appendChild(actions);

  void ensureLucideIcons(row);
  return row;
}

function rerenderColumnItem(column) {
  const element = columnElements.get(column);
  if (!element) {
    return;
  }
  const state = getColumnState(column);
  const previousPanel = element.querySelector(".column-config-panel");
  const scrollTop = previousPanel?.scrollTop ?? 0;
  const nextElement = buildColumnItem(column);
  columnElements.set(column, nextElement);
  element.replaceWith(nextElement);
  if (state.open) {
    const nextPanel = nextElement.querySelector(".column-config-panel");
    if (nextPanel) {
      nextPanel.scrollTop = scrollTop;
    }
  }
}

function setColumnType(column, type) {
  const state = getColumnState(column);
  if (state.type === type) {
    return;
  }
  state.type = type;
  if (type === COLUMN_INPUT_TYPES.PRESETS && (!Array.isArray(state.presets) || !state.presets.length)) {
    state.presets = [createPresetOption("")];
  }
  state.open = true;
  rerenderColumnItem(column);
}

function setSelectionMode(column, mode) {
  const state = getColumnState(column);
  if (state.selectionMode === mode) {
    return;
  }
  state.selectionMode = mode;
  state.open = true;
  rerenderColumnItem(column);
}

function addPresetOption(column) {
  const state = getColumnState(column);
  const newPreset = createPresetOption("");
  state.presets = [...state.presets, newPreset];
  state.pendingFocusPresetId = newPreset.id;
  state.open = true;
  rerenderColumnItem(column);
}

function removePresetOption(column, presetId) {
  const state = getColumnState(column);
  if (state.presets.length <= 1) {
    return;
  }
  state.presets = state.presets.filter((preset) => preset.id !== presetId);
  if (!state.presets.length) {
    state.presets = [createPresetOption("")];
  }
  state.open = true;
  rerenderColumnItem(column);
}

function togglePresetLink(column, presetId) {
  const state = getColumnState(column);
  const preset = state.presets.find((item) => item.id === presetId);
  if (!preset) {
    return;
  }
  preset.linked = !preset.linked;
  if (preset.linked) {
    const prioritized = preset.value || preset.title || "";
    preset.value = prioritized;
    preset.title = prioritized;
  } else if (!preset.value && preset.title) {
    preset.value = preset.title;
  }
  state.open = true;
  rerenderColumnItem(column);
}

function setPresetDefault(column, presetId) {
  const state = getColumnState(column);
  let target = null;
  state.presets.forEach((preset) => {
    if (preset.id === presetId) {
      target = preset;
    }
  });
  if (!target) {
    return;
  }
  const shouldEnable = !target.isDefault;
  state.presets.forEach((preset) => {
    preset.isDefault = shouldEnable && preset.id === presetId;
  });
  state.open = true;
  rerenderColumnItem(column);
}

function renderPreview(headers, rows) {
  previewContainer.hidden = false;
  previewTable.innerHTML = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((header) => {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  previewTable.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.slice(0, 5).forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  previewTable.appendChild(tbody);
}

function buildSessionSummary(state) {
  if (!state) {
    return "No configured session yet.";
  }
  const current = state.row?.indexValue ?? "Unknown";
  const total = state.totalRows ?? 0;
  const progress = total ? `${state.currentRowIndex + 1} / ${total}` : "0 / 0";
  if (state.active) {
    return `Collecting data for ${current} (${progress}).`;
  }
  return `Ready to resume at ${current} (${progress}).`;
}

async function loadExistingSession() {
  const response = await extensionApi.runtime.sendMessage({ type: "getSessionSummary" });
  if (response?.ok && response.state) {
    sessionCard.hidden = false;
    sessionSummary.textContent = buildSessionSummary(response.state);
    resumeButton.disabled = false;
    exportButton.disabled = false;
    resetButton.disabled = false;
  } else {
    sessionCard.hidden = true;
    resumeButton.disabled = true;
    exportButton.disabled = true;
    resetButton.disabled = true;
  }
}

function formatSavedDetail(item) {
  const parts = [];
  if (item.savedAt) {
    const date = new Date(item.savedAt);
    parts.push(Number.isNaN(date.getTime()) ? item.savedAt : date.toLocaleString());
  }
  const downloadPath = item.downloadInfo?.filename ?? item.downloadInfo?.url;
  if (downloadPath) {
    parts.push(downloadPath);
  }
  return parts.join(" · ") || "Saved snapshot";
}

function renderSavedIterations(items) {
  if (!historyCard || !historyList || !historyEmpty) {
    return;
  }
  historyList.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    historyCard.hidden = false;
    historyList.hidden = true;
    historyEmpty.hidden = false;
    return;
  }
  historyCard.hidden = false;
  historyList.hidden = false;
  historyEmpty.hidden = true;
  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = item.fileName || "Saved CSV";
    const detail = document.createElement("span");
    detail.textContent = formatSavedDetail(item);

    meta.appendChild(title);
    meta.appendChild(detail);

    const resumeButtonEl = document.createElement("button");
    resumeButtonEl.type = "button";
    resumeButtonEl.dataset.id = item.id;
    resumeButtonEl.textContent = "Resume";

    li.appendChild(meta);
    li.appendChild(resumeButtonEl);
    historyList.appendChild(li);
  });
}

async function refreshSavedIterations() {
  try {
    const response = await extensionApi.runtime.sendMessage({ type: "listSavedIterations" });
    if (response?.ok) {
      renderSavedIterations(response.items ?? []);
    }
  } catch (error) {
    console.warn("Unable to load saved iterations", error);
  }
}

function handleSaveToNewToggle() {
  if (!saveToNewCheckbox.checked) {
    outputNameWrapper.hidden = false;
    return;
  }
  outputNameWrapper.hidden = true;
  outputNameInput.value = "";
}

saveToNewCheckbox.addEventListener("change", handleSaveToNewToggle);

async function handleFileSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  fileNameLabel.textContent = file.name;
  fileNameLabel.hidden = false;

  const text = await file.text();
  parsedCsv = parseCsv(text);
  const { headers, rows } = parsedCsv;

  if (!headers?.length || !rows?.length) {
    configError.hidden = false;
    configError.textContent = "CSV must include headers and at least one row.";
    return;
  }

  csvState = {
    fileName: file.name,
    headers,
    rows: buildRowObjects(headers, rows)
  };

  renderPreview(headers, rows);

  const headerOptions = headers.map((header) => ({ value: header }));
  populateSelect(indexColumnSelect, headerOptions, { placeholder: "Choose column" });
  populateSelect(urlColumnSelect, headerOptions, { placeholder: "Choose column" });
  populateSelect(startRowSelect, csvState.rows.map((row) => ({
    value: String(row.index),
    label: `${row.index + 1} – ${row.data[headers[0]] ?? "Row"}`
  })), { placeholder: "Start from first row" });
  renderInputColumnsList(headers);

  if (columnsCard) {
    columnsCard.hidden = false;
  }
  configCard.hidden = false;
}

uploadInput.addEventListener("change", handleFileSelection);

configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  configError.hidden = true;
  if (!csvState) {
    configError.hidden = false;
    configError.textContent = "Import a CSV first.";
    return;
  }

  const indexColumn = indexColumnSelect.value;
  const urlColumn = urlColumnSelect.value;
  const selectedColumns = headerOrder.filter((column) => getColumnState(column)?.selected);
  const inputColumnSettings = {};
  selectedColumns.forEach((column) => {
    const state = getColumnState(column);
    if (state.type === COLUMN_INPUT_TYPES.PRESETS) {
      const selectionMode = state.selectionMode ?? SELECTION_MODES.SINGLE;
      const presets = (state.presets ?? []).map((preset) => {
        const rawTitle = (preset.title ?? "").trim();
        const rawValue = (preset.value ?? "").trim();
        const value = rawValue || rawTitle;
        const title = preset.linked ? value : rawTitle;
        return {
          title,
          value,
          linked: Boolean(preset.linked),
          isDefault: Boolean(preset.isDefault)
        };
      });
      inputColumnSettings[column] = {
        type: COLUMN_INPUT_TYPES.PRESETS,
        selectionMode,
        presets
      };
    } else if (state.type === COLUMN_INPUT_TYPES.LINK_HREF) {
      inputColumnSettings[column] = {
        type: COLUMN_INPUT_TYPES.LINK_HREF
      };
    } else {
      inputColumnSettings[column] = {
        type: COLUMN_INPUT_TYPES.TEXTAREA
      };
    }
  });
  const startRowIndex = Number(startRowSelect.value || "0");
  const skipFilled = skipFilledCheckbox.checked;
  const saveToNewFile = saveToNewCheckbox.checked;
  const outputFileName = outputNameInput.value.trim();

  if (!indexColumn || !urlColumn) {
    configError.hidden = false;
    configError.textContent = "Pick index and URL columns.";
    return;
  }
  if (!selectedColumns.length) {
    configError.hidden = false;
    configError.textContent = "Choose at least one input column.";
    return;
  }

  startButton.disabled = true;

  const payload = {
    headers: csvState.headers,
    rows: csvState.rows,
    indexColumn,
    urlColumn,
    inputColumns: selectedColumns,
    inputColumnSettings,
    skipFilled,
    saveToNewFile,
    startRowIndex,
    sourceFileName: csvState.fileName,
    outputFileName: saveToNewFile ? "" : outputFileName
  };

  try {
    const response = await extensionApi.runtime.sendMessage({
      type: "saveSessionConfig",
      payload
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Unable to start session");
    }

    configForm.reset();
    if (columnsCard) {
      columnsCard.hidden = true;
    }
    configCard.hidden = true;
    sessionCard.hidden = false;
    sessionSummary.textContent = "Collection tab opened in a new window.";
  } catch (error) {
    configError.hidden = false;
    configError.textContent = error.message;
  } finally {
    startButton.disabled = false;
  }
});

resumeButton.addEventListener("click", async () => {
  const response = await extensionApi.runtime.sendMessage({ type: "openCurrentRow" });
  if (!response?.ok) {
    alert(response?.error ?? "Unable to open current collection tab.");
  }
});

exportButton.addEventListener("click", async () => {
  const response = await extensionApi.runtime.sendMessage({ type: "exportCsv" });
  if (!response?.ok) {
    alert(response?.error ?? "Failed to trigger CSV download.");
  }
});

resetButton.addEventListener("click", async () => {
  if (!confirm("Reset the current session?")) {
    return;
  }
  const response = await extensionApi.runtime.sendMessage({ type: "resetSession" });
  if (response?.ok) {
    resetUi();
    refreshSavedIterations();
  }
});

historyList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button) {
    return;
  }
  const { id } = button.dataset;
  button.disabled = true;
  try {
    const response = await extensionApi.runtime.sendMessage({
      type: "loadSavedIteration",
      payload: { id }
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Unable to resume saved session.");
    }
    sessionSummary.textContent = "Collection tab opened in a new window.";
    sessionCard.hidden = false;
    resumeButton.disabled = false;
    exportButton.disabled = false;
    resetButton.disabled = false;
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    Promise.all([loadExistingSession(), refreshSavedIterations()]).catch(() => {});
  }
});

if (extensionApi?.storage?.onChanged) {
  extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "mwSavedIterations")) {
      refreshSavedIterations();
    }
    if (Object.prototype.hasOwnProperty.call(changes, "mwSession")) {
      loadExistingSession().catch(() => {});
    }
  });
}

resetUi();
Promise.all([loadExistingSession(), refreshSavedIterations()]).catch(() => {});
