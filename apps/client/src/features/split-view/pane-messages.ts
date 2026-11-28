export type PaneLocationMessage = {
  type: "docmost:pane-location";
  pathname: string;
  slugId: string | null;
};

export type PaneAuthExpiredMessage = { type: "docmost:pane-auth-expired" };

function fromOurPane(event: MessageEvent, frame: HTMLIFrameElement | null) {
  return (
    !!frame?.contentWindow &&
    event.origin === window.location.origin &&
    event.source === frame.contentWindow
  );
}

export function isPaneLocationMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): event is MessageEvent<PaneLocationMessage> {
  if (!fromOurPane(event, frame)) return false;
  const data = event.data;
  return (
    !!data &&
    typeof data === "object" &&
    data.type === "docmost:pane-location" &&
    typeof data.pathname === "string" &&
    (data.slugId === null || typeof data.slugId === "string")
  );
}

export function isPaneAuthExpiredMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): event is MessageEvent<PaneAuthExpiredMessage> {
  return (
    fromOurPane(event, frame) &&
    !!event.data &&
    typeof event.data === "object" &&
    event.data.type === "docmost:pane-auth-expired"
  );
}

export function postToParent(message: PaneLocationMessage | PaneAuthExpiredMessage) {
  window.parent.postMessage(message, window.location.origin);
}
