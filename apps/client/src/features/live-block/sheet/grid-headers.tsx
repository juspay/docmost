import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ResizeTarget } from "./use-resize";
import classes from "./sheet.module.css";

/** The draggable edge of a column or row header. */
export function ResizeHandle({
  target,
  onStart,
}: {
  target: ResizeTarget;
  onStart(e: ReactPointerEvent): void;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={target.kind === "col" ? classes.colResize : classes.rowResize}
      data-resize
      role="separator"
      aria-orientation={target.kind === "col" ? "vertical" : "horizontal"}
      aria-label={target.kind === "col" ? t("Resize column") : t("Resize row")}
      onPointerDown={onStart}
    />
  );
}
