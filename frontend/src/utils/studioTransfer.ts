import { gzipSync, Gunzip, strToU8, strFromU8 } from "fflate";
export const STUDIO_ORIGIN = "https://studio.brickbuilder.ai";
export const BUILDER_ORIGIN = "https://brickbuilder.ai";
export const MAX_TRANSFER = 16_000_000;
// Clear desktop model fragments before application analytics initialize.
let pendingEncoded: string | null = null;
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.hash.slice(1));
  pendingEncoded = params.get("model");
  if (pendingEncoded)
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
}
export function hasIncomingTransfer(): boolean {
  return Boolean(
    pendingEncoded ||
    new URLSearchParams(window.location.search).has("transfer"),
  );
}
export interface ModelTransfer {
  name: string;
  content: string;
}
export function validateTransfer(value: unknown): ModelTransfer {
  const data = value as Partial<ModelTransfer> | null;
  if (
    !data ||
    typeof data.name !== "string" ||
    !data.name.trim() ||
    data.name.length > 120 ||
    typeof data.content !== "string" ||
    data.content.length > MAX_TRANSFER ||
    !/^1\s/m.test(data.content)
  )
    throw new Error("Invalid or oversized LDraw transfer.");
  return { name: data.name, content: data.content };
}
export function encodeTransfer(value: ModelTransfer): string {
  const bytes = gzipSync(strToU8(JSON.stringify(validateTransfer(value))));
  const token = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (token.length > 24000)
    throw new Error(
      "This model is too large for a desktop link. Download the LDraw file and import it on the destination page.",
    );
  return token;
}
export function decodeTransfer(token: string): ModelTransfer {
  if (!/^[a-zA-Z0-9_-]{1,24000}$/.test(token))
    throw new Error("Invalid transfer link.");
  const bytes = Uint8Array.from(
    atob(token.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const unzip = new Gunzip((chunk) => {
    size += chunk.length;
    if (size > MAX_TRANSFER + 1000) throw new Error("Transfer exceeds 16 MB.");
    chunks.push(chunk);
  });
  for (let i = 0; i < bytes.length; i += 256)
    unzip.push(bytes.subarray(i, i + 256), i + 256 >= bytes.length);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return validateTransfer(JSON.parse(strFromU8(result)));
}
/** No model or credentials in query strings; exact origin, window and nonce checks. */
export function sendModel(
  destination: string,
  model: ModelTransfer,
): Promise<void> {
  validateTransfer(model);
  const url = new URL(destination);
  if (![STUDIO_ORIGIN, BUILDER_ORIGIN].includes(url.origin))
    throw new Error("Unsupported transfer destination.");
  const nonce = crypto.randomUUID();
  url.searchParams.set("transfer", nonce);
  const popup = window.open(url.href, "_blank");
  if (!popup)
    return Promise.reject(
      new Error(
        "Allow pop-ups to transfer this model, or export and import the LDraw file.",
      ),
    );
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", receive);
      clearTimeout(timer);
    };
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== url.origin ||
        event.source !== popup ||
        event.data?.nonce !== nonce
      )
        return;
      if (event.data.type === "brickbuilder-ready")
        popup.postMessage(
          { type: "brickbuilder-model", nonce, model },
          url.origin,
        );
      if (event.data.type === "brickbuilder-received") {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Transfer timed out. Keep both tabs open or export and import the LDraw file.",
        ),
      );
    }, 45000);
    window.addEventListener("message", receive);
  });
}
export function receiveModel(
  expectedOrigin: string,
  onModel: (model: ModelTransfer) => void,
  onError: (error: Error) => void,
): () => void {
  const url = new URL(window.location.href),
    nonce = url.searchParams.get("transfer");
  const hash = new URLSearchParams(url.hash.slice(1)),
    encoded = pendingEncoded || hash.get("model");
  pendingEncoded = null;
  if (encoded) {
    history.replaceState(null, "", url.pathname + url.search);
    try {
      onModel(decodeTransfer(encoded));
    } catch (e) {
      onError(e instanceof Error ? e : new Error("Invalid transfer."));
    }
    return () => {};
  }
  if (!nonce) return () => {};
  if (!/^[-a-f0-9]{36}$/.test(nonce) || !window.opener) {
    onError(
      new Error(
        "The source tab is unavailable. Export and import the LDraw file, or start the transfer again.",
      ),
    );
    return () => {};
  }
  let received = false;
  const source = window.opener;
  const ready = () =>
    source.postMessage({ type: "brickbuilder-ready", nonce }, expectedOrigin);
  const receive = (event: MessageEvent) => {
    if (
      received ||
      event.origin !== expectedOrigin ||
      event.source !== source ||
      event.data?.nonce !== nonce ||
      event.data.type !== "brickbuilder-model"
    )
      return;
    try {
      const model = validateTransfer(event.data.model);
      received = true;
      source.postMessage(
        { type: "brickbuilder-received", nonce },
        expectedOrigin,
      );
      clearInterval(timer);
      window.removeEventListener("message", receive);
      url.searchParams.delete("transfer");
      history.replaceState(null, "", url.pathname + url.search);
      onModel(model);
    } catch (e) {
      onError(e instanceof Error ? e : new Error("Invalid transfer."));
    }
  };
  window.addEventListener("message", receive);
  const timer = setInterval(ready, 500);
  ready();
  const timeout = setTimeout(() => {
    clearInterval(timer);
    window.removeEventListener("message", receive);
    if (!received)
      onError(
        new Error(
          "The source tab did not respond. Export and import the LDraw file, or try again.",
        ),
      );
  }, 45000);
  return () => {
    clearInterval(timer);
    clearTimeout(timeout);
    window.removeEventListener("message", receive);
  };
}
