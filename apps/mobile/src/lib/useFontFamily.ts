const FONT_FAMILIES = {
  regular: "System",
  medium: "System",
  bold: "System",
} as const;

export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  return FONT_FAMILIES[weight];
}
