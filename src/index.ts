export type BibEntry = {
  type: string;
  key: string;
  fields: Record<string, string>;
};

export type BibParseError = {
  message: string;
  offset: number;
};

export type BibParseResult = {
  entries: BibEntry[];
  errors: BibParseError[];
};

export type BibFieldRow = {
  type: string;
  key: string;
  fields: Record<string, boolean>;
};

export type BibFieldGroup = {
  type: string;
  fieldNames: string[];
  rows: BibFieldRow[];
};

export type BibFieldMatrix = {
  groups: BibFieldGroup[];
  errors: BibParseError[];
};

export type BibVariationCandidate = {
  field: string;
  label: string;
  values: string[];
};

export type BibDocumentAnalysis = {
  entries: BibEntry[];
  groups: BibFieldGroup[];
  errors: BibParseError[];
  consistencyNotes: string[];
  variationCandidates: BibVariationCandidate[];
};

const PREFERRED_FIELD_ORDER = [
  "author",
  "editor",
  "title",
  "journal",
  "booktitle",
  "publisher",
  "school",
  "institution",
  "year",
  "volume",
  "number",
  "pages",
  "doi",
  "url",
];

export const BIB_DATE_FIELDS = ["year", "month", "day"] as const;

const LOW_PRIORITY_FIELDS = new Set([
  "abstract",
  "archiveprefix",
  "copyright",
  "eprint",
  "file",
  "keywords",
  "langid",
  "primaryclass",
  "urldate",
]);

const BOOK_LIKE_TYPES = new Set(["book", "inbook", "incollection", "proceedings"]);
const VARIATION_FIELDS = ["author", "editor", "publisher", "journal", "booktitle", "school", "institution"];

function skipWhitespace(input: string, index: number): number {
  let current = index;
  while (current < input.length && /\s/.test(input[current])) current += 1;
  return current;
}

function readIdentifier(input: string, index: number): { value: string; end: number } {
  let current = index;
  while (current < input.length && /[A-Za-z0-9_:\-.]/.test(input[current])) current += 1;
  return { value: input.slice(index, current), end: current };
}

function findEntryEnd(input: string, bodyStart: number, openChar: "{" | "("): number {
  const closeChar = openChar === "{" ? "}" : ")";
  let depth = 1;
  let current = bodyStart;
  let quoteOpen = false;

  while (current < input.length) {
    const char = input[current];
    const previous = current > 0 ? input[current - 1] : "";

    if (char === '"' && previous !== "\\") {
      quoteOpen = !quoteOpen;
    } else if (!quoteOpen && char === openChar) {
      depth += 1;
    } else if (!quoteOpen && char === closeChar) {
      depth -= 1;
      if (depth === 0) return current;
    }
    current += 1;
  }

  return -1;
}

function splitTopLevelFields(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let quoteOpen = false;

  for (let current = 0; current < body.length; current += 1) {
    const char = body[current];
    const previous = current > 0 ? body[current - 1] : "";

    if (char === '"' && previous !== "\\") {
      quoteOpen = !quoteOpen;
    } else if (!quoteOpen && char === "{") {
      braceDepth += 1;
    } else if (!quoteOpen && char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (!quoteOpen && char === "(") {
      parenDepth += 1;
    } else if (!quoteOpen && char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (!quoteOpen && braceDepth === 0 && parenDepth === 0 && char === ",") {
      parts.push(body.slice(start, current));
      start = current + 1;
    }
  }

  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function stripOuterValueDelimiters(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of splitTopLevelFields(body)) {
    const equalIndex = part.indexOf("=");
    if (equalIndex < 0) continue;

    const name = part.slice(0, equalIndex).trim().toLowerCase();
    const value = stripOuterValueDelimiters(part.slice(equalIndex + 1));
    if (name) fields[name] = value;
  }
  return fields;
}

export function parseBib(input: string): BibParseResult {
  const entries: BibEntry[] = [];
  const errors: BibParseError[] = [];
  let current = 0;

  while (current < input.length) {
    const atIndex = input.indexOf("@", current);
    if (atIndex < 0) break;

    const typeStart = atIndex + 1;
    const typeToken = readIdentifier(input, typeStart);
    const type = typeToken.value.toLowerCase();
    let cursor = skipWhitespace(input, typeToken.end);

    if (!type || (input[cursor] !== "{" && input[cursor] !== "(")) {
      errors.push({ message: "Could not parse BibTeX entry header.", offset: atIndex });
      current = typeStart;
      continue;
    }

    const openChar = input[cursor] as "{" | "(";
    const bodyStart = cursor + 1;
    const bodyEnd = findEntryEnd(input, bodyStart, openChar);
    if (bodyEnd < 0) {
      errors.push({ message: `Unclosed @${type} entry.`, offset: atIndex });
      break;
    }

    const body = input.slice(bodyStart, bodyEnd);
    const commaIndex = body.indexOf(",");
    if (commaIndex < 0) {
      errors.push({ message: `Missing citation key in @${type} entry.`, offset: atIndex });
      current = bodyEnd + 1;
      continue;
    }

    const key = body.slice(0, commaIndex).trim();
    const fields = parseFields(body.slice(commaIndex + 1));
    if (!key) {
      errors.push({ message: `Empty citation key in @${type} entry.`, offset: atIndex });
    } else {
      entries.push({ type, key, fields });
    }

    current = bodyEnd + 1;
  }

  return { entries, errors };
}

function sortFieldNames(fields: Iterable<string>): string[] {
  const uniqueFields = Array.from(new Set(fields));
  return uniqueFields.sort((left, right) => {
    const leftPreferredIndex = PREFERRED_FIELD_ORDER.indexOf(left);
    const rightPreferredIndex = PREFERRED_FIELD_ORDER.indexOf(right);
    if (leftPreferredIndex >= 0 && rightPreferredIndex >= 0) {
      return leftPreferredIndex - rightPreferredIndex;
    }
    if (leftPreferredIndex >= 0) return -1;
    if (rightPreferredIndex >= 0) return 1;
    return left.localeCompare(right);
  });
}

export function analyzeBibFields(input: string): BibFieldMatrix {
  const parsed = parseBib(input);
  const entriesByType = new Map<string, BibEntry[]>();

  for (const entry of parsed.entries) {
    const entries = entriesByType.get(entry.type) ?? [];
    entries.push(entry);
    entriesByType.set(entry.type, entries);
  }

  const groups = Array.from(entriesByType.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, entries]) => {
      const fieldNames = sortFieldNames(entries.flatMap((entry) => Object.keys(entry.fields)));
      const rows = entries
        .slice()
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((entry) => ({
          type,
          key: entry.key,
          fields: Object.fromEntries(fieldNames.map((field) => [field, field in entry.fields])),
        }));
      return { type, fieldNames, rows };
    });

  return { groups, errors: parsed.errors };
}

function getEntryYear(entry: BibEntry): number | undefined {
  const year = Number.parseInt(entry.fields.year ?? "", 10);
  return Number.isFinite(year) ? year : undefined;
}

export function isLowPriorityBibField(field: string): boolean {
  return LOW_PRIORITY_FIELDS.has(field);
}

export function isModernBookMissingIsbn(entry: BibEntry): boolean {
  const year = getEntryYear(entry);
  return BOOK_LIKE_TYPES.has(entry.type) && !entry.fields.isbn && year !== undefined && year >= 1970;
}

export function isPre1970BookMissingIsbn(entry: BibEntry): boolean {
  const year = getEntryYear(entry);
  return BOOK_LIKE_TYPES.has(entry.type) && !entry.fields.isbn && year !== undefined && year < 1970;
}

export function getBibFieldColumns(group: BibFieldGroup, showLowPriority: boolean): string[] {
  const fieldNames = new Set(group.fieldNames);
  if (BOOK_LIKE_TYPES.has(group.type)) fieldNames.add("isbn");
  const hasDateFields = BIB_DATE_FIELDS.some((field) => fieldNames.has(field));
  const fields = Array.from(fieldNames).filter((field) => {
    if (BIB_DATE_FIELDS.includes(field as (typeof BIB_DATE_FIELDS)[number])) return false;
    return showLowPriority || !LOW_PRIORITY_FIELDS.has(field);
  });
  const titleIndex = fields.indexOf("title");
  if (!hasDateFields) return fields;
  const insertIndex = titleIndex >= 0 ? titleIndex + 1 : Math.min(3, fields.length);
  return [...fields.slice(0, insertIndex), "date", ...fields.slice(insertIndex)];
}

function normalizeBibValue(value: string): string {
  return value
    .replace(/[{}]/g, "")
    .replace(/\\[A-Za-z]+/g, "")
    .replace(/\\./g, "")
    .replace(/&/g, " and ")
    .replace(/\b(inc|ltd|llc|co|press|publishing|publishers)\b/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function levenshtein(left: string, right: string): number {
  const costs = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = costs[0];
    costs[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = costs[j];
      costs[j] = left[i - 1] === right[j - 1]
        ? previous
        : Math.min(previous, costs[j - 1], costs[j]) + 1;
      previous = current;
    }
  }
  return costs[right.length];
}

function similarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshtein(left, right) / maxLength;
}

function splitNameList(value: string): string[] {
  return value.split(/\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
}

export function detectBibVariations(entries: BibEntry[]): BibVariationCandidate[] {
  const candidates: BibVariationCandidate[] = [];

  for (const field of VARIATION_FIELDS) {
    const values = entries.flatMap((entry) => {
      const value = entry.fields[field];
      if (!value) return [];
      return field === "author" || field === "editor" ? splitNameList(value) : [value];
    });
    const uniqueValues = Array.from(new Set(values));
    const byNormalized = new Map<string, Set<string>>();

    for (const value of uniqueValues) {
      const normalized = normalizeBibValue(value);
      if (!normalized) continue;
      const set = byNormalized.get(normalized) ?? new Set<string>();
      set.add(value);
      byNormalized.set(normalized, set);
    }

    for (const [normalized, originals] of byNormalized.entries()) {
      if (originals.size > 1) {
        candidates.push({ field, label: normalized, values: Array.from(originals).sort() });
      }
    }

    const normalizedValues = Array.from(byNormalized.keys());
    for (let leftIndex = 0; leftIndex < normalizedValues.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < normalizedValues.length; rightIndex += 1) {
        const left = normalizedValues[leftIndex];
        const right = normalizedValues[rightIndex];
        if (left.length < 5 || right.length < 5) continue;
        if (similarity(left, right) >= 0.88) {
          candidates.push({
            field,
            label: `${left} / ${right}`,
            values: [
              ...Array.from(byNormalized.get(left) ?? []),
              ...Array.from(byNormalized.get(right) ?? []),
            ].sort(),
          });
        }
      }
    }
  }

  return candidates.slice(0, 12);
}

export function buildBibConsistencyNotes(groups: BibFieldGroup[], entries: BibEntry[]): string[] {
  const notes: string[] = [];

  for (const group of groups) {
    const importantFields = group.fieldNames.filter((field) => !LOW_PRIORITY_FIELDS.has(field));
    for (const field of importantFields) {
      const presentCount = group.rows.filter((row) => row.fields[field]).length;
      if (presentCount > 0 && presentCount < group.rows.length) {
        notes.push(`@${group.type}: ${field} is present in ${presentCount}/${group.rows.length} entries.`);
      }
    }
  }

  const modernBooksMissingIsbn = entries.filter(isModernBookMissingIsbn);
  if (modernBooksMissingIsbn.length > 0) {
    notes.push(`${modernBooksMissingIsbn.length} post-1970 book-like entries are missing ISBN.`);
  }

  const partialDates = entries.filter((entry) => {
    const fields = BIB_DATE_FIELDS.filter((field) => Boolean(entry.fields[field]));
    return fields.length > 0 && !entry.fields.year;
  });
  if (partialDates.length > 0) {
    notes.push(`${partialDates.length} entries have month/day without year.`);
  }

  return notes.slice(0, 8);
}

export function analyzeBibDocument(input: string): BibDocumentAnalysis {
  const parsed = parseBib(input);
  const matrix = analyzeBibFields(input);

  return {
    entries: parsed.entries,
    groups: matrix.groups,
    errors: matrix.errors,
    consistencyNotes: buildBibConsistencyNotes(matrix.groups, parsed.entries),
    variationCandidates: detectBibVariations(parsed.entries),
  };
}
