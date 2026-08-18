import type { Metadata } from "next";
import { connection } from "next/server";
import { TraditionalLegalPage } from "@/app/zh-Hant/_components/traditional-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";
import { getPublicLegalIdentity } from "@/lib/public-legal-identity";

export const metadata: Metadata = {
  title: "服務條款 - OwnMinutes",
  description: "使用 OwnMinutes 錄音、模型處理、分享與 Apple 訂閱功能的條款。",
};

export default async function TraditionalTermsPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const legalIdentity = getPublicLegalIdentity();
  const supportText = supportEmail
    ? `支援電子郵件：${supportEmail}。請勿透過電子郵件傳送密碼、模型 API 金鑰、完整錄音或未去識別化的會議內容。`
    : "請使用應用程式內的支援與資料控制功能。正式託管服務啟用後，頁面會顯示公開支援電子郵件。";
  const actions = [
    ...(supportEmail ? [{ href: `mailto:${supportEmail}`, label: "聯絡支援" }] : []),
    {
      href: "https://apps.apple.com/account/subscriptions",
      label: "管理 Apple 訂閱",
      type: "external" as const,
    },
  ];

  return (
    <TraditionalLegalPage
      actions={actions}
      englishHref="/en/terms"
      simplifiedHref="/terms"
      title="服務條款"
      updatedAt="2026-07-30"
      intro="使用 OwnMinutes 即表示你同意本條款。開始錄音、將會議內容傳送給模型供應商或發佈分享連結前，請確認你具有相應的法律與組織授權。"
      sections={[
        {
          title: "帳號資格與安全",
          items: [
            "請使用可正常收信的電子郵件地址註冊，妥善保護帳號、密碼與已登入裝置，不得轉讓帳號，也不得使用他人帳號未經授權存取資料。",
            "請保持帳號資訊正確。若懷疑帳號遭入侵、發生未授權登入或資料安全問題，請立即更改密碼並聯絡支援。",
            "對於濫用、攻擊、詐欺、侵權、未授權存取或嚴重違反本條款的帳號，我們可能限制或暫停其使用。",
          ],
        },
        {
          title: "錄音與內容責任",
          items: [
            "OwnMinutes 不是電話通話錄音工具，也不會繞過 iOS、會議軟體或其他系統所施加的限制。",
            "錄音前，你必須確保與會者已知情，並遵守適用的錄音、隱私、僱傭、營業祕密與資料保護法律及組織政策。",
            "不得使用 OwnMinutes 處理違法、侵權、未經授權、受限制，或你無權交由第三方模型服務處理的內容。",
            "你保留對會議內容的合法權利，並僅在提供你所要求的錄音、轉寫、摘要、儲存、分享與匯出功能所必需的範圍內，授權 OwnMinutes 處理相關內容。",
          ],
        },
        {
          title: "模型服務與結果檢查",
          items: [
            "在 BYOK 模式下，費用會由你選擇的供應商向你的供應商帳號收取。你須自行負責該供應商的條款、額度、資料政策、端點、模型、區域及金鑰設定。",
            "使用官方處理分鐘時，OwnMinutes 可能將必要的會議內容傳送給已設定的語音辨識或語言模型供應商，並依應用程式顯示的規則扣除用量。",
            "即時轉寫只是草稿。正式逐字稿、發言者辨識、摘要、決策與待辦事項仍可能有誤。分享、指派工作或存入知識庫前，請先人工檢查。",
            "模型輸出不構成法律、醫療、財務、僱傭或其他專業意見，也不得作為高風險決策的唯一依據。",
          ],
        },
        {
          title: "Apple 購買、自動續訂與退款",
          items: [
            "iOS 應用程式內的付費數位方案透過 Apple App 內購買銷售。產品、計費週期、所含權益、本地化價格、幣別、稅務處理，以及任何試用或優惠，都會在你於 Apple 購買介面確認前顯示。",
            "購買確認時，費用會由你的 Apple 帳號收取。自動續訂項目會按相同週期續訂，除非你至少在目前週期結束前 24 小時於 Apple 的訂閱設定中取消。Apple 可能在週期結束前 24 小時內收取續訂費用，並依你所在地區的 App Store 條款處理。",
            "你可以從 iPhone「設定」> Apple 帳號 >「訂閱」，或 Apple 的訂閱管理頁面管理或取消訂閱。移除 OwnMinutes 或刪除 OwnMinutes 帳號不會取消訂閱；若不希望再次續訂，請先向 Apple 取消。",
            "符合資格的購買未反映時，請在應用程式內使用「恢復購買」。OwnMinutes 會根據已驗證的 Apple 交易與訂閱事件更新權益，包括續訂、升級、降級、到期、撤銷及退款。",
            "App Store 購買的計費與退款決定由 Apple 處理。BYOK 供應商費用與 App Store 購買無關，須直接與供應商處理。",
          ],
        },
        {
          title: "分享、匯出與第三方位置",
          items: [
            "發佈分享連結前，請確認任何取得連結的人都可以查看摘要、發言者觀點、決策與待辦事項。公開逐字稿需要再次確認。",
            "帳號摘要匯出不包含完整逐字稿或完整會議 Markdown；可攜式匯出會包含會議結果、逐字稿與 Markdown。兩種匯出都不包含密碼、模型金鑰明文或原始錄音。",
            "匯出至 Files、Obsidian、雲端硬碟、團隊知識庫或其他服務後，你須自行負責該副本的存取控制、保留及刪除。",
            "請勿在回饋、公開 Issue、螢幕截圖或評論中包含模型金鑰、密碼、完整錄音、客戶資訊、私密分享連結或未去識別化的會議內容。",
          ],
        },
        {
          title: "可用性與限制",
          items: [
            "服務可能因裝置權限、網路狀況、作業系統限制、模型供應商、Apple 服務或使用者設定而延遲或失敗。重要會議請保留適當的人工紀錄與檢查流程。",
            "在法律允許的範圍內，OwnMinutes 不對未取得必要錄音同意、依賴不準確的模型輸出、錯誤設定第三方服務或不當發佈內容所造成的損失負責。",
            "我們可能基於安全、合規或產品改進調整功能或本條款。重大變更會視情況透過應用程式、網站或註冊電子郵件通知。",
          ],
        },
        {
          title: "帳號刪除、開放原始碼與聯絡方式",
          items: [
            "你可以在應用程式內刪除帳號。帳號刪除會移除對內容的一般存取，但不會取消 Apple 訂閱，也不一定會刪除因法律、會計、詐欺防止、退款、拒付或爭議需要保留的最低限度紀錄。",
            "開放原始碼可依其授權條款商用或修改，並須遵守適用的出處標示要求。修改版本的發行者必須自行提供條款、隱私權政策、支援、計費與資料處理規範。",
            "未經授權，開放原始碼版本或第三方發行者不得存取官方託管服務的帳號、使用者資料、金鑰與工作階段。",
            supportText,
          ],
        },
        {
          title: "締約營運主體與適用司法管轄區",
          items: legalIdentity
            ? [
                `締約營運主體：${legalIdentity.operatorName}。`,
                `聯絡地址：${legalIdentity.operatorAddress}。`,
                `適用司法管轄區：${legalIdentity.jurisdiction}。依法不得排除的消費者權利不受本條款限制。`,
              ]
            : [
                "目前未設定可公開核驗的締約營運主體、聯絡地址與適用司法管轄區，因此付費服務維持關閉。",
                "付費服務開放前，必須公布真實締約主體資料，並完成目標地區的專業法律審查。",
              ],
        },
      ]}
    />
  );
}
