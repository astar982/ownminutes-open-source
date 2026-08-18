import { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

export function Panel({ title, children, plain = false }: { title?: string; children: ReactNode; plain?: boolean }) {
  return (
    <View style={[styles.panel, plain ? styles.panelPlain : null]}>
      {title ? <Text accessibilityRole="header" style={styles.panelTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${label}：${value}`} style={styles.stat}>
      <Text accessibilityElementsHidden style={styles.statLabel}>{label}</Text>
      <Text accessibilityElementsHidden adjustsFontSizeToFit minimumFontScale={0.72} style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: "#fff",
    borderColor: "transparent",
    borderRadius: 0,
    borderWidth: 0,
    marginBottom: 10,
    marginHorizontal: -16,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  panelTitle: {
    color: "#17211d",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 14,
  },
  panelPlain: {
    backgroundColor: "transparent",
    borderWidth: 0,
    marginBottom: 0,
    padding: 0,
  },
  stat: {
    backgroundColor: "#f5f8f6",
    borderColor: "#e3e9e5",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minWidth: 104,
    padding: 10,
  },
  statLabel: {
    color: "#756c5f",
    fontSize: 12,
    marginBottom: 6,
  },
  statValue: {
    color: "#171713",
    fontSize: 15,
    fontWeight: "700",
  },
});
