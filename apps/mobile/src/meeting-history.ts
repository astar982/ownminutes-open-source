import type { MeetingListItem } from "./types";

export type MeetingHistoryFilter = "all" | "completed" | "pending" | "shared";

export function filterMeetingHistory(
  meetings: MeetingListItem[],
  options: { filter: MeetingHistoryFilter; query: string },
) {
  const query = normalizeMeetingSearchText(options.query);

  return meetings.filter((meeting) => {
    if (options.filter === "completed" && !meeting.hasResult) return false;
    if (options.filter === "pending" && meeting.hasResult) return false;
    if (options.filter === "shared" && meeting.share.visibility !== "public") return false;
    if (!query) return true;

    const searchable = normalizeMeetingSearchText(
      [
        meeting.title,
        meeting.metadata.project,
        ...meeting.metadata.participants,
        ...meeting.metadata.tags,
      ]
        .filter(Boolean)
        .join(" "),
    );
    return query.split(" ").every((term) => searchable.includes(term));
  });
}

function normalizeMeetingSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
