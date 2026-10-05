// Registry of playable Break Room games — GameShell looks a gameType up
// here rather than switching on it inline, so adding a new game is a
// one-line addition in exactly one place.
import CongoLineGame from './congoLine/CongoLineGame';
import BucketsGame from './buckets/BucketsGame';
import PillPopGame from './pillPop/PillPopGame';
import FullSendGame from './fullSend/FullSendGame';

export const GAME_LABELS = {
  CONGO_LINE: 'Congo Line',
  BUCKETS: 'Buckets',
  FULL_SEND: 'Full Send',
  PILL_POP: 'Pill Pop',
};

export const GAME_BLURBS = {
  CONGO_LINE: 'Grow the office conga line. Collect coffee, dodge the printer jam.',
  BUCKETS: 'Time your shot. Chain makes for a multiplier streak.',
  FULL_SEND: 'Side-scrolling desk-chair motocross. Land tricks, don’t crash the quarter.',
  PILL_POP: 'Match falling capsules before your CRM backlog overflows.',
};

export const GAME_COMPONENTS = {
  CONGO_LINE: CongoLineGame,
  BUCKETS: BucketsGame,
  FULL_SEND: FullSendGame,
  PILL_POP: PillPopGame,
};
