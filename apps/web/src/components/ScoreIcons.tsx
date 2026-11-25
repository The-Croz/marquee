/**
 * Small marks for each score on a title page, so they're recognisable at a
 * glance: TMDB, IMDb, Rotten Tomatoes (a fresh tomato at 60% and up, a green
 * splat below) and Metacritic (green, yellow or red by score, as Metacritic
 * colours them). Our own drawings, 20px tall; the score's name is always in the
 * label next to it for screen readers.
 */

const box = 'h-5 w-auto flex-none';

export function TmdbMark() {
  return (
    <svg viewBox="0 0 44 20" className={box} aria-hidden="true">
      <defs>
        <linearGradient id="tmdb-g" x1="0" x2="1">
          <stop offset="0" stopColor="#90cea1" />
          <stop offset="1" stopColor="#01b4e4" />
        </linearGradient>
      </defs>
      <rect width="44" height="20" rx="4" fill="#0d253f" />
      <text x="22" y="14.5" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="800" fill="url(#tmdb-g)">
        TMDB
      </text>
    </svg>
  );
}

export function ImdbMark() {
  return (
    <svg viewBox="0 0 40 20" className={box} aria-hidden="true">
      <rect width="40" height="20" rx="4" fill="#f5c518" />
      <text x="20" y="14.5" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11.5" fontWeight="900" fill="#000">
        IMDb
      </text>
    </svg>
  );
}

/** Fresh (60% and up): a red tomato with a green top. Rotten: a green splat. */
export function TomatoMark({ score }: { score: number }) {
  if (score >= 60)
    return (
      <svg viewBox="0 0 20 20" className={box} aria-hidden="true">
        <circle cx="10" cy="11.5" r="7.5" fill="#fa320a" />
        <ellipse cx="7.5" cy="9" rx="2.2" ry="1.4" fill="#ff8a6b" opacity=".7" />
        <path d="M10 4.6c-1.6-1.3-3.6-1.2-4.6-.4 1.4.1 2.4.6 3 1.3-1.5.2-2.6 1-3 2 1.7-.6 3.2-.5 4.6.2 1.4-.7 2.9-.8 4.6-.2-.4-1-1.5-1.8-3-2 .6-.7 1.6-1.2 3-1.3-1-.8-3-.9-4.6.4Z" fill="#00912d" />
      </svg>
    );
  return (
    <svg viewBox="0 0 20 20" className={box} aria-hidden="true">
      <path
        d="M10 2.5l1.6 3.4 3.3-1.9-.5 3.8 3.8.4-2.8 2.6 2.8 2.6-3.8.4.5 3.8-3.3-1.9L10 17.5l-1.6-3.4-3.3 1.9.5-3.8-3.8-.4 2.8-2.6-2.8-2.6 3.8-.4-.5-3.8 3.3 1.9z"
        fill="#0ac855"
      />
    </svg>
  );
}

export function MetacriticMark({ score }: { score: number }) {
  const fill = score >= 61 ? '#00ce7a' : score >= 40 ? '#ffbd3f' : '#ff6874';
  return (
    <svg viewBox="0 0 20 20" className={box} aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="#000" stroke={fill} strokeWidth="2" />
      <text x="10" y="14.2" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="900" fill={fill}>
        M
      </text>
    </svg>
  );
}
