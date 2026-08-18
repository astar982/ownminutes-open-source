import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import * as FileSystem from "expo-file-system/legacy";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

type ShowcaseScreen = "recording" | "transcript" | "summary" | "meetings" | "settings";
type ShowcaseLocale = "zh-Hans" | "en-US" | "zh-Hant";
type ShowcaseControl = { screen: ShowcaseScreen; locale: ShowcaseLocale };

const defaultShowcaseControl: ShowcaseControl = { screen: "recording", locale: "zh-Hans" };

const transcriptRowsByLocale = {
  "zh-Hans": [
    { speaker: "Speaker 1", avatar: "1", time: "09:32", text: "这一版先把移动端录音稳定性和弱网恢复做成发布门槛，实时转写只作为会议中的草稿。" },
    { speaker: "Speaker 2", avatar: "2", time: "09:34", text: "会后再用完整音频重新识别，正式纪要里要明确区分决策、待办和没有结论的问题。" },
    { speaker: "Speaker 1", avatar: "1", time: "09:36", text: "同意。分享页默认隐藏原始音频和逐字稿，用户确认后再单独开放。" },
  ],
  "en-US": [
    { speaker: "Speaker 1", avatar: "1", time: "09:32", text: "For this release, recording stability and weak-network recovery are launch gates. Live transcription remains a meeting draft." },
    { speaker: "Speaker 2", avatar: "2", time: "09:34", text: "After the meeting, the complete audio will be transcribed again. Final notes separate decisions, action items, and open questions." },
    { speaker: "Speaker 1", avatar: "1", time: "09:36", text: "Agreed. Shared pages hide the original audio and transcript by default, and users can enable them separately." },
  ],
  "zh-Hant": [
    { speaker: "講者 1", avatar: "1", time: "09:32", text: "這一版先把行動端錄音穩定性與弱網路恢復列為發布門檻，即時轉寫只作為會議草稿。" },
    { speaker: "講者 2", avatar: "2", time: "09:34", text: "會後再用完整音訊重新辨識，正式會議記錄要明確區分決策、待辦與尚無結論的問題。" },
    { speaker: "講者 1", avatar: "1", time: "09:36", text: "同意。分享頁預設隱藏原始音訊與逐字稿，使用者確認後再個別開放。" },
  ],
} as const;

export function AppStoreShowcase() {
  const [control, setControl] = useState<ShowcaseControl>(defaultShowcaseControl);

  useEffect(() => {
    if (!FileSystem.documentDirectory) return;
    const path = `${FileSystem.documentDirectory}ownminutes-appstore-showcase.txt`;
    const readScreen = async () => {
      try {
        const value = (await FileSystem.readAsStringAsync(path)).trim();
        const nextControl = parseShowcaseControl(value);
        if (nextControl) {
          setControl((current) => (
            current.screen === nextControl.screen && current.locale === nextControl.locale
              ? current
              : nextControl
          ));
        }
      } catch {
        // The capture controller creates the file after the Release app launches.
      }
    };
    void readScreen();
    const timer = setInterval(() => void readScreen(), 200);
    return () => clearInterval(timer);
  }, []);

  const copy = showcaseCopy[control.locale];

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.appShell}>
          {control.screen === "recording" ? <RecordingScreen copy={copy.recording} /> : null}
          {control.screen === "transcript" ? <TranscriptScreen copy={copy.transcript} rows={transcriptRowsByLocale[control.locale]} /> : null}
          {control.screen === "summary" ? <SummaryScreen copy={copy.summary} /> : null}
          {control.screen === "meetings" ? <MeetingsScreen copy={copy.meetings} /> : null}
          {control.screen === "settings" ? <SettingsScreen copy={copy.settings} /> : null}
        </View>
        <BottomTabs screen={control.screen} labels={copy.tabs} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const showcaseCopy = {
  "zh-Hans": {
    recording: {
      title: "会议记录",
      trailing: "产品周会",
      live: "录音中",
      saved: "本地已保存",
      caption: "音频持续保存，实时内容仅作草稿",
      stop: "结束会议",
      metrics: [
        { label: "实时转写", value: "38 条" },
        { label: "本地原音", value: "已保存" },
        { label: "云端同步", value: "正常" },
      ],
      statusTitle: "当前状态",
      microphoneTitle: "麦克风输入稳定",
      microphoneDetail: "录音持续写入本机",
      networkTitle: "网络连接正常",
      networkDetail: "网络可用时同步实时草稿",
    },
    transcript: {
      eyebrow: "正在记录 · 24:18",
      title: "实时转写",
      trailing: "草稿",
      notice: "会后将用完整音频重新识别并校正发言人",
      active: "正在识别下一段发言…",
    },
    summary: {
      eyebrow: "2026 年 7 月 12 日 · 42 分钟",
      title: "产品周会",
      trailing: "已完成",
      label: "会议摘要",
      text: "团队确认首版以 iPhone 录音稳定性为核心，实时转写只作草稿；会后使用完整音频重新识别，并由用户确认正式纪要后再分享。",
      decisionsTitle: "决策记录",
      decisions: [
        "首版只支持 iPhone，不承诺电话录音。",
        "分享链接默认不包含逐字稿和原始音频。",
        "模型调用保留 BYOK，成本由用户自行控制。",
      ],
      tasksTitle: "待办事项",
      tasks: [
        { title: "整理首版发布说明", owner: "产品负责人", due: "7 月 15 日" },
        { title: "确认默认分享权限", owner: "隐私审查", due: "7 月 16 日" },
        { title: "汇总首轮用户反馈", owner: "用户研究", due: "7 月 18 日" },
      ],
    },
    meetings: {
      title: "会议",
      trailing: "12 场",
      search: "搜索标题、发言人或知识点",
      sections: [
        {
          label: "本周",
          items: [
            { date: "12", month: "7 月", title: "产品周会", meta: "42 分钟 · 3 位发言人", tags: ["发布计划", "录音稳定性"] },
            { date: "11", month: "7 月", title: "用户访谈复盘", meta: "36 分钟 · 2 位发言人", tags: ["用户反馈", "成本控制"] },
          ],
        },
        {
          label: "上周",
          items: [
            { date: "05", month: "7 月", title: "开源路线讨论", meta: "58 分钟 · 4 位发言人", tags: ["开源", "App Store"] },
            { date: "03", month: "7 月", title: "语音模型评测", meta: "27 分钟 · 2 位发言人", tags: ["ASR", "说话人识别"] },
          ],
        },
      ],
    },
    settings: {
      title: "成本与模型",
      costLabel: "本月模型费用",
      costValue: "¥3.42",
      costCaption: "7 场会议 · 共 186 分钟",
      budget: "预算 ¥20",
      usage: "已使用 17%",
      modelsTitle: "模型配置",
      speechTitle: "会后语音识别",
      speechProvider: "火山引擎文件识别",
      summaryTitle: "会议纪要总结",
      summaryProvider: "豆包大模型",
      policyTitle: "费用策略",
      ownModelTitle: "优先使用自己的模型",
      ownModelText: "密钥加密保存于后端，可随时更换或删除。",
      privacyTitle: "录音默认私密",
      privacyText: "分享前由你选择是否包含逐字稿。",
    },
    tabs: { recording: "记录", meetings: "会议", account: "我的" },
  },
  "en-US": {
    recording: {
      title: "Meeting Notes",
      trailing: "Product Sync",
      live: "Recording",
      saved: "Saved locally",
      caption: "Audio is continuously saved; live text is only a draft",
      stop: "End meeting",
      metrics: [
        { label: "Live transcript", value: "38 lines" },
        { label: "Local audio", value: "Saved" },
        { label: "Cloud sync", value: "Normal" },
      ],
      statusTitle: "Current status",
      microphoneTitle: "Microphone input is stable",
      microphoneDetail: "Audio keeps saving on this device",
      networkTitle: "Network connected",
      networkDetail: "Live drafts sync when a network is available",
    },
    transcript: {
      eyebrow: "RECORDING · 24:18",
      title: "Live Transcript",
      trailing: "DRAFT",
      notice: "After the meeting, complete audio will be transcribed again and speaker labels corrected",
      active: "Listening for the next segment…",
    },
    summary: {
      eyebrow: "JUL 12, 2026 · 42 MIN",
      title: "Product Sync",
      trailing: "COMPLETE",
      label: "MEETING SUMMARY",
      text: "The team confirmed that reliable iPhone recording is the first-release focus. Live transcription remains a draft; complete audio is processed again after the meeting, and users confirm final notes before sharing.",
      decisionsTitle: "Decisions",
      decisions: [
        "The first release supports iPhone only and does not promise phone-call recording.",
        "Shared links exclude transcripts and original audio by default.",
        "Model access stays BYOK, so users remain in control of usage costs.",
      ],
      tasksTitle: "Action items",
      tasks: [
        { title: "Prepare first-release notes", owner: "Product owner", due: "Jul 15" },
        { title: "Confirm default sharing access", owner: "Privacy reviewer", due: "Jul 16" },
        { title: "Summarize early user feedback", owner: "Research lead", due: "Jul 18" },
      ],
    },
    meetings: {
      title: "Meetings",
      trailing: "12 total",
      search: "Search titles, speakers, or topics",
      sections: [
        {
          label: "THIS WEEK",
          items: [
            { date: "12", month: "JUL", title: "Product Sync", meta: "42 min · 3 speakers", tags: ["Release plan", "Recording"] },
            { date: "11", month: "JUL", title: "Interview Review", meta: "36 min · 2 speakers", tags: ["User feedback", "Cost control"] },
          ],
        },
        {
          label: "LAST WEEK",
          items: [
            { date: "05", month: "JUL", title: "Open-source Roadmap", meta: "58 min · 4 speakers", tags: ["Open source", "App Store"] },
            { date: "03", month: "JUL", title: "Speech Model Review", meta: "27 min · 2 speakers", tags: ["Speech to text", "Speaker labels"] },
          ],
        },
      ],
    },
    settings: {
      title: "Costs & Models",
      costLabel: "Model usage this month",
      costValue: "$0.48",
      costCaption: "7 meetings · 186 minutes",
      budget: "Budget $3",
      usage: "17% used",
      modelsTitle: "Model setup",
      speechTitle: "Post-meeting transcription",
      speechProvider: "Your speech-to-text provider",
      summaryTitle: "Meeting summary",
      summaryProvider: "Your language model",
      policyTitle: "Cost policy",
      ownModelTitle: "Use your own models first",
      ownModelText: "Keys are encrypted on the server and can be replaced or removed anytime.",
      privacyTitle: "Recordings are private by default",
      privacyText: "You choose whether a shared page includes the transcript.",
    },
    tabs: { recording: "Record", meetings: "Meetings", account: "Account" },
  },
  "zh-Hant": {
    recording: {
      title: "會議記錄",
      trailing: "產品週會",
      live: "錄音中",
      saved: "本機已儲存",
      caption: "音訊持續儲存，即時內容僅作草稿",
      stop: "結束會議",
      metrics: [
        { label: "即時轉寫", value: "38 條" },
        { label: "本機原音", value: "已儲存" },
        { label: "雲端同步", value: "正常" },
      ],
      statusTitle: "目前狀態",
      microphoneTitle: "麥克風輸入穩定",
      microphoneDetail: "錄音持續寫入本機",
      networkTitle: "網路連線正常",
      networkDetail: "網路可用時同步即時草稿",
    },
    transcript: {
      eyebrow: "正在記錄 · 24:18",
      title: "即時轉寫",
      trailing: "草稿",
      notice: "會後將使用完整音訊重新辨識並校正發言者",
      active: "正在辨識下一段發言…",
    },
    summary: {
      eyebrow: "2026 年 7 月 12 日 · 42 分鐘",
      title: "產品週會",
      trailing: "已完成",
      label: "會議摘要",
      text: "團隊確認首版以 iPhone 錄音穩定性為核心，即時轉寫只作草稿；會後使用完整音訊重新辨識，並由使用者確認正式會議記錄後再分享。",
      decisionsTitle: "決策記錄",
      decisions: [
        "首版只支援 iPhone，不承諾電話錄音。",
        "分享連結預設不包含逐字稿與原始音訊。",
        "模型呼叫保留 BYOK，費用由使用者自行控制。",
      ],
      tasksTitle: "待辦事項",
      tasks: [
        { title: "整理首版發布說明", owner: "產品負責人", due: "7 月 15 日" },
        { title: "確認預設分享權限", owner: "隱私審查人", due: "7 月 16 日" },
        { title: "彙整首輪使用者回饋", owner: "研究負責人", due: "7 月 18 日" },
      ],
    },
    meetings: {
      title: "會議",
      trailing: "12 場",
      search: "搜尋標題、發言者或知識點",
      sections: [
        {
          label: "本週",
          items: [
            { date: "12", month: "7 月", title: "產品週會", meta: "42 分鐘 · 3 位發言者", tags: ["發布計畫", "錄音穩定性"] },
            { date: "11", month: "7 月", title: "使用者訪談回顧", meta: "36 分鐘 · 2 位發言者", tags: ["使用者回饋", "費用控制"] },
          ],
        },
        {
          label: "上週",
          items: [
            { date: "05", month: "7 月", title: "開源路線討論", meta: "58 分鐘 · 4 位發言者", tags: ["開源", "App Store"] },
            { date: "03", month: "7 月", title: "語音模型評估", meta: "27 分鐘 · 2 位發言者", tags: ["語音轉文字", "發言者標籤"] },
          ],
        },
      ],
    },
    settings: {
      title: "費用與模型",
      costLabel: "本月模型費用",
      costValue: "¥3.42",
      costCaption: "7 場會議 · 共 186 分鐘",
      budget: "預算 ¥20",
      usage: "已使用 17%",
      modelsTitle: "模型設定",
      speechTitle: "會後語音辨識",
      speechProvider: "你的語音辨識服務",
      summaryTitle: "會議記錄摘要",
      summaryProvider: "你的語言模型",
      policyTitle: "費用策略",
      ownModelTitle: "優先使用自己的模型",
      ownModelText: "金鑰加密儲存於後端，可隨時更換或刪除。",
      privacyTitle: "錄音預設為私密",
      privacyText: "分享前由你選擇是否包含逐字稿。",
    },
    tabs: { recording: "記錄", meetings: "會議", account: "我的" },
  },
} as const;

type ShowcaseCopy = (typeof showcaseCopy)[ShowcaseLocale];

function parseShowcaseControl(value: string): ShowcaseControl | null {
  if (isShowcaseScreen(value)) return { screen: value, locale: "zh-Hans" };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as { screen?: unknown; locale?: unknown };
    if (typeof candidate.screen !== "string" || !isShowcaseScreen(candidate.screen)) return null;
    if (typeof candidate.locale !== "string" || !isShowcaseLocale(candidate.locale)) return null;
    return { screen: candidate.screen, locale: candidate.locale };
  } catch {
    return null;
  }
}

function isShowcaseScreen(value: string): value is ShowcaseScreen {
  return ["recording", "transcript", "summary", "meetings", "settings"].includes(value);
}

function isShowcaseLocale(value: string): value is ShowcaseLocale {
  return ["zh-Hans", "en-US", "zh-Hant"].includes(value);
}

function Header({ eyebrow, title, trailing }: { eyebrow: string; title: string; trailing?: string }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.pageTitle}>{title}</Text>
      </View>
      {trailing ? <Text style={styles.headerTrailing}>{trailing}</Text> : null}
    </View>
  );
}

function RecordingScreen({ copy }: { copy: ShowcaseCopy["recording"] }) {
  return (
    <ScrollView style={styles.screenScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Header eyebrow="OWNMINUTES" title={copy.title} trailing={copy.trailing} />
      <View style={styles.recorderPanel}>
        <View style={styles.statusRow}>
          <View style={styles.inlineRow}><View style={styles.liveDot} /><Text style={styles.liveText}>{copy.live}</Text></View>
          <View style={styles.inlineRow}><Ionicons name="cloud-done-outline" size={18} color="#DFF8EE" /><Text style={styles.savedText}>{copy.saved}</Text></View>
        </View>
        <Text style={styles.timer}>24:18</Text>
        <Text style={styles.timerCaption}>{copy.caption}</Text>
        <View style={styles.waveform}>
          {Array.from({ length: 31 }, (_, index) => <View key={index} style={[styles.waveBar, { height: 18 + ((index * 17) % 54) }]} />)}
        </View>
        <View style={styles.stopButton}><Ionicons name="stop" size={34} color="#FFFFFF" /></View>
        <Text style={styles.stopLabel}>{copy.stop}</Text>
      </View>
      <View style={styles.metricStrip}>
        {copy.metrics.map((metric, index) => <Metric key={metric.label} label={metric.label} value={metric.value} accent={index === 2} />)}
      </View>
      <SectionTitle title={copy.statusTitle} />
      <View style={styles.statusList}>
        <StatusLine icon="mic-outline" title={copy.microphoneTitle} detail={copy.microphoneDetail} />
        <StatusLine icon="wifi-outline" title={copy.networkTitle} detail={copy.networkDetail} />
      </View>
    </ScrollView>
  );
}

function TranscriptScreen({ copy, rows }: { copy: ShowcaseCopy["transcript"]; rows: (typeof transcriptRowsByLocale)[ShowcaseLocale] }) {
  return (
    <ScrollView style={styles.screenScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Header eyebrow={copy.eyebrow} title={copy.title} trailing={copy.trailing} />
      <View style={styles.notice}><Ionicons name="information-circle-outline" size={19} color="#176B59" /><Text style={styles.noticeText}>{copy.notice}</Text></View>
      <View style={styles.transcriptList}>
        {rows.map((row, index) => (
          <View key={row.time} style={styles.transcriptRow}>
            <View style={[styles.avatar, index === 1 ? styles.avatarAmber : null]}><Text style={styles.avatarText}>{row.avatar}</Text></View>
            <View style={styles.transcriptBody}>
              <View style={styles.inlineRow}><Text style={styles.speakerName}>{row.speaker}</Text><Text style={styles.rowTime}>{row.time}</Text></View>
              <Text style={styles.transcriptText}>{row.text}</Text>
            </View>
          </View>
        ))}
      </View>
      <View style={styles.activeDraft}>
        <View style={styles.activePulse} />
        <Text style={styles.activeDraftText}>{copy.active}</Text>
      </View>
    </ScrollView>
  );
}

function SummaryScreen({ copy }: { copy: ShowcaseCopy["summary"] }) {
  return (
    <ScrollView style={styles.screenScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Header eyebrow={copy.eyebrow} title={copy.title} trailing={copy.trailing} />
      <View style={styles.summaryHero}>
        <Text style={styles.summaryLabel}>{copy.label}</Text>
        <Text style={styles.summaryText}>{copy.text}</Text>
      </View>
      <SectionTitle title={copy.decisionsTitle} count={String(copy.decisions.length)} />
      <View style={styles.cleanList}>
        {copy.decisions.map((decision, index) => <NumberedLine key={decision} number={String(index + 1).padStart(2, "0")} text={decision} />)}
      </View>
      <SectionTitle title={copy.tasksTitle} count={String(copy.tasks.length)} />
      <View style={styles.taskList}>
        {copy.tasks.map((task) => <TaskLine key={task.title} title={task.title} owner={task.owner} due={task.due} />)}
      </View>
    </ScrollView>
  );
}

function MeetingsScreen({ copy }: { copy: ShowcaseCopy["meetings"] }) {
  return (
    <ScrollView style={styles.screenScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Header eyebrow="OWNMINUTES" title={copy.title} trailing={copy.trailing} />
      <View style={styles.searchBar}><Ionicons name="search" size={20} color="#72817B" /><Text style={styles.searchText}>{copy.search}</Text></View>
      {copy.sections.map((section) => (
        <View key={section.label}>
          <Text style={styles.monthLabel}>{section.label}</Text>
          {section.items.map((item) => <MeetingCard key={`${item.date}-${item.title}`} {...item} />)}
        </View>
      ))}
    </ScrollView>
  );
}

function SettingsScreen({ copy }: { copy: ShowcaseCopy["settings"] }) {
  return (
    <ScrollView style={styles.screenScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Header eyebrow="OWNMINUTES" title={copy.title} trailing="BYOK" />
      <View style={styles.costHero}>
        <Text style={styles.costLabel}>{copy.costLabel}</Text>
        <Text style={styles.costValue}>{copy.costValue}</Text>
        <Text style={styles.costCaption}>{copy.costCaption}</Text>
        <View style={styles.costTrack}><View style={styles.costTrackFill} /></View>
        <View style={styles.costFooter}><Text style={styles.costFooterText}>{copy.budget}</Text><Text style={styles.costFooterText}>{copy.usage}</Text></View>
      </View>
      <SectionTitle title={copy.modelsTitle} />
      <ProviderLine icon="mic-outline" title={copy.speechTitle} provider={copy.speechProvider} status="BYOK" />
      <ProviderLine icon="sparkles-outline" title={copy.summaryTitle} provider={copy.summaryProvider} status="BYOK" />
      <SectionTitle title={copy.policyTitle} />
      <View style={styles.policyPanel}>
        <Ionicons name="key-outline" size={24} color="#176B59" />
        <View style={styles.policyBody}><Text style={styles.policyTitle}>{copy.ownModelTitle}</Text><Text style={styles.policyText}>{copy.ownModelText}</Text></View>
        <Ionicons name="checkmark-circle" size={24} color="#176B59" />
      </View>
      <View style={styles.policyPanel}>
        <Ionicons name="shield-checkmark-outline" size={24} color="#176B59" />
        <View style={styles.policyBody}><Text style={styles.policyTitle}>{copy.privacyTitle}</Text><Text style={styles.policyText}>{copy.privacyText}</Text></View>
        <Ionicons name="chevron-forward" size={22} color="#8A9892" />
      </View>
    </ScrollView>
  );
}

function BottomTabs({ screen, labels }: { screen: ShowcaseScreen; labels: ShowcaseCopy["tabs"] }) {
  const active = screen === "recording" || screen === "transcript" || screen === "summary"
    ? "recording"
    : screen === "meetings"
      ? "meetings"
      : "account";
  const tabs = [
    { id: "recording", label: labels.recording, icon: "mic-outline" },
    { id: "meetings", label: labels.meetings, icon: "document-text-outline" },
    { id: "account", label: labels.account, icon: "person-outline" },
  ] as const;
  return <View style={styles.tabBar}>{tabs.map((tab) => <View key={tab.id} style={styles.tabItem}><Ionicons name={tab.icon} size={25} color={active === tab.id ? "#118363" : "#84918C"} /><Text style={[styles.tabText, active === tab.id ? styles.tabTextActive : null]}>{tab.label}</Text></View>)}</View>;
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={[styles.metricValue, accent ? styles.metricAccent : null]}>{value}</Text></View>;
}

function SectionTitle({ title, count }: { title: string; count?: string }) {
  return <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{title}</Text>{count ? <Text style={styles.sectionCount}>{count}</Text> : null}</View>;
}

function StatusLine({ icon, title, detail }: { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string }) {
  return <View style={styles.statusLine}><View style={styles.iconTile}><Ionicons name={icon} size={21} color="#176B59" /></View><View><Text style={styles.statusTitle}>{title}</Text><Text style={styles.statusDetail}>{detail}</Text></View><Ionicons name="checkmark-circle" size={23} color="#22A37A" /></View>;
}

function NumberedLine({ number, text }: { number: string; text: string }) {
  return <View style={styles.numberedLine}><Text style={styles.lineNumber}>{number}</Text><Text style={styles.numberedText}>{text}</Text></View>;
}

function TaskLine({ title, owner, due }: { title: string; owner: string; due: string }) {
  return <View style={styles.taskLine}><View style={styles.taskPending}><Ionicons name="time-outline" size={16} color="#B06D20" /></View><View style={styles.taskBody}><Text style={styles.taskTitle}>{title}</Text><Text style={styles.taskMeta}>{owner} · {due}</Text></View></View>;
}

function MeetingCard({ date, month, title, meta, tags }: { date: string; month: string; title: string; meta: string; tags: readonly string[] }) {
  return <View style={styles.meetingCard}><View style={styles.dateBlock}><Text style={styles.dateNumber}>{date}</Text><Text style={styles.dateMonth}>{month}</Text></View><View style={styles.meetingBody}><Text style={styles.meetingTitle}>{title}</Text><Text style={styles.meetingMeta}>{meta}</Text><View style={styles.tagRow}>{tags.map((tag) => <Text key={tag} style={styles.tag}>{tag}</Text>)}</View></View><Ionicons name="chevron-forward" size={22} color="#899690" /></View>;
}

function ProviderLine({ icon, title, provider, status }: { icon: keyof typeof Ionicons.glyphMap; title: string; provider: string; status: string }) {
  return <View style={styles.providerLine}><View style={styles.iconTile}><Ionicons name={icon} size={21} color="#176B59" /></View><View style={styles.providerBody}><Text style={styles.providerTitle}>{title}</Text><Text style={styles.providerName}>{provider}</Text></View><Text style={styles.providerStatus}>{status}</Text></View>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F6F8F7" }, appShell: { flex: 1, minHeight: 0 }, screenScroll: { flex: 1 }, content: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 28 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }, eyebrow: { color: "#6F7F78", fontSize: 13, fontWeight: "700", marginBottom: 5 }, pageTitle: { color: "#10231D", fontSize: 34, fontWeight: "800" }, headerTrailing: { color: "#176B59", fontSize: 14, fontWeight: "700", backgroundColor: "#E6F3EE", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 7, overflow: "hidden" },
  inlineRow: { flexDirection: "row", alignItems: "center", gap: 7 }, recorderPanel: { backgroundColor: "#0E382E", borderRadius: 8, padding: 22, alignItems: "center" }, statusRow: { alignSelf: "stretch", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, liveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#F45C57" }, liveText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" }, savedText: { color: "#DFF8EE", fontSize: 13, fontWeight: "600" }, timer: { color: "#FFFFFF", fontSize: 66, fontWeight: "300", marginTop: 38, fontVariant: ["tabular-nums"] }, timerCaption: { color: "#AFC8BF", fontSize: 13, marginTop: 2 }, waveform: { height: 88, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginVertical: 30 }, waveBar: { width: 6, borderRadius: 3, backgroundColor: "#52D1A8" }, stopButton: { width: 92, height: 92, borderRadius: 46, backgroundColor: "#E64B45", alignItems: "center", justifyContent: "center" }, stopLabel: { color: "#FFFFFF", fontSize: 17, fontWeight: "700", marginTop: 12 },
  metricStrip: { flexDirection: "row", marginTop: 14, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E1E9E5", borderRadius: 8 }, metric: { flex: 1, paddingVertical: 15, paddingHorizontal: 12, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: "#DDE6E2" }, metricLabel: { color: "#7C8984", fontSize: 11 }, metricValue: { color: "#152820", fontSize: 17, fontWeight: "700", marginTop: 5 }, metricAccent: { color: "#118363" },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 26, marginBottom: 12 }, sectionTitle: { color: "#132720", fontSize: 20, fontWeight: "800" }, sectionCount: { color: "#176B59", fontSize: 13, fontWeight: "700", backgroundColor: "#E6F3EE", borderRadius: 5, paddingHorizontal: 9, paddingVertical: 4, overflow: "hidden" }, statusList: { backgroundColor: "#FFFFFF", borderRadius: 8, borderWidth: 1, borderColor: "#E1E9E5" }, statusLine: { flexDirection: "row", alignItems: "center", gap: 12, padding: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E1E9E5" }, iconTile: { width: 42, height: 42, borderRadius: 8, backgroundColor: "#EAF4F0", alignItems: "center", justifyContent: "center" }, statusTitle: { color: "#183027", fontSize: 15, fontWeight: "700" }, statusDetail: { color: "#7A8782", fontSize: 12, marginTop: 3 },
  notice: { flexDirection: "row", gap: 8, padding: 13, borderRadius: 7, backgroundColor: "#EAF4F0", marginBottom: 10 }, noticeText: { flex: 1, color: "#315B4D", fontSize: 13, lineHeight: 19 }, transcriptList: { backgroundColor: "#FFFFFF", borderRadius: 8, borderWidth: 1, borderColor: "#E0E8E4" }, transcriptRow: { flexDirection: "row", gap: 12, padding: 17, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#DEE7E3" }, avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#176B59", alignItems: "center", justifyContent: "center" }, avatarAmber: { backgroundColor: "#C7822E" }, avatarText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" }, transcriptBody: { flex: 1 }, speakerName: { color: "#183028", fontSize: 14, fontWeight: "800" }, rowTime: { color: "#8A9691", fontSize: 11, marginLeft: 8 }, transcriptText: { color: "#33463F", fontSize: 16, lineHeight: 25, marginTop: 7 }, activeDraft: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16, marginTop: 14, borderRadius: 7, borderWidth: 1, borderColor: "#A9D8C7", borderStyle: "dashed" }, activePulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#22A37A" }, activeDraftText: { color: "#527068", fontSize: 14 },
  summaryHero: { backgroundColor: "#0E382E", borderRadius: 8, padding: 20 }, summaryLabel: { color: "#8FE0C3", fontSize: 12, fontWeight: "700" }, summaryText: { color: "#FFFFFF", fontSize: 17, lineHeight: 28, marginTop: 10, fontWeight: "600" }, cleanList: { backgroundColor: "#FFFFFF", borderRadius: 8, borderWidth: 1, borderColor: "#E0E8E4" }, numberedLine: { flexDirection: "row", gap: 13, padding: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E0E8E4" }, lineNumber: { color: "#C7822E", fontSize: 12, fontWeight: "800", marginTop: 3 }, numberedText: { flex: 1, color: "#263D35", fontSize: 15, lineHeight: 22 }, taskList: { gap: 9 }, taskLine: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#FFFFFF", borderRadius: 8, borderWidth: 1, borderColor: "#E0E8E4", padding: 14 }, taskPending: { width: 25, height: 25, borderRadius: 13, backgroundColor: "#F8EFE3", alignItems: "center", justifyContent: "center" }, taskBody: { flex: 1 }, taskTitle: { color: "#1A3028", fontSize: 15, fontWeight: "700" }, taskMeta: { color: "#7B8883", fontSize: 12, marginTop: 4 },
  searchBar: { flexDirection: "row", gap: 9, alignItems: "center", backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#DDE6E2", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 13 }, searchText: { color: "#8A9691", fontSize: 14 }, monthLabel: { color: "#53675F", fontSize: 13, fontWeight: "800", marginTop: 24, marginBottom: 9 }, meetingCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E0E8E4", borderRadius: 8, padding: 15, marginBottom: 10 }, dateBlock: { width: 49, alignItems: "center", borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: "#D8E3DE" }, dateNumber: { color: "#153128", fontSize: 23, fontWeight: "800" }, dateMonth: { color: "#7C8984", fontSize: 11, marginTop: 2 }, meetingBody: { flex: 1 }, meetingTitle: { color: "#172D25", fontSize: 16, fontWeight: "800" }, meetingMeta: { color: "#7D8984", fontSize: 12, marginTop: 4 }, tagRow: { flexDirection: "row", gap: 6, marginTop: 8 }, tag: { color: "#35705E", fontSize: 10, backgroundColor: "#EAF4F0", paddingHorizontal: 7, paddingVertical: 4, borderRadius: 4, overflow: "hidden" },
  costHero: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#DDE7E2", borderRadius: 8, padding: 20 }, costLabel: { color: "#66756F", fontSize: 13 }, costValue: { color: "#10261E", fontSize: 48, fontWeight: "800", marginTop: 5 }, costCaption: { color: "#7B8883", fontSize: 13, marginTop: 2 }, costTrack: { height: 8, borderRadius: 4, backgroundColor: "#E5ECE9", marginTop: 20, overflow: "hidden" }, costTrackFill: { width: "17%", height: 8, borderRadius: 4, backgroundColor: "#D59135" }, costFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 }, costFooterText: { color: "#7D8984", fontSize: 11 }, providerLine: { flexDirection: "row", gap: 12, alignItems: "center", backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E0E8E4", padding: 14, marginBottom: 9, borderRadius: 8 }, providerBody: { flex: 1 }, providerTitle: { color: "#1C322A", fontSize: 15, fontWeight: "700" }, providerName: { color: "#7A8782", fontSize: 12, marginTop: 3 }, providerStatus: { color: "#176B59", fontSize: 12, fontWeight: "700" }, policyPanel: { flexDirection: "row", gap: 12, alignItems: "center", backgroundColor: "#FFFFFF", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#DDE6E2", padding: 16 }, policyBody: { flex: 1 }, policyTitle: { color: "#1B332A", fontSize: 15, fontWeight: "700" }, policyText: { color: "#7B8883", fontSize: 12, marginTop: 4, lineHeight: 18 },
  tabBar: { height: 76, flexShrink: 0, flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#D8E2DE", backgroundColor: "#FFFFFF", paddingTop: 10 }, tabItem: { flex: 1, alignItems: "center", gap: 4 }, tabText: { color: "#84918C", fontSize: 11, fontWeight: "700" }, tabTextActive: { color: "#118363" },
});
