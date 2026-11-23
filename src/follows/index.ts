/**
 * Public API of the `follows` context. Followed fics and the recent-delivery list, persisted in the follows file.
 * Code outside `src/follows/` imports only from here.
 */
export {
  createFollows,
  type DeliveryOutcome,
  emptyFollowsState,
  type FollowedFic,
  type FollowResult,
  type Follows,
  type FollowsState,
  parseFollowsState,
  type UnfollowResult,
} from "./follows.js";
