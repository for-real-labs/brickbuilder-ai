import { afterEach, describe, it, expect, vi } from "vitest";
import {
  encodeTransfer,
  decodeTransfer,
  validateTransfer,
  sendModel,
  receiveModel,
  BUILDER_ORIGIN,
  STUDIO_ORIGIN,
} from "../src/utils/studioTransfer";
const model = {
  name: "Café 🧱",
  content: "0 Example\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});
describe("model transfer boundary", () => {
  it("round trips Unicode names and exact LDraw through compressed desktop links", () =>
    expect(decodeTransfer(encodeTransfer(model))).toEqual(model));
  it("rejects invalid and oversized payloads", () => {
    expect(() => decodeTransfer("https://evil.test")).toThrow();
    expect(() =>
      validateTransfer({ ...model, content: "1 " + "x".repeat(16_000_000) }),
    ).toThrow();
    expect(() =>
      validateTransfer({ ...model, content: "<script>alert(1)</script>" }),
    ).toThrow();
  });
  it("sends only to the requested window with matching origin and nonce", async () => {
    const popup = { postMessage: vi.fn() };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);
    const pending = sendModel(BUILDER_ORIGIN + "/", model),
      url = new URL(open.mock.calls[0][0] as string),
      nonce = url.searchParams.get("transfer");
    const event = (
      origin: string,
      source: unknown,
      type = "brickbuilder-ready",
    ) =>
      new MessageEvent("message", {
        origin,
        source: source as Window,
        data: { type, nonce },
      });
    window.dispatchEvent(event("https://evil.test", popup));
    window.dispatchEvent(event(BUILDER_ORIGIN, window));
    expect(popup.postMessage).not.toHaveBeenCalled();
    window.dispatchEvent(event(BUILDER_ORIGIN, popup));
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: "brickbuilder-model", nonce, model },
      BUILDER_ORIGIN,
    );
    window.dispatchEvent(event(BUILDER_ORIGIN, popup, "brickbuilder-received"));
    await pending;
  });
  it("handles blocked popups and forbids untrusted destinations", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await expect(sendModel(BUILDER_ORIGIN, model)).rejects.toThrow("pop-ups");
    expect(() => sendModel("https://evil.test", model)).toThrow("destination");
  });
  it("accepts one model only from its opener and removes transfer data from the URL", () => {
    const opener = { postMessage: vi.fn() };
    vi.stubGlobal("opener", opener);
    const nonce = crypto.randomUUID();
    history.replaceState(null, "", `/?transfer=${nonce}`);
    const receive = vi.fn(),
      error = vi.fn(),
      cleanup = receiveModel(STUDIO_ORIGIN, receive, error);
    const data = { type: "brickbuilder-model", nonce, model };
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: BUILDER_ORIGIN,
        source: opener as unknown as Window,
        data,
      }),
    );
    expect(receive).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: STUDIO_ORIGIN,
        source: opener as unknown as Window,
        data,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: STUDIO_ORIGIN,
        source: opener as unknown as Window,
        data,
      }),
    );
    expect(receive).toHaveBeenCalledExactlyOnceWith(model);
    expect(window.location.search).toBe("");
    cleanup();
    vi.unstubAllGlobals();
  });
});
