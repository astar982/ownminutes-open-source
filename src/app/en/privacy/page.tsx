import type { Metadata } from "next";
import { connection } from "next/server";
import { EnglishLegalPage } from "@/app/en/_components/english-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";
import { getPublicLegalIdentity } from "@/lib/public-legal-identity";

export const metadata: Metadata = {
  title: "Privacy Policy - OwnMinutes",
  description: "How OwnMinutes processes account, meeting, model-provider, purchase, and usage data.",
};

export default async function EnglishPrivacyPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const legalIdentity = getPublicLegalIdentity();
  const supportText = supportEmail
    ? `Support email: ${supportEmail}. Do not send passwords, model API keys, full recordings, or unredacted meeting content by email.`
    : "Use the in-app export, revoke-sharing, meeting-deletion, and account-deletion controls for account and data requests. A public support email will be shown when the hosted service is enabled.";

  return (
    <EnglishLegalPage
      actions={supportEmail ? [{ href: `mailto:${supportEmail}?subject=OwnMinutes%20Privacy%20Request`, label: "Contact privacy support" }] : []}
      chineseHref="/privacy"
      title="Privacy Policy"
      updatedAt="2026-07-30"
      intro="OwnMinutes records meetings, creates live transcript drafts and final post-meeting results, produces meeting notes, and supports sharing and Markdown export. This policy explains what we process, why we process it, and how you can access, export, or delete your data."
      sections={[
        {
          title: "Data we process",
          items: [
            "Account data includes your display name, email address, email-verification state, sign-in sessions, internal user identifier, plan entitlements, and usage records. Passwords and email-verification or password-reset credentials are stored only as irreversible hashes.",
            "Meeting data may include meeting titles, participants and tags, recordings and audio chunks, live transcript drafts, final transcripts, speaker labels, summaries, decisions, action items, risks, knowledge points, and generated Markdown.",
            "Model configuration includes your selected speech-recognition and language-model providers, non-secret settings, and encrypted provider keys. Plaintext keys are not returned in account exports, shared pages, Markdown, or ordinary API responses.",
            "Purchase and usage data may include Apple transaction and original-transaction identifiers, product identifiers, subscription dates and status, entitlements, official-minute usage, and minimal App Store Server Notification identifiers and processing results.",
            "Product and diagnostic data may include microphone permission state, audio format, recording and upload state, network-recovery state, provider health results, app version, device and operating-system details, and low-sensitivity error information needed to keep recording and processing reliable.",
          ],
        },
        {
          title: "Why we process data",
          items: [
            "To save meeting audio, create live drafts and final results, and let you review, play, search, share, and export content from your device or account.",
            "To generate summaries, decisions, action items, and knowledge points, and to create or revoke sharing links at your direction.",
            "To verify account ownership, secure sign-in and data access, recover accounts, deliver paid entitlements, restore purchases, process subscription lifecycle events, and prevent fraud or abuse.",
            "To diagnose recording, upload, crash, compatibility, network, model-provider, and purchase-delivery failures and to comply with legal, tax, accounting, refund, and dispute obligations.",
          ],
        },
        {
          title: "Microphone use and participant consent",
          items: [
            "OwnMinutes records meeting audio only after you grant microphone permission and actively start a recording. The app displays a clear recording state while recording is active.",
            "Before recording, you must notify participants and confirm that recording, transcription, model processing, summarization, and sharing comply with applicable law, your organization’s policies, and participant agreements.",
            "OwnMinutes is not a telephone-call recorder and does not bypass recording restrictions imposed by iOS, conferencing software, or other systems.",
          ],
        },
        {
          title: "Model providers and other third parties",
          items: [
            "Meeting content may be sent to the speech-recognition or language-model provider you select so that the requested transcription or summary can be created. In BYOK mode, your configured provider processes those requests under your provider account.",
            "When you use official processing minutes, OwnMinutes sends only the data needed for the requested feature to a model provider configured by OwnMinutes. Provider infrastructure may process data in a different jurisdiction, subject to that provider’s terms and privacy policy.",
            "Transactional account email may be delivered by an email provider. Apple processes App Store purchases. Hosting, database, and object-storage providers process data needed to operate the service.",
            "Do not record or submit confidential, regulated, or sensitive information that you are not authorized to process through the provider and region you selected.",
          ],
        },
        {
          title: "Sharing and public access",
          items: [
            "A sharing link shows the summary, speaker viewpoints, decisions, and action items by default. The full transcript is hidden by default and requires an additional confirmation before it is made public.",
            "Original audio is private by default and is not automatically included in a shared page or an account export.",
            "Revoking a sharing link disables the link served by OwnMinutes. Copies already downloaded, copied, captured, or stored by another person or service cannot be removed automatically by OwnMinutes.",
          ],
        },
        {
          title: "Retention, export, and deletion",
          items: [
            "Account and meeting data is retained while needed to provide the service, until you delete the meeting or account, or for longer when law requires it.",
            "After deletion, content is removed from normal online access. Copies in encrypted backups may remain for up to 35 days and are deleted through backup rotation; they are not used for ordinary product access during that period.",
            "After account deletion, OwnMinutes may retain a minimal, pseudonymized or anonymized ledger of Apple order and server-notification events only as needed for entitlement integrity, fraud prevention, accounting or tax records, refunds, chargebacks, disputes, and legal compliance. This ledger does not retain meeting content, recordings, transcripts, plaintext model keys, or an active login session.",
            "The account-summary export contains account details, usage, a meeting index, and low-sensitivity configuration summaries; it excludes full transcripts, full meeting Markdown, passwords, plaintext model keys, and original recordings.",
            "The portable export contains meeting results, full transcripts, and meeting Markdown for migration. It still excludes passwords, plaintext model keys, and original recordings. Copies exported to Files, Obsidian, cloud drives, or other services are controlled and deleted by you in those services.",
            "Deleting your OwnMinutes account or uninstalling the app does not cancel an Apple subscription. Cancel it separately in Apple’s subscription settings before deleting your account if you do not want it to renew.",
          ],
        },
        {
          title: "Your choices and contact",
          items: [
            "You may deny microphone access, stop recording, revoke a share, hide a transcript, delete one meeting, export account data, or permanently delete your account in the app.",
            "OwnMinutes does not use meeting content for cross-app advertising tracking and does not sell your recordings, transcripts, or model keys.",
            supportText,
          ],
        },
        {
          title: "Operator identity and governing jurisdiction",
          items: legalIdentity
            ? [
                `Operator: ${legalIdentity.operatorName}.`,
                `Contact address: ${legalIdentity.operatorAddress}.`,
                `Governing jurisdiction: ${legalIdentity.jurisdiction}. Mandatory statutory rights are not excluded by this policy.`,
              ]
            : [
                "No verifiable public operator name, contact address, and governing jurisdiction are configured, so paid service remains closed.",
                "OwnMinutes must publish its real operator identity here before paid service opens; placeholder names and invented addresses are not accepted.",
              ],
        },
      ]}
    />
  );
}
