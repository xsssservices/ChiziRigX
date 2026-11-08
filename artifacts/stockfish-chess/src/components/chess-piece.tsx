import { useId } from 'react';
import type { AnalysisPieceType, ChessSide } from '@/lib/analysis-board';

type ChessPieceProps = {
  type: AnalysisPieceType;
  color: ChessSide;
};

export function ChessPiece({ type, color }: ChessPieceProps) {
  const isWhite = color === 'w';
  const gradientId = `piece-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const outline = isWhite ? '#64685f' : '#14281f';
  const highlight = isWhite ? '#ffffff' : '#829789';

  return (
    <svg className={`chess-piece-art ${isWhite ? 'piece-art-white' : 'piece-art-black'}`} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          {isWhite ? (
            <>
              <stop offset="0" stopColor="#fffdf5" />
              <stop offset=".55" stopColor="#f0eee5" />
              <stop offset="1" stopColor="#deddd3" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor="#59615a" />
              <stop offset=".55" stopColor="#353b36" />
              <stop offset="1" stopColor="#222824" />
            </>
          )}
        </linearGradient>
      </defs>
      <g fill={`url(#${gradientId})`} stroke={outline} strokeWidth="1.55" strokeLinejoin="round" strokeLinecap="round">
        {type === 'k' && <>
          <path d="M29 4h6v7h7v5h-7v7h-6v-7h-7v-5h7z" />
          <path d="M23 28c0-3.6 3.8-6.2 9-6.2s9 2.6 9 6.2c0 2.2-1.4 4.2-4 5.7 5.3 3.5 8.4 9.7 9.2 17.3H17.8c.8-7.6 3.9-13.8 9.2-17.3-2.6-1.5-4-3.5-4-5.7z" />
          <path d="M18 51h28c3 0 5 1.6 5 3.8V58H13v-3.2c0-2.2 2-3.8 5-3.8zM12 58h40v2H12z" />
          <path d="M22 53h20M25 37c-2 3-3.5 6.5-4 10" fill="none" stroke={highlight} strokeWidth="1.4" />
        </>}
        {type === 'q' && <>
          <circle cx="13" cy="16" r="3.2" /><circle cx="32" cy="8" r="3.2" /><circle cx="51" cy="16" r="3.2" />
          <path d="M15 21l7 5 10-13 10 13 7-5-5 8-4 17H21l-4-17z" />
          <path d="M18 49h28c3 0 5 1.5 5 3.5V57H13v-4.5c0-2 2-3.5 5-3.5zM12 57h40v3H12z" />
          <path d="M24 31l-2 14M32 28v17M40 31l2 14" fill="none" stroke={highlight} strokeWidth="1.35" />
        </>}
        {type === 'r' && <>
          <path d="M16 10h8v7h5v-7h6v7h5v-7h8v13l-5 4v20H21V27l-5-4z" />
          <path d="M19 49h26c3 0 5 1.5 5 3.5V57H14v-4.5c0-2 2-3.5 5-3.5zM12 57h40v3H12z" />
          <path d="M20 21h4M29 21h6M40 21h4M25 30v15M39 30v15" fill="none" stroke={highlight} strokeWidth="1.35" />
        </>}
        {type === 'b' && <>
          <path d="M32 8c-7.7 4.7-11.4 10-9.4 15.8 1.2 3.6 4.1 6.4 7.4 8.8-5.4 4.1-8.7 9.4-9.5 16.4h23c-.8-7-4.1-12.3-9.5-16.4 3.3-2.4 6.2-5.2 7.4-8.8C43.4 18 39.7 12.7 32 8z" />
          <path d="M18 49h28c3 0 5 1.5 5 3.5V57H13v-4.5c0-2 2-3.5 5-3.5zM12 57h40v3H12z" />
          <path d="M27 17l10 11M26 37c-2 3.3-3 6.4-3.3 9" fill="none" stroke={highlight} strokeWidth="1.7" />
        </>}
        {type === 'n' && <>
          <path d="M16 50c1-7.7 5.7-14.6 13-19.6l-5.7-7.8c-2-3.2-1.8-7.5.7-11.9l4 5.8 8.1-3.1 9.4 6.4-.9 7.4c4.6 5.4 6.8 12.5 7.2 22.8z" />
          <path d="M17 50h34c3 0 5 1.4 5 3.5V57H12v-3.5c0-2.1 2-3.5 5-3.5zM11 57h44v3H11z" />
          <path d="M28 20l7 8-3-12M34 29c4.5-1 8.3.1 11.2 3.2M19 48c1.2-4.5 3.1-7.8 6-10.8" fill="none" stroke={highlight} strokeWidth="1.6" />
          <circle cx="41" cy="23" r="1.7" fill={outline} stroke="none" />
        </>}
        {type === 'p' && <>
          <circle cx="32" cy="16.5" r="8" />
          <path d="M24.5 26.5c2.1 2.2 4.5 3.3 7.5 3.3s5.4-1.1 7.5-3.3c.2 6.8 2 11.6 5.1 16.6l3.2 6.1H16.2l3.2-6.1c3.1-5 4.9-9.8 5.1-16.6z" />
          <path d="M18 49h28c3 0 5 1.5 5 3.5V57H13v-4.5c0-2 2-3.5 5-3.5zM12 57h40v3H12z" />
          <path d="M28 35c-1.7 3.6-3 7.3-3.5 11M22 53h20" fill="none" stroke={highlight} strokeWidth="1.4" />
        </>}
      </g>
    </svg>
  );
}
