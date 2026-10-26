import { SEO } from "./SEO";
import React, { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import posthog from "posthog-js";
import { useAuth } from "../contexts/AuthContext";
import { useLandingModel } from "../hooks/useLandingModel";
import { getGeneratedModelPath } from "../utils/generationRoutes";
const Viewer = lazy(() =>
  import("./ThreeLDRViewer").then((module) => ({
    default: module.ThreeLDRViewer,
  })),
);
export function ImportedStudioOrder({ id }: { id: string }) {
  const { session, user } = useAuth();
  const { model, error } = useLandingModel(
    user?.id || "guest",
    session?.access_token,
    id,
  );
  return (
    <>
      <SEO
        title="Prepare your Studio model for ordering"
        description="Validate your imported model before ordering its parts."
        url="https://brickbuilder.ai/order"
        noIndex
      />
      <main className="min-h-screen bg-[#fbfbfd] px-5 py-10">
        <section className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="mb-3 text-sm font-bold text-[#f44336]">
            BRICKBUILDER • ORDER THIS MODEL
          </p>
          <h1 className="mb-3 text-3xl font-bold text-slate-900">
            Prepare {model?.generation.name || "your model"} for ordering
          </h1>
          <p className="mb-5 text-slate-600">
            Your edited model is imported. Apply an AI edit to check it against
            available parts and colors before getting a kit price. You can
            review the updated model before placing an order.
          </p>
          {model && (
            <div className="mb-6 h-80 overflow-hidden rounded-xl bg-slate-100">
              <Suspense fallback={<p>Loading preview…</p>}>
                <Viewer
                  modelContent={model.content}
                  showModelControls={false}
                />
              </Suspense>
            </div>
          )}
          {error && (
            <p role="alert" className="mb-4 text-red-700">
              {error}
            </p>
          )}
          <Link
            to={getGeneratedModelPath(id, true)}
            className="inline-flex rounded-full bg-[#f44336] px-6 py-3 font-semibold text-white"
            onClick={() =>
              posthog.capture("studio_order_prepare_clicked", {
                generation_id: id,
              })
            }
          >
            Edit with AI to prepare parts
          </Link>
          <p className="mt-4 text-sm text-slate-500">
            Suggested edit: “Adapt this model to available parts and colors,
            preserving its appearance.” AI editing uses your normal BrickBuilder
            plan or credits. No order has been placed.
          </p>
        </section>
      </main>
    </>
  );
}
