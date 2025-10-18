import { parseCsv, buildRowObjects } from "../common/csv.js";

const extensionApi = typeof browser !== "undefined" ? browser : chrome;

const uploadInput = document.getElementById("csv-file");
const fileNameLabel = document.getElementById("file-name");
const previewContainer = document.getElementById("preview");
const previewTable = document.getElementById("preview-table");
const configCard = document.getElementById("config-card");
const sessionCard = document.getElementById("session-card");
const configForm = document.getElementById("config-form");
const indexColumnSelect = document.getElementById("index-column");
const urlColumnSelect = document.getElementById("url-column");
const startRowSelect = document.getElementById("start-row");
const inputColumnsSelect = document.getElementById("input-columns");
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

function resetUi() {
  csvState = null;
  parsedCsv = null;
  previewContainer.hidden = true;
  configCard.hidden = true;
  sessionCard.hidden = true;
  fileNameLabel.hidden = true;
  configError.hidden = true;
  configForm.reset();
  indexColumnSelect.innerHTML = "";
  urlColumnSelect.innerHTML = "";
  startRowSelect.innerHTML = "";
  inputColumnsSelect.innerHTML = "";
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
  populateSelect(inputColumnsSelect, headerOptions, { multiple: true });

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
  const inputColumns = Array.from(inputColumnsSelect.selectedOptions).map((option) => option.value);
  const startRowIndex = Number(startRowSelect.value || "0");
  const skipFilled = skipFilledCheckbox.checked;
  const saveToNewFile = saveToNewCheckbox.checked;
  const outputFileName = outputNameInput.value.trim();

  if (!indexColumn || !urlColumn) {
    configError.hidden = false;
    configError.textContent = "Pick index and URL columns.";
    return;
  }
  if (!inputColumns.length) {
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
    inputColumns,
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
