import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";

import { AppText as Text } from "../../../../components/AppText";
import { APP_ICON_OPTIONS, type AppIconGroup, type AppIconOption } from "../../../../lib/appIcons";
import {
  appIconsSupported,
  applyAppIcon,
  getCurrentAppIconKey,
} from "../../../../lib/appIconControl";
import { SettingsSection } from "../../components/SettingsSection";

function AppIconTile(props: {
  readonly option: AppIconOption;
  readonly selected: boolean;
  readonly onSelect: (key: string | null) => void;
}) {
  const { option, selected } = props;
  return (
    <Pressable
      accessibilityLabel={`${option.label} app icon`}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      className="w-1/3 items-center gap-1.5 py-2"
      onPress={() => props.onSelect(option.key)}
    >
      <View
        className={
          selected
            ? "rounded-[18px] border-2 border-primary p-0.5"
            : "rounded-[18px] border-2 border-transparent p-0.5"
        }
      >
        <Image
          accessibilityIgnoresInvertColors
          source={option.thumbnail}
          style={{ width: 64, height: 64, borderRadius: 14 }}
          contentFit="cover"
        />
      </View>
      <Text
        className={
          selected ? "text-xs font-t3-bold text-foreground" : "text-xs text-foreground-muted"
        }
      >
        {option.label}
      </Text>
    </Pressable>
  );
}

function AppIconGroupCard(props: {
  readonly title: string;
  readonly group: AppIconGroup;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const options = APP_ICON_OPTIONS.filter((option) => option.group === props.group);
  return (
    <SettingsSection card title={props.title}>
      <View className="flex-row flex-wrap px-2 py-1">
        {options.map((option) => (
          <AppIconTile
            key={option.key ?? "default"}
            option={option}
            selected={props.selectedKey === option.key}
            onSelect={props.onSelect}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

export function AppIconSection() {
  const [selectedKey, setSelectedKey] = useState<string | null>(() => getCurrentAppIconKey());

  const handleSelect = useCallback((key: string | null) => {
    setSelectedKey(key);
    if (!applyAppIcon(key)) {
      // The switch was rejected (e.g. unsupported) — fall back to what's live.
      setSelectedKey(getCurrentAppIconKey());
    }
  }, []);

  if (!appIconsSupported) return null;

  return (
    <View className="gap-6">
      <AppIconGroupCard
        title="App Icon — Light"
        group="light"
        selectedKey={selectedKey}
        onSelect={handleSelect}
      />
      <AppIconGroupCard
        title="App Icon — Dark"
        group="dark"
        selectedKey={selectedKey}
        onSelect={handleSelect}
      />
    </View>
  );
}
