import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Button,
  Checkbox,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { sheet as S } from "@docmost/live-blocks";
import { findMatches, replaceAll, replaceInText } from "./find-replace";
import type { CellPos } from "./use-grid-selection";
import classes from "./sheet.module.css";

type FindBarProps = {
  sheet: S.Sheet;
  /** changes whenever a cell does */
  version: number;
  readOnly: boolean;
  onClose(): void;
  /** selects a match and brings it into view */
  onGoto(pos: CellPos): void;
  setCell(row: number, col: number, input: string): void;
  applyToSheet(mutate: (draft: S.Sheet) => void): void;
  /** the highlighted cells: "match", and "current" for the selected one */
  onHighlight(found: Map<string, "match" | "current">): void;
};

export function FindReplaceBar(props: FindBarProps) {
  const { sheet, readOnly, onGoto, onHighlight } = props;
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [inFormulas, setInFormulas] = useState(false);
  const [index, setIndex] = useState(0);

  const matches = useMemo(
    () => findMatches(sheet, query, { matchCase, inFormulas }),
    // cells change in place; version marks each change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, props.version, query, matchCase, inFormulas],
  );
  const current = matches.length ? Math.min(index, matches.length - 1) : -1;

  useEffect(() => {
    const found = new Map<string, "match" | "current">();
    matches.forEach((m, i) =>
      found.set(`${m.row}:${m.col}`, i === current ? "current" : "match"),
    );
    onHighlight(found);
  }, [matches, current, onHighlight]);
  useEffect(() => () => onHighlight(new Map()), [onHighlight]);

  const go = (delta: number) => {
    if (!matches.length) return;
    const next = (current + delta + matches.length) % matches.length;
    setIndex(next);
    onGoto(matches[next]);
  };

  const replaceCurrent = () => {
    if (current < 0) return;
    const m = matches[current];
    const raw = S.getRaw(sheet, m.row, m.col);
    props.setCell(
      m.row,
      m.col,
      replaceInText(raw, query, replacement, matchCase),
    );
  };

  const replaceEverything = () => {
    if (!matches.length) return;
    props.applyToSheet((draft) =>
      replaceAll(draft, matches, query, replacement, matchCase),
    );
  };

  const stopKeys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") props.onClose();
  };

  return (
    <div className={classes.findBar} role="search" data-sheet-find>
      <TextInput
        size="xs"
        autoFocus
        aria-label={t("Find")}
        placeholder={t("Find")}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          stopKeys(e);
          if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
        }}
        w={150}
      />
      <Text size="xs" c="dimmed" w={64} ta="center">
        {query
          ? matches.length
            ? t("{{current}} of {{total}}", {
                current: current + 1,
                total: matches.length,
              })
            : t("No matches")
          : ""}
      </Text>
      <Tooltip label={t("Previous")} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t("Previous")}
          onClick={() => go(-1)}
        >
          <IconChevronUp size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t("Next")} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t("Next")}
          onClick={() => go(1)}
        >
          <IconChevronDown size={16} />
        </ActionIcon>
      </Tooltip>
      {!readOnly && (
        <>
          <TextInput
            size="xs"
            aria-label={t("Replace with")}
            placeholder={t("Replace with")}
            value={replacement}
            onChange={(e) => setReplacement(e.currentTarget.value)}
            onKeyDown={stopKeys}
            w={150}
          />
          <Button
            size="compact-xs"
            variant="default"
            onClick={replaceCurrent}
            disabled={current < 0}
          >
            {t("Replace")}
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={replaceEverything}
            disabled={!matches.length}
          >
            {t("Replace all")}
          </Button>
        </>
      )}
      <Checkbox
        size="xs"
        label={t("Match case")}
        checked={matchCase}
        onChange={(e) => setMatchCase(e.currentTarget.checked)}
      />
      <Checkbox
        size="xs"
        label={t("Search in formulas")}
        checked={inFormulas}
        onChange={(e) => setInFormulas(e.currentTarget.checked)}
      />
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={t("Close")}
        onClick={props.onClose}
      >
        <IconX size={16} />
      </ActionIcon>
    </div>
  );
}
