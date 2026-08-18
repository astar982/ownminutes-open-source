# App Store Submission Runbook

## Scope

OwnMinutes 1.0 is an iPhone-only release. `apps/mobile/app.json` keeps `supportsTablet=false` until the iPad UX, 13-inch screenshots, and iPad recording matrix are separately accepted.

Apple currently accepts 1-10 iPhone screenshots and can scale the highest-resolution set to smaller iPhone sizes. OwnMinutes requires five 6.9-inch portrait screenshots as its own launch quality bar:

- `1260x2736`
- `1290x2796`
- `1320x2868`

Official references:

- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots
- https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/
- https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/

## Versioned Material

The repository contains:

- `app-store/metadata/zh-Hans.json`: Chinese name, subtitle, promotional text, description, keywords, categories, review notes, privacy declaration, and screenshot order.
- `apps/mobile/assets/icon-appstore-source.png`: selected high-resolution source for the iOS and App Store icon.
- `apps/mobile/assets/icon-source.svg`: deterministic vector source for splash, favicon, and Android adaptive assets.
- `scripts/generate-mobile-brand-assets.mjs`: produces the iOS, Android, splash, and favicon assets.
- `scripts/check-app-store-submission.mjs`: validates metadata, icon, URLs, review contacts, and screenshots.

Do not put an App Store review password, API key, Apple private key, real meeting, raw transcript, or customer identifier in versioned metadata.

## Brand Assets

Regenerate assets and verify the iOS icon is 1024x1024 without alpha:

```bash
npm run mobile:brand:generate
sips -g pixelWidth -g pixelHeight -g hasAlpha apps/mobile/assets/icon.png
```

The generated PNG files are committed. The selected App Store source is resized to 1024x1024, flattened without alpha, and extended to a full-bleed square before export because Apple applies the platform corner mask. The auxiliary SVG remains authoritative for splash, favicon, and Android adaptive assets. Do not hand-edit only `icon.png`; regenerate the complete asset set.

## Native Screenshot Capture

Run:

```bash
npm run appstore:screenshots:capture
```

The command selects an available iPhone Pro Max simulator, builds the actual Expo project as an independent Xcode Release app, restarts the simulator to clear stale system dialogs, and renders five native states:

1. recording
2. transcript
3. summary
4. meetings
5. settings

Output stays private and ignored:

```text
.data/appstore-submission/zh-Hans/iphone-6.9/
```

The screenshot build sets `EXPO_PUBLIC_APPSTORE_SHOWCASE=1`. That flag is absent from TestFlight and App Store candidate builds. The showcase uses representative content, no real account, no provider secret, and no customer meeting. It proves screenshot rendering only; it does not prove recording, ASR accuracy, TestFlight installation, Apple IAP, or production readiness.

The capture controller writes the selected screen into the installed simulator app's Documents directory, polls it only in showcase builds, removes it after capture, flattens alpha, checks the exact 6.9-inch dimensions, scans runtime fatal logs, and rejects undersized output. It does not use a custom URL scheme, so iOS cannot leave an `Open in OwnMinutes` confirmation over the screenshots.

Always inspect all five images visually before submission. Reject any image with:

- system or development dialogs;
- Expo Go or development overlays;
- secret, test password, `.local` account, raw customer content, or localhost URL;
- clipped text, overlap, blank canvas, duplicate screen, or wrong selected tab;
- provider state that contradicts the review build.
- real-person names on the real-time draft before the complete-audio speaker correction step;
- text that claims an outstanding release gate, real-iPhone test, provider quality test, or production deployment has already passed;
- pending action items rendered with a completed checkmark.

`smoke:appstore-submission` statically protects these content boundaries in addition to image dimensions and metadata. Representative showcase content may demonstrate the product workflow, but it must not convert an unverified capability into a completed claim.

## Metadata Gate

Draft inspection is intentionally allowed before the production URL and review contacts exist:

```bash
npm run appstore:prepare
```

It must report `metadataReady=true`. `submissionReady=false` is expected while external submission fields are missing.

Strict validation requires runtime-only values:

```bash
export OWNMINUTES_APP_URL=https://app.example.com
export OWNMINUTES_SUPPORT_EMAIL=support@example.com
export OWNMINUTES_REVIEW_CONTACT_FIRST_NAME=GivenName
export OWNMINUTES_REVIEW_CONTACT_LAST_NAME=FamilyName
export OWNMINUTES_REVIEW_CONTACT_EMAIL=review@example.com
export OWNMINUTES_REVIEW_CONTACT_PHONE=+8613800000000
npm run appstore:validate
```

The strict gate requires:

- stable public HTTPS marketing, privacy, and support URLs;
- a monitored public support mailbox rendered on the support, privacy, terms, and data-deletion pages; placeholder domains are rejected;
- App Store name no longer than 30 characters;
- subtitle no longer than 30 characters;
- promotional text no longer than 170 characters;
- description no longer than 4000 characters;
- keywords no longer than 100 UTF-8 bytes, unique, and longer than two characters each;
- a 1024x1024 icon without alpha;
- five unique 6.9-inch portrait screenshots without alpha;
- review contacts supplied at runtime;
- no secret-like content in versioned metadata.

The private 0600 manifest is written to:

```text
.data/appstore-submission/manifest.json
```

## Native Privacy Compliance Gate

The App Store candidate must pass the native bundle gate, not only the Expo config check:

```bash
npm run smoke:ios-appstore-compliance
OWNMINUTES_IOS_COMPLIANCE_IPA_PATH=.data/testflight-local/OwnMinutes.ipa \
  npm run mobile:ios:compliance
```

The IPA must be ignored by Git and mode `0600`. For local simulator diagnostics, set `OWNMINUTES_IOS_COMPLIANCE_APP_PATH` to the built `.app` instead. `mobile:ios:local:build` and `smoke:ios-native-build` run the same bundle inspection automatically.

The gate parses XML and binary property lists and requires:

- iPhone-only `UIDeviceFamily=[1]`;
- only the `audio` background mode;
- `ITSAppUsesNonExemptEncryption=false` for the current exempt-encryption declaration;
- a meeting-specific microphone purpose string;
- restricted App Transport Security and no tracking permission prompt;
- only the Expo-generated Bundle ID URL scheme, with unknown schemes rejected;
- a root privacy manifest that declares the seven current linked, non-tracking data categories;
- the approved UserDefaults, file timestamp, and system boot time required-reason API entries;
- valid root and embedded SDK privacy manifests with tracking disabled.

The checker writes private evidence to `.data/acceptance/ios-appstore-compliance-latest.json`. This verifies the binary declaration, but it does not complete the App Store Connect App Privacy questionnaire. Reconcile that questionnaire again whenever production storage, analytics, crash reporting, email, payments, or AI providers change.

## App Store Connect

The dedicated review account and password belong only in App Store Connect Sign-in information. Create it against the same public backend as the uploaded build, grant enough official test quota to finish one short meeting, and do not require Apple reviewers to provide a third-party model key.

Before submission, reconcile the privacy declaration with the actual production database, object storage, logs, analytics, crash reporting, email, Apple IAP, and third-party AI data flows. The repository JSON is a review checklist, not proof that the App Privacy questionnaire has been completed in App Store Connect.

The repository pages are product-policy drafts, not jurisdiction-specific legal advice. Before public launch, the operator must add the correct legal entity/contact details and obtain a final review for the countries where the service will be offered; do not invent an entity name or governing-law clause in the codebase.

Run the full TestFlight and launch gates after metadata validation:

```bash
npm run smoke:appstore-submission
npm run mobile:ios:local:upload-evidence
npm run ios:testflight:evidence
npm run launch:acceptance:evidence
```

No screenshot or metadata result can clear the real iPhone, public deployment, Apple sandbox, ASR quality, database, storage, KMS, or backup blockers.
