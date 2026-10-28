/**
 * The two framer-motion primitives, as one injectable seam.
 *
 * `motion` and `AnimatePresence` travel together — `AnimatePresence` is meaningless without a
 * `motion` child — so one context holds both. jsdom does not animate, so a test stands in for them
 * through the React tree rather than through the module loader: bun's `mock.module` is process-wide
 * and would leak across files, while a context override is scoped to the subtree below it.
 *
 * The defaults are the real primitives, so nothing outside a test has to provide anything and a
 * component rendered without a provider behaves exactly as it did before this seam existed.
 */
import { AnimatePresence, motion } from "framer-motion";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type ChatMotion = {
  readonly motion: typeof motion;
  readonly AnimatePresence: typeof AnimatePresence;
};

export type ChatMotionOverride = {
  motion?: typeof motion;
  AnimatePresence?: typeof AnimatePresence;
};

const DEFAULT_MOTION: ChatMotion = { motion, AnimatePresence };

const ChatMotionContext = createContext<ChatMotion>(DEFAULT_MOTION);

export function ChatMotionProvider({
  motion: motionOverride,
  AnimatePresence: animatePresenceOverride,
  children,
}: ChatMotionOverride & { children: ReactNode }) {
  const value = useMemo<ChatMotion>(
    () => ({
      motion: motionOverride ?? motion,
      AnimatePresence: animatePresenceOverride ?? AnimatePresence,
    }),
    [motionOverride, animatePresenceOverride],
  );
  return <ChatMotionContext.Provider value={value}>{children}</ChatMotionContext.Provider>;
}

export function useMotion(): ChatMotion {
  return useContext(ChatMotionContext);
}
