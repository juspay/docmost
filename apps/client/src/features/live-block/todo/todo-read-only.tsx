import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { todo as B, type LiveBlockSnapshot } from "@docmost/live-blocks";
import { RatingChip } from "./rating-chip";
import classes from "./todo.module.css";

function Items({ nodes, view }: { nodes: B.TodoNode[]; view: B.TodoView }) {
  return (
    <>
      {B.viewNodes(nodes, view).map((node) => {
        const isTask = node.kind === "task";
        return (
          <div
            key={node.id}
            className={clsx(classes.node, !isTask && classes.nodeSection)}
          >
            <div
              className={clsx(
                classes.row,
                isTask && node.done && classes.rowDone,
              )}
            >
              {isTask ? (
                <span
                  className={clsx(
                    classes.check,
                    node.done && classes.checkChecked,
                  )}
                  role="checkbox"
                  aria-checked={node.done}
                  aria-readonly="true"
                >
                  {node.done && <IconCheck size={11} stroke={3} />}
                </span>
              ) : (
                <span className={classes.sectionMark} aria-hidden="true" />
              )}
              <span className={clsx(classes.readOnlyText, classes.text)}>
                {node.text}
              </span>
              {isTask &&
                (node.priority > 0 || node.effort > 0 || node.time > 0) && (
                  <span className={classes.ratings}>
                    {node.priority > 0 && (
                      <RatingChip kind="priority" value={node.priority} />
                    )}
                    {node.effort > 0 && (
                      <RatingChip kind="effort" value={node.effort} />
                    )}
                    {node.time > 0 && (
                      <RatingChip kind="time" value={node.time} />
                    )}
                  </span>
                )}
            </div>
            {node.children.length > 0 && (
              <div className={classes.children}>
                <Items nodes={node.children} view={view} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The stored board as plain cards, for people who only read the page. */
export default function TodoReadOnly({
  snapshot,
}: {
  snapshot?: LiveBlockSnapshot;
}) {
  const { t } = useTranslation();
  if (
    !snapshot ||
    snapshot.kind !== "todo" ||
    snapshot.board.columns.length === 0
  ) {
    return <p className={classes.empty}>{t("No cards yet.")}</p>;
  }
  const { board } = snapshot;
  return (
    <div className={classes.readOnly} data-testid="todo-read-only">
      {board.columns.map((column) => {
        const progress = B.countProgress(column.nodes);
        return (
          <div
            key={column.id}
            className={classes.readOnlyCard}
            style={{ width: B.effectiveColumnWidth(column) }}
          >
            <div className={classes.cardHead} style={{ cursor: "default" }}>
              <span className={classes.readOnlyTitle}>{column.title}</span>
              <span className={classes.cardRatings}>
                {column.priority > 0 && (
                  <RatingChip kind="priority" value={column.priority} />
                )}
                {column.effort > 0 && (
                  <RatingChip kind="effort" value={column.effort} />
                )}
                {column.time > 0 && (
                  <RatingChip kind="time" value={column.time} />
                )}
              </span>
              {progress.total > 0 && (
                <span className={classes.count}>
                  {progress.done}/{progress.total}
                </span>
              )}
            </div>
            <div className={classes.nodes}>
              <Items nodes={column.nodes} view={board.view} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
