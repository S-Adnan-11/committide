export const DEFAULT_TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf',
  'test', 'build', 'ci', 'chore', 'revert',
] as const;

export const TYPE_TOKEN = /^[\p{L}\p{M}\p{N}_-]+$/u;
const HEADER = /^([\p{L}\p{M}\p{N}_-]+)(?:\(([^()\r\n]+)\))?(!)?: (.+)$/u;
const FOOTER = /^(BREAKING CHANGE|[\p{L}\p{M}\p{N}_-]+)(: | #)(.*)$/u;
const BREAKING = /^BREAKING[ -]CHANGE$/;

export interface Diagnostic {
  rule: string;
  message: string;
  line: number;
}

export interface Footer {
  token: string;
  separator: ': ' | ' #';
  value: string;
  line: number;
}

export interface ParsedMessage {
  header: string;
  type: string;
  scope: string | null;
  description: string;
  body: string | null;
  footers: Footer[];
  breaking: boolean;
  breakingDescriptions: string[];
}

export interface ParseResult {
  parsed: ParsedMessage | null;
  diagnostics: Diagnostic[];
}

function removeTrailingBlankLines(lines: string[]): string[] {
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines;
}

/** Parse structure independently of the current allowed-type policy. */
export function parseMessage(message: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const report = (rule: string, text: string, line: number) => {
    diagnostics.push({ rule, message: text, line });
  };
  const lines = removeTrailingBlankLines(message.replace(/\r\n/g, '\n').split('\n'));
  const header = lines[0] ?? '';
  const match = HEADER.exec(header);
  if (!match || !match[4]?.trim() || (match[2] !== undefined && !match[2].trim())) {
    report('header-format', 'Use type(scope)!: description; scope and ! are optional, and the description must be nonempty.', 1);
    return { parsed: null, diagnostics };
  }
  if (message.includes('\0') || message.replace(/\r\n/g, '').includes('\r')) {
    report('message-control', 'Remove NUL characters and use LF or CRLF line endings.', 1);
  }
  if (lines.length > 1 && lines[1]?.trim()) {
    report('header-blank-line', 'Separate the header from the body or footers with a blank line.', 2);
  }

  const body: string[] = [];
  const footers: Footer[] = [];
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index]!;
    const footerMatch = FOOTER.exec(line);
    // A first footer starts a paragraph; subsequent tokens end the prior value.
    const beginsFooter = footerMatch && (footers.length > 0 || !lines[index - 1]?.trim());
    if (/^breaking[ -]change(?::| #|$)/i.test(line)) {
      if (!footerMatch || !BREAKING.test(footerMatch[1]!) || footerMatch[2] !== ': ') {
        report('breaking-footer', 'Use BREAKING CHANGE: description or BREAKING-CHANGE: description with uppercase text and a space after the colon.', index + 1);
      } else if (!beginsFooter) {
        report('footer-blank-line', 'Separate the first breaking-change footer from the body with a blank line.', index + 1);
      }
    }
    if (beginsFooter) {
      footers.push({
        token: footerMatch[1]!,
        separator: footerMatch[2] as Footer['separator'],
        value: footerMatch[3]!,
        line: index + 1,
      });
    } else if (footers.length) {
      footers[footers.length - 1]!.value += `\n${line}`;
    } else {
      body.push(line);
    }
  }
  for (const footer of footers) {
    if (!footer.value.trim()) {
      report('footer-value', `Add a nonempty value after ${footer.token}${footer.separator}.`, footer.line);
    }
  }
  const breakingDescriptions = footers
    .filter(footer => BREAKING.test(footer.token) && footer.separator === ': ')
    .map(footer => footer.value);
  const hasBang = match[3] === '!';
  if (hasBang && !breakingDescriptions.length) breakingDescriptions.push(match[4]!);
  return {
    parsed: {
      header,
      type: match[1]!,
      scope: match[2] ?? null,
      description: match[4]!,
      body: removeTrailingBlankLines(body).join('\n') || null,
      footers,
      breaking: hasBang || breakingDescriptions.length > 0,
      breakingDescriptions,
    },
    diagnostics,
  };
}

/** Shared lint entry point for CLI and future Git consumers. */
export function lintMessage(message: string, allowedTypes: readonly string[] = DEFAULT_TYPES): ParseResult {
  const result = parseMessage(message);
  if (result.parsed && !allowedTypes.some(type => type.toLowerCase() === result.parsed!.type.toLowerCase())) {
    result.diagnostics.push({
      rule: 'type-allowed',
      message: `Choose an allowed type: ${allowedTypes.join(', ')}; or configure allowedTypes/extendTypes.`,
      line: 1,
    });
  }
  return result;
}
