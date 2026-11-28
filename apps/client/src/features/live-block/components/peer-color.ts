const FALLBACK = "#868e96";
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION = /^(?:rgb|hsl)a?\(\s*[\d.%\s,/+-]+\)$/i;

/** A collaborator picks their own colour; only a plain colour may reach CSS. */
export function safePeerColor(value: unknown): string {
  if (typeof value !== "string") return FALLBACK;
  const color = value.trim();
  return HEX.test(color) || FUNCTION.test(color) ? color : FALLBACK;
}
