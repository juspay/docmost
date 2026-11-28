import { sheet as S } from "@docmost/live-blocks";
import type { CellKind } from "./grid-cell";
import type { GridDisplay } from "./grid";

const EMPTY = { text: "", kind: "text" as CellKind };

function kindOf(value: S.CellValue): CellKind {
  if (value instanceof S.FormulaError) return "error";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

/** What a live grid shows: the engine's display string and the value's kind. */
export function engineDisplay(engine: S.Engine, sheet: S.Sheet): GridDisplay {
  return (row, col) => {
    const cell = sheet.cells[`${row}:${col}`];
    if (!cell || cell.v === "") return EMPTY;
    try {
      const kind = kindOf(engine.getValue(sheet.id, row, col));
      return { text: engine.display(sheet.id, row, col), kind };
    } catch {
      return { text: S.ERR_PARSE, kind: "error" };
    }
  };
}

/** What a stored snapshot shows; cells past its cap are computed here. */
export function snapshotDisplay(
  values: Record<string, string> | undefined,
  fallback: GridDisplay,
): GridDisplay {
  return (row, col) => {
    const text = values?.[`${row}:${col}`];
    if (text === undefined) return fallback(row, col);
    const kind: CellKind = /^#[A-Z/0-9]+[!?]$|^#N\/A$/.test(text)
      ? "error"
      : S.parseNumberLiteral(text) !== null
        ? "number"
        : text === "TRUE" || text === "FALSE"
          ? "boolean"
          : "text";
    return { text, kind };
  };
}
