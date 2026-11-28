import { useCallback, useEffect, useRef, useState } from "react";

export const TEXT_WRITE_DELAY_MS = 400;

/**
 * A text field that keeps what is being typed locally and writes it when the
 * field loses focus or after a pause in typing, not on every key. A remote
 * change shows up unless there is something typed here that is not written yet.
 */
export function useDraftText(
  value: string,
  commit: (text: string) => void,
  registerFlush?: (fn: () => void) => () => void,
) {
  const [draft, setDraft] = useState(value);
  const state = useRef({
    draft: value,
    dirty: false,
    timer: null as ReturnType<typeof setTimeout> | null,
    value,
    commit,
  });
  state.current.value = value;
  state.current.commit = commit;

  const flush = useCallback(() => {
    const s = state.current;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (!s.dirty) return;
    s.dirty = false;
    if (s.draft !== s.value) s.commit(s.draft);
  }, []);

  useEffect(() => {
    if (state.current.dirty) return;
    state.current.draft = value;
    setDraft(value);
  }, [value]);

  useEffect(() => registerFlush?.(flush), [registerFlush, flush]);
  // leaving the page or closing the block must not lose the last words
  useEffect(() => flush, [flush]);

  const onChange = useCallback(
    (text: string) => {
      const s = state.current;
      s.draft = text;
      s.dirty = true;
      setDraft(text);
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(flush, TEXT_WRITE_DELAY_MS);
    },
    [flush],
  );

  return { draft, onChange, flush };
}
