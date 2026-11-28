import { useCallback, useEffect, useRef } from "react";
import { Button, ActionIcon, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  IconGripVertical,
  IconList,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { todo as B } from "@docmost/live-blocks";
import { startPointerDrag } from "./pointer-drag";
import { RatingChip } from "./rating-chip";
import { TodoItem } from "./todo-item";
import { useTodoContext } from "./todo-context";
import { useDraftText } from "./use-draft-text";
import classes from "./todo.module.css";

/** Runs the latest queued write once per frame; `now` runs it straight away. */
function useFrameWriter() {
  const pending = useRef<(() => void) | null>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const now = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);
  const queue = useCallback(
    (run: () => void) => {
      pending.current = run;
      if (!frame.current) frame.current = requestAnimationFrame(now);
    },
    [now],
  );
  return { queue, now };
}

export function TodoCard({
  column,
  zoom,
  canDelete,
}: {
  column: B.TodoColumn;
  zoom: number;
  canDelete: boolean;
}) {
  const { t } = useTranslation();
  const { view, readOnly, apply, requestFocus, registerFlush } =
    useTodoContext();
  const cardRef = useRef<HTMLDivElement>(null);
  const writer = useFrameWriter();
  const id = column.id;

  const title = useDraftText(
    column.title,
    (value) => apply((d) => B.renameColumn(d, id, value)),
    registerFlush,
  );

  const progress = B.countProgress(column.nodes);
  const visible = B.viewNodes(column.nodes, view);
  const width = B.effectiveColumnWidth(column);

  const startMove = (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    // the title, ratings and delete button are not drag handles
    if ((e.target as Element).closest("input,button")) return;
    e.stopPropagation();
    const { x, y } = column;
    startPointerDrag(
      e,
      (dx, dy) =>
        writer.queue(() =>
          apply((d) =>
            B.setColumnPosition(d, id, x + dx / zoom, y + dy / zoom),
          ),
        ),
      writer.now,
    );
  };

  const startResize = (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    e.stopPropagation();
    const start = cardRef.current?.offsetWidth || width;
    startPointerDrag(
      e,
      (dx) =>
        writer.queue(() =>
          apply((d) => B.setColumnWidth(d, id, start + dx / zoom)),
        ),
      writer.now,
    );
  };

  const addNode = (node: B.TodoNode) => {
    apply((d) => B.appendToColumn(d, id, node));
    requestFocus(node.id);
  };

  const remove = () => {
    const hasItems = column.nodes.some(
      (n) => n.text.trim() || n.children.length,
    );
    if (!hasItems) return apply((d) => B.removeColumn(d, id));
    modals.openConfirmModal({
      title: t("Delete card"),
      centered: true,
      children: (
        <Text size="sm">
          {t('Delete the card "{{title}}" and all its items?', {
            title: column.title.trim() || t("Untitled"),
          })}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => apply((d) => B.removeColumn(d, id)),
    });
  };

  return (
    <div
      ref={cardRef}
      className={classes.card}
      data-todo-card={id}
      style={{ left: column.x, top: column.y, width }}
    >
      <div className={classes.cardHead} onPointerDown={startMove}>
        <span className={classes.grip} aria-hidden="true">
          <IconGripVertical size={14} />
        </span>
        <input
          className={classes.cardTitle}
          value={title.draft}
          readOnly={readOnly}
          placeholder={t("Card title")}
          aria-label={t("Card title")}
          onChange={(e) => title.onChange(e.currentTarget.value)}
          onBlur={title.flush}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <div className={classes.cardRatings}>
          <RatingChip
            kind="priority"
            value={column.priority}
            onClick={
              readOnly
                ? undefined
                : () => apply((d) => B.cycleColumnPriority(d, id))
            }
          />
          <RatingChip
            kind="effort"
            value={column.effort}
            onClick={
              readOnly
                ? undefined
                : () => apply((d) => B.cycleColumnEffort(d, id))
            }
          />
          <RatingChip
            kind="time"
            value={column.time}
            onClick={
              readOnly
                ? undefined
                : () => apply((d) => B.cycleColumnTime(d, id))
            }
          />
        </div>
        {progress.total > 0 && (
          <span className={classes.count}>
            {progress.done}/{progress.total}
          </span>
        )}
        {!readOnly && canDelete && (
          <Tooltip label={t("Delete card")} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              aria-label={t("Delete card")}
              onClick={remove}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>

      {progress.total > 0 && (
        <div className={classes.progress}>
          <span
            className={classes.progressFill}
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}

      <div className={classes.nodes}>
        {visible.map((node) => (
          <TodoItem key={node.id} node={node} depth={0} />
        ))}
        {column.nodes.length === 0 ? (
          <p className={classes.empty}>{t("No items yet.")}</p>
        ) : (
          visible.length === 0 && (
            <p className={classes.empty}>{t("Everything is done.")}</p>
          )
        )}
      </div>

      {!readOnly && (
        <div className={classes.cardFoot}>
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconPlus size={12} />}
            onClick={() => addNode(B.newTask(""))}
          >
            {t("Task")}
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconList size={12} />}
            onClick={() => addNode(B.newSection(""))}
          >
            {t("Section")}
          </Button>
        </div>
      )}

      <div
        className={clsx(
          classes.resizeHandle,
          column.width !== null && classes.resizeHandleExplicit,
        )}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize card")}
        title={t("Drag to resize, double-click to fit the content")}
        onPointerDown={startResize}
        onDoubleClick={() =>
          !readOnly && apply((d) => B.clearColumnWidth(d, id))
        }
      />
    </div>
  );
}
