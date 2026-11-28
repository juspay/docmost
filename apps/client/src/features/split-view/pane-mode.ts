export function isPaneMode(): boolean {
  try {
    return window.frameElement?.getAttribute("data-docmost-pane") === "1";
  } catch {
    // reading frameElement throws when the parent is another origin
    return false;
  }
}
