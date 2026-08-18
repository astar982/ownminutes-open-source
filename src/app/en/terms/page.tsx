import type { Metadata } from "next";
import { connection } from "next/server";
import { EnglishLegalPage } from "@/app/en/_components/english-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";
import { getPublicLegalIdentity } from "@/lib/public-legal-identity";

export const metadata: Metadata = {
  title: "Terms of Service - OwnMinutes",
  description: "Terms for using OwnMinutes recording, model-processing, sharing, and Apple subscription features.",
};

export default async function EnglishTermsPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const legalIdentity = getPublicLegalIdentity();
  const supportText = supportEmail
    ? `Support email: ${supportEmail}. Do not send passwords, model API keys, full recordings, or unredacted meeting content by email.`
    : "Use the in-app support and data controls. A public support email will be shown when the hosted service is enabled.";
  const actions = [
    ...(supportEmail ? [{ href: `mailto:${supportEmail}`, label: "Contact support" }] : []),
    {
      href: "https://apps.apple.com/account/subscriptions",
      label: "Manage Apple subscriptions",
      type: "external" as const,
    },
  ];

  return (
    <EnglishLegalPage
      actions={actions}
      chineseHref="/terms"
      title="Terms of Service"
      updatedAt="2026-07-30"
      intro="By using OwnMinutes, you agree to these terms. Before recording, sending meeting content to a model provider, or publishing a sharing link, confirm that you have the legal and organizational authority to do so."
      sections={[
        {
          title: "Account eligibility and security",
          items: [
            "Register with an email address that you can receive mail at, keep your account, password, and signed-in devices secure, and do not transfer your account or use another person’s account to access data without authorization.",
            "Keep account information accurate. If you suspect account compromise, an unauthorized sign-in, or a data-security issue, change your password and contact support promptly.",
            "We may restrict or suspend accounts used for abuse, attacks, fraud, infringement, unauthorized access, or material violations of these terms.",
          ],
        },
        {
          title: "Recording and content responsibility",
          items: [
            "OwnMinutes is not a telephone-call recorder and does not bypass restrictions imposed by iOS, conferencing software, or other systems.",
            "Before recording, you must make sure participants are informed and comply with applicable recording, privacy, employment, trade-secret, and data-protection laws and organizational policies.",
            "Do not use OwnMinutes for unlawful, infringing, unauthorized, or restricted content, or for content that you are not permitted to provide to a third-party model service.",
            "You retain your lawful rights in meeting content and authorize OwnMinutes to process it only as needed to provide recording, transcription, summarization, storage, sharing, and export features that you request.",
          ],
        },
        {
          title: "Model services and review of results",
          items: [
            "In BYOK mode, charges are billed by your selected provider to your provider account. You are responsible for that provider’s terms, quota, data policy, endpoint, model, region, and key configuration.",
            "When you use official processing minutes, OwnMinutes may send the necessary meeting content to a configured speech-recognition or language-model provider and deduct usage under the rules shown in the app.",
            "Live transcription is a draft. Final transcripts, speaker identification, summaries, decisions, and action items can still be wrong. Review results before sharing them, assigning work, or saving them to a knowledge base.",
            "Model output is not legal, medical, financial, employment, or other professional advice and must not be the sole basis for a high-risk decision.",
          ],
        },
        {
          title: "Apple purchases, auto-renewal, and refunds",
          items: [
            "Paid digital plans in the iOS app are sold through Apple In-App Purchase. The product, billing period, included benefits, localized price, currency, tax treatment, and any trial or introductory offer are shown before you confirm the purchase in Apple’s purchase sheet.",
            "Payment is charged to your Apple Account when the purchase is confirmed. An auto-renewable subscription renews for the same period unless you cancel it in Apple’s subscription settings at least 24 hours before the current period ends. Apple may charge the renewal within 24 hours before the period ends, subject to the App Store terms for your storefront.",
            "Manage or cancel a subscription from iPhone Settings > Apple Account > Subscriptions or from Apple’s subscription-management page. Uninstalling OwnMinutes or deleting your OwnMinutes account does not cancel the subscription; cancel it with Apple first if you do not want another renewal.",
            "Use Restore Purchases in the app when an eligible purchase is not reflected. OwnMinutes updates entitlements from verified Apple transactions and subscription events, including renewals, upgrades, downgrades, expirations, revocations, and refunds.",
            "Apple controls billing and refund decisions for App Store purchases. BYOK provider charges are separate from App Store purchases and must be resolved directly with the provider.",
          ],
        },
        {
          title: "Sharing, export, and third-party locations",
          items: [
            "Before publishing a sharing link, confirm that the summary, speaker viewpoints, decisions, and action items can be viewed by anyone with the link. Publishing a transcript requires an additional confirmation.",
            "The account-summary export excludes full transcripts and full meeting Markdown. The portable export includes meeting results, transcripts, and Markdown. Both exclude passwords, plaintext model keys, and original recordings.",
            "After exporting to Files, Obsidian, a cloud drive, a team knowledge base, or another service, you are responsible for the copy’s access controls, retention, and deletion.",
            "Do not include model keys, passwords, full recordings, customer information, private sharing links, or unredacted meeting content in feedback, public issues, screenshots, or reviews.",
          ],
        },
        {
          title: "Availability and limits",
          items: [
            "Service may be delayed or fail because of device permissions, network conditions, operating-system restrictions, model providers, Apple services, or user configuration. Keep appropriate human notes and review for important meetings.",
            "To the extent permitted by law, OwnMinutes is not responsible for losses caused by recording without required consent, relying on inaccurate model output, misconfiguring third-party services, or publishing content inappropriately.",
            "We may change features or these terms for security, compliance, or product improvement. Material changes will be communicated in the app, on the website, or to the registered email address as appropriate.",
          ],
        },
        {
          title: "Account deletion, open source, and contact",
          items: [
            "You may delete your account in the app. Account deletion removes normal access to your content but does not cancel an Apple subscription and may not erase minimal records that must be retained for legal, accounting, fraud-prevention, refund, chargeback, or dispute purposes.",
            "Open-source code may be used commercially or modified under its license, including applicable attribution requirements. A distributor of a modified version must provide its own terms, privacy policy, support, billing, and data practices.",
            "The official hosted service’s accounts, user data, keys, and sessions may not be accessed by an open-source build or third-party distributor without authorization.",
            supportText,
          ],
        },
        {
          title: "Contracting operator and governing jurisdiction",
          items: legalIdentity
            ? [
                `Contracting operator: ${legalIdentity.operatorName}.`,
                `Contact address: ${legalIdentity.operatorAddress}.`,
                `Governing jurisdiction: ${legalIdentity.jurisdiction}. Mandatory consumer rights available under applicable law are not excluded.`,
              ]
            : [
                "No verifiable public contracting operator, contact address, and governing jurisdiction are configured, so paid service remains closed.",
                "The real contracting operator must be published and the launch regions professionally reviewed before paid service opens.",
              ],
        },
      ]}
    />
  );
}
