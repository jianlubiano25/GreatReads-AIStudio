import type { Book } from '../../../types';
import type { ContentFlags } from '../quality';

/** What every source adapter returns: a normalised Book plus the signals the quality filter looks at. */
export interface Hit {
  book: Book;
  flags: ContentFlags;
}

export interface CallOpts {
  signal?: AbortSignal;
  /** Extra attempts after a timeout, a 429 or a 5xx (default 0) */
  retries?: number;
}
