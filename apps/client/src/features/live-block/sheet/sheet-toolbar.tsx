import { type ReactNode, useMemo, useState } from "react";
import {
  ActionIcon,
  Button,
  ColorPicker,
  Menu,
  Popover,
  Stack,
  Tooltip,
} from "@mantine/core";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconBold,
  IconBorderAll,
  IconBorderBottom,
  IconBorderHorizontal,
  IconBorderInner,
  IconBorderLeft,
  IconBorderNone,
  IconBorderOuter,
  IconBorderRight,
  IconBorderTop,
  IconBorderVertical,
  IconBucketDroplet,
  IconChevronDown,
  IconClearFormatting,
  IconCurrencyDollar,
  IconIndentDecrease,
  IconIndentIncrease,
  IconItalic,
  IconLayoutAlignBottom,
  IconLayoutAlignMiddle,
  IconLayoutAlignTop,
  IconPercentage,
  IconStrikethrough,
  IconTextColor,
  IconTextWrap,
  IconUnderline,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  IconArrowMergeBoth,
  IconSnowflake,
  IconSortAscending,
  IconSortDescending,
} from "@tabler/icons-react";
import { sheet as S } from "@docmost/live-blocks";
import {
  activeFormat,
  allHave,
  applyBorders,
  type BorderPreset,
  bumpDecimals,
  clearFormatting,
  type FlagKey,
  setFormat,
  setNumberFormat,
  toggleFlag,
  formatIsCut,
  formatWouldOverflow,
} from "./format-actions";
import classes from "./sheet.module.css";

const SWATCHES = [
  "#000000",
  "#495057",
  "#868e96",
  "#ffffff",
  "#c92a2a",
  "#e8590c",
  "#f08c00",
  "#2f9e44",
  "#1971c2",
  "#6741d9",
  "#ffc9c9",
  "#ffec99",
  "#b2f2bb",
  "#a5d8ff",
  "#d0bfff",
];

export type ToolbarProps = {
  sheet: S.Sheet;
  range: S.MergeRange;
  active: { row: number; col: number };
  /** runs a change on a copy of the tab; one undo step */
  apply(mutate: (draft: S.Sheet, range: S.MergeRange) => void): void;
  valueAt(row: number, col: number): S.CellValue;
  /** changes whenever a cell does: the pressed states are worked out once per change */
  version?: number;
  /** structure controls (merge, freeze, sort) added after the format ones */
  children?: ReactNode;
};

function Tool(props: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={props.label} withArrow openDelay={400}>
      <ActionIcon
        variant={props.pressed ? "light" : "subtle"}
        color={props.pressed ? "blue" : "gray"}
        size="md"
        aria-label={props.label}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed}
        onClick={props.onClick}
      >
        {props.children}
      </ActionIcon>
    </Tooltip>
  );
}

function ColorTool(props: {
  label: string;
  icon: ReactNode;
  value?: string;
  onPick(color: string | undefined): void;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const pick = (color: string | undefined) => {
    props.onPick(color);
    setOpened(false);
  };
  return (
    <Popover
      position="bottom"
      withArrow
      shadow="md"
      withinPortal
      opened={opened}
      onChange={setOpened}
    >
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="md"
          aria-label={props.label}
          onClick={() => setOpened((o) => !o)}
        >
          <span
            style={{
              display: "inline-flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            {props.icon}
            <span
              style={{
                width: 14,
                height: 3,
                marginTop: -2,
                background: props.value ?? "transparent",
                border: props.value
                  ? undefined
                  : "1px solid var(--mantine-color-default-border)",
              }}
            />
          </span>
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <ColorPicker
            format="hex"
            swatches={SWATCHES}
            swatchesPerRow={5}
            value={props.value ?? "#000000"}
            onChangeEnd={(c) => props.onPick(c)}
            onColorSwatchClick={(c) => pick(c)}
          />
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => pick(undefined)}
          >
            {t("Reset")}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

const NUMBER_FORMATS: [S.NumberFormat, string, string][] = [
  ["auto", "General", ""],
  ["number", "Number", "1,000.12"],
  ["integer", "Whole number", "1,000"],
  ["currency", "Currency", "$1,000.12"],
  ["accounting", "Accounting", "($1,000.12)"],
  ["percent", "Percent", "10.12%"],
  ["scientific", "Scientific", "1.01E+03"],
  ["date", "Date", "Sep 26, 2026"],
  ["datetime", "Date and time", "Sep 26, 2026 15:59"],
  ["time", "Time", "15:59:00"],
  ["duration", "Duration", "24:01:00"],
  ["text", "Plain text", ""],
];

const BORDER_PRESETS: [BorderPreset, string, ReactNode][] = [
  ["all", "All borders", <IconBorderAll size={16} key="all" />],
  ["outer", "Outer borders", <IconBorderOuter size={16} key="outer" />],
  ["inner", "Inner borders", <IconBorderInner size={16} key="inner" />],
  ["innerH", "Horizontal borders", <IconBorderHorizontal size={16} key="h" />],
  ["innerV", "Vertical borders", <IconBorderVertical size={16} key="v" />],
  ["top", "Top border", <IconBorderTop size={16} key="top" />],
  ["bottom", "Bottom border", <IconBorderBottom size={16} key="bottom" />],
  ["left", "Left border", <IconBorderLeft size={16} key="left" />],
  ["right", "Right border", <IconBorderRight size={16} key="right" />],
  ["none", "No borders", <IconBorderNone size={16} key="none" />],
];

const BORDER_STYLES: S.BorderStyle[] = [
  "thin",
  "medium",
  "thick",
  "dashed",
  "dotted",
  "double",
];

export function SheetToolbar({
  sheet,
  range,
  active,
  apply,
  valueAt,
  version,
  children,
}: ToolbarProps) {
  const { t } = useTranslation();
  // one pass over the selection for all five toggles, not one per render
  const pressed = useMemo(
    () => {
      const out = {} as Record<FlagKey, boolean>;
      for (const key of [
        "bold",
        "italic",
        "underline",
        "strike",
        "wrap",
      ] as FlagKey[]) {
        out[key] = allHave(sheet, range, key);
      }
      return out;
    },
    // cells change in place; version marks each change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, version, range.r1, range.c1, range.r2, range.c2],
  );
  const f = activeFormat(sheet, active.row, active.col);
  const run = (mutate: (draft: S.Sheet, r: S.MergeRange) => void) => {
    if (formatWouldOverflow(sheet, range)) {
      notifications.show({
        color: "yellow",
        message: t("This would make the sheet too large to format"),
      });
      return;
    }
    apply(mutate);
    if (formatIsCut(range)) {
      notifications.show({
        color: "yellow",
        message: t(
          "Only the cells in use were formatted: the selection is too large",
        ),
      });
    }
  };
  const flag = (key: FlagKey, label: string, icon: ReactNode) => (
    <Tool
      label={label}
      pressed={pressed[key]}
      onClick={() => run((d, r) => toggleFlag(d, r, key))}
    >
      {icon}
    </Tool>
  );
  const fmt = (patch: Partial<S.CellFormat>) =>
    run((d, r) => setFormat(d, r, patch));
  const borderRef = { style: "thin" as S.BorderStyle, color: "#495057" };

  return (
    <div
      className={classes.toolbar}
      // a press keeps the focus in the grid, so keys still reach the sheet
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("input, textarea"))
          e.preventDefault();
      }}
      role="toolbar"
      aria-label={t("Formatting")}
    >
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            rightSection={<IconChevronDown size={12} />}
            aria-label={t("Font")}
          >
            {f.font ?? t("Default")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {S.FONT_FAMILIES.map((font) => (
            <Menu.Item
              key={font}
              onClick={() => fmt({ font })}
              style={{
                fontFamily: font === "Default" ? undefined : S.fontStack(font),
              }}
            >
              {font === "Default" ? t("Default") : font}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            rightSection={<IconChevronDown size={12} />}
            aria-label={t("Font size")}
          >
            {f.size ?? S.DEFAULT_FONT_SIZE}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {S.FONT_SIZES.map((size) => (
            <Menu.Item key={size} onClick={() => fmt({ size })}>
              {size}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <span className={classes.toolbarDivider} />
      {flag("bold", t("Bold"), <IconBold size={16} />)}
      {flag("italic", t("Italic"), <IconItalic size={16} />)}
      {flag("underline", t("Underline"), <IconUnderline size={16} />)}
      {flag("strike", t("Strikethrough"), <IconStrikethrough size={16} />)}
      <ColorTool
        label={t("Text color")}
        icon={<IconTextColor size={16} />}
        value={f.color}
        onPick={(color) => fmt({ color })}
      />
      <ColorTool
        label={t("Fill color")}
        icon={<IconBucketDroplet size={16} />}
        value={f.bg}
        onPick={(bg) => fmt({ bg })}
      />
      <span className={classes.toolbarDivider} />
      <Tool
        label={t("Align left")}
        pressed={!f.align || f.align === "left"}
        onClick={() => fmt({ align: "left" })}
      >
        <IconAlignLeft size={16} />
      </Tool>
      <Tool
        label={t("Align center")}
        pressed={f.align === "center"}
        onClick={() => fmt({ align: "center" })}
      >
        <IconAlignCenter size={16} />
      </Tool>
      <Tool
        label={t("Align right")}
        pressed={f.align === "right"}
        onClick={() => fmt({ align: "right" })}
      >
        <IconAlignRight size={16} />
      </Tool>
      <Tool
        label={t("Align top")}
        pressed={f.valign === "top"}
        onClick={() => fmt({ valign: "top" })}
      >
        <IconLayoutAlignTop size={16} />
      </Tool>
      <Tool
        label={t("Align middle")}
        pressed={!f.valign || f.valign === "middle"}
        onClick={() => fmt({ valign: "middle" })}
      >
        <IconLayoutAlignMiddle size={16} />
      </Tool>
      <Tool
        label={t("Align bottom")}
        pressed={f.valign === "bottom"}
        onClick={() => fmt({ valign: "bottom" })}
      >
        <IconLayoutAlignBottom size={16} />
      </Tool>
      <Tool
        label={t("Decrease indent")}
        onClick={() => fmt({ indent: Math.max(0, (f.indent ?? 0) - 1) })}
      >
        <IconIndentDecrease size={16} />
      </Tool>
      <Tool
        label={t("Increase indent")}
        onClick={() =>
          fmt({ indent: Math.min(S.MAX_INDENT, (f.indent ?? 0) + 1) })
        }
      >
        <IconIndentIncrease size={16} />
      </Tool>
      {flag("wrap", t("Wrap text"), <IconTextWrap size={16} />)}
      <span className={classes.toolbarDivider} />
      <Tool
        label={t("Format as currency")}
        pressed={f.numFmt === "currency"}
        onClick={() => run((d, r) => setNumberFormat(d, r, "currency"))}
      >
        <IconCurrencyDollar size={16} />
      </Tool>
      <Tool
        label={t("Format as percent")}
        pressed={f.numFmt === "percent"}
        onClick={() => run((d, r) => setNumberFormat(d, r, "percent"))}
      >
        <IconPercentage size={16} />
      </Tool>
      <Tool
        label={t("Fewer decimals")}
        onClick={() => run((d, r) => bumpDecimals(d, r, -1, valueAt))}
      >
        <span style={{ fontSize: 11, fontWeight: 600 }}>.0</span>
      </Tool>
      <Tool
        label={t("More decimals")}
        onClick={() => run((d, r) => bumpDecimals(d, r, 1, valueAt))}
      >
        <span style={{ fontSize: 11, fontWeight: 600 }}>.00</span>
      </Tool>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            rightSection={<IconChevronDown size={12} />}
            aria-label={t("Number format")}
          >
            {t(
              NUMBER_FORMATS.find(
                ([key]) => key === (f.numFmt ?? "auto"),
              )?.[1] ?? "General",
            )}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {NUMBER_FORMATS.map(([key, label, example]) => (
            <Menu.Item
              key={key}
              onClick={() => run((d, r) => setNumberFormat(d, r, key))}
              rightSection={
                <span style={{ opacity: 0.6, fontSize: 11 }}>{example}</span>
              }
            >
              {t(label)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <Menu position="bottom-start" withinPortal closeOnItemClick>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="md"
            aria-label={t("Borders")}
          >
            <IconBorderAll size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {BORDER_PRESETS.map(([preset, label, icon]) => (
            <Menu.Item
              key={preset}
              leftSection={icon}
              onClick={() =>
                run((d, r) => applyBorders(d, r, preset, borderRef))
              }
            >
              {t(label)}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Label>{t("Border style")}</Menu.Label>
          {BORDER_STYLES.filter((s) => s !== "thin").map((style) => (
            <Menu.Item
              key={style}
              onClick={() =>
                run((d, r) =>
                  applyBorders(d, r, "outer", {
                    style,
                    color: borderRef.color,
                  }),
                )
              }
            >
              {t("Outer border: {{style}}", { style })}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <Tool
        label={t("Clear formatting")}
        onClick={() => run((d, r) => clearFormatting(d, r))}
      >
        <IconClearFormatting size={16} />
      </Tool>
      {children && <span className={classes.toolbarDivider} />}
      {children}
    </div>
  );
}

/** Merge, freeze and sort: the structure controls after the format ones. */
export function StructureTools(props: {
  merged: boolean;
  canMerge: boolean;
  active: { row: number; col: number };
  frozen: { rows: number; cols: number };
  onMerge(): void;
  onUnmerge(): void;
  onFreeze(rows: number, cols: number): void;
  onSort(ascending: boolean): void;
}) {
  const { t } = useTranslation();
  const { active, frozen } = props;
  return (
    <>
      <Tool
        label={props.merged ? t("Unmerge cells") : t("Merge cells")}
        pressed={props.merged}
        onClick={() => {
          if (props.merged) props.onUnmerge();
          else if (props.canMerge) props.onMerge();
        }}
      >
        <IconArrowMergeBoth size={16} />
      </Tool>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <ActionIcon
            variant={frozen.rows || frozen.cols ? "light" : "subtle"}
            color={frozen.rows || frozen.cols ? "blue" : "gray"}
            size="md"
            aria-label={t("Freeze")}
          >
            <IconSnowflake size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => props.onFreeze(active.row + 1, frozen.cols)}
          >
            {t("Freeze up to row {{row}}", { row: active.row + 1 })}
          </Menu.Item>
          <Menu.Item
            onClick={() => props.onFreeze(frozen.rows, active.col + 1)}
          >
            {t("Freeze up to column {{col}}", {
              col: S.colToLetter(active.col),
            })}
          </Menu.Item>
          <Menu.Item
            onClick={() => props.onFreeze(active.row + 1, active.col + 1)}
          >
            {t("Freeze up to {{cell}}", {
              cell: S.toA1(active.row, active.col),
            })}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            disabled={!frozen.rows && !frozen.cols}
            onClick={() => props.onFreeze(0, 0)}
          >
            {t("Unfreeze")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Tool label={t("Sort A to Z")} onClick={() => props.onSort(true)}>
        <IconSortAscending size={16} />
      </Tool>
      <Tool label={t("Sort Z to A")} onClick={() => props.onSort(false)}>
        <IconSortDescending size={16} />
      </Tool>
    </>
  );
}
