import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ seo: vi.fn(), model: vi.fn() }));
vi.mock("../src/components/SEO", () => ({
  SEO: (props: unknown) => {
    mocks.seo(props);
    return null;
  },
}));
vi.mock("../src/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "owner" },
    session: { access_token: "test-token" },
  }),
}));
vi.mock("../src/hooks/useLandingModel", () => ({
  useLandingModel: mocks.model,
}));
vi.mock("../src/components/ThreeLDRViewer", () => ({
  ThreeLDRViewer: () => <div>Model preview</div>,
}));
vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
import { ImportedStudioOrder } from "../src/components/ImportedStudioOrder";
it("shows the imported model and requires AI validation before ordering, with the correct page metadata", async () => {
  mocks.model.mockReturnValue({
    model: { generation: { name: "Garden" }, content: "0 Garden" },
    error: null,
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<ImportedStudioOrder id="model-123" />));
    expect(mocks.model).toHaveBeenCalledWith(
      "owner",
      "test-token",
      "model-123",
    );
    expect(node.textContent).toContain("Prepare Garden for ordering");
    expect(node.textContent).toContain("No order has been placed.");
    expect(node.querySelector("a")?.getAttribute("href")).toBe(
      "/?id=model-123&exact=1",
    );
    expect(mocks.seo).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Prepare your Studio model for ordering",
        noIndex: true,
      }),
    );
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});
