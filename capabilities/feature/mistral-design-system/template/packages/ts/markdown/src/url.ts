export type MarkdownUrlAllowPredicate = (url: string) => boolean;

export function sanitizeMarkdownUrl(
  url: string | undefined,
  allowUrl?: MarkdownUrlAllowPredicate,
): string | undefined {
  if (url === undefined) return undefined;

  const trimmedUrl = url.trim();

  if (trimmedUrl.length === 0) return undefined;
  if (allowUrl?.(trimmedUrl)) return url;
  if (isSafeMarkdownUrl(trimmedUrl)) return url;

  return undefined;
}

function isSafeMarkdownUrl(url: string): boolean {
  const colon = url.indexOf(":");

  if (colon === -1) return true;
  if (hasEarlierUrlBoundary(url, colon)) return true;

  const scheme = url.slice(0, colon).toLowerCase();

  return (
    scheme === "http" ||
    scheme === "https" ||
    scheme === "mailto" ||
    scheme === "irc" ||
    scheme === "ircs" ||
    scheme === "xmpp"
  );
}

function hasEarlierUrlBoundary(url: string, colon: number): boolean {
  for (let index = 0; index < colon; index += 1) {
    const code = url.charCodeAt(index);

    if (code === 0x2f || code === 0x3f || code === 0x23) return true;
  }

  return false;
}
