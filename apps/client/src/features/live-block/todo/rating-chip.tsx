import type { MouseEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import type { todo } from "@docmost/live-blocks";
import classes from "./todo.module.css";

export type RatingKind = "effort" | "time" | "priority";

const LEVELS = [1, 2, 3] as const;

function Flame({ lit }: { lit: boolean }) {
  return (
    <svg
      className={clsx(classes.flame, lit && classes.flameLit)}
      data-lit={lit ? "" : undefined}
      width={10}
      height={10}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

/**
 * One of the three ratings. Effort shows as bars, time as dots and priority as
 * flames. Without `onClick` it is a plain badge.
 */
export function RatingChip({
  kind,
  value,
  onClick,
}: {
  kind: RatingKind;
  value: todo.Rating;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const names = {
    effort: t("Effort"),
    time: t("Time"),
    priority: t("Priority"),
  };
  const levels = {
    effort: [t("Not set"), t("Low"), t("Medium"), t("High")],
    time: [t("Not set"), t("Quick"), t("Medium"), t("Long")],
    priority: [t("Not set"), t("Low"), t("High"), t("Burning")],
  };
  const label = `${names[kind]}: ${levels[kind][value]}`;

  const marks =
    kind === "priority" ? (
      <span className={classes.marks}>
        {LEVELS.map((n) => (
          <Flame key={n} lit={value >= n} />
        ))}
      </span>
    ) : (
      <>
        <span className={classes.ratingKey}>
          {kind === "effort" ? "E" : "T"}
        </span>
        <span className={classes.marks}>
          {LEVELS.map((n) => (
            <span
              key={n}
              data-lit={value >= n ? "" : undefined}
              className={clsx(
                kind === "effort" ? classes.bar : classes.dot,
                kind === "effort" && classes[`bar${n}`],
                value >= n && classes.markLit,
              )}
            />
          ))}
        </span>
      </>
    );

  const className = clsx(
    classes.rating,
    classes[`rating_${kind}`],
    value > 0 && classes.ratingSet,
  );

  if (!onClick) {
    // a reader has nothing to set: an empty badge only takes room from the text
    if (value === 0) return null;
    return (
      <span className={className} title={label} role="img" aria-label={label}>
        {marks}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      // hidden on a resting row (CSS) so the text gets the room
      data-unset={value === 0 ? "" : undefined}
      // a click on a chip must not start dragging the card or panning the canvas
      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {marks}
    </button>
  );
}
