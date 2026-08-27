import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

/**
 * Alternate app-icon switching, routed through our own T3NativeControls module
 * (which reliably links) rather than a third-party native module. The alternate
 * icons themselves are registered in Info.plist by the expo-dynamic-app-icon
 * config plugin at prebuild; here we only flip between them at runtime.
 *
 * requireOptionalNativeModule returns null instead of throwing when the module
 * is unavailable, so this never crashes the app at import.
 */
interface AlternateIconNativeModule {
  readonly supportsAlternateIcons: () => boolean;
  readonly getAppIcon: () => string;
  readonly setAppIcon: (name: string) => string;
}

const nativeModule = requireOptionalNativeModule<AlternateIconNativeModule>("T3NativeControls");

// Don't call into UIKit at module-load; just confirm the module + function
// exist. The device capability is re-checked inside the native setter.
export const appIconsSupported =
  Platform.OS === "ios" && typeof nativeModule?.setAppIcon === "function";

/** The currently-applied icon key, or null when the primary icon is active. */
export function getCurrentAppIconKey(): string | null {
  if (!appIconsSupported || !nativeModule) return null;
  try {
    const current = nativeModule.getAppIcon();
    return !current || current === "DEFAULT" ? null : current;
  } catch {
    return null;
  }
}

/** Apply an icon by key (null → primary/default). Returns whether it succeeded. */
export function applyAppIcon(key: string | null): boolean {
  if (!appIconsSupported || !nativeModule) return false;
  try {
    nativeModule.setAppIcon(key ?? "DEFAULT");
    return true;
  } catch {
    return false;
  }
}
