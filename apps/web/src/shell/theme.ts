import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { createContext, use } from "react";

export type Theme = "light" | "dark";

export const THEME_COOKIE_NAME = "theme";

// A year. The sidebar's cookie is the library's seven days; a theme is a preference, not a
// session detail, and being asked again next week would read as the setting not sticking.
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Which theme to paint, resolved identically on the server and in the browser so the toggle's
 * first render matches the class already on `<html>`. Dark is the default.
 */
export const readTheme = createIsomorphicFn()
  .server((): Theme => (getCookie(THEME_COOKIE_NAME) === "light" ? "light" : "dark"))
  .client(
    (): Theme =>
      document.cookie.split(";").some((entry) => entry.trim() === `${THEME_COOKIE_NAME}=light`)
        ? "light"
        : "dark",
  );

/**
 * Sets the class on `<html>` before first paint. The root document owns `<html>`, so the layout
 * route contributes this through its `head` scripts rather than a `className` prop. Keep it in
 * step with `readTheme`.
 */
export const THEME_SCRIPT = `document.documentElement.classList.add(document.cookie.split(";").some(function(e){return e.trim()==="${THEME_COOKIE_NAME}=light"})?"light":"dark")`;

export function applyTheme(theme: Theme): void {
  document.cookie = `${THEME_COOKIE_NAME}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}`;
  document.documentElement.classList.remove(theme === "dark" ? "light" : "dark");
  document.documentElement.classList.add(theme);
}

type ThemeControls = {
  theme: Theme;
  toggleTheme: () => void;
};

export const ThemeContext = createContext<ThemeControls | null>(null);

export function useTheme(): ThemeControls {
  const controls = use(ThemeContext);

  if (!controls) {
    throw new Error("useTheme must be used inside the app layout's ThemeContext.");
  }

  return controls;
}
