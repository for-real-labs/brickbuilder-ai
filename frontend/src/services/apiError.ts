export async function readApiError(response: Response): Promise<string> {
  const errorText = await response.text();

  try {
    const errorData = JSON.parse(errorText) as { detail?: string; error?: string; message?: string };
    return errorData.detail || errorData.error || errorData.message || errorText;
  } catch {
    return errorText || `${response.status} ${response.statusText}`;
  }
}
