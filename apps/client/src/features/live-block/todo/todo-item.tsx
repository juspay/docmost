import { useEffect, useRef } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import {
  IconCheck,
  IconChevronRight,
  IconList,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { todo as B } from "@docmost/live-blocks";
import { RatingChip } from "./rating-chip";
import { useTodoContext } from "./todo-context";
import { useDraftText } from "./use-draft-text";
import classes from "./todo.module.css";

export function TodoItem({ node, depth }: { node: B.TodoNode; depth: number }) {
  const { t } = useTranslation();
  const { view, readOnly, apply, focusId, requestFocus, registerFlush } =
    useTodoContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const isTask = node.kind === "task";
  const id = node.id;

  const text = useDraftText(
    node.text,
    (value) => apply((d) => B.setText(d, id, value)),
    registerFlush,
  );

  useEffect(() => {
    if (focusId !== id || !inputRef.current) return;
    inputRef.current.focus();
    requestFocus(null);
  }, [focusId, id, requestFocus]);

  const hasChildren = node.children.length > 0;
  const progress = hasChildren ? B.countProgress(node.children) : null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (readOnly) return;
    const mod = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    if (e.key === "Enter" && !shift) {
      e.preventDefault();
      text.flush();
      if (mod) {
        if (isTask) apply((d) => B.toggleDone(d, id));
        return;
      }
      const created = B.newTask("");
      apply((d) => B.addSiblingAfter(d, id, created));
      requestFocus(created.id);
    } else if (e.key === "Tab") {
      e.preventDefault();
      text.flush();
      apply((d) => (shift ? B.outdentNode(d, id) : B.indentNode(d, id)));
      requestFocus(id);
    } else if (e.key === "Backspace" && text.draft === "" && !hasChildren) {
      e.preventDefault();
      const card = e.currentTarget.closest("[data-todo-card]");
      const fields = Array.from(
        card?.querySelectorAll<HTMLInputElement>("input[data-todo-input]") ??
          [],
      );
      const above = fields[fields.indexOf(e.currentTarget) - 1];
      apply((d) => B.removeNode(d, id));
      above?.focus();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      text.flush();
      apply((d) => B.moveNode(d, id, e.key === "ArrowUp" ? -1 : 1));
      requestFocus(id);
    }
  };

  return (
    <div
      className={clsx(classes.node, !isTask && classes.nodeSection)}
      data-depth={depth}
    >
      <div
        className={clsx(classes.row, isTask && node.done && classes.rowDone)}
      >
        <button
          type="button"
          className={clsx(
            classes.twisty,
            !hasChildren && classes.twistyHidden,
            node.collapsed && classes.twistyCollapsed,
          )}
          aria-label={node.collapsed ? t("Expand") : t("Collapse")}
          aria-hidden={hasChildren ? undefined : true}
          tabIndex={hasChildren ? 0 : -1}
          onClick={() => apply((d) => B.toggleCollapsed(d, id))}
          disabled={!hasChildren}
        >
          <IconChevronRight size={12} />
        </button>

        {isTask ? (
          <button
            type="button"
            className={clsx(classes.check, node.done && classes.checkChecked)}
            role="checkbox"
            aria-checked={node.done}
            aria-label={node.done ? t("Mark not done") : t("Mark done")}
            disabled={readOnly}
            onClick={() => apply((d) => B.toggleDone(d, id))}
          >
            {node.done && <IconCheck size={11} stroke={3} />}
          </button>
        ) : (
          <span className={classes.sectionMark} aria-hidden="true" />
        )}

        <input
          ref={inputRef}
          data-todo-input=""
          className={classes.text}
          value={text.draft}
          readOnly={readOnly}
          placeholder={isTask ? t("To-do") : t("Section title")}
          aria-label={isTask ? t("To-do item") : t("Section title")}
          onChange={(e) => text.onChange(e.currentTarget.value)}
          onBlur={text.flush}
          onKeyDown={onKeyDown}
        />

        {progress && node.collapsed && progress.total > 0 && (
          <span className={classes.count}>
            {progress.done}/{progress.total}
          </span>
        )}

        {!readOnly && (
          <div className={classes.actions}>
            <Tooltip
              label={
                isTask
                  ? t("Turn into a section heading")
                  : t("Turn into a to-do item")
              }
              withArrow
            >
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                aria-label={
                  isTask
                    ? t("Turn into a section heading")
                    : t("Turn into a to-do item")
                }
                onClick={() => apply((d) => B.toggleNodeKind(d, id))}
              >
                {isTask ? <IconList size={12} /> : <IconCheck size={12} />}
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Add sub-item")} withArrow>
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                aria-label={t("Add sub-item")}
                onClick={() => {
                  text.flush();
                  const created = B.newTask("");
                  apply((d) => B.addChild(d, id, created));
                  requestFocus(created.id);
                }}
              >
                <IconPlus size={12} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Delete item")} withArrow>
              <ActionIcon
                size="xs"
                variant="subtle"
                color="red"
                aria-label={t("Delete item")}
                onClick={() => apply((d) => B.removeNode(d, id))}
              >
                <IconTrash size={12} />
              </ActionIcon>
            </Tooltip>
          </div>
        )}

        {isTask && (
          <div className={classes.ratings}>
            <RatingChip
              kind="priority"
              value={node.priority}
              onClick={
                readOnly
                  ? undefined
                  : () => apply((d) => B.cyclePriority(d, id))
              }
            />
            <RatingChip
              kind="effort"
              value={node.effort}
              onClick={
                readOnly ? undefined : () => apply((d) => B.cycleEffort(d, id))
              }
            />
            <RatingChip
              kind="time"
              value={node.time}
              onClick={
                readOnly ? undefined : () => apply((d) => B.cycleTime(d, id))
              }
            />
          </div>
        )}
      </div>

      {hasChildren && !node.collapsed && (
        <div className={classes.children}>
          {B.viewNodes(node.children, view).map((child) => (
            <TodoItem key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
