import type { Metadata } from "next";
import { connection } from "next/server";
import { EnglishLegalPage } from "@/app/en/_components/english-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";

export const metadata: Metadata = {
  title: "Data Deletion - OwnMinutes",
  description: "How to revoke sharing, delete meetings, export data, and permanently delete an OwnMinutes account.",
};

export default async function EnglishDataDeletionPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const supportText = supportEmail
    ? `Support email: ${supportEmail}. Do not send a password, verification code, model key, full recording, or full transcript.`
    : "Use the in-app deletion controls when you can sign in. A public support email will be shown when the hosted service is enabled.";
  const actions = [
    ...(supportEmail
      ? [{ href: `mailto:${supportEmail}?subject=OwnMinutes%20Data%20Deletion%20Request`, label: "Contact deletion support" }]
      : []),
    {
      href: "https://apps.apple.com/account/subscriptions",
      label: "Manage Apple subscriptions",
      type: "external" as const,
    },
  ];

  return (
    <EnglishLegalPage
      actions={actions}
      chineseHref="/data-deletion"
      title="Data Deletion"
      updatedAt="2026-07-31"
      intro="You can revoke a public share, delete one meeting, export account data, or permanently delete your account in OwnMinutes. The sections below explain where to find each control, what it removes, and the limited records that may remain."
      sections={[
        {
          title: "Revoke a public share",
          items: [
            "Open the meeting details, enter sharing settings, and revoke the share. The OwnMinutes sharing URL and public Markdown download endpoint will stop working.",
            "The transcript is private by default. If you enabled public transcript access, you can turn it off without deleting the entire meeting.",
            "Copies already downloaded, copied, captured, or stored by another person or third-party service cannot be deleted automatically by revoking the OwnMinutes link.",
          ],
        },
        {
          title: "Delete one meeting",
          items: [
            "In the Meetings tab, open the meeting details, go to the destructive-actions section, choose Delete Meeting, and confirm the action.",
            "Deletion removes that meeting’s original audio, audio chunks, live draft, final transcript, final notes, Markdown, metadata, and sharing state from normal service access.",
            "After deletion, the meeting no longer appears in meeting lists, project archives, sharing links, or account export indexes.",
          ],
        },
        {
          title: "Export account data",
          items: [
            "From Profile or Account Center, choose Export Account Summary to receive account, entitlement, usage, masked provider-configuration, and meeting-index information. The summary excludes full transcripts and full Markdown.",
            "Choose Export All Meeting Content to create portable NDJSON containing meeting results, full transcripts, and Markdown. Both exports exclude original recordings, passwords, and plaintext model keys.",
          ],
        },
        {
          title: "Cancel Apple billing before account deletion",
          items: [
            "Deleting your OwnMinutes account or uninstalling OwnMinutes does not cancel, refund, or stop an Apple subscription. Apple may continue to renew and charge it until you cancel it in Apple’s subscription settings.",
            "Before deleting your account, open iPhone Settings > Apple Account > Subscriptions, select OwnMinutes, and cancel the subscription if you do not want another renewal. Cancel at least 24 hours before the current billing period ends.",
            "Deleting an account can prevent future subscription benefits from being delivered to that account. If Apple charges you after account deletion, use Apple’s subscription and refund tools and contact OwnMinutes support with a redacted transaction reference if account-side help is needed.",
          ],
        },
        {
          title: "Permanently delete your account",
          items: [
            "After signing in, open Profile or Account Center, choose Delete Account, review the impact, and complete the second confirmation.",
            "Account deletion signs out all sessions and removes provider configuration, model-key references, active entitlements and usage access, meetings, audio, final results, Markdown, and public sharing links. Records that must remain are minimized and pseudonymized or anonymized.",
            "The old sign-in session stops working after deletion. To use OwnMinutes again, you must create a new account and configure providers again. A previous purchase is restored only when Apple and OwnMinutes can verify that it is eligible for the new signed-in account.",
          ],
        },
        {
          title: "Model keys and BYOK configuration",
          items: [
            "Model keys are encrypted by the server. The currently implemented managed production option is HashiCorp Vault Transit. Local AES-GCM is development-only, and a KMS identifier or another unimplemented Secret Store is not treated as production-ready. Keys are not written to the phone or returned in plaintext through account exports, sharing pages, Markdown, or ordinary API responses.",
            "Deleting a provider removes its key reference and settings. Deleting the account removes all BYOK configuration for that account. You should also revoke the key in the provider’s own console.",
          ],
        },
        {
          title: "Storage and retention limits",
          items: [
            "The hosted service stores account and usage data in PostgreSQL and stores original audio, generated results, and Markdown in private object storage. Local development storage does not define hosted-service retention.",
            "Deleted online data stops being available through normal product access. Copies in encrypted backups may remain for up to 35 days and are then removed through backup rotation and object-lifecycle controls.",
            "OwnMinutes may retain a minimal, pseudonymized or anonymized Apple order and App Store Server Notification ledger only for entitlement integrity, fraud prevention, accounting or tax requirements, refunds, chargebacks, disputes, and legal compliance. It does not retain meeting audio, transcripts, summaries, plaintext model keys, or a reusable login session.",
            "Copies exported to Files, Obsidian, a cloud drive, a team knowledge base, or another service must be deleted by you in that service.",
          ],
        },
        {
          title: "Request deletion when you cannot sign in",
          items: [
            "Contact support from the registered email address and state whether you want the entire account or a specific sharing link deleted. To protect the account, we may require email-ownership verification or other low-sensitivity evidence.",
            "Do not send model API keys, passwords, full recordings, or full transcripts. Support will not ask for those materials.",
            "Do not post an email address, sharing link, meeting content, order details, or other identity information in a public issue.",
            supportText,
          ],
        },
      ]}
    />
  );
}
