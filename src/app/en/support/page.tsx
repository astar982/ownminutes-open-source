import type { Metadata } from "next";
import { connection } from "next/server";
import { EnglishLegalPage } from "@/app/en/_components/english-legal-page";
import { getPublicSupportEmail } from "@/lib/public-support";

export const metadata: Metadata = {
  title: "Support - OwnMinutes",
  description: "Help with OwnMinutes recording, transcription, model providers, Apple purchases, accounts, and data deletion.",
};

export default async function EnglishSupportPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const supportText = supportEmail
    ? `Support email: ${supportEmail}. Never send a password, verification code, model key, cloud credential, full recording, or unredacted transcript.`
    : "Use the in-app support and data controls. A public support email will be shown when the hosted service is enabled.";
  const actions = [
    ...(supportEmail ? [{ href: `mailto:${supportEmail}`, label: "Email support" }] : []),
    {
      href: "https://apps.apple.com/account/subscriptions",
      label: "Manage Apple subscriptions",
      type: "external" as const,
    },
    {
      href: "https://github.com/astar982/ownminutes-open-source/issues",
      label: "Report a public issue",
      type: "external" as const,
    },
  ];

  return (
    <EnglishLegalPage
      actions={actions}
      chineseHref="/support"
      title="Support and Help"
      updatedAt="2026-07-30"
      intro="Use these steps when recording, transcription, a model provider, sharing, export, an Apple purchase, or your account is not working. Send account, purchase, and deletion requests through private support, not a public issue."
      sections={[
        {
          title: "Recording does not start",
          items: [
            "Open iPhone Settings and confirm that OwnMinutes has microphone permission, then return to the app and reopen the recording screen.",
            "Confirm that another app is not exclusively using the microphone and that any Bluetooth headset or external microphone is still connected.",
            "After starting, you should see a clear recording state, timer, and audio-level activity. If the state does not change, do not continue the meeting as if it were being captured; reauthorize the microphone or restart the app first.",
            "Tell meeting participants and obtain any consent required by law or organizational policy before recording or sending audio to a speech-recognition or language-model provider.",
          ],
        },
        {
          title: "Upload or transcription does not finish",
          items: [
            "OwnMinutes prioritizes retaining audio on the device. If the network fails, do not delete the app or meeting; reconnect and allow pending audio chunks to synchronize.",
            "Live transcription is only a draft. The final result is generated after the meeting from the complete audio and may differ from the live draft.",
            "Run the service-connection and provider health checks in Settings. For BYOK, verify the provider, model, endpoint, key, provider-account quota, region, and network configuration.",
            "Meeting content may be processed by the model provider you selected or, when official minutes are used, by a provider configured by OwnMinutes. Review the Privacy Policy before processing sensitive or regulated content.",
          ],
        },
        {
          title: "Speaker labels, notes, or action items are inaccurate",
          items: [
            "A single-device mixed recording cannot guarantee perfect speaker separation. Rename Speaker labels and check which segments belong to each participant after the meeting.",
            "Verify decisions, owners, due dates, risks, and unresolved issues. Remove or mark uncertain any statement that is not supported by the transcript.",
            "Check transcript visibility again before sharing. Original audio is not shared by default, and the transcript is hidden by default.",
          ],
        },
        {
          title: "Apple purchase, renewal, or restore",
          items: [
            "If a purchase is not reflected, confirm that the device uses the Apple Account that made the purchase, sign in to the intended OwnMinutes account, and choose Restore Purchases. Do not publish an order number or full transaction credential.",
            "Subscriptions renew automatically unless canceled in Apple’s subscription settings at least 24 hours before the current billing period ends. Apple controls billing, renewal timing, payment methods, taxes, and refund decisions.",
            "Manage or cancel from iPhone Settings > Apple Account > Subscriptions or Apple’s subscription-management page. Deleting the OwnMinutes app or account does not cancel an Apple subscription.",
            "For an entitlement mismatch, provide support with the app version, product name, approximate purchase time, signed-in OwnMinutes email, and a redacted transaction reference. Never send Apple Account credentials or a complete signed transaction payload.",
          ],
        },
        {
          title: "Account and data",
          items: [
            "Use Forgot Password on the sign-in screen if needed. Check spam and confirm that the registered email address was entered correctly.",
            "Profile or Account Center provides account export and permanent account deletion. Meeting details provide sharing revocation and single-meeting deletion.",
            "Cancel an Apple subscription before account deletion if you do not want it to renew. Account deletion removes normal product access but may retain a minimal, pseudonymized or anonymized Apple order and notification ledger for legal, accounting, refund, dispute, and fraud-prevention obligations.",
          ],
        },
        {
          title: "What to include in a support report",
          items: [
            "Include device model, iOS version, OwnMinutes version, meeting duration, network state, headset or BYOK use, approximate error time, and reproducible steps.",
            "For sharing issues, provide only the meeting title or a low-sensitivity suffix from the sharing link. For provider issues, provide the provider name, error code, and masked key identifier.",
            "Do not send passwords, verification codes, model keys, cloud credentials, full recordings, full transcripts, customer lists, or unredacted meeting screenshots.",
          ],
        },
        {
          title: "Contact channels",
          items: [
            supportText,
            "GitHub Issues is only for public defects and feature requests that contain no account, meeting, purchase, or customer information. Use private support for sign-in, billing, deletion, or confidential-content issues.",
          ],
        },
      ]}
    />
  );
}
