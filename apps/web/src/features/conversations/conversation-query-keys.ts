/** Query keys shared by conversation views and realtime invalidation paths. */
/** Prefix used to invalidate every following-agent list for one public channel. */
export function threadFollowingAgentsQueryPrefix(channelId: string) {
  return ["conversation", "thread-following-agents", channelId] as const;
}
