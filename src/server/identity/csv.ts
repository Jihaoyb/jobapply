/** Pure CSV parsing and row validation for the history import (issue 003). */
import { createHash } from 'node:crypto';
import { isIsoDate } from './capdates.js';
import { normalizeEmployerName, normalizeTitle, urlKey } from './normalize.js';

export interface ImportRow {
  /** 1-based line number in the uploaded file (the header is line 1). */
  line: number;
  employer: string;
  title: string;
  date: string;
  sourceUrl: string;
  rowHash: string;
}
export interface ImportRowError {
  line: number;
  column: 'employer' | 'title' | 'date' | 'source URL' | null;
  message: string;
}
export interface ParsedImport {
  rows: ImportRow[];
  errors: ImportRowError[];
  /** Exact repeats inside the same file; imported once. */
  repeated: { line: number; sameAsLine: number }[];
}

export const IMPORT_HEADER = 'employer,title,date,source URL';
export const MAX_IMPORT_ROWS = 2000;

/** RFC 4180 records: quoted fields, escaped quotes, CRLF/LF; tracks each record's first line. */
export function parseCsvRecords(text: string): {
  records: { line: number; fields: string[] }[];
  error: string | null;
} {
  const records: { line: number; fields: string[] }[] = [];
  let field = '',
    fields: string[] = [],
    quoted = false,
    line = 1,
    recordLine = 1,
    afterQuote = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field.trim() !== '' || afterQuote)
        return {
          records,
          error: `Line ${line}: unexpected quote inside an unquoted field`,
        };
      field = '';
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
      afterQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = '';
      afterQuote = false;
      line++;
      recordLine = line;
    } else {
      if (afterQuote && char.trim())
        return {
          records,
          error: `Line ${line}: text after a closing quote`,
        };
      field += char;
    }
  }
  if (quoted)
    return { records, error: `Line ${recordLine}: unterminated quoted field` };
  if (field !== '' || fields.length) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  return {
    records: records.filter((r) => r.fields.some((f) => f.trim() !== '')),
    error: null,
  };
}

const headerAliases = [
  ['employer'],
  ['title'],
  ['date'],
  ['source url', 'source_url', 'sourceurl', 'url', 'source'],
];
export function importRowHash(row: {
  employer: string;
  title: string;
  date: string;
  sourceUrl: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        normalizeEmployerName(row.employer),
        normalizeTitle(row.title),
        row.date,
        urlKey(row.sourceUrl) ?? row.sourceUrl.trim(),
      ]),
    )
    .digest('hex');
}

/** Validates the four-column file. `today` is the Los Angeles local date; future dates fail. */
export function parseImportCsv(text: string, today: string): ParsedImport {
  const result: ParsedImport = { rows: [], errors: [], repeated: [] };
  const { records, error } = parseCsvRecords(text);
  if (error) {
    result.errors.push({ line: 0, column: null, message: error });
    return result;
  }
  const [header, ...body] = records;
  const headerOk =
    header &&
    header.fields.length === 4 &&
    header.fields.every((value, index) =>
      headerAliases[index].includes(value.trim().toLowerCase()),
    );
  if (!headerOk) {
    result.errors.push({
      line: header?.line ?? 1,
      column: null,
      message: `First line must be the header "${IMPORT_HEADER}"`,
    });
    return result;
  }
  if (!body.length)
    result.errors.push({ line: 2, column: null, message: 'No rows to import' });
  if (body.length > MAX_IMPORT_ROWS) {
    result.errors.push({
      line: body[MAX_IMPORT_ROWS].line,
      column: null,
      message: `Import at most ${MAX_IMPORT_ROWS} rows per file`,
    });
    return result;
  }
  const seen = new Map<string, number>();
  for (const record of body) {
    const errors: ImportRowError[] = [];
    if (record.fields.length !== 4) {
      result.errors.push({
        line: record.line,
        column: null,
        message: `Expected 4 columns (${IMPORT_HEADER}) but found ${record.fields.length}; quote values that contain commas`,
      });
      continue;
    }
    const [employer, title, date, sourceUrl] = record.fields.map((v) =>
      v.trim(),
    );
    if (!employer)
      errors.push({
        line: record.line,
        column: 'employer',
        message: 'Employer is required',
      });
    else if (employer.length > 300)
      errors.push({
        line: record.line,
        column: 'employer',
        message: 'Employer must be at most 300 characters',
      });
    if (!title)
      errors.push({
        line: record.line,
        column: 'title',
        message: 'Title is required',
      });
    else if (title.length > 300)
      errors.push({
        line: record.line,
        column: 'title',
        message: 'Title must be at most 300 characters',
      });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      errors.push({
        line: record.line,
        column: 'date',
        message: `Date "${date.slice(0, 40)}" must be an ISO local date like 2026-08-09`,
      });
    else if (!isIsoDate(date))
      errors.push({
        line: record.line,
        column: 'date',
        message: `Date ${date} does not exist on the calendar`,
      });
    else if (date > today)
      errors.push({
        line: record.line,
        column: 'date',
        message: `Date ${date} is after today (${today}, Los Angeles)`,
      });
    let urlOk = false;
    try {
      const url = new URL(sourceUrl);
      urlOk =
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        sourceUrl.length <= 4000;
    } catch {
      urlOk = false;
    }
    if (!urlOk)
      errors.push({
        line: record.line,
        column: 'source URL',
        message: sourceUrl
          ? 'Source URL must be an http(s) link without credentials'
          : 'Source URL is required (the posting or application link)',
      });
    if (errors.length) {
      result.errors.push(...errors);
      continue;
    }
    const row = { employer, title, date, sourceUrl };
    const rowHash = importRowHash(row);
    const first = seen.get(rowHash);
    if (first !== undefined) {
      result.repeated.push({ line: record.line, sameAsLine: first });
      continue;
    }
    seen.set(rowHash, record.line);
    result.rows.push({ line: record.line, ...row, rowHash });
  }
  return result;
}
