import { z } from 'zod';

/**
 * Every machine-readable error code the API can return, grouped by cause. Clients switch on `error.code`
 * (never on `message`, which is for humans/logs). A server-side test fails when source code uses a code
 * that is not listed here.
 */
export const API_ERROR_CODES = [
  // request / session
  'bad_request',
  'unauthenticated',
  'forbidden',
  'unmask_required',
  'rate_limited',
  'not_found',
  'user_not_found',
  'expired',
  'idempotency_key_required',
  'idempotency_key_reused',
  'request_in_progress',
  // participant actions
  'verification_required',
  'own_gift',
  'gift_locked',
  'gift_not_votable',
  'gift_not_opened',
  'no_pairing',
  'invalid_category',
  'voting_not_open',
  'voting_closed',
  'profile_locked',
  'name_taken',
  // join / claim
  'already_claimed',
  'invalid_claim',
  'join_closed',
  'over_capacity',
  // uploads
  'invalid_image',
  'unsupported_file',
  'file_too_large',
  'invalid_mapping',
  'invalid_pairing',
  'import_locked',
  'import_not_allowed',
  'correction_closed',
  // event lifecycle
  'invalid_settings',
  'max_below_roster',
  'paused',
  'invalid_step',
  'same_phase',
  'pairing_not_ready',
  'backstep_after_reveal',
  'use_reopen_voting',
  'voting_not_closed',
  'opening_not_available',
  'nothing_to_open',
  'invalid_order',
  'reveal_not_started',
  // boards / ceremony
  'small_cohort_ack_required',
  'board_hidden',
  'ceremony_started',
  'ceremony_not_running',
  'ceremony_not_paused',
  'stale_step',
  'not_in_awards_phase',
  'decisions_pending',
  'nothing_to_show',
  'no_decision_needed',
  'not_a_candidate',
  // phase 2: guesses, clues, missions, mini-games, presentations
  'feature_disabled',
  'guess_closed',
  'invalid_suspect',
  'clue_not_allowed',
  'clue_limit',
  'clue_not_pending',
  'not_in_games_phase',
  'game_active',
  'game_not_active',
  'invalid_game',
  'invalid_game_state',
  'not_enough_gifts',
  'round_not_open',
  'already_submitted',
  'invalid_answer',
  'opted_out',
  'swap_unavailable',
  'mission_closed',
  'mission_not_pending',
  'presentation_not_available',
  // phase 2/3 follow-ups: features, coins, auction, history, custom content
  'features_locked',
  'coins_disabled',
  'insufficient_coins',
  'auction_disabled',
  'no_prize_on_stage',
  'auction_closed',
  'bid_too_low',
  'already_leading',
  'invalid_prize_state',
  'stage_busy',
  'categories_locked',
  'category_in_use',
  'duplicate_key',
  'invalid_link',
  'already_linked',
  'verification_required_for_link',
  'history_disabled',
] as const;

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Shape of every non-2xx JSON response. */
export const ApiErrorBodySchema = z.strictObject({
  error: z.strictObject({ code: ApiErrorCodeSchema, message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
