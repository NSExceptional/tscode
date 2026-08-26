// "" = the released build, which shows no stage badge next to the wordmark.
export type MobileStageLabel = "" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "";
}
