import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  receive: vi.fn(),
  upload: vi.fn(),
  navigate: vi.fn(),
  send: vi.fn(),
  incoming: true,
  record: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("../src/utils/studioTransfer", () => ({
  receiveModel: mocks.receive,
  hasIncomingTransfer: () => mocks.incoming,
  sendModel: mocks.send,
  STUDIO_ORIGIN: "https://studio.brickbuilder.ai",
}));
vi.mock("../src/services/uploadLdrawApi", () => ({
  UploadLdrawApiService: { upload: mocks.upload },
}));
vi.mock("../src/utils/anonGenerations", () => ({
  recordAnonymousGeneration: mocks.record,
}));
vi.mock("../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
      }),
    },
  },
}));
import { StudioTransferGate } from "../src/components/StudioTransferGate";
import { StudioEditButton } from "../src/components/StudioEditButton";
import type { LandingModel } from "../src/hooks/useLandingModel";
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.incoming = true;
  window.history.replaceState(null, "", "/");
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  mocks.receive.mockReturnValue(() => {});
  mocks.upload.mockResolvedValue({ generation_id: "model-123" });
  mocks.send.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});
const payload = {
  name: "Garden",
  content: "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
};
it("imports exactly once under StrictMode using the signed-in identity and opens the landing edit stage", async () => {
  await act(async () =>
    root.render(
      <React.StrictMode>
        <StudioTransferGate>
          <p>Editor</p>
        </StudioTransferGate>
      </React.StrictMode>,
    ),
  );
  await act(async () => mocks.receive.mock.calls.at(-1)![1](payload));
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.upload.mock.calls[0][0].name).toBe("Garden.ldr");
  expect(mocks.upload.mock.calls[0][1]).toBe("test-token");
  expect(mocks.navigate).toHaveBeenCalledWith("/?id=model-123&exact=1", {
    replace: true,
  });
  expect(mocks.record).not.toHaveBeenCalled();
});
it("sends order transfers to the validation step on /order with the imported model ID", async () => {
  window.history.replaceState(null, "", "/order?transfer=test");
  await act(async () =>
    root.render(
      <StudioTransferGate>
        <p>Checkout</p>
      </StudioTransferGate>,
    ),
  );
  await act(async () => mocks.receive.mock.calls[0][1](payload));
  expect(mocks.navigate).toHaveBeenCalledWith("/order?imported=model-123", {
    replace: true,
  });
});
it("keeps the model available after an upload failure and retries on request", async () => {
  mocks.upload.mockRejectedValueOnce(new Error("Server unavailable"));
  await act(async () =>
    root.render(
      <StudioTransferGate>
        <p>Editor</p>
      </StudioTransferGate>,
    ),
  );
  await act(async () => mocks.receive.mock.calls[0][1](payload));
  expect(node.textContent).toContain("Server unavailable");
  expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () => node.querySelector("button")!.click());
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(mocks.navigate).toHaveBeenCalled();
});
it("exports the currently displayed model for manual editing and reports blocked transfers", async () => {
  const model = {
    content: payload.content,
    generation: { name: "Garden", generation_id: "g1" },
  } as LandingModel;
  mocks.send.mockRejectedValueOnce(new Error("Allow pop-ups"));
  await act(async () => root.render(<StudioEditButton model={model} />));
  await act(async () => node.querySelector("button")!.click());
  expect(mocks.send).toHaveBeenCalledWith(
    "https://studio.brickbuilder.ai/",
    payload,
  );
  expect(node.textContent).toContain("Allow pop-ups");
});
