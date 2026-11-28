import { ActionIcon, Button, Menu, Switch, Tooltip } from "@mantine/core";
import {
  IconCheck,
  IconChevronDown,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { todo } from "@docmost/live-blocks";
import classes from "./todo.module.css";

const SORTS: todo.TodoSort[] = ["manual", "effort", "time", "priority"];

export function TodoToolbar({
  view,
  progress,
  zoom,
  canEdit,
  onSort,
  onHideDone,
  onZoom,
  onFit,
  onAddCard,
}: {
  view: todo.TodoView;
  progress: todo.Progress;
  zoom: number;
  canEdit: boolean;
  onSort(sort: todo.TodoSort): void;
  onHideDone(hide: boolean): void;
  onZoom(factor: number): void;
  onFit(): void;
  onAddCard(): void;
}) {
  const { t } = useTranslation();
  const sortNames: Record<todo.TodoSort, string> = {
    manual: t("Manual"),
    effort: t("Effort"),
    time: t("Time"),
    priority: t("Priority"),
  };

  return (
    <div
      className={classes.toolbar}
      role="toolbar"
      aria-label={t("To-do board")}
    >
      {canEdit && (
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={onAddCard}
        >
          {t("Card")}
        </Button>
      )}
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            size="compact-sm"
            variant="default"
            disabled={!canEdit}
            rightSection={<IconChevronDown size={12} />}
            aria-label={t("Sort")}
          >
            {t("Sort")}: {sortNames[view.sort]}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {SORTS.map((sort) => (
            <Menu.Item
              key={sort}
              rightSection={view.sort === sort ? <IconCheck size={14} /> : null}
              onClick={() => onSort(sort)}
            >
              {sortNames[sort]}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <Switch
        size="xs"
        label={t("Hide done")}
        checked={view.hideDone}
        disabled={!canEdit}
        onChange={(e) => onHideDone(e.currentTarget.checked)}
      />
      <span className={classes.toolbarSpacer} />
      {progress.total > 0 && (
        <span className={classes.overall}>
          {t("{{done}} of {{total}} done", progress)}
        </span>
      )}
      <ActionIcon.Group>
        <Tooltip label={t("Zoom out")} withArrow>
          <ActionIcon
            size="md"
            variant="default"
            aria-label={t("Zoom out")}
            onClick={() => onZoom(1 / 1.2)}
          >
            <IconMinus size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Fit all cards in view")} withArrow>
          <Button
            size="compact-md"
            variant="default"
            aria-label={t("Fit all cards in view")}
            onClick={onFit}
            style={{ minWidth: 52 }}
          >
            {Math.round(zoom * 100)}%
          </Button>
        </Tooltip>
        <Tooltip label={t("Zoom in")} withArrow>
          <ActionIcon
            size="md"
            variant="default"
            aria-label={t("Zoom in")}
            onClick={() => onZoom(1.2)}
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Tooltip>
      </ActionIcon.Group>
    </div>
  );
}
