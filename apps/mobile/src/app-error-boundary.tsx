import { Component, type ReactNode } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getLocales } from "expo-localization";
import { resolveSystemLocale, translate } from "./i18n/core";

type Props = {
  children: ReactNode;
};

type State = {
  supportCode: string | null;
  retryKey: number;
};

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { supportCode: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { supportCode: supportCodeForError(error) };
  }

  componentDidCatch(error: Error) {
    console.error("[OwnMinutes] App render failed", error.name || "AppError");
  }

  retry = () => {
    this.setState((current) => ({ supportCode: null, retryKey: current.retryKey + 1 }));
  };

  render() {
    if (this.state.supportCode) {
      const locale = resolveSystemLocale(getLocales().map((item) => item.languageTag ?? item.languageCode));
      return (
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.content}>
            <View accessibilityElementsHidden style={styles.mark}>
              <Ionicons color="#b5473f" name="alert-circle-outline" size={32} />
            </View>
            <Text style={styles.title}>{translate(locale, "appError.title")}</Text>
            <Text style={styles.body}>{translate(locale, "appError.body")}</Text>
            <Text selectable style={styles.code}>{translate(locale, "appError.code", { code: this.state.supportCode })}</Text>
            <Pressable accessibilityLabel={translate(locale, "appError.retry")} accessibilityRole="button" onPress={this.retry} style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}>
              <Ionicons accessibilityElementsHidden color="#ffffff" name="refresh" size={18} />
              <Text style={styles.buttonText}>{translate(locale, "appError.retry")}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      );
    }

    return <View key={this.state.retryKey} style={styles.appRoot}>{this.props.children}</View>;
  }
}

function supportCodeForError(error: Error) {
  const signature = `${error.name || "AppError"}\n${error.message || ""}\n${error.stack?.split("\n").slice(0, 3).join("\n") || ""}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `OM-R-${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

const styles = StyleSheet.create({
  appRoot: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: "#f7f8f6",
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  mark: {
    alignItems: "center",
    justifyContent: "center",
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#f7e8e5",
  },
  title: {
    marginTop: 24,
    color: "#17211c",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  body: {
    marginTop: 12,
    color: "#637069",
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
  },
  code: {
    marginTop: 12,
    color: "#8a948f",
    fontSize: 12,
  },
  button: {
    minHeight: 48,
    marginTop: 28,
    paddingHorizontal: 22,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#14795b",
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
});
