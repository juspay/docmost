import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronDown,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { sheet as S } from "@docmost/live-blocks";
import classes from "./sheet.module.css";

const DRAG_TYPE = "application/x-docmost-sheet-tab";

type SheetTabsProps = {
  sheets: S.Sheet[];
  activeId: string;
  onSelect(id: string): void;
  readOnly?: boolean;
  onAdd?(): void;
  onRename?(id: string, name: string): void;
  onDelete?(id: string): void;
  /** move `id` to where `beforeId` is */
  onMove?(id: string, beforeId: string): void;
};

export function SheetTabs(props: SheetTabsProps) {
  const { sheets, activeId, onSelect, readOnly } = props;
  const { t } = useTranslation();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<S.Sheet | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const editable = !readOnly;
  const onMove = props.onMove;

  // The page editor treats a drag inside a block as dragging the block; a tab
  // drag is handled here and never reaches it.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !editable) return;
    const start = (e: DragEvent) => {
      const tab = (e.target as HTMLElement).closest?.("[data-tab-id]");
      e.stopPropagation();
      if (!tab || !e.dataTransfer) return;
      e.dataTransfer.setData(DRAG_TYPE, tab.getAttribute("data-tab-id") ?? "");
      e.dataTransfer.effectAllowed = "move";
    };
    bar.addEventListener("dragstart", start);
    return () => bar.removeEventListener("dragstart", start);
  }, [editable]);

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    const current = sheets.find((s) => s.id === renaming.id);
    if (name && current && name !== current.name)
      props.onRename?.(renaming.id, name);
    setRenaming(null);
  };

  return (
    <div className={classes.tabs} role="tablist" ref={barRef}>
      {sheets.map((s) => {
        const active = s.id === activeId;
        if (renaming?.id === s.id) {
          return (
            <TextInput
              key={s.id}
              size="xs"
              autoFocus
              aria-label={t("Sheet name")}
              value={renaming.name}
              onChange={(e) =>
                setRenaming({ id: s.id, name: e.currentTarget.value })
              }
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              styles={{ input: { height: 26, minHeight: 26, width: 120 } }}
            />
          );
        }
        return (
          <Menu
            key={s.id}
            opened={editable && menuFor === s.id}
            // opens from a right-click or the chevron only; a click switches tabs
            onChange={(open) => {
              if (!open) setMenuFor(null);
            }}
            position="top-start"
            withinPortal
          >
            <Menu.Target>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                data-tab-id={s.id}
                aria-label={s.name}
                draggable={editable}
                className={clsx(
                  classes.tab,
                  active && classes.tabActive,
                  dragOver === s.id && classes.tabDragOver,
                )}
                onClick={() => onSelect(s.id)}
                onDoubleClick={() =>
                  editable && setRenaming({ id: s.id, name: s.name })
                }
                onContextMenu={(e) => {
                  if (!editable) return;
                  e.preventDefault();
                  onSelect(s.id);
                  setMenuFor(s.id);
                }}
                onDragOver={(e) => {
                  if (!editable) return;
                  e.preventDefault();
                  setDragOver(s.id);
                }}
                onDragLeave={() => setDragOver((v) => (v === s.id ? null : v))}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(null);
                  const id = e.dataTransfer?.getData(DRAG_TYPE);
                  if (id && id !== s.id) onMove?.(id, s.id);
                }}
              >
                {s.name}
                {active && editable && (
                  <IconChevronDown
                    size={12}
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(s.id);
                    }}
                  />
                )}
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconPencil size={14} />}
                onClick={() => setRenaming({ id: s.id, name: s.name })}
              >
                {t("Rename")}
              </Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={14} />}
                disabled={sheets.length <= 1}
                onClick={() => sheets.length > 1 && setDeleting(s)}
              >
                {t("Delete")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        );
      })}
      {editable && props.onAdd && (
        <Tooltip label={t("Add sheet")} withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={t("Add sheet")}
            onClick={props.onAdd}
            style={{ alignSelf: "center" }}
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Tooltip>
      )}

      <Modal
        opened={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? t("Delete {{name}}?", { name: deleting.name }) : ""}
        size="sm"
      >
        <Text size="sm">
          {t(
            "The sheet and its cells are deleted. Formulas that refer to it show #REF!.",
          )}
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setDeleting(null)}>
            {t("Cancel")}
          </Button>
          <Button
            color="red"
            onClick={() => {
              if (deleting && sheets.length > 1) props.onDelete?.(deleting.id);
              setDeleting(null);
            }}
          >
            {t("Delete sheet")}
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
