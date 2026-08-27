import type { ImageSourcePropType } from "react-native";

export type AppIconGroup = "light" | "dark";

export interface AppIconOption {
  /**
   * Alternate-icon name registered with expo-dynamic-app-icon, or `null` for
   * the app's primary (default) icon. Blue-dark is the primary, so its key is
   * null and selecting it resets to "DEFAULT".
   */
  readonly key: string | null;
  readonly label: string;
  readonly group: AppIconGroup;
  readonly thumbnail: ImageSourcePropType;
}

/**
 * Every selectable app icon, split into the two "major groups" the artwork
 * ships in: the light ("Revised") set and the dark ("Revised (dark)") set.
 * Keep the alternate keys in sync with the expo-dynamic-app-icon plugin config
 * in app.config.ts (every non-null key must be registered there).
 */
export const APP_ICON_OPTIONS: readonly AppIconOption[] = [
  // ── Light ──────────────────────────────────────────────────────────────
  {
    key: "blue",
    label: "Blue",
    group: "light",
    thumbnail: require("../../assets/app-icons/AppIcon-blue.png"),
  },
  {
    key: "purple",
    label: "Purple",
    group: "light",
    thumbnail: require("../../assets/app-icons/AppIcon-purple.png"),
  },
  {
    key: "rainbow",
    label: "Rainbow",
    group: "light",
    thumbnail: require("../../assets/app-icons/AppIcon-rainbow.png"),
  },
  {
    key: "red",
    label: "Red",
    group: "light",
    thumbnail: require("../../assets/app-icons/AppIcon-red.png"),
  },
  {
    key: "teal",
    label: "Teal",
    group: "light",
    thumbnail: require("../../assets/app-icons/AppIcon-teal.png"),
  },
  {
    key: "yellow",
    label: "Yellow",
    group: "light",
    thumbnail: require("../../assets/app-icons/AppIcon-yellow.png"),
  },
  // ── Dark ───────────────────────────────────────────────────────────────
  {
    // Primary/default icon — resets alternates when chosen.
    key: null,
    label: "Blue",
    group: "dark",
    thumbnail: require("../../assets/app-icons/AppIcon-blue-dark.png"),
  },
  {
    key: "purple_dark",
    label: "Purple",
    group: "dark",
    thumbnail: require("../../assets/app-icons/AppIcon-purple-dark.png"),
  },
  {
    key: "rainbow_dark",
    label: "Rainbow",
    group: "dark",
    thumbnail: require("../../assets/app-icons/AppIcon-rainbow-dark.png"),
  },
  {
    key: "red_dark",
    label: "Red",
    group: "dark",
    thumbnail: require("../../assets/app-icons/AppIcon-red-dark.png"),
  },
  {
    key: "teal_dark",
    label: "Teal",
    group: "dark",
    thumbnail: require("../../assets/app-icons/AppIcon-teal-dark.png"),
  },
  {
    key: "yellow_dark",
    label: "Yellow",
    group: "dark",
    thumbnail: require("../../assets/app-icons/AppIcon-yellow-dark.png"),
  },
];

export const APP_ICON_GROUP_LABELS: Record<AppIconGroup, string> = {
  light: "Light",
  dark: "Dark",
};
