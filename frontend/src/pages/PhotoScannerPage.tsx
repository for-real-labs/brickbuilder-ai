import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Camera, ScanLine, ArrowLeft, Upload, LockKeyhole } from "lucide-react";
import { Helmet } from "react-helmet-async";
import posthog from "posthog-js";
import { useAuth } from "../contexts/AuthContext";
import {
  canUsePhotoScanner,
  groupScanRegions,
  PhotoScannerApi,
  scanFinished,
  type PhotoScan,
  type ScanRegion,
} from "../services/photoScannerApi";
import {
  IMAGE_UPLOAD_ACCEPT,
  prepareImageUpload,
} from "../utils/prepareImageUpload";
import "./PhotoScannerPage.css";

const track = (action: string, properties: Record<string, unknown> = {}) =>
  posthog.capture(`photo_scanner_${action}`, {
    page: "/photo-scanner",
    ...properties,
  });
function useAsset(scanId?: string, asset?: string) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!scanId || !asset) return;
    const controller = new AbortController();
    let current: string | undefined;
    PhotoScannerApi.asset(scanId, asset, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) URL.revokeObjectURL(value);
        else {
          current = value;
          setUrl(value);
        }
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (current) URL.revokeObjectURL(current);
    };
  }, [scanId, asset]);
  return url;
}
function Crop({ scanId, region }: { scanId: string; region: string }) {
  const url = useAsset(scanId, region);
  return url ? (
    <img src={url} alt={`Detected region ${region}`} />
  ) : (
    <span className="scanner-image-placeholder">
      <ScanLine aria-hidden="true" />
    </span>
  );
}
function PartThumbnail({
  scanId,
  region,
}: {
  scanId: string;
  region: ScanRegion;
}) {
  const [failed, setFailed] = useState(false);
  return region.match?.image_url && !failed ? (
    <img
      src={region.match.image_url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <Crop scanId={scanId} region={region.id} />
  );
}
function ReviewRegion({
  scan,
  region,
  onUpdate,
}: {
  scan: PhotoScan;
  region: ScanRegion;
  onUpdate: (scan: PhotoScan) => void;
}) {
  const [part, setPart] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (body: Record<string, unknown>, action: string) => {
    setBusy(true);
    setError("");
    try {
      onUpdate(
        await PhotoScannerApi.review(scan.id, region.id, {
          excluded: region.excluded,
          ...body,
        }),
      );
      track(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this review.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="scanner-review"
      aria-label={`Review region ${region.id}`}
    >
      <div className="scanner-review-heading">
        <h3>Region {region.id}</h3>
        <span>
          {region.excluded
            ? "Excluded"
            : region.reviewed
              ? "Reviewed"
              : "Needs review"}
        </span>
      </div>
      <div className="scanner-crop">
        <Crop scanId={scan.id} region={region.id} />
      </div>
      <p>
        {region.match?.name ??
          (region.status === "failed"
            ? "Recognition failed. You can identify this piece manually."
            : "No match yet.")}
      </p>
      <p className="scanner-muted">
        {region.match?.id ? `Part ${region.match.id} · ` : ""}
        {region.match?.score != null
          ? `${Math.round(region.match.score * 100)}% similarity`
          : "No model confidence available"}
      </p>
      <fieldset disabled={busy || region.status === "pending"}>
        <label>
          Choose a candidate
          <select
            aria-label="Choose a candidate"
            value=""
            onChange={(e) => {
              if (e.target.value)
                void save(
                  { candidate_id: e.target.value },
                  "candidate_selected",
                );
            }}
          >
            <option value="">Review alternatives…</option>
            {region.candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.name} · {Math.round((item.score ?? 0) * 100)}%
              </option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({ part_id: part, name: name || part }, "match_corrected");
          }}
        >
          <label>
            Correct part number
            <input
              aria-label="Correct part number"
              required
              maxLength={100}
              pattern="[A-Za-z0-9._\-]+"
              value={part}
              onChange={(e) => setPart(e.target.value)}
              placeholder="e.g. 3001"
            />
          </label>
          <label>
            Part name <span className="scanner-muted">(optional)</span>
            <input
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Brick 2 × 4"
            />
          </label>
          <button type="submit">Save correction</button>
        </form>
        <div className="scanner-review-actions">
          <button
            type="button"
            onClick={() =>
              void save({ excluded: !region.excluded }, "exclusion_changed")
            }
          >
            {region.excluded ? "Restore detection" : "Exclude detection"}
          </button>
          <button
            type="button"
            onClick={() => void save({ unmatched: true }, "match_cleared")}
          >
            Clear match
          </button>
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function ScannerWorkspace({ owner }: { owner: string }) {
  const [allowed, setAllowed] = useState(false);
  const [scan, setScan] = useState<PhotoScan>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [pollAttempt, setPollAttempt] = useState(0);
  const [overlay, setOverlay] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const reviewPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected)
      reviewPanel.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "nearest",
      });
  }, [selected]);
  const alive = useRef(true);
  const photo = useAsset(scan?.id, "photo");
  const key = `photo-scanner:${owner}`;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    PhotoScannerApi.access(controller.signal)
      .then(async () => {
        if (controller.signal.aborted) return;
        setAllowed(true);
        track("opened");
        const saved = sessionStorage.getItem(key);
        if (saved) {
          try {
            const previous = await PhotoScannerApi.get(
              saved,
              controller.signal,
            );
            if (!controller.signal.aborted) setScan(previous);
          } catch {
            if (!controller.signal.aborted) sessionStorage.removeItem(key);
          }
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [key]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    if (!scan || scanFinished(scan)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await PhotoScannerApi.get(scan.id, controller.signal);
        if (controller.signal.aborted) return;
        setScan(next);
        if (scanFinished(next))
          track("finished", {
            status: next.status,
            regions: next.regions.length,
          });
        else timer = setTimeout(poll, 1500);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not refresh scan.");
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [scan?.id, scan?.status, pollAttempt]);
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const prepared = await prepareImageUpload(file, {
        maxDimension: 6000,
        maxBytes: 16 * 1024 * 1024,
      });
      if (!alive.current) return;
      setPreview(URL.createObjectURL(prepared));
      setScan(undefined);
      setSelected(undefined);
      track("scan_started");
      const next = await PhotoScannerApi.start(prepared);
      if (!alive.current) return;
      sessionStorage.setItem(key, next.id);
      setScan(next);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "Could not start scan.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const groups = groupScanRegions(scan?.regions ?? []);
  const unresolved = scan?.regions.filter((r) => !r.match || r.excluded) ?? [];
  const identified = groups.reduce(
    (sum, group) => sum + group.regions.length,
    0,
  );
  const review = scan?.regions.find((r) => r.id === selected);
  const running = scan && !scanFinished(scan);
  const select = (id: string) => {
    setSelected(id);
    track("region_selected");
  };
  return (
    <>
      <div className="scanner-title">
        <div>
          <span className="scanner-eyebrow">
            <LockKeyhole size={13} /> PRIVATE PROTOTYPE
          </span>
          <h1>Your bricks, in focus.</h1>
          <p>
            Photograph a spread. Find individual pieces. Review what’s there.
          </p>
        </div>
        <span className="scanner-title-icon">
          <Camera size={30} />
        </span>
      </div>
      {error && (
        <div role="alert" className="scanner-error">
          {error}{" "}
          {scan && (
            <button
              onClick={() => {
                setError("");
                setPollAttempt((n) => n + 1);
                track("refresh_clicked");
              }}
            >
              Refresh results
            </button>
          )}
        </div>
      )}
      {!allowed ? (
        <p role="status">
          {error
            ? "This page is available only to the prototype account."
            : "Checking private access…"}
        </p>
      ) : (
        <>
          <div className="scanner-toolbar">
            <div>
              <strong>Photo Scanner</strong>
              <span> SAM 3 + Brickognize</span>
            </div>
            <input
              ref={input}
              type="file"
              aria-label="Choose a photo"
              accept={IMAGE_UPLOAD_ACCEPT}
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
            <button
              className="scanner-primary"
              disabled={busy || Boolean(running)}
              onClick={() => {
                input.current?.click();
                track("upload_clicked");
              }}
            >
              <Upload size={16} />
              {busy ? "Preparing photo…" : "Choose photo"}
            </button>
          </div>
          <p className="scanner-disclosure">
            Your photo is sent to fal.ai; isolated crops are sent to
            Brickognize. Results are private and temporary (up to one hour;
            server restarts clear them). Colors and inventory completeness are
            not verified.
          </p>
          {!scan && !preview ? (
            <div className="scanner-empty">
              <span>
                <ScanLine size={42} />
              </span>
              <h2>Start with a spread of pieces</h2>
              <p>
                Use a clear, well-lit photo from above. Leave space between
                pieces when you can.
              </p>
              <div className="scanner-steps">
                <span>01 · Upload photo</span>
                <span>02 · Detect pieces</span>
                <span>03 · Review parts</span>
              </div>
            </div>
          ) : (
            <div className="scanner-layout">
              <section className="scanner-photo-panel">
                <div className="scanner-section-heading">
                  <h2>The photo</h2>
                  <label>
                    <input
                      type="checkbox"
                      checked={overlay}
                      onChange={(e) => {
                        setOverlay(e.target.checked);
                        track("overlay_toggled");
                      }}
                    />{" "}
                    Regions
                  </label>
                </div>
                <div className="scanner-photo">
                  {(photo || preview) && (
                    <img src={photo || preview} alt="Uploaded LEGO spread" />
                  )}
                  {scan && overlay && (
                    <svg
                      viewBox={`0 0 ${scan.width} ${scan.height}`}
                      aria-label="Detected regions overlay"
                    >
                      {scan.regions.map((region) => (
                        <g
                          key={region.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Review region ${region.id}`}
                          onClick={() => select(region.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              select(region.id);
                            }
                          }}
                          className={
                            region.excluded
                              ? "excluded"
                              : region.id === selected
                                ? "selected"
                                : ""
                          }
                        >
                          <rect
                            x={region.box[0]}
                            y={region.box[1]}
                            width={region.box[2] - region.box[0]}
                            height={region.box[3] - region.box[1]}
                          />
                          <text x={region.box[0]} y={region.box[1] + 18}>
                            {region.id}
                          </text>
                        </g>
                      ))}
                    </svg>
                  )}
                </div>
                {scan && (
                  <>
                    <div className="scanner-progress" role="status">
                      <strong>
                        {scan.status === "segmenting"
                          ? `Finding pieces · tile ${scan.tiles_done} of ${scan.tiles_total}`
                          : scan.status === "identifying"
                            ? `Identifying · ${scan.completed} of ${scan.regions.length}`
                            : scan.status === "cancelled"
                              ? "Scan cancelled · partial results saved"
                              : scan.status === "failed"
                                ? "Scan stopped · partial results saved"
                                : "Scan complete · ready to review"}
                      </strong>
                      <span>{Math.round(scan.elapsed_seconds)}s</span>
                    </div>
                    <progress
                      max={
                        scan.status === "segmenting"
                          ? scan.tiles_total || 1
                          : scan.regions.length || 1
                      }
                      value={
                        scan.status === "segmenting"
                          ? scan.tiles_done
                          : scan.completed
                      }
                    />
                    {running && (
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            setScan(await PhotoScannerApi.cancel(scan.id));
                            track("cancelled");
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Cancel scan
                      </button>
                    )}
                    {scan.warnings.map((warning, i) => (
                      <p key={i} className="scanner-warning">
                        {warning}
                      </p>
                    ))}
                  </>
                )}
                {scan && review ? (
                  <div ref={reviewPanel}>
                    <ReviewRegion
                      key={review.id}
                      scan={scan}
                      region={review}
                      onUpdate={setScan}
                    />
                  </div>
                ) : (
                  <p className="scanner-muted">
                    Select a numbered region or part card to inspect its crop
                    and correct a match.
                  </p>
                )}
              </section>
              <section className="scanner-results">
                <div className="scanner-counts">
                  <div>
                    <strong>{scan?.regions.length ?? "—"}</strong>
                    <span>Detected regions</span>
                  </div>
                  <div>
                    <strong>{identified}</strong>
                    <span>Identified pieces</span>
                  </div>
                  <div>
                    <strong>{groups.length}</strong>
                    <span>Unique part types</span>
                  </div>
                </div>
                <div className="scanner-section-heading">
                  <h2>Parts found</h2>
                  <span>Review before using</span>
                </div>
                <p className="scanner-muted">
                  Quantities count regions, not alternative matches. Similarity
                  scores are not verified accuracy.
                </p>
                <div className="scanner-parts-grid">
                  {groups.map((group) => (
                    <article className="scanner-part" key={group.match.id}>
                      <button
                        className="scanner-part-main"
                        onClick={() => select(group.regions[0].id)}
                      >
                        <div className="scanner-part-image">
                          {scan && (
                            <PartThumbnail
                              scanId={scan.id}
                              region={group.regions[0]}
                            />
                          )}
                          <b>×{group.regions.length}</b>
                        </div>
                        <strong>{group.match.name}</strong>
                        <span>#{group.match.id}</span>
                        <small>
                          {group.regions.some((r) => r.match?.score == null)
                            ? "Includes manual correction"
                            : `${Math.round(Math.min(...group.regions.map((r) => r.match!.score!)) * 100)}–${Math.round(Math.max(...group.regions.map((r) => r.match!.score!)) * 100)}% similarity`}
                        </small>
                        <em>
                          {group.regions.some(
                            (r) => !r.reviewed && (r.match?.score ?? 0) < 0.8,
                          )
                            ? "Uncertain · review"
                            : group.regions.every((r) => r.reviewed)
                              ? "Reviewed"
                              : "Suggested match"}
                        </em>
                      </button>
                      <div className="scanner-region-links">
                        {group.regions.map((r) => (
                          <button
                            key={r.id}
                            aria-label={`Review region ${r.id}`}
                            onClick={() => select(r.id)}
                          >
                            {r.id}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
                {unresolved.length > 0 && (
                  <>
                    <h2 className="scanner-unresolved-title">
                      Unmatched & excluded <span>{unresolved.length}</span>
                    </h2>
                    <div className="scanner-parts-grid">
                      {unresolved.map((region) => (
                        <button
                          className="scanner-unresolved"
                          key={region.id}
                          onClick={() => select(region.id)}
                        >
                          <Crop scanId={scan!.id} region={region.id} />
                          <strong>Region {region.id}</strong>
                          <span>
                            {region.excluded ? "Excluded" : region.status}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {scan && (
                  <p className="scanner-muted">
                    {scan.duplicates_removed} likely duplicate detections
                    removed · {scan.retries} API retries
                  </p>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </>
  );
}
export default function PhotoScannerPage() {
  const { user, loading } = useAuth();
  return (
    <main className="photo-scanner">
      <Helmet>
        <title>Photo Scanner · BrickBuilder.ai</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="scanner-shell">
        <Link to="/" className="scanner-back">
          <ArrowLeft size={16} />
          Back to BrickBuilder
        </Link>
        {loading ? (
          <p>Checking account…</p>
        ) : canUsePhotoScanner(user?.email) && user ? (
          <ScannerWorkspace key={user.id} owner={user.id} />
        ) : (
          <div className="scanner-private">
            <LockKeyhole />
            <h1>Private prototype</h1>
            <p>This tool is available only to the prototype account.</p>
            <Link to="/login">Sign in</Link>
          </div>
        )}
      </div>
    </main>
  );
}
