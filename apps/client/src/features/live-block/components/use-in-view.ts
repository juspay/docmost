import { type RefObject, useEffect, useState } from "react";

/** True while the element is near the viewport, and for `lingerMs` after it leaves. */
export function useInView(
  ref: RefObject<Element | null>,
  lingerMs: number,
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          if (timer) clearTimeout(timer);
          timer = null;
          setInView(true);
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            setInView(false);
          }, lingerMs);
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [ref, lingerMs]);

  return inView;
}
