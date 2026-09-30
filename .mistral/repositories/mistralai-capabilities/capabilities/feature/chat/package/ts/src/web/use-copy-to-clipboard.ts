import { useCallback } from "react";
import { toast } from "sonner";

const COPY_FAILURE = "Could not copy this message.";

/**
 * Copies `content`, reporting either outcome to the user.
 *
 * The assistant footer and the user message hover tray both need this. It is shared because of the
 * failure path: a discarded promise tells the user nothing and leaves them believing the copy
 * worked.
 */
export function useCopyToClipboard(content: string): () => void {
  return useCallback(() => {
    void (async () => {
      try {
        // No `navigator.clipboard` guard: it is absent outside a secure context, and the
        // TypeError that raises is the same failure as a rejected write. One catch, one toast.
        await navigator.clipboard.writeText(content);
        toast.success("Copied");
      } catch {
        toast.error(COPY_FAILURE);
      }
    })();
  }, [content]);
}
