import type { ColorValue } from "react-native";
import Svg, { Text as SvgText } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedText = withUniwind(SvgText);

// The fork's "TS" mark; cap height ≈ 0.7 em, so the font is scaled to fill `height`.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const fontSize = props.height / 0.7;
  return (
    <Svg accessibilityLabel="TS" height={props.height} width={fontSize * 1.25}>
      <ThemedText
        x={0}
        y={props.height}
        fontSize={fontSize}
        fontWeight="bold"
        letterSpacing={-0.04 * fontSize}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      >
        TS
      </ThemedText>
    </Svg>
  );
}
