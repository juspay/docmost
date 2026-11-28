// The person dismissed the browser's passkey prompt: nothing to report.
export function isPromptCancelled(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError";
}
