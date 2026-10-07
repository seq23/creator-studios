// Approval rules (section 9): nothing reaches the Calendar without approval; auto-approve
// does not exist; rejected clips stay 7 days; delete is permanent.
export type ClipStatus = "draft" | "approved" | "rejected" | "deleted";

export const TRANSITIONS: Record<ClipStatus, ClipStatus[]> = {
  draft: ["approved", "rejected", "deleted"],
  approved: ["rejected", "deleted", "draft"],
  rejected: ["approved", "deleted", "draft"],
  deleted: [],
};

export function canTransition(from: ClipStatus, to: ClipStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function schedulable(status: ClipStatus): boolean {
  return status === "approved";
}

export function rejectedExpired(reviewedAt: string | null, now: Date, retentionDays: number): boolean {
  if (!reviewedAt) return false;
  return new Date(reviewedAt).getTime() + retentionDays * 86400_000 < now.getTime();
}
