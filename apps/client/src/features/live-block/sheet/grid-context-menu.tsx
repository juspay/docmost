import { Menu } from "@mantine/core";
import {
  IconArrowMergeBoth,
  IconArrowsSplit,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconColumnRemove,
  IconEraser,
  IconRowInsertBottom,
  IconRowInsertTop,
  IconRowRemove,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { sheet as S } from "@docmost/live-blocks";

export type ContextMenuState = {
  x: number;
  y: number;
  kind: "cell" | "row" | "col";
};

export type ContextActions = {
  insertRows(where: "above" | "below"): void;
  insertCols(where: "left" | "right"): void;
  deleteRows(): void;
  deleteCols(): void;
  clear(): void;
  merge(): void;
  unmerge(): void;
};

/** Right-click on a cell or a header: insert, delete, clear, merge. */
export function GridContextMenu({
  state,
  range,
  sheet,
  onClose,
  actions,
}: {
  state: ContextMenuState | null;
  range: S.MergeRange;
  sheet: S.Sheet;
  onClose(): void;
  actions: ContextActions;
}) {
  const { t } = useTranslation();
  const rows = range.r2 - range.r1 + 1;
  const cols = range.c2 - range.c1 + 1;
  const showRows = state?.kind !== "col";
  const showCols = state?.kind !== "row";
  const merged = sheet.merges.some(
    (m) =>
      m.r1 <= range.r2 &&
      m.r2 >= range.r1 &&
      m.c1 <= range.c2 &&
      m.c2 >= range.c1,
  );
  const many = (one: string, several: string, count: number) =>
    count === 1 ? t(one) : t(several, { count });
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Menu
      opened={state !== null}
      onChange={(open) => !open && onClose()}
      position="bottom-start"
      withinPortal
      shadow="md"
    >
      <Menu.Target>
        <div
          style={{
            position: "fixed",
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 1,
            height: 1,
            pointerEvents: "none",
          }}
        />
      </Menu.Target>
      <Menu.Dropdown data-sheet-context-menu>
        {showRows && (
          <>
            <Menu.Item
              leftSection={<IconRowInsertTop size={16} />}
              onClick={run(() => actions.insertRows("above"))}
            >
              {many("Insert row above", "Insert {{count}} rows above", rows)}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconRowInsertBottom size={16} />}
              onClick={run(() => actions.insertRows("below"))}
            >
              {many("Insert row below", "Insert {{count}} rows below", rows)}
            </Menu.Item>
          </>
        )}
        {showCols && (
          <>
            <Menu.Item
              leftSection={<IconColumnInsertLeft size={16} />}
              onClick={run(() => actions.insertCols("left"))}
            >
              {many(
                "Insert column left",
                "Insert {{count}} columns left",
                cols,
              )}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconColumnInsertRight size={16} />}
              onClick={run(() => actions.insertCols("right"))}
            >
              {many(
                "Insert column right",
                "Insert {{count}} columns right",
                cols,
              )}
            </Menu.Item>
          </>
        )}
        <Menu.Divider />
        {showRows && (
          <Menu.Item
            color="red"
            leftSection={<IconRowRemove size={16} />}
            disabled={rows >= sheet.rows}
            onClick={run(actions.deleteRows)}
          >
            {many("Delete row", "Delete {{count}} rows", rows)}
          </Menu.Item>
        )}
        {showCols && (
          <Menu.Item
            color="red"
            leftSection={<IconColumnRemove size={16} />}
            disabled={cols >= sheet.cols}
            onClick={run(actions.deleteCols)}
          >
            {many("Delete column", "Delete {{count}} columns", cols)}
          </Menu.Item>
        )}
        <Menu.Item
          leftSection={<IconEraser size={16} />}
          onClick={run(actions.clear)}
        >
          {t("Clear contents")}
        </Menu.Item>
        {state?.kind === "cell" && (rows > 1 || cols > 1 || merged) && (
          <>
            <Menu.Divider />
            {merged ? (
              <Menu.Item
                leftSection={<IconArrowsSplit size={16} />}
                onClick={run(actions.unmerge)}
              >
                {t("Unmerge cells")}
              </Menu.Item>
            ) : (
              <Menu.Item
                leftSection={<IconArrowMergeBoth size={16} />}
                onClick={run(actions.merge)}
              >
                {t("Merge cells")}
              </Menu.Item>
            )}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
