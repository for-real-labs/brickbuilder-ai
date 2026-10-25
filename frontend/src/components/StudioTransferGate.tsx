import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import posthog from "posthog-js";
import {
  receiveModel,
  hasIncomingTransfer,
  STUDIO_ORIGIN,
  type ModelTransfer,
} from "../utils/studioTransfer";
import { UploadLdrawApiService } from "../services/uploadLdrawApi";
import { supabase } from "../lib/supabase";
import { recordAnonymousGeneration } from "../utils/anonGenerations";
import { getGeneratedModelPath } from "../utils/generationRoutes";
export function StudioTransferGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [active, setActive] = useState(hasIncomingTransfer);
  const [model, setModel] = useState<ModelTransfer | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const importing = useRef(false),
    destination = useRef(
      window.location.pathname === "/order" ? "order" : "edit",
    );
  useEffect(
    () => receiveModel(STUDIO_ORIGIN, setModel, (e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    if (!model || importing.current) return;
    importing.current = true;
    setError("");
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const file = new File(
          [model.content],
          `${model.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.ldr`,
          { type: "text/plain" },
        );
        const result = await UploadLdrawApiService.upload(
          file,
          data.session?.access_token,
        );
        try {
          localStorage.setItem("lastGenerationId", result.generation_id);
        } catch {
          /* Model route works without storage. */
        }
        if (!data.session) recordAnonymousGeneration(result.generation_id);
        posthog.capture("studio_model_imported", {
          generation_id: result.generation_id,
          destination: destination.current,
        });
        setActive(false);
        setModel(null);
        navigate(
          destination.current === "order"
            ? `/order?imported=${encodeURIComponent(result.generation_id)}`
            : getGeneratedModelPath(result.generation_id, true),
          { replace: true },
        );
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Import failed. Please try again.",
        );
        posthog.capture("studio_model_import_failed");
      } finally {
        importing.current = false;
      }
    })();
  }, [model, attempt, navigate]);
  if (!active) return <>{children}</>;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#fbfbfd] p-6">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="mb-3 text-sm font-bold text-[#f44336]">
          BRICKBUILDER STUDIO
        </p>
        <h1 className="mb-4 text-2xl font-bold text-slate-900">
          {error
            ? "Your model needs another try"
            : model
              ? `Importing ${model.name}`
              : "Receiving your model…"}
        </h1>
        <p role={error ? "alert" : "status"} className="text-slate-600">
          {error ||
            "Keep the source tab open. Your model will open here for AI editing or part ordering."}
        </p>
        {error && model && (
          <button
            className="mt-5 rounded-full bg-[#f44336] px-6 py-3 font-semibold text-white"
            onClick={() => {
              posthog.capture("studio_import_retry_clicked");
              setAttempt((n) => n + 1);
            }}
          >
            Retry import
          </button>
        )}
        {error && (
          <a
            className="mt-5 block text-[#f44336] underline"
            href="/use-ai-to-edit-ldraw"
          >
            Choose an LDraw file instead
          </a>
        )}
      </section>
    </main>
  );
}
