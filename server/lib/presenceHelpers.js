import { q } from '../db/index.js';
import { PRESENCE_TTL, isOnline } from './presence.js';
import { unreadCount } from './connections.js';
import { unreadNotificationCount } from './events.js';

/** Aggregated presence payload for the client shell. */
export function getPresenceSummary(userId) {
  return {
    online: isOnline(userId),
    ttlMs: PRESENCE_TTL,
  };
}

export function shellCounters(userId) {
  return {
    unreadMessages: unreadCount(userId),
    unreadNotifications: unreadNotificationCount(userId),
    pendingSignals: q.get(
      "SELECT COUNT(*) AS n FROM anonymous_signals WHERE recipient_user_id = ? AND status IN ('delivered','reacted')",
      userId,
    ).n,
    pendingRequests: q.get(
      "SELECT COUNT(*) AS n FROM connection_requests WHERE to_user_id = ? AND status = 'pending'",
      userId,
    ).n,
  };
}
