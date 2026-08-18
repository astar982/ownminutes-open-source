import type { Metadata } from "next";
import { connection } from "next/server";
import { TraditionalLegalPage } from "@/app/zh-Hant/_components/traditional-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";

export const metadata: Metadata = {
  title: "支援 - OwnMinutes",
  description: "OwnMinutes 錄音、轉寫、模型供應商、Apple 購買、帳號與資料刪除說明。",
};

export default async function TraditionalSupportPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const supportText = supportEmail
    ? `支援電子郵件：${supportEmail}。切勿傳送密碼、驗證碼、模型金鑰、雲端憑證、完整錄音或未去識別化的逐字稿。`
    : "請使用應用程式內的支援與資料控制功能。正式託管服務啟用後，頁面會顯示公開支援電子郵件。";
  const actions = [
    ...(supportEmail ? [{ href: `mailto:${supportEmail}`, label: "寄送支援郵件" }] : []),
    {
      href: "https://apps.apple.com/account/subscriptions",
      label: "管理 Apple 訂閱",
      type: "external" as const,
    },
    {
      href: "https://github.com/astar982/ownminutes-open-source/issues",
      label: "回報公開問題",
      type: "external" as const,
    },
  ];

  return (
    <TraditionalLegalPage
      actions={actions}
      englishHref="/en/support"
      simplifiedHref="/support"
      title="支援與說明"
      updatedAt="2026-07-30"
      intro="錄音、轉寫、模型供應商、分享、匯出、Apple 購買或帳號功能無法正常運作時，請依以下步驟排查。帳號、購買與刪除請求請透過私人支援提出，不要發佈到公開 Issue。"
      sections={[
        {
          title: "無法開始錄音",
          items: [
            "開啟 iPhone「設定」，確認 OwnMinutes 已取得麥克風權限，然後返回應用程式並重新進入錄音畫面。",
            "確認沒有其他應用程式獨占麥克風，並檢查藍牙耳機或外接麥克風是否仍保持連線。",
            "開始後應看到明確的錄音狀態、計時器與音量變化。若狀態沒有改變，不要誤以為會議已被錄下；請先重新授權麥克風或重新啟動應用程式。",
            "錄音或將音訊傳送至語音辨識或語言模型供應商前，請告知與會者並取得法律或組織政策要求的同意。",
          ],
        },
        {
          title: "上傳或轉寫未完成",
          items: [
            "OwnMinutes 會優先在裝置上保留音訊。網路中斷時，請勿刪除應用程式或會議；重新連線後，讓待上傳的音訊分段繼續同步。",
            "即時轉寫只是一份草稿。正式結果會在會議結束後根據完整音訊產生，內容可能與即時草稿不同。",
            "請在「設定」中執行服務連線與供應商健康檢查。使用 BYOK 時，請確認供應商、模型、端點、金鑰、供應商帳號額度、區域及網路設定。",
            "會議內容可能由你選擇的模型供應商處理；使用官方分鐘時，則可能由 OwnMinutes 設定的供應商處理。處理敏感或受監管內容前，請先閱讀隱私權政策。",
          ],
        },
        {
          title: "發言者標籤、紀要或待辦事項不準確",
          items: [
            "單一裝置的混合錄音無法保證完美區分發言者。會後請重新命名 Speaker 標籤，並檢查每個片段的實際發言者。",
            "請確認決策、負責人、期限、風險與未解決問題。沒有逐字稿依據的陳述應刪除或標示為不確定。",
            "分享前請再次確認逐字稿公開狀態。原始音訊預設不會分享，逐字稿也預設隱藏。",
          ],
        },
        {
          title: "Apple 購買、續訂或恢復購買",
          items: [
            "購買未反映時，請確認裝置使用的是購買時的 Apple 帳號，登入預期的 OwnMinutes 帳號，然後選擇「恢復購買」。請勿公開訂單編號或完整交易憑證。",
            "訂閱會自動續訂，除非你至少在目前計費週期結束前 24 小時於 Apple 的訂閱設定中取消。計費、續訂時間、付款方式、稅務及退款決定由 Apple 處理。",
            "請從 iPhone「設定」> Apple 帳號 >「訂閱」，或 Apple 的訂閱管理頁面管理或取消。刪除 OwnMinutes 應用程式或帳號不會取消 Apple 訂閱。",
            "若權益不符，請向支援提供應用程式版本、產品名稱、大約購買時間、已登入的 OwnMinutes 電子郵件及已遮蔽的交易參考資料。切勿傳送 Apple 帳號憑證或完整的已簽署交易內容。",
          ],
        },
        {
          title: "帳號與資料",
          items: [
            "忘記密碼時，請在登入畫面使用「忘記密碼」。請檢查垃圾郵件，並確認註冊電子郵件地址輸入正確。",
            "「我的」或帳號中心提供帳號匯出與永久刪除帳號功能。會議詳細資料提供撤銷分享與刪除單一會議功能。",
            "若不希望訂閱續期，請在刪除帳號前取消 Apple 訂閱。帳號刪除會移除一般產品存取，但可能保留最低限度、已假名化或匿名化的 Apple 訂單與通知紀錄，以履行法律、會計、退款、爭議及詐欺防止義務。",
          ],
        },
        {
          title: "支援回報應包含哪些資訊",
          items: [
            "請提供裝置型號、iOS 版本、OwnMinutes 版本、會議長度、網路狀態、是否使用耳機或 BYOK、錯誤的大約時間及可重現步驟。",
            "分享問題只需提供會議標題或分享連結末端的低敏感識別資訊。供應商問題可提供供應商名稱、錯誤碼及已遮蔽的金鑰識別資訊。",
            "請勿傳送密碼、驗證碼、模型金鑰、雲端憑證、完整錄音、完整逐字稿、客戶清單或未去識別化的會議螢幕截圖。",
          ],
        },
        {
          title: "聯絡管道",
          items: [
            supportText,
            "GitHub Issues 只用於不含帳號、會議、購買或客戶資訊的公開缺陷與功能建議。登入、計費、刪除或機密內容問題請使用私人支援。",
          ],
        },
      ]}
    />
  );
}
