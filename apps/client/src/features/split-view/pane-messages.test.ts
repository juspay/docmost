import { describe, expect, it } from "vitest";
import {
  isPaneAuthExpiredMessage,
  isPaneLocationMessage,
} from "./pane-messages";

const frame = { contentWindow: window } as unknown as HTMLIFrameElement;
const data = {
  type: "docmost:pane-location",
  pathname: "/s/general/p/abc-123456",
  slugId: "123456",
};

function message(init: MessageEventInit) {
  return new MessageEvent("message", init);
}

describe("pane messages", () => {
  it("a pane message from our own iframe is accepted", () => {
    const event = message({ data, origin: window.location.origin, source: window });
    expect(isPaneLocationMessage(event, frame)).toBe(true);
  });

  it("a pane message from another origin is rejected", () => {
    const event = message({ data, origin: "https://evil.example", source: window });
    expect(isPaneLocationMessage(event, frame)).toBe(false);
  });

  it("a pane message from a window that is not our iframe is rejected", () => {
    const other = { contentWindow: {} } as unknown as HTMLIFrameElement;
    const event = message({ data, origin: window.location.origin, source: window });
    expect(isPaneLocationMessage(event, other)).toBe(false);
    expect(isPaneLocationMessage(event, null)).toBe(false);
  });

  it("a message with the wrong shape is rejected", () => {
    const base = { origin: window.location.origin, source: window };
    expect(isPaneLocationMessage(message({ ...base, data: "x" }), frame)).toBe(false);
    expect(
      isPaneLocationMessage(
        message({ ...base, data: { ...data, pathname: 5 } }),
        frame,
      ),
    ).toBe(false);
  });

  it("an auth-expired message is checked the same way", () => {
    const data = { type: "docmost:pane-auth-expired" };
    expect(
      isPaneAuthExpiredMessage(
        message({ data, origin: window.location.origin, source: window }),
        frame,
      ),
    ).toBe(true);
    expect(
      isPaneAuthExpiredMessage(
        message({ data, origin: "https://evil.example", source: window }),
        frame,
      ),
    ).toBe(false);
  });
});
