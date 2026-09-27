export function parseCsv(text) {
  const rows = [];
  let fields = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        value += character;
      } else if (text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      fields.push(value);
      value = "";
    } else if (character === "\n") {
      fields.push(value);
      rows.push(fields);
      fields = [];
      value = "";
    } else if (character !== "\r") {
      value += character;
    }
  }
  if (value || fields.length) {
    fields.push(value);
    rows.push(fields);
  }
  return rows;
}

function normalizeHeader(header) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function csvToRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((header) => header.trim());
  const lookup = new Map();
  headers.forEach((header, column) => {
    const key = normalizeHeader(header);
    if (key && !lookup.has(key)) lookup.set(key, column);
  });

  const records = rows.slice(1).map((row, offset) => ({
    line: offset + 2,
    values: row,
    get(...candidates) {
      for (const candidate of candidates) {
        const column = lookup.get(normalizeHeader(candidate));
        if (column !== undefined) return (row[column] || "").trim();
      }
      return "";
    },
  }));
  return { headers, records };
}
