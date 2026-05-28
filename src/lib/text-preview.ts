export type DiffRowKind = "context" | "add" | "remove";

export interface DiffRow {
  kind: DiffRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffPreview {
  path: string;
  fileName: string;
  added: number;
  removed: number;
  rows: DiffRow[];
}

const MAX_ROWS = 240;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

export function getToolPath(input: Record<string, unknown>): string {
  const direct = asString(input.file_path) ?? asString(input.path) ?? asString(input.filename);
  if (direct) return direct;

  const patch = asString(input.patch) ?? asString(input.command);
  if (!patch) return "";

  const match = patch.match(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function pushLimited(rows: DiffRow[], row: DiffRow) {
  if (rows.length < MAX_ROWS) rows.push(row);
}

function addPairRows(
  rows: DiffRow[],
  oldText: string,
  newText: string,
  oldStart: number,
  newStart: number,
) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix + prefix < oldLines.length &&
    suffix + prefix < newLines.length &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = Math.max(0, prefix - 2);
  for (let i = contextBefore; i < prefix; i++) {
    pushLimited(rows, {
      kind: "context",
      oldLine: oldStart + i,
      newLine: newStart + i,
      text: oldLines[i] ?? "",
    });
  }

  for (let i = prefix; i < oldLines.length - suffix; i++) {
    pushLimited(rows, {
      kind: "remove",
      oldLine: oldStart + i,
      newLine: null,
      text: oldLines[i] ?? "",
    });
  }

  for (let i = prefix; i < newLines.length - suffix; i++) {
    pushLimited(rows, {
      kind: "add",
      oldLine: null,
      newLine: newStart + i,
      text: newLines[i] ?? "",
    });
  }

  for (let i = Math.max(prefix, oldLines.length - suffix); i < oldLines.length; i++) {
    const newIndex = newLines.length - oldLines.length + i;
    pushLimited(rows, {
      kind: "context",
      oldLine: oldStart + i,
      newLine: newStart + newIndex,
      text: oldLines[i] ?? "",
    });
  }
}

function buildPatchDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of splitLines(patch)) {
    if (line.startsWith("@@")) {
      const match = line.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("*** ")) {
      continue;
    }
    if (line.startsWith("+")) {
      pushLimited(rows, { kind: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      pushLimited(rows, { kind: "remove", oldLine: oldLine++, newLine: null, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      pushLimited(rows, {
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: line.slice(1),
      });
    }
  }

  return rows;
}

function rowsFromPairs(input: Record<string, unknown>): DiffRow[] {
  const rows: DiffRow[] = [];
  const edits = Array.isArray(input.edits) ? input.edits : null;
  if (edits) {
    edits.forEach((edit, index) => {
      if (typeof edit !== "object" || edit === null) return;
      const record = edit as Record<string, unknown>;
      const oldText = asString(record.old_string) ?? asString(record.oldText) ?? asString(record.old);
      const newText = asString(record.new_string) ?? asString(record.newText) ?? asString(record.new);
      if (oldText === null || newText === null) return;
      addPairRows(rows, oldText, newText, index + 1, index + 1);
    });
    return rows;
  }

  const oldText = asString(input.old_string) ?? asString(input.oldText) ?? asString(input.old);
  const newText = asString(input.new_string) ?? asString(input.newText) ?? asString(input.new);
  if (oldText !== null && newText !== null) {
    addPairRows(rows, oldText, newText, 1, 1);
    return rows;
  }

  const content = asString(input.content) ?? asString(input.text);
  if (content !== null) {
    splitLines(content).forEach((line, index) => {
      pushLimited(rows, { kind: "add", oldLine: null, newLine: index + 1, text: line });
    });
  }

  return rows;
}

export function buildDiffPreview(input: Record<string, unknown>): DiffPreview | null {
  const path = getToolPath(input);
  const patch = asString(input.patch) ?? asString(input.diff);
  const rows = patch ? buildPatchDiff(patch) : rowsFromPairs(input);
  if (rows.length === 0) return null;

  return {
    path,
    fileName: path ? basename(path) : "changes",
    added: rows.filter((row) => row.kind === "add").length,
    removed: rows.filter((row) => row.kind === "remove").length,
    rows,
  };
}

export function getReadableInputPreview(input: Record<string, unknown>): string | null {
  return (
    asString(input.content) ??
    asString(input.text) ??
    asString(input.new_string) ??
    asString(input.newText) ??
    null
  );
}
