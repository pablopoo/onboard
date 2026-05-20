export async function copyText(
  value,
  {
    navigator = globalThis.navigator,
    document = globalThis.document,
  } = {},
) {
  const text = String(value ?? "");

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (
    !document?.createElement ||
    !document?.body?.append ||
    typeof document.execCommand !== "function"
  ) {
    throw new Error("Clipboard copy unavailable");
  }

  const helper = document.createElement("textarea");
  try {
    helper.value = text;
    helper.className = "sr-only";
    document.body.append(helper);
    helper.select?.();
    if (document.execCommand("copy") !== true) {
      throw new Error("Clipboard copy failed");
    }
  } finally {
    helper.remove?.();
  }
}
