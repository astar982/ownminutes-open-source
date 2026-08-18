export class MeetingSharePublicationPreparationError extends Error {
  readonly code = "share_publication_not_committed";
  readonly publicManifestCommitted = false;
  readonly retryable = true;
  readonly stage: "analytics" | "catalog";
  readonly status = 503;

  constructor(stage: "analytics" | "catalog", options: { cause: unknown }) {
    super("分享发布所需数据暂未就绪，链接仍保持私密。请稍后重试。", options);
    this.name = "MeetingSharePublicationPreparationError";
    this.stage = stage;
  }
}

export async function commitPreparedPublicMeetingShare(input: {
  commitPublicManifest: () => Promise<void>;
  prepareAnalytics: () => Promise<void>;
  prepareCatalog: () => Promise<void>;
}) {
  try {
    await input.prepareCatalog();
  } catch (error) {
    throw new MeetingSharePublicationPreparationError("catalog", { cause: error });
  }

  try {
    await input.prepareAnalytics();
  } catch (error) {
    throw new MeetingSharePublicationPreparationError("analytics", { cause: error });
  }

  // This must remain the final durable operation. Once anonymous readers can
  // observe "public", no auxiliary database write may turn a real success into
  // a failed API response.
  await input.commitPublicManifest();
}
