import React, { useState } from "react";
import { PencilRuler } from "lucide-react";
import posthog from "posthog-js";
import { sendModel, STUDIO_ORIGIN } from "../utils/studioTransfer";
import type { LandingModel } from "../hooks/useLandingModel";
export function StudioEditButton({
  model,
  disabled = false,
}: {
  model: LandingModel;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    posthog.capture("landing_model_studio_edit_clicked", {
      generation_id: model.generation.generation_id,
    });
    try {
      await sendModel(STUDIO_ORIGIN + "/", {
        name: (model.generation.name || "My model").slice(0, 120),
        content: model.content,
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Export LDraw from Tools and open it in BrickBuilder Studio.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        className="landing-action-button"
        disabled={disabled || busy}
        onClick={() => void open()}
      >
        <PencilRuler size={16} aria-hidden="true" />
        <span>{busy ? "Opening Studio…" : "Edit in BrickBuilder Studio"}</span>
      </button>
      {error && (
        <p role="alert" className="max-w-xs p-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
