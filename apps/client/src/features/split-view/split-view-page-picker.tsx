import { useTranslation } from "react-i18next";
import { DestinationPickerModal } from "@/components/ui/destination-picker/destination-picker-modal.tsx";
import type { DestinationSelection } from "@/components/ui/destination-picker/destination-picker.types.ts";
import { useSplitView } from "./use-split-view.ts";

export function SplitViewPagePicker({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { open } = useSplitView();

  const onSelect = (selection: DestinationSelection) => {
    if (selection.type !== "page" || !selection.page.slugId) return;
    open(selection.page.slugId);
    onClose();
  };

  return (
    <DestinationPickerModal
      opened={opened}
      onClose={onClose}
      title={t("Open in split view")}
      actionLabel={t("Open")}
      onSelect={onSelect}
    />
  );
}
