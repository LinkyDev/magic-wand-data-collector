export function parseCsv(text) {
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentValue += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if ((char === "," || char === "\n" || char === "\r") && !inQuotes) {
      if (char === ",") {
        currentRow.push(currentValue);
        currentValue = "";
        continue;
      }

      // Handle newline
      currentRow.push(currentValue);
      currentValue = "";
      rows.push(currentRow);
      currentRow = [];

      if (char === "\r" && next === "\n") {
        i += 1;
      }
      continue;
    }

    currentValue += char;
  }

  // Flush trailing cell
  if (currentValue !== "" || inQuotes || currentRow.length) {
    currentRow.push(currentValue);
  }
  if (currentRow.length) {
    rows.push(currentRow);
  }

  if (!rows.length) {
    return { headers: [], rows: [] };
  }

  const [headerRow, ...dataRows] = rows;
  return {
    headers: headerRow.map((cell) => cell.trim()),
    rows: dataRows
  };
}

export function buildRowObjects(headers, rows) {
  return rows.map((cells, index) => {
    const data = {};
    headers.forEach((header, columnIndex) => {
      data[header] = cells[columnIndex] ?? "";
    });
    return { index, data };
  });
}
