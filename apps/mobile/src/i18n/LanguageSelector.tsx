import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { localePreferences, type AppLocale, type LocalePreference } from "./core";
import { useI18n } from "./provider";

const labels: Record<LocalePreference, string> = {
  system: "common.system",
  en: "common.english",
  "zh-Hans": "common.simplifiedChinese",
  "zh-Hant": "common.traditionalChinese",
};

const autonyms: Record<AppLocale, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

export function LanguageSelector({ variant = "settings" }: { variant?: "auth" | "settings" }) {
  const { locale, preference, setPreference, systemLocale, t } = useI18n();
  const [visible, setVisible] = useState(false);
  const currentLabel = preference === "system"
    ? t("language.systemCurrent", { language: autonyms[systemLocale] })
    : autonyms[preference];
  const triggerLabel = variant === "auth" ? autonyms[locale] : currentLabel;

  async function chooseLanguage(option: LocalePreference) {
    await setPreference(option);
    setVisible(false);
  }

  return (
    <>
      <Pressable
        accessibilityHint={t("language.choose")}
        accessibilityLabel={`${t("language.displayTitle")} · ${currentLabel}`}
        accessibilityRole="button"
        onPress={() => setVisible(true)}
        style={({ pressed }) => [
          variant === "auth" ? styles.authTrigger : styles.settingsTrigger,
          pressed ? styles.pressed : null,
        ]}
      >
        <View style={variant === "auth" ? styles.authIcon : styles.settingsIcon}>
          <Ionicons accessibilityElementsHidden color="#254137" name="language-outline" size={variant === "auth" ? 18 : 20} />
        </View>
        {variant === "settings" ? (
          <View style={styles.triggerCopy}>
            <Text style={styles.triggerTitle}>{t("language.displayTitle")}</Text>
            <Text numberOfLines={1} style={styles.triggerDetail}>{currentLabel}</Text>
          </View>
        ) : (
          <Text numberOfLines={1} style={styles.authLabel}>{triggerLabel}</Text>
        )}
        <Ionicons accessibilityElementsHidden color="#7b8881" name="chevron-forward" size={variant === "auth" ? 16 : 19} />
      </Pressable>

      <Modal animationType="slide" onRequestClose={() => setVisible(false)} presentationStyle="pageSheet" visible={visible}>
        <SafeAreaView style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <View style={styles.modalHeading}>
              <Text accessibilityRole="header" style={styles.modalTitle}>{t("language.displayTitle")}</Text>
              <Text style={styles.modalDetail}>{t("language.choose")}</Text>
            </View>
            <Pressable
              accessibilityLabel={t("common.close")}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setVisible(false)}
              style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}
            >
              <Ionicons accessibilityElementsHidden color="#53615a" name="close" size={23} />
            </Pressable>
          </View>

          <View accessibilityRole="radiogroup" style={styles.options}>
            {localePreferences.map((option) => {
              const selected = preference === option;
              const optionLabel = option === "system" ? t(labels[option]) : autonyms[option];
              const optionDetail = option === "system" ? t("language.systemCurrent", { language: autonyms[systemLocale] }) : null;
              const optionAccessibilityLabel = option === "system"
                ? `${optionLabel} · ${autonyms[systemLocale]}`
                : optionLabel;
              return (
                <Pressable
                  accessibilityLabel={optionAccessibilityLabel}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  key={option}
                  onPress={() => void chooseLanguage(option)}
                  style={({ pressed }) => [styles.option, selected ? styles.optionSelected : null, pressed ? styles.pressed : null]}
                >
                  <View style={styles.optionCopy}>
                    <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>{optionLabel}</Text>
                    {optionDetail ? <Text style={styles.optionDetail}>{optionDetail}</Text> : null}
                  </View>
                  <View style={[styles.radio, selected ? styles.radioSelected : null]}>
                    {selected ? <View style={styles.radioDot} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.systemDetail}>{t("language.systemDetail")}</Text>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  authTrigger: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#f4f7f4",
    borderColor: "#dce2dd",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 44,
    maxWidth: 176,
    paddingHorizontal: 10,
  },
  authIcon: {
    alignItems: "center",
    justifyContent: "center",
  },
  authLabel: {
    color: "#254137",
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  settingsTrigger: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderBottomColor: "#e8ebe8",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 66,
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  settingsIcon: {
    alignItems: "center",
    backgroundColor: "#edf6f1",
    borderRadius: 11,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  triggerCopy: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  triggerTitle: {
    color: "#17201b",
    fontSize: 15,
    fontWeight: "700",
  },
  triggerDetail: {
    color: "#6d7973",
    fontSize: 12,
  },
  modalSafeArea: {
    backgroundColor: "#fbfcfa",
    flex: 1,
    paddingHorizontal: 20,
  },
  modalHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 16,
    justifyContent: "space-between",
    paddingBottom: 18,
    paddingTop: 18,
  },
  modalHeading: {
    flex: 1,
    gap: 5,
  },
  modalTitle: {
    color: "#17201b",
    fontSize: 24,
    fontWeight: "800",
  },
  modalDetail: {
    color: "#68736d",
    fontSize: 14,
    lineHeight: 20,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "#eef1ee",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  options: {
    backgroundColor: "#ffffff",
    borderColor: "#e0e5e1",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  option: {
    alignItems: "center",
    borderBottomColor: "#e8ebe8",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 14,
    justifyContent: "space-between",
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  optionSelected: {
    backgroundColor: "#edf7f2",
  },
  optionCopy: {
    flex: 1,
    gap: 3,
  },
  optionLabel: {
    color: "#35433c",
    fontSize: 16,
    fontWeight: "600",
  },
  optionLabelSelected: {
    color: "#14795b",
    fontWeight: "800",
  },
  optionDetail: {
    color: "#728079",
    fontSize: 12,
  },
  radio: {
    alignItems: "center",
    borderColor: "#a7b0ab",
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  radioSelected: {
    borderColor: "#14795b",
  },
  radioDot: {
    backgroundColor: "#14795b",
    borderRadius: 999,
    height: 12,
    width: 12,
  },
  systemDetail: {
    color: "#7a746b",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 14,
  },
  pressed: {
    opacity: 0.72,
  },
});
