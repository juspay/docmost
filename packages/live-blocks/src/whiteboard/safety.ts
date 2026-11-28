import type { WhiteboardElement } from './reconcile';

/**
 * What a board may show its viewers. A board is written by any editor (and by
 * MCP and the import), and Excalidraw renders some elements as live HTML:
 * `iframe` and `magicframe` (a frame with `srcDoc` from
 * `customData.generationData.html`, with scripts allowed) and `embeddable`
 * (an iframe of its link). Those never reach a viewer unchecked.
 */
export const SAFE_ELEMENT_TYPES = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'text',
  'line',
  'arrow',
  'freedraw',
  'image',
  'frame',
  'embeddable',
]);

const YOUTUBE_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'www.youtube-nocookie.com',
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_LIST = /^[A-Za-z0-9_-]{10,64}$/;
const VIMEO_ID = /^\d{1,12}$/;
const FIGMA_KEY = /^[A-Za-z0-9]{10,64}$/;

/** `t` or `start` in seconds, or as 1h2m3s; anything else is ignored. */
function startSeconds(url: URL): number {
  const raw = url.searchParams.get('start') ?? url.searchParams.get('t');
  if (!raw) return 0;
  if (/^\d{1,6}$/.test(raw)) return Number(raw);
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(raw);
  if (!m || raw === '') return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function youtube(id: string, url: URL): string {
  const start = startSeconds(url);
  return `https://www.youtube.com/embed/${id}${start > 0 ? `?start=${start}` : ''}`;
}

/**
 * The only embeds a board may show, rebuilt from the id in the parsed URL:
 * YouTube, Vimeo and Figma. Nothing else of the original link (query,
 * fragment, extra path) is carried over, so no accepted link can reach one of
 * Excalidraw's other renderers (Twitter, Gist, generic iframe, srcdoc), which
 * it picks by unanchored patterns over the whole link. Returns null otherwise.
 */
export function canonicalEmbedLink(link: unknown): string | null {
  if (typeof link !== 'string' || link.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return null;
  }
  const host = url.hostname;
  const path = url.pathname;
  if (host === 'youtu.be') {
    const m = /^\/([^/]+)$/.exec(path);
    return m && YOUTUBE_ID.test(m[1]) ? youtube(m[1], url) : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    if (path === '/watch') {
      const v = url.searchParams.get('v');
      return v && YOUTUBE_ID.test(v) ? youtube(v, url) : null;
    }
    if (path === '/playlist' || path === '/embed/videoseries') {
      const list = url.searchParams.get('list');
      return list && YOUTUBE_LIST.test(list)
        ? `https://www.youtube.com/playlist?list=${list}`
        : null;
    }
    const m = /^\/(?:embed|shorts|live)\/([^/]+)$/.exec(path);
    return m && YOUTUBE_ID.test(m[1]) ? youtube(m[1], url) : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m =
      host === 'vimeo.com'
        ? /^\/([^/]+)$/.exec(path)
        : /^\/video\/([^/]+)$/.exec(path);
    return m && VIMEO_ID.test(m[1])
      ? `https://player.vimeo.com/video/${m[1]}`
      : null;
  }
  if (host === 'www.figma.com' || host === 'figma.com') {
    const m = /^\/(file|design|proto|board)\/([^/]+)(?:\/[^/]*)?$/.exec(path);
    return m && FIGMA_KEY.test(m[2])
      ? `https://www.figma.com/${m[1]}/${m[2]}`
      : null;
  }
  return null;
}

/** An embed link a viewer may load: exactly the canonical form of an accepted link. */
export function isSafeEmbedLink(link: unknown): boolean {
  return typeof link === 'string' && canonicalEmbedLink(link) === link;
}

/** A link a viewer may follow: http(s), mailto, or within the app. */
export function isSafeLink(link: unknown): boolean {
  if (typeof link !== 'string') return false;
  // browsers drop tabs and newlines anywhere in a URL, and read \ as /
  const trimmed = link.trim().replace(/[\t\n\r]/g, '');
  if (trimmed === '') return true;
  if (/^[?#]/.test(trimmed)) return true;
  if (trimmed.startsWith('/')) {
    // "//host", "/\\host" or "/%5chost" leaves the site
    return !/^\/(?:[/\\]|%5c)/i.test(trimmed);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) return false;
  return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase());
}

const hasGeneratedHtml = (el: Record<string, unknown>) => {
  const custom = el.customData;
  return (
    typeof custom === 'object' &&
    custom !== null &&
    'generationData' in (custom as Record<string, unknown>)
  );
};

/** Why an element may not be stored, or null when it may. */
export function unsafeReason(el: Record<string, unknown>): string | null {
  if (typeof el.type !== 'string' || !SAFE_ELEMENT_TYPES.has(el.type)) {
    return `an element type that is not allowed: ${String(el.type).slice(0, 40)}`;
  }
  if (hasGeneratedHtml(el)) return 'generated HTML in custom data';
  if (el.link !== undefined && el.link !== null && !isSafeLink(el.link)) {
    return 'a link that is not http, https or mailto';
  }
  if (el.type === 'embeddable' && !canonicalEmbedLink(el.link)) {
    return 'an embedded page that is not a YouTube, Vimeo or Figma link';
  }
  return null;
}

/**
 * The element as a viewer may see it, or null to leave it out: unsafe types
 * and embeds are dropped, custom data and unsafe links are removed.
 */
export function sanitizeElement(
  el: WhiteboardElement,
): WhiteboardElement | null {
  if (typeof el.type !== 'string' || !SAFE_ELEMENT_TYPES.has(el.type)) {
    return null;
  }
  let embedLink: string | null = null;
  if (el.type === 'embeddable') {
    embedLink = canonicalEmbedLink(el.link);
    if (!embedLink) return null;
  }
  if (
    !('customData' in el) &&
    (el.type === 'embeddable'
      ? embedLink === el.link
      : el.link == null || isSafeLink(el.link))
  ) {
    return el;
  }
  const copy: WhiteboardElement = { ...el };
  if (embedLink) copy.link = embedLink;
  delete copy.customData;
  if (copy.link != null && !isSafeLink(copy.link)) copy.link = null;
  return copy;
}

export type AlteredElement = { id: string; reason: string };

const isBinding = (v: unknown, removed: Set<string>) =>
  typeof v === 'object' &&
  v !== null &&
  removed.has((v as { elementId?: unknown }).elementId as string);

/**
 * Clears every reference to a removed element, in one pass: arrow bindings
 * become null, a child leaves its frame, bound text whose container was
 * removed stays as free text, and boundElements entries for it are filtered.
 * Elements with no such reference are returned as they were.
 */
export function dropReferences(
  elements: readonly WhiteboardElement[],
  removed: Set<string>,
): { elements: WhiteboardElement[]; altered: AlteredElement[] } {
  const altered: AlteredElement[] = [];
  if (removed.size === 0) return { elements: [...elements], altered };
  const out = elements.map((el) => {
    let copy: WhiteboardElement | null = null;
    const edit = () => (copy ??= { ...el });
    let binding = false;
    for (const key of ['startBinding', 'endBinding']) {
      if (isBinding(el[key], removed)) {
        edit()[key] = null;
        binding = true;
      }
    }
    if (Array.isArray(el.boundElements)) {
      const kept = el.boundElements.filter(
        (b: unknown) =>
          !(
            typeof b === 'object' &&
            b !== null &&
            removed.has((b as { id?: unknown }).id as string)
          ),
      );
      if (kept.length !== el.boundElements.length) {
        edit().boundElements = kept;
        binding = true;
      }
    }
    const id = el.id.slice(0, 200);
    if (binding)
      altered.push({ id, reason: 'binding to a removed element cleared' });
    if (typeof el.containerId === 'string' && removed.has(el.containerId)) {
      edit().containerId = null;
      altered.push({ id, reason: 'container was removed; kept as free text' });
    }
    if (typeof el.frameId === 'string' && removed.has(el.frameId)) {
      edit().frameId = null;
      altered.push({ id, reason: 'frame was removed; kept outside it' });
    }
    return copy ?? el;
  });
  return { elements: out, altered };
}

export function sanitizeElements(
  elements: readonly WhiteboardElement[],
): WhiteboardElement[] {
  const out: WhiteboardElement[] = [];
  const removed = new Set<string>();
  for (const el of elements) {
    const safe = sanitizeElement(el);
    if (safe) out.push(safe);
    else if (typeof el?.id === 'string') removed.add(el.id);
  }
  return dropReferences(out, removed).elements;
}

export type RemovedElement = { id: string | null; reason: string };

/** A link typed without a scheme ("example.com/x"), as Excalidraw stores it. */
const BARE_HOST_LINK = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]|$)/i;

/**
 * Untrusted elements made safe instead of refused, for imports and any other
 * caller that would rather keep a board than lose it:
 * - an element without a string id, or of a type that is not allowed, is dropped;
 * - a repeated id keeps the first copy;
 * - a link without a scheme gets https://, any other unsafe link is removed;
 * - an embed that is not a YouTube, Vimeo or Figma link becomes a plain
 *   rectangle with no link; an accepted one gets its canonical link;
 * - custom data is removed.
 * Returns the kept elements (copies when changed) and what was removed and why.
 */
export function cleanElements(elements: readonly unknown[]): {
  elements: WhiteboardElement[];
  removed: RemovedElement[];
  /** kept elements whose references to a removed element were cleared */
  altered: AlteredElement[];
} {
  const kept: WhiteboardElement[] = [];
  const removed: RemovedElement[] = [];
  const seen = new Set<string>();
  // ids no kept element carries (a repeated id keeps its first copy, so it stays)
  const gone = new Set<string>();
  for (const raw of elements) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as WhiteboardElement).id !== 'string'
    ) {
      removed.push({
        id: null,
        reason: 'dropped: not an element with a string id',
      });
      continue;
    }
    const el = raw as WhiteboardElement;
    const id = el.id.slice(0, 200);
    if (seen.has(el.id)) {
      removed.push({ id, reason: 'dropped: repeated element id' });
      continue;
    }
    seen.add(el.id);
    if (typeof el.type !== 'string' || !SAFE_ELEMENT_TYPES.has(el.type)) {
      removed.push({
        id,
        reason: `dropped: element type ${String(el.type).slice(0, 40)} is not allowed`,
      });
      gone.add(el.id);
      continue;
    }
    const copy: WhiteboardElement = { ...el };
    delete copy.customData;
    if (copy.type === 'embeddable') {
      const canonical = canonicalEmbedLink(copy.link);
      if (canonical) copy.link = canonical;
      else {
        copy.type = 'rectangle';
        copy.link = null;
        removed.push({
          id,
          reason:
            'embed replaced by a plain rectangle: not a YouTube, Vimeo or Figma link',
        });
      }
    } else if (copy.link != null && !isSafeLink(copy.link)) {
      if (
        typeof copy.link === 'string' &&
        BARE_HOST_LINK.test(copy.link.trim())
      ) {
        copy.link = `https://${copy.link.trim()}`;
      } else {
        copy.link = null;
        removed.push({ id, reason: 'link removed: not http, https or mailto' });
      }
    }
    kept.push(copy);
  }
  const repaired = dropReferences(kept, gone);
  return { elements: repaired.elements, removed, altered: repaired.altered };
}
