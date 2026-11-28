import { parseA1 } from './model';

/** "B3", "$B$3", "Sheet2!A1" or "'My sheet'!A1" → a 0-based position. */
export function parseCellAddress(
  text: string,
): { sheetName?: string; row: number; col: number } | null {
  if (typeof text !== 'string') return null;
  const bang = text.lastIndexOf('!');
  let sheetName: string | undefined;
  if (bang >= 0) {
    let prefix = text.slice(0, bang).trim();
    if (prefix.length >= 2 && prefix.startsWith("'") && prefix.endsWith("'")) {
      prefix = prefix.slice(1, -1).replace(/''/g, "'");
    }
    if (!prefix) return null;
    sheetName = prefix;
  }
  const ref = parseA1(text.slice(bang + 1));
  if (!ref) return null;
  return sheetName === undefined
    ? { row: ref.row, col: ref.col }
    : { sheetName, row: ref.row, col: ref.col };
}
