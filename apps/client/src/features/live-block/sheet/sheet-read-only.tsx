import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { sheet as S, type SheetSnapshot } from "@docmost/live-blocks";
import { serializeRange } from "./clipboard";
import { Grid } from "./grid";
import { SheetTabs } from "./sheet-tabs";
import { useGridSelection } from "./use-grid-selection";
import { engineDisplay, snapshotDisplay } from "./display";
import classes from "./sheet.module.css";

export default function SheetReadOnly({
  snapshot,
  height,
}: {
  snapshot?: SheetSnapshot;
  height: number;
}) {
  const { t } = useTranslation();
  const book = useMemo(
    () =>
      snapshot?.book?.sheets?.length ? snapshot.book : S.createEmptyBook(),
    [snapshot],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const sheet = book.sheets.find((s) => s.id === activeId) ?? book.sheets[0];
  const engine = useMemo(() => new S.Engine(book), [book]);
  const display = useMemo(
    () =>
      snapshotDisplay(
        snapshot?.display?.[sheet.id],
        engineDisplay(engine, sheet),
      ),
    [snapshot, sheet, engine],
  );
  const sel = useGridSelection(sheet);

  return (
    <div className={classes.workspace} style={{ height }} data-sheet-read-only>
      <Grid
        sheet={sheet}
        display={display}
        sel={sel}
        readOnly
        // readers can copy what they see
        onCopy={(e) => {
          const { text, html } = serializeRange(book, sheet.id, sel.range());
          e.preventDefault();
          e.stopPropagation();
          e.clipboardData.setData("text/plain", text);
          e.clipboardData.setData("text/html", html);
        }}
      />
      {book.sheets.length > 1 && (
        <SheetTabs
          sheets={book.sheets}
          activeId={sheet.id}
          onSelect={setActiveId}
          readOnly
        />
      )}
      {!snapshot && (
        <div className={classes.empty}>{t("Empty spreadsheet")}</div>
      )}
      {snapshot?.truncated && (
        <div className={classes.truncatedNotice}>
          {t("This table is too large to show in full")}
        </div>
      )}
    </div>
  );
}
