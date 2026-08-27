import { Platform } from "react-native";
import { getAppIcon, setAppIcon } from "expo-dynamic-app-icon";

/**
 * Thin wrapper over expo-dynamic-app-icon that speaks in our catalog's terms:
 * a `null` key means the primary/default icon (the library's "DEFAULT").
 */

export const appIconsSupported = Platform.OS === "ios" || Platform.OS === "android";

/** The currently-applied icon key, or null when the primary icon is active. */
export function getCurrentAppIconKey(): string | null {
  if (!appIconsSupported) return null;
  const current = getAppIcon();
  return !current || current === "DEFAULT" ? null : current;
}

/** Apply an icon by key (null → primary/default). Returns whether it succeeded. */
export function applyAppIcon(key: string | null): boolean {
  if (!appIconsSupported) return false;
  return setAppIcon(key ?? "DEFAULT") !== false;
}
