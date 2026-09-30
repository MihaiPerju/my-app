"use client";

import { useEffect, useMemo, useState } from "react";

import { formatShortcutForPlatform, getModifierLabels } from "./key-display";
import type { ShortcutDisplay } from "./types";

interface NavigatorWithUAData extends Navigator {
  userAgentData: { platform: string };
}

function hasUserAgentData(nav: Navigator): nav is NavigatorWithUAData {
  return "userAgentData" in nav;
}

export function getIsMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  if (hasUserAgentData(navigator)) {
    return /mac/i.test(navigator.userAgentData.platform);
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function useShortcutDisplay(): ShortcutDisplay {
  const [isMacPlatform, setIsMacPlatform] = useState(false);

  useEffect(() => {
    setIsMacPlatform(getIsMacPlatform());
  }, []);

  return useMemo(() => {
    const { altLabel, modLabel } = getModifierLabels(isMacPlatform);

    return {
      altLabel,
      formatShortcut: (...keys: string[]) =>
        formatShortcutForPlatform(isMacPlatform, ...keys),
      modLabel,
    };
  }, [isMacPlatform]);
}
