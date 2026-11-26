import { useEffect, useState } from "react";
import { PhotoScannerApi } from "../services/photoScannerApi";

type AccessResult = "allowed" | "denied" | "unavailable";

export function usePhotoScannerAccess(account?: { id: string; email?: string } | null) {
  const accountId = account?.id;
  const email = account?.email;
  const [result, setResult] = useState<{ accountId: string; email?: string; access: AccessResult }>();

  useEffect(() => {
    setResult(undefined);
    if (!accountId) return;

    const controller = new AbortController();
    const resolve = (access: AccessResult) => {
      if (!controller.signal.aborted) setResult({ accountId, email, access });
    };
    PhotoScannerApi.access(controller.signal)
      .then(({ allowed }) => resolve(allowed ? "allowed" : "denied"))
      .catch(() => resolve("unavailable"));

    return () => controller.abort();
  }, [accountId, email]);

  if (!accountId) return "denied";
  return result?.accountId === accountId && result.email === email ? result.access : "checking";
}
