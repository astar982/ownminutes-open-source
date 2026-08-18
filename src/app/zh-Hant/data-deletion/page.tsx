import type { Metadata } from "next";
import { connection } from "next/server";
import { TraditionalLegalPage } from "@/app/zh-Hant/_components/traditional-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";

export const metadata: Metadata = {
  title: "資料刪除 - OwnMinutes",
  description: "如何撤銷分享、刪除會議、匯出資料，以及永久刪除 OwnMinutes 帳號。",
};

export default async function TraditionalDataDeletionPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const supportText = supportEmail
    ? `支援電子郵件：${supportEmail}。請勿傳送密碼、驗證碼、模型金鑰、完整錄音或完整逐字稿。`
    : "能夠登入時，請使用應用程式內的刪除功能。正式託管服務啟用後，頁面會顯示公開支援電子郵件。";
  const actions = [
    ...(supportEmail
      ? [{ href: `mailto:${supportEmail}?subject=OwnMinutes%20Data%20Deletion%20Request`, label: "聯絡刪除支援" }]
      : []),
    {
      href: "https://apps.apple.com/account/subscriptions",
      label: "管理 Apple 訂閱",
      type: "external" as const,
    },
  ];

  return (
    <TraditionalLegalPage
      actions={actions}
      englishHref="/en/data-deletion"
      simplifiedHref="/data-deletion"
      title="資料刪除"
      updatedAt="2026-07-31"
      intro="你可以在 OwnMinutes 中撤銷公開分享、刪除單一會議、匯出帳號資料，或永久刪除帳號。以下說明每項功能的位置、刪除範圍，以及可能保留的有限紀錄。"
      sections={[
        {
          title: "撤銷公開分享",
          items: [
            "開啟會議詳細資料，進入分享設定並撤銷分享。OwnMinutes 分享網址與公開 Markdown 下載端點會停止運作。",
            "逐字稿預設為私人內容。如果你曾開啟公開逐字稿，可以在不刪除整場會議的情況下關閉。",
            "其他人或第三方服務已下載、複製、擷取或儲存的副本，無法透過撤銷 OwnMinutes 連結自動刪除。",
          ],
        },
        {
          title: "刪除單一會議",
          items: [
            "在「會議」分頁開啟會議詳細資料，前往危險操作區域，選擇「刪除會議」並確認。",
            "刪除會從一般服務存取中移除該會議的原始音訊、音訊分段、即時草稿、正式逐字稿、正式紀要、Markdown、後設資料及分享狀態。",
            "刪除後，該會議不會再出現在會議清單、專案封存、分享連結或帳號匯出索引中。",
          ],
        },
        {
          title: "匯出帳號資料",
          items: [
            "在「我的」或帳號中心選擇「匯出帳號摘要」，即可取得帳號、權益、用量、已遮蔽的供應商設定及會議索引；摘要不包含完整逐字稿或完整 Markdown。",
            "選擇「匯出全部會議內容」會產生可攜式 NDJSON，包含會議結果、完整逐字稿與 Markdown。兩種匯出都不包含原始錄音、密碼或模型金鑰明文。",
          ],
        },
        {
          title: "刪除帳號前先取消 Apple 計費",
          items: [
            "刪除 OwnMinutes 帳號或移除 OwnMinutes 不會取消、退款或停止 Apple 訂閱。除非你在 Apple 的訂閱設定中取消，Apple 仍可能繼續續訂並收費。",
            "刪除帳號前，請開啟 iPhone「設定」> Apple 帳號 >「訂閱」，選擇 OwnMinutes；若不希望再次續訂，請取消訂閱。請至少在目前計費週期結束前 24 小時取消。",
            "刪除帳號可能使後續訂閱權益無法交付至該帳號。若帳號刪除後仍被 Apple 收費，請使用 Apple 的訂閱與退款工具；如需帳號端協助，請使用已遮蔽的交易參考資料聯絡 OwnMinutes 支援。",
          ],
        },
        {
          title: "永久刪除帳號",
          items: [
            "登入後，開啟「我的」或帳號中心，選擇「刪除帳號」，閱讀影響範圍並完成第二次確認。",
            "帳號刪除會登出所有工作階段，並移除供應商設定、模型金鑰參照、有效權益與用量存取、會議、音訊、正式結果、Markdown 及公開分享連結。必須保留的紀錄會降至最低限度，並進行假名化或匿名化。",
            "刪除後，舊登入工作階段會停止運作。若要再次使用 OwnMinutes，必須建立新帳號並重新設定供應商。只有在 Apple 與 OwnMinutes 能確認購買符合新登入帳號的資格時，先前購買才可恢復。",
          ],
        },
        {
          title: "模型金鑰與 BYOK 設定",
          items: [
            "模型金鑰由伺服器端加密保存；目前已實作的正式環境託管方案是 HashiCorp Vault Transit。本機 AES-GCM 僅供開發使用；KMS 識別碼或其他尚未實作的 Secret Store 不會被視為已達正式環境就緒。金鑰不會寫入手機，也不會透過帳號匯出、分享頁面、Markdown 或一般 API 回應以明文傳回。",
            "刪除供應商會移除其金鑰參照與設定；刪除帳號會移除該帳號的全部 BYOK 設定。你也應在供應商自己的控制台撤銷金鑰。",
          ],
        },
        {
          title: "儲存與保留範圍",
          items: [
            "託管服務將帳號與用量資料儲存在 PostgreSQL，並將原始音訊、產生的結果與 Markdown 儲存在私人物件儲存空間。本機開發儲存不代表託管服務的保留政策。",
            "刪除的線上資料會停止透過一般產品功能存取。加密備份中的副本可能保留最多 35 天，之後透過備份輪替與物件生命週期控制移除。",
            "OwnMinutes 可能只保留最低限度、已假名化或匿名化的 Apple 訂單與 App Store 伺服器通知紀錄，用於權益完整性、詐欺防止、會計或稅務要求、退款、拒付、爭議及法律合規。該紀錄不會保留會議音訊、逐字稿、摘要、模型金鑰明文或可再次使用的登入工作階段。",
            "匯出至 Files、Obsidian、雲端硬碟、團隊知識庫或其他服務的副本，須由你在相應服務中刪除。",
          ],
        },
        {
          title: "無法登入時請求刪除",
          items: [
            "請使用註冊電子郵件地址聯絡支援，並說明要刪除整個帳號或特定分享連結。為保護帳號，我們可能要求完成信箱所有權驗證或提供其他低敏感證據。",
            "請勿傳送模型 API 金鑰、密碼、完整錄音或完整逐字稿。支援人員不會索取這些資料。",
            "請勿在公開 Issue 中發佈電子郵件地址、分享連結、會議內容、訂單資訊或其他身分資料。",
            supportText,
          ],
        },
      ]}
    />
  );
}
