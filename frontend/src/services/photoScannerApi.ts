import { authenticatedApiFetch } from "./apiFetch";
import { NOVA_API_BASE_URL } from "./novaToBricksApi";

export const canUsePhotoScanner = (email?: string | null) =>
  ["jake@brickbuilder.ai", "jakejohnson3700@gmail.com"].includes(email?.toLowerCase() ?? "");
export interface ScanMatch {
  id: string;
  name: string;
  score: number | null;
  image_url: string | null;
}
export interface ScanRegion {
  id: string;
  box: [number, number, number, number];
  status: string;
  candidates: ScanMatch[];
  match: ScanMatch | null;
  excluded: boolean;
  reviewed: boolean;
}
export interface PhotoScan {
  id: string;
  status: string;
  width: number;
  height: number;
  regions: ScanRegion[];
  completed: number;
  tiles_done: number;
  tiles_total: number;
  warnings: string[];
  elapsed_seconds: number;
  duplicates_removed: number;
  retries: number;
}
export const scanFinished = (scan: PhotoScan) =>
  ["complete", "cancelled", "failed"].includes(scan.status);
export function groupScanRegions(regions: ScanRegion[]) {
  const groups = new Map<string, { match: ScanMatch; regions: ScanRegion[] }>();
  for (const region of regions) {
    if (region.excluded || !region.match) continue;
    const group = groups.get(region.match.id) ?? {
      match: region.match,
      regions: [],
    };
    group.regions.push(region);
    groups.set(region.match.id, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.regions.length - a.regions.length,
  );
}
const base = `${NOVA_API_BASE_URL}/photo-scanner`;
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedApiFetch(base + path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Photo Scanner is unavailable. Please try again.",
    );
  return data as T;
}
export const PhotoScannerApi = {
  access: (signal?: AbortSignal) => request("/access", { signal }),
  start: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<PhotoScan>("/scans", { method: "POST", body });
  },
  get: (id: string, signal?: AbortSignal) =>
    request<PhotoScan>(`/scans/${id}`, { signal }),
  cancel: (id: string) =>
    request<PhotoScan>(`/scans/${id}/cancel`, { method: "POST" }),
  review: (id: string, region: string, body: Record<string, unknown>) =>
    request<PhotoScan>(`/scans/${id}/regions/${region}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  async asset(id: string, asset: string, signal: AbortSignal) {
    const response = await authenticatedApiFetch(
      `${base}/scans/${id}/assets/${asset}`,
      { signal },
    );
    if (!response.ok) throw new Error("Image unavailable.");
    return URL.createObjectURL(await response.blob());
  },
};
