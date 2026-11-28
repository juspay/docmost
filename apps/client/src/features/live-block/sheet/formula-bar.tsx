import { TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { sheet as S } from "@docmost/live-blocks";
import { type CellEditing, editorKey } from "./cell-editor";
import type { CellPos } from "./use-grid-selection";
import classes from "./sheet.module.css";

/** The active cell's raw input; editing it edits the cell. */
export function FormulaBar({
  sheet,
  active,
  editing,
  readOnly,
}: {
  sheet: S.Sheet;
  active: CellPos;
  editing: CellEditing;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const edit = editing.edit;
  const value = edit ? edit.value : S.getRaw(sheet, active.row, active.col);
  return (
    <div className={classes.formulaBar}>
      <span className={classes.address} aria-label={t("Cell")}>
        {S.toA1(edit?.row ?? active.row, edit?.col ?? active.col)}
      </span>
      <TextInput
        className={classes.formulaInput}
        size="xs"
        variant="filled"
        aria-label={t("Formula")}
        placeholder={
          readOnly ? "" : t("Type a value or a formula such as =SUM(A1:A3)")
        }
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onFocus={(e) => {
          editing.inputRef.current = e.currentTarget;
          if (!edit && !readOnly) editing.start(undefined, "bar");
        }}
        onChange={(e) => {
          if (!edit) editing.start(undefined, "bar");
          editing.change(
            e.currentTarget.value,
            e.currentTarget.selectionStart ?? 0,
          );
        }}
        onSelect={(e) => editing.setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (!editorKey(e, editing)) e.stopPropagation();
        }}
        onBlur={(e) => editing.blur(e.relatedTarget as Element | null)}
        data-formula-input
      />
    </div>
  );
}
