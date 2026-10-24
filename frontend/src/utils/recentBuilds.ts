/** The welcome prompt follows the user's local calendar day, including DST. */
export function isBuildFromToday(createdAt?: string | null, now = new Date()): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt);
  return created.getTime() <= now.getTime() && created.getFullYear() === now.getFullYear()
    && created.getMonth() === now.getMonth() && created.getDate() === now.getDate();
}
