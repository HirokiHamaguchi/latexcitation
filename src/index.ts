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
