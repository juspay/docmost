import { type CSSProperties, memo, type ReactNode } from "react";
import clsx from "clsx";
import { sheet as S } from "@docmost/live-blocks";
import classes from "./sheet.module.css";

export type CellKind = "text" | "number" | "boolean" | "error";

// Formats are written by other people: every one goes through the shared
// normalizeFormat (known keys, whitelisted values) before it becomes a style.
export function safeColor(v: unknown): string | undefined {
  return S.safeColor(v) ?? undefined;
}

export function safeFormat(f: unknown): S.CellFormat | null {
  return S.normalizeFormat(f);
}

const styleCache = new Map<string, CSSProperties>();

/** Dark or light text for a hex fill; undefined for other colour forms. */
export function textOn(bg: string): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(bg);
  if (!m) return undefined;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? "#1a1b1e" : "#f8f9fa";
}

/** The ported formatCss as a React style object. */
export function formatStyle(
  f: S.CellFormat | null | undefined,
): CSSProperties | undefined {
  if (!f) return undefined;
  const key = JSON.stringify(f);
  let style = styleCache.get(key);
  if (!style) {
    style = {};
    for (const decl of S.formatCss(safeFormat(f)).split(";")) {
      const i = decl.indexOf(":");
      if (i <= 0) continue;
      const prop = decl
        .slice(0, i)
        .trim()
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      (style as Record<string, string>)[prop] = decl.slice(i + 1).trim();
    }
    // a fill with no text colour gets readable text in both themes
    const safe = safeFormat(f);
    if (safe?.bg && !safe.color) {
      const text = textOn(safe.bg);
      if (text) style.color = text;
    }
    if (styleCache.size > 2000) styleCache.clear();
    styleCache.set(key, style);
  }
  return style;
}

export type GridCellProps = {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  kind: CellKind;
  format: S.CellFormat | undefined;
  selected: boolean;
  active: boolean;
  /** which edges of the selection this cell is on: top, right, bottom, left */
  edges: number;
  /** another person's colour when their cursor is here */
  remoteColor?: string;
  remoteName?: string;
  fillHandle?: boolean;
  /** matches of find, highlighted */
  found?: "match" | "current";
  children?: ReactNode;
};

export const EDGE_TOP = 1;
export const EDGE_RIGHT = 2;
export const EDGE_BOTTOM = 4;
export const EDGE_LEFT = 8;
const SELECTION_COLOR = "var(--mantine-color-blue-6)";

function edgeShadow(edges: number, active: boolean): string | undefined {
  const parts: string[] = [];
  if (edges & EDGE_TOP) parts.push(`inset 0 2px 0 0 ${SELECTION_COLOR}`);
  if (edges & EDGE_BOTTOM) parts.push(`inset 0 -2px 0 0 ${SELECTION_COLOR}`);
  if (edges & EDGE_LEFT) parts.push(`inset 2px 0 0 0 ${SELECTION_COLOR}`);
  if (edges & EDGE_RIGHT) parts.push(`inset -2px 0 0 0 ${SELECTION_COLOR}`);
  if (active && parts.length === 0)
    parts.push(`inset 0 0 0 2px ${SELECTION_COLOR}`);
  return parts.length ? parts.join(", ") : undefined;
}

export const GridCell = memo(function GridCell(props: GridCellProps) {
  const style: CSSProperties = {
    left: props.x,
    top: props.y,
    width: props.width,
    height: props.height,
    ...formatStyle(props.format),
  };
  const shadow = edgeShadow(props.edges, props.active);
  if (shadow) style.boxShadow = shadow;
  if (props.remoteColor) {
    style.outline = `2px solid ${props.remoteColor}`;
    style.outlineOffset = -2;
  }
  return (
    <div
      className={clsx(
        classes.cell,
        props.kind === "number" && !props.format?.align && classes.alignRight,
        props.kind === "boolean" && !props.format?.align && classes.alignCenter,
        props.kind === "error" && classes.errorValue,
        props.selected && !props.active && classes.selected,
        props.found === "match" && classes.found,
        props.found === "current" && classes.foundCurrent,
      )}
      style={style}
      data-r={props.row}
      data-c={props.col}
      aria-rowindex={props.row + 1}
      aria-colindex={props.col + 1}
      data-active={props.active || undefined}
      role="gridcell"
      aria-selected={props.selected}
    >
      <span className={classes.cellText}>{props.text}</span>
      {props.remoteName && (
        <span
          className={classes.remoteTag}
          style={{ background: props.remoteColor }}
        >
          {props.remoteName}
        </span>
      )}
      {props.fillHandle && (
        <span className={classes.fillHandle} data-fill-handle />
      )}
      {props.children}
    </div>
  );
});
