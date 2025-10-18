const SESSION_KEY = "mwSession";
const SAVED_ITERATIONS_KEY = "mwSavedIterations";
const DEBUG_FLAGS_KEY = "mwDebugFlags";
let sessionCache = null;

const DEFAULT_DEBUG_FLAGS = {
  autoCollect: false
};

const MESSAGE_TYPES = {
  LAUNCH_SETUP: "launchSetup",
  GET_SESSION_SUMMARY: "getSessionSummary",
  SAVE_SESSION_CONFIG: "saveSessionConfig",
  GET_CONTENT_STATE: "getContentState",
  SAVE_CAPTURED_DATA: "saveCapturedData",
  SET_AUTO_NAVIGATE: "setAutoNavigate",
  NAVIGATE_MANUAL: "navigateManual",
  UPDATE_INPUT_VALUE: "updateInputValue",
  UPDATE_COLUMN_TRANSFORM: "updateColumnTransform",
  FOCUS_INPUT_COLUMN: "focusInputColumn",
  OPEN_CURRENT_ROW: "openCurrentRow",
  SAVE_AND_EXIT: "saveAndExit",
  LIST_SAVED_ITERATIONS: "listSavedIterations",
  LOAD_SAVED_ITERATION: "loadSavedIteration",
  GET_DEBUG_FLAGS: "getDebugFlags",
  EXPORT_CSV: "exportCsv",
  RESET_SESSION: "resetSession"
};

function sanitizeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return String(value).trim();
}

function getCellValue(row, column) {
  return row.data[column] ?? "";
}

function rowHasMissingInputs(row, config) {
  return config.inputColumns.some((column) => sanitizeValue(getCellValue(row, column)) === "");
}

function pickFirstMissingColumnIndex(row, config) {
  for (let i = 0; i < config.inputColumns.length; i += 1) {
    const column = config.inputColumns[i];
    if (sanitizeValue(getCellValue(row, column)) === "") {
      return i;
    }
  }
  return 0;
}

function ensureColumnTransforms(config) {
  if (!config.columnTransforms || typeof config.columnTransforms !== "object") {
    config.columnTransforms = {};
  }
  return config.columnTransforms;
}

async function loadSession() {
  if (sessionCache) {
    return sessionCache;
  }
  const stored = await browser.storage.local.get(SESSION_KEY);
  sessionCache = stored[SESSION_KEY] ?? null;
  return sessionCache;
}

async function persistSession(session) {
  sessionCache = session;
  if (session) {
    await browser.storage.local.set({ [SESSION_KEY]: session });
  } else {
    await browser.storage.local.remove(SESSION_KEY);
  }
}

async function loadSavedIterations() {
  const stored = await browser.storage.local.get(SAVED_ITERATIONS_KEY);
  const iterations = stored[SAVED_ITERATIONS_KEY];
  if (!Array.isArray(iterations)) {
    return [];
  }
  return iterations;
}

async function persistSavedIterations(iterations) {
  await browser.storage.local.set({ [SAVED_ITERATIONS_KEY]: iterations });
}

async function loadDebugFlags() {
  try {
    const stored = await browser.storage.local.get(DEBUG_FLAGS_KEY);
    const flags = stored?.[DEBUG_FLAGS_KEY];
    if (flags && typeof flags === "object") {
      return { ...DEFAULT_DEBUG_FLAGS, ...flags };
    }
  } catch (error) {
    // Ignore storage issues and fall back to defaults.
  }
  return { ...DEFAULT_DEBUG_FLAGS };
}

function ensureSession(session) {
  if (!session) {
    throw new Error("No active session");
  }
  return session;
}

function findNextRowIndex(session, startIndex, direction, includeStart) {
  const { rows, config } = session;
  const { skipFilled, urlColumn } = config;
  const length = rows.length;
  let index = includeStart ? startIndex : startIndex + direction;
  while (index >= 0 && index < length) {
    const candidate = rows[index];
    const url = sanitizeValue(getCellValue(candidate, urlColumn));
    if (url) {
      if (!skipFilled || rowHasMissingInputs(candidate, config)) {
        return index;
      }
    }
    index += direction;
  }
  return null;
}

function buildContentState(session) {
  if (!session) {
    return { active: false };
  }
  const { headers, rows, config, progress } = session;
  ensureColumnTransforms(config);
  const { currentRowIndex, currentInputIndex, autoNavigate, completed } = progress;
  const row = rows[currentRowIndex] ?? null;
  const currentColumn = row ? config.inputColumns[currentInputIndex] ?? null : null;
  const rowPayload = row
    ? {
        indexValue: sanitizeValue(getCellValue(row, config.indexColumn)),
        url: sanitizeValue(getCellValue(row, config.urlColumn)),
        inputs: config.inputColumns.map((column) => ({
          column,
          value: getCellValue(row, column)
        }))
      }
    : null;

  return {
    active: progress.active ?? false,
    autoNavigate,
    completed: completed ?? false,
    headers,
    config,
    currentRowIndex,
    currentInputIndex,
    currentColumn,
    totalRows: rows.length,
    row: rowPayload
  };
}

function buildCsv(headers, rows) {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const dataLines = rows.map((row) => {
    const cells = headers.map((header) => escapeCsvCell(getCellValue(row, header)));
    return cells.join(",");
  });
  return [headerLine, ...dataLines].join("\r\n");
}

function ensureCsvExtension(name) {
  if (!name) {
    return "collected-data.csv";
  }
  return name.toLowerCase().endsWith(".csv") ? name : `${name}.csv`;
}

function resolveOutputFileName(config) {
  const baseName = config.sourceFileName?.replace(/\.csv$/i, "") || "collected-data";
  const custom = config.outputFileName?.trim();
  if (custom) {
    return ensureCsvExtension(custom);
  }
  if (config.saveToNewFile) {
    return `${baseName}_collected.csv`;
  }
  return ensureCsvExtension(config.sourceFileName ?? `${baseName}.csv`);
}

async function triggerCsvDownload(session) {
  const csv = buildCsv(session.headers, session.rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const fileName = resolveOutputFileName(session.config);
  try {
    const downloadId = await browser.downloads.download({ url, filename: fileName, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { downloadId, fileName };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function lookupDownload(downloadId) {
  if (typeof downloadId !== "number") {
    return null;
  }
  try {
    const results = await browser.downloads.search({ id: downloadId });
    if (Array.isArray(results) && results.length > 0) {
      const item = results[0];
      return {
        id: downloadId,
        url: item.url,
        filename: item.filename,
        mime: item.mime
      };
    }
  } catch (error) {
    // Ignore lookup failures (some browsers may restrict this).
  }
  return { id: downloadId };
}

function makeRandomId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `mw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function recordSavedIteration(session, fileName, downloadInfo) {
  const iterations = await loadSavedIterations();
  const snapshot = JSON.parse(JSON.stringify(session));
  if (snapshot?.progress) {
    snapshot.progress.active = false;
    snapshot.progress.sessionTabId = null;
  }
  if (snapshot?.config) {
    snapshot.config.outputFileName = fileName;
  }
  const entry = {
    id: makeRandomId(),
    savedAt: new Date().toISOString(),
    fileName,
    downloadInfo: downloadInfo ?? null,
    session: snapshot
  };
  iterations.unshift(entry);
  await persistSavedIterations(iterations);
  return entry;
}

function escapeCsvCell(value) {
  const stringValue = value === undefined || value === null ? "" : String(value);
  const needsQuotes = /[",\n\r]/.test(stringValue);
  let escaped = stringValue.replace(/"/g, '""');
  if (needsQuotes) {
    escaped = `"${escaped}"`;
  }
  return escaped;
}

async function openSetupTab() {
  const url = browser.runtime.getURL("setup/setup.html");
  await browser.tabs.create({ url, active: true });
  return { ok: true };
}

async function ensureSessionTabInjection(tabId) {
  try {
    await browser.tabs.insertCSS(tabId, {
      file: "content/contentStyles.css"
    });
  } catch (error) {
    // Ignore injection race conditions.
  }
  try {
    await browser.tabs.executeScript(tabId, {
      file: "content/contentScript.js"
    });
  } catch (error) {
    // Ignore if already injected.
  }
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  const session = await loadSession();
  if (!session?.progress?.sessionTabId || tabId !== session.progress.sessionTabId) {
    return;
  }
  await ensureSessionTabInjection(tabId);
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  const session = await loadSession();
  if (!session) {
    return;
  }
  if (session.progress.sessionTabId === tabId) {
    session.progress.sessionTabId = null;
    session.progress.active = false;
    await persistSession(session);
  }
});

async function launchCollection(session, targetRowIndex) {
  const url = sanitizeValue(getCellValue(session.rows[targetRowIndex], session.config.urlColumn));
  if (!url) {
    throw new Error("Selected row does not have a URL");
  }
  let tab;
  if (session.progress.sessionTabId) {
    tab = await browser.tabs.update(session.progress.sessionTabId, { url, active: true });
  } else {
    tab = await browser.tabs.create({ url, active: true });
  }
  session.progress.sessionTabId = tab.id;
  session.progress.active = true;
  await persistSession(session);
  return tab.id;
}

browser.runtime.onMessage.addListener((message, sender) => {
  const { type, payload } = message;
  switch (type) {
    case MESSAGE_TYPES.LAUNCH_SETUP:
      return openSetupTab();
    case MESSAGE_TYPES.GET_SESSION_SUMMARY:
      return (async () => {
        const session = await loadSession();
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.SAVE_SESSION_CONFIG:
      return (async () => {
        const {
          headers,
          rows,
          indexColumn,
          urlColumn,
          inputColumns,
          skipFilled,
          saveToNewFile,
          startRowIndex,
          sourceFileName,
          outputFileName
        } = payload;

        if (!headers?.length || !rows?.length) {
          return { ok: false, error: "CSV appears to be empty." };
        }
        if (!inputColumns?.length) {
          return { ok: false, error: "Select at least one input column." };
        }

        const session = {
          headers,
          rows,
          config: {
            indexColumn,
            urlColumn,
            inputColumns,
            skipFilled,
            saveToNewFile,
            sourceFileName,
            outputFileName,
            startRowIndex,
            columnTransforms: {}
          },
          progress: {
            currentRowIndex: startRowIndex ?? 0,
            currentInputIndex: 0,
            autoNavigate: true,
            active: false,
            sessionTabId: null,
            completed: false
          }
        };

        const firstRowIndex = findNextRowIndex(session, session.progress.currentRowIndex, 1, true);
        if (firstRowIndex === null) {
          return { ok: false, error: "No rows meet the criteria to collect." };
        }
        session.progress.currentRowIndex = firstRowIndex;
        session.progress.currentInputIndex = pickFirstMissingColumnIndex(
          session.rows[firstRowIndex],
          session.config
        );

        await launchCollection(session, firstRowIndex);

        return { ok: true };
      })();
    case MESSAGE_TYPES.GET_CONTENT_STATE:
      return (async () => {
        const session = await loadSession();
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.SAVE_CAPTURED_DATA:
      return (async () => {
        const session = ensureSession(await loadSession());
        const { value, column: columnOverride } = payload;
        const { currentRowIndex } = session.progress;
        const inputs = session.config.inputColumns;
        if (!inputs?.length) {
          return { ok: false, error: "No input columns configured." };
        }
        let targetIndex = session.progress.currentInputIndex;
        if (columnOverride) {
          const overrideIndex = inputs.indexOf(columnOverride);
          if (overrideIndex === -1) {
            return { ok: false, error: "Unknown column." };
          }
          targetIndex = overrideIndex;
        }
        const column = inputs[targetIndex];
        if (!column) {
          return { ok: false, error: "Unable to resolve column." };
        }
        session.rows[currentRowIndex].data[column] = value;

        let rowComplete = !rowHasMissingInputs(session.rows[currentRowIndex], session.config);
        let navigation = null;

        session.progress.currentInputIndex = targetIndex;

        if (!rowComplete) {
          let nextIndex = -1;
          for (let i = targetIndex + 1; i < inputs.length; i += 1) {
            const nextColumn = inputs[i];
            if (sanitizeValue(getCellValue(session.rows[currentRowIndex], nextColumn)) === "") {
              nextIndex = i;
              break;
            }
          }
          if (nextIndex === -1) {
            nextIndex = pickFirstMissingColumnIndex(session.rows[currentRowIndex], session.config);
          }
          session.progress.currentInputIndex = nextIndex;
        } else if (session.progress.autoNavigate) {
          const nextRowIndex = findNextRowIndex(session, currentRowIndex, 1, false);
          if (nextRowIndex !== null) {
            session.progress.currentRowIndex = nextRowIndex;
            session.progress.currentInputIndex = pickFirstMissingColumnIndex(
              session.rows[nextRowIndex],
              session.config
            );
            const nextUrl = sanitizeValue(
              getCellValue(session.rows[nextRowIndex], session.config.urlColumn)
            );
            if (nextUrl) {
              navigation = { action: "navigate", url: nextUrl };
              if (session.progress.sessionTabId) {
                await browser.tabs.update(session.progress.sessionTabId, {
                  url: nextUrl,
                  active: true
                });
              }
            }
          } else {
            session.progress.completed = true;
            navigation = { action: "complete" };
          }
        } else {
          navigation = { action: "row-complete" };
        }

        await persistSession(session);
        return { ok: true, state: buildContentState(session), navigation };
      })();
    case MESSAGE_TYPES.SET_AUTO_NAVIGATE:
      return (async () => {
        const session = ensureSession(await loadSession());
        session.progress.autoNavigate = Boolean(payload.enabled);
        await persistSession(session);
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.NAVIGATE_MANUAL:
      return (async () => {
        const session = ensureSession(await loadSession());
        const direction = payload?.direction === "back" ? -1 : 1;
        const nextRowIndex = findNextRowIndex(session, session.progress.currentRowIndex, direction, false);
        if (nextRowIndex === null) {
          return { ok: false, error: "No more rows in that direction." };
        }
        session.progress.currentRowIndex = nextRowIndex;
        session.progress.currentInputIndex = pickFirstMissingColumnIndex(
          session.rows[nextRowIndex],
          session.config
        );
        const nextUrl = sanitizeValue(getCellValue(session.rows[nextRowIndex], session.config.urlColumn));
        if (nextUrl) {
          if (session.progress.sessionTabId) {
            await browser.tabs.update(session.progress.sessionTabId, { url: nextUrl, active: true });
          } else {
            await browser.tabs.create({ url: nextUrl, active: true });
          }
        }
        await persistSession(session);
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.OPEN_CURRENT_ROW:
      return (async () => {
        const session = ensureSession(await loadSession());
        await launchCollection(session, session.progress.currentRowIndex);
        return { ok: true };
      })();
    case MESSAGE_TYPES.UPDATE_INPUT_VALUE:
      return (async () => {
        const session = ensureSession(await loadSession());
        const { rowIndex, column, value } = payload;
        if (rowIndex < 0 || rowIndex >= session.rows.length) {
          return { ok: false, error: "Row index out of range." };
        }
        if (!session.headers.includes(column)) {
          return { ok: false, error: "Unknown column." };
        }
        session.rows[rowIndex].data[column] = value;
        if (rowIndex === session.progress.currentRowIndex) {
          if (sanitizeValue(value) === "") {
            const targetIndex = session.config.inputColumns.indexOf(column);
            if (targetIndex >= 0) {
              session.progress.currentInputIndex = targetIndex;
            }
          }
        }
        await persistSession(session);
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.UPDATE_COLUMN_TRANSFORM:
      return (async () => {
        const session = ensureSession(await loadSession());
        const column = payload?.column;
        if (!column) {
          return { ok: false, error: "Missing column." };
        }
        if (!session.headers.includes(column)) {
          return { ok: false, error: "Unknown column." };
        }
        const transforms = ensureColumnTransforms(session.config);
        const rawTransform = payload?.transform;
        let cleaned = null;
        if (rawTransform && typeof rawTransform === "object") {
          const next = {};
          if (typeof rawTransform.regexPattern === "string") {
            const pattern = rawTransform.regexPattern.trim();
            if (pattern) {
              next.regexPattern = pattern;
              if (typeof rawTransform.regexFlags === "string") {
                const flags = rawTransform.regexFlags.replace(/[^dgimsuy]/gi, "").toLowerCase();
                if (flags) {
                  next.regexFlags = flags;
                }
              }
            }
          }
          const commaSource = rawTransform.commaLimit;
          let commaLimit = null;
          if (Number.isInteger(commaSource) && commaSource > 0) {
            commaLimit = commaSource;
          } else if (typeof commaSource === "string") {
            const parsed = Number.parseInt(commaSource, 10);
            if (Number.isInteger(parsed) && parsed > 0) {
              commaLimit = parsed;
            }
          }
          if (commaLimit !== null) {
            next.commaLimit = commaLimit;
          }
          if (Object.keys(next).length) {
            cleaned = next;
          }
        }
        if (cleaned) {
          transforms[column] = cleaned;
        } else {
          delete transforms[column];
        }
        await persistSession(session);
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.FOCUS_INPUT_COLUMN:
      return (async () => {
        const session = ensureSession(await loadSession());
        const column = payload?.column;
        if (!column) {
          return { ok: false, error: "Missing column." };
        }
        const inputs = session.config.inputColumns ?? [];
        const index = inputs.indexOf(column);
        if (index === -1) {
          return { ok: false, error: "Unknown column." };
        }
        session.progress.currentInputIndex = index;
        await persistSession(session);
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.FOCUS_INPUT_COLUMN:
      return (async () => {
        const session = ensureSession(await loadSession());
        const column = payload?.column;
        if (!column) {
          return { ok: false, error: "Missing column." };
        }
        const inputs = session.config?.inputColumns ?? [];
        const targetIndex = inputs.indexOf(column);
        if (targetIndex === -1) {
          return { ok: false, error: "Unknown column." };
        }
        const rowIndex = typeof payload?.rowIndex === "number" ? payload.rowIndex : null;
        if (rowIndex !== null && rowIndex >= 0 && rowIndex < session.rows.length) {
          session.progress.currentRowIndex = rowIndex;
        }
        session.progress.currentInputIndex = targetIndex;
        await persistSession(session);
        return { ok: true, state: buildContentState(session) };
      })();
    case MESSAGE_TYPES.SAVE_AND_EXIT:
      return (async () => {
        try {
          const session = ensureSession(await loadSession());
          const { downloadId, fileName } = await triggerCsvDownload(session);
          const downloadInfo = await lookupDownload(downloadId);
          if (session.progress.sessionTabId) {
            try {
              await browser.tabs.remove(session.progress.sessionTabId);
            } catch (error) {
              // Ignore tab close failures (tab may already be gone).
            }
          }
          session.progress.sessionTabId = null;
          session.progress.active = false;
          await persistSession(session);
          await recordSavedIteration(session, fileName, downloadInfo);
          return { ok: true, state: buildContentState(session) };
        } catch (error) {
          return { ok: false, error: error?.message ?? "Unable to save and exit." };
        }
      })();
    case MESSAGE_TYPES.EXPORT_CSV:
      return (async () => {
        try {
          const session = ensureSession(await loadSession());
          await triggerCsvDownload(session);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error?.message ?? "Failed to export CSV." };
        }
      })();
    case MESSAGE_TYPES.LIST_SAVED_ITERATIONS:
      return (async () => {
        const iterations = await loadSavedIterations();
        return {
          ok: true,
          items: iterations.map((entry) => ({
            id: entry.id,
            savedAt: entry.savedAt,
            fileName: entry.fileName,
            downloadInfo: entry.downloadInfo ?? null
          }))
        };
      })();
    case MESSAGE_TYPES.LOAD_SAVED_ITERATION:
      return (async () => {
        const { id } = payload ?? {};
        if (!id) {
          return { ok: false, error: "Missing saved iteration id." };
        }
        const iterations = await loadSavedIterations();
        const entry = iterations.find((item) => item.id === id);
        if (!entry) {
          return { ok: false, error: "Saved iteration not found." };
        }
        const session = entry.session;
        if (!session) {
          return { ok: false, error: "Saved iteration is empty." };
        }
        session.config = session.config ?? {};
        ensureColumnTransforms(session.config);
        session.config.saveToNewFile = false;
        if (entry.fileName) {
          session.config.outputFileName = entry.fileName;
        }
        session.progress = {
          currentRowIndex: session.progress?.currentRowIndex ?? 0,
          currentInputIndex: session.progress?.currentInputIndex ?? 0,
          autoNavigate: session.progress?.autoNavigate ?? true,
          active: false,
          sessionTabId: null,
          completed: session.progress?.completed ?? false
        };
        await persistSession(session);
        const resumeRowIndex = findNextRowIndex(session, session.progress.currentRowIndex, 1, true);
        if (resumeRowIndex === null) {
          return { ok: false, error: "No rows available to resume." };
        }
        session.progress.currentRowIndex = resumeRowIndex;
        if (
          session.progress.currentInputIndex < 0 ||
          session.progress.currentInputIndex >= session.config.inputColumns.length
        ) {
          session.progress.currentInputIndex = pickFirstMissingColumnIndex(
            session.rows[resumeRowIndex],
            session.config
          );
        }
        session.progress.sessionTabId = null;
        session.progress.active = false;
        await persistSession(session);
        await launchCollection(session, resumeRowIndex);
        return { ok: true };
      })();
    case MESSAGE_TYPES.GET_DEBUG_FLAGS:
      return (async () => {
        const flags = await loadDebugFlags();
        return { ok: true, flags };
      })();
    case MESSAGE_TYPES.RESET_SESSION:
      return (async () => {
        await persistSession(null);
        return { ok: true };
      })();
    default:
      return false;
  }
});
