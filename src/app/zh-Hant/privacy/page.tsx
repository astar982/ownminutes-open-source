import type { Metadata } from "next";
import { connection } from "next/server";
import { TraditionalLegalPage } from "@/app/zh-Hant/_components/traditional-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";
import { getPublicLegalIdentity } from "@/lib/public-legal-identity";

export const metadata: Metadata = {
  title: "隱私權政策 - OwnMinutes",
  description: "OwnMinutes 如何處理帳號、會議、模型供應商、購買與使用資料。",
};

export default async function TraditionalPrivacyPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const legalIdentity = getPublicLegalIdentity();
  const supportText = supportEmail
    ? `支援電子郵件：${supportEmail}。請勿透過電子郵件傳送密碼、模型 API 金鑰、完整錄音或未去識別化的會議內容。`
    : "請使用應用程式內的匯出、撤銷分享、刪除會議與刪除帳號功能提出帳號及資料請求。正式託管服務啟用後，頁面會顯示公開支援電子郵件。";

  return (
    <TraditionalLegalPage
      actions={
        supportEmail
          ? [{ href: `mailto:${supportEmail}?subject=OwnMinutes%20Privacy%20Request`, label: "聯絡隱私支援" }]
          : []
      }
      englishHref="/en/privacy"
      simplifiedHref="/privacy"
      title="隱私權政策"
      updatedAt="2026-07-30"
      intro="OwnMinutes 用於會議錄音、產生即時轉寫草稿與會後正式結果、整理會議紀要，並支援分享及 Markdown 匯出。本政策說明我們處理哪些資料、為何處理，以及你可以如何存取、匯出或刪除資料。"
      sections={[
        {
          title: "我們處理的資料",
          items: [
            "帳號資料包括你的顯示名稱、電子郵件地址、信箱驗證狀態、登入工作階段、內部使用者識別碼、方案權益及使用紀錄。密碼、信箱驗證與密碼重設憑證只會以不可逆雜湊保存。",
            "會議資料可能包括會議標題、與會者與標籤、錄音及音訊分段、即時轉寫草稿、正式逐字稿、發言者標籤、摘要、決策、待辦事項、風險、知識重點及產生的 Markdown。",
            "模型設定包括你選擇的語音辨識及語言模型供應商、非機密設定，以及加密保存的供應商金鑰。帳號匯出、分享頁面、Markdown 或一般 API 回應都不會傳回金鑰明文。",
            "購買與使用資料可能包括 Apple 交易及原始交易識別碼、產品識別碼、訂閱日期與狀態、權益、官方分鐘用量，以及最少量的 App Store 伺服器通知識別碼與處理結果。",
            "產品互動與診斷資料可能包括麥克風權限狀態、音訊格式、錄音與上傳狀態、網路復原狀態、供應商健康檢查結果、應用程式版本、裝置與作業系統資訊，以及維持錄音與處理可靠性所需的低敏感錯誤資訊。",
          ],
        },
        {
          title: "我們處理資料的目的",
          items: [
            "儲存會議音訊、產生即時草稿與正式結果，並讓你可在裝置或帳號中檢視、播放、搜尋、分享及匯出內容。",
            "產生摘要、決策、待辦事項與知識重點，並依你的指示建立或撤銷分享連結。",
            "驗證帳號所有權、保護登入與資料存取、復原帳號、提供付費權益、恢復購買、處理訂閱生命週期事件，以及防止詐欺或濫用。",
            "診斷錄音、上傳、當機、相容性、網路、模型供應商與購買權益交付失敗，並履行法律、稅務、會計、退款及爭議處理義務。",
          ],
        },
        {
          title: "麥克風使用與與會者同意",
          items: [
            "只有在你授予麥克風權限並主動開始錄音後，OwnMinutes 才會錄製會議音訊。錄音進行時，應用程式會顯示明確的錄音狀態。",
            "錄音前，你必須告知與會者，並確認錄音、轉寫、模型處理、摘要與分享符合適用法律、組織政策及與會者約定。",
            "OwnMinutes 不是電話通話錄音工具，也不會繞過 iOS、會議軟體或其他系統所施加的錄音限制。",
          ],
        },
        {
          title: "模型供應商與其他第三方",
          items: [
            "為產生你要求的轉寫或摘要，會議內容可能會傳送至你選擇的語音辨識或語言模型供應商。在 BYOK 模式下，相關請求由你設定的供應商透過你的供應商帳號處理。",
            "使用官方處理分鐘時，OwnMinutes 只會將完成所要求功能所需的資料傳送至 OwnMinutes 設定的模型供應商。供應商基礎設施可能在不同司法管轄區處理資料，並受該供應商的條款與隱私權政策約束。",
            "帳號交易郵件可能由郵件服務供應商寄送。App Store 購買由 Apple 處理。託管、資料庫與物件儲存供應商會處理營運服務所需的資料。",
            "請勿錄製或提交你無權透過所選供應商及區域處理的機密、受監管或敏感資訊。",
          ],
        },
        {
          title: "分享與公開存取",
          items: [
            "分享連結預設顯示摘要、發言者觀點、決策與待辦事項。完整逐字稿預設隱藏，公開前需要再次確認。",
            "原始音訊預設為私人內容，不會自動包含在分享頁面或帳號匯出中。",
            "撤銷分享連結後，OwnMinutes 提供的連結會停止運作。其他人或服務已下載、複製、擷取或儲存的副本，OwnMinutes 無法自動刪除。",
          ],
        },
        {
          title: "保留、匯出與刪除",
          items: [
            "帳號與會議資料會在提供服務所需期間保留，直到你刪除會議或帳號；法律要求時可能需要保留更久。",
            "刪除後，內容會從一般線上存取中移除。加密備份中的副本可能保留最多 35 天，之後透過備份輪替刪除；在此期間不會用於一般產品存取。",
            "帳號刪除後，OwnMinutes 可能只保留最低限度、已假名化或匿名化的 Apple 訂單及伺服器通知紀錄，用於權益完整性、詐欺防止、會計或稅務紀錄、退款、拒付、爭議及法律合規。該紀錄不會保留會議內容、錄音、逐字稿、模型金鑰明文或有效登入工作階段。",
            "帳號摘要匯出包含帳號資訊、用量、會議索引與低敏感設定摘要，不包含完整逐字稿、完整會議 Markdown、密碼、模型金鑰明文或原始錄音。",
            "可攜式匯出包含會議結果、完整逐字稿與會議 Markdown，方便遷移；仍不包含密碼、模型金鑰明文或原始錄音。匯出至 Files、Obsidian、雲端硬碟或其他服務的副本，由你在相應服務中管理與刪除。",
            "刪除 OwnMinutes 帳號或移除應用程式不會取消 Apple 訂閱。如果你不希望訂閱續期，請在刪除帳號前另行於 Apple 的訂閱設定中取消。",
          ],
        },
        {
          title: "你的選擇與聯絡方式",
          items: [
            "你可以拒絕麥克風存取、停止錄音、撤銷分享、隱藏逐字稿、刪除單一會議、匯出帳號資料，或在應用程式內永久刪除帳號。",
            "OwnMinutes 不會將會議內容用於跨應用程式廣告追蹤，也不會出售你的錄音、逐字稿或模型金鑰。",
            supportText,
          ],
        },
        {
          title: "營運主體與適用司法管轄區",
          items: legalIdentity
            ? [
                `營運主體：${legalIdentity.operatorName}。`,
                `聯絡地址：${legalIdentity.operatorAddress}。`,
                `適用司法管轄區：${legalIdentity.jurisdiction}。本政策不排除依法不得排除的權利。`,
              ]
            : [
                "目前未設定可公開核驗的營運主體名稱、聯絡地址與適用司法管轄區，因此付費服務維持關閉。",
                "付費服務開放前，OwnMinutes 必須在本頁公布真實營運主體資料，不會使用預留名稱或虛構地址。",
              ],
        },
      ]}
    />
  );
}
