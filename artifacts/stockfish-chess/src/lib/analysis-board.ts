import type { Square } from 'chess.js';

export type ChessSide = 'w' | 'b';
export type AnalysisPieceType = 'k' | 'q' | 'r' | 'b' | 'n' | 'p';
export type AnalysisPiece = { type: AnalysisPieceType; color: ChessSide };
export type AnalysisBoard = Array<Array<AnalysisPiece | null>>;
export type AnalysisMoveRecord = {
  from: Square;
  to: Square;
  piece: AnalysisPiece;
  captured?: AnalysisPiece;
  promotion?: AnalysisPieceType;
};

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export function parseAnalysisBoard(fen: string): AnalysisBoard {
  const placement = fen.split(' ')[0];
  const ranks = placement?.split('/') ?? [];

  if (ranks.length !== 8) throw new Error('The analysis position must have eight ranks.');

  return ranks.map((rank) => {
    const row: Array<AnalysisPiece | null> = [];
    for (const char of rank) {
      if (/^[1-8]$/.test(char)) {
        for (let count = Number(char); count > 0; count -= 1) row.push(null);
      } else {
        const type = char.toLowerCase();
        if (!'kqrbnp'.includes(type)) throw new Error('The analysis position contains an unknown piece.');
        row.push({ type: type as AnalysisPieceType, color: char === type ? 'b' : 'w' });
      }
    }
    if (row.length !== 8) throw new Error('Each analysis rank must contain eight squares.');
    return row;
  });
}

export function getAnalysisTargets(board: AnalysisBoard, from: Square): Map<Square, boolean> {
  const fromFile = files.indexOf(from[0]);
  const fromRow = 8 - Number(from[1]);
  const piece = board[fromRow]?.[fromFile];
  const targets = new Map<Square, boolean>();
  if (!piece) return targets;

  for (let row = 0; row < 8; row += 1) {
    for (let file = 0; file < 8; file += 1) {
      if (row === fromRow && file === fromFile) continue;
      const target = board[row]?.[file];
      if (target?.color === piece.color || target?.type === 'k') continue;
      targets.set(`${files[file]}${8 - row}` as Square, Boolean(target));
    }
  }
  return targets;
}

function boardToFen(board: AnalysisBoard): string {
  return board.map((row) => {
    let empty = 0;
    let rank = '';
    for (const piece of row) {
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) {
        rank += String(empty);
        empty = 0;
      }
      rank += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    if (empty) rank += String(empty);
    return rank;
  }).join('/');
}

export function applyFreeAnalysisMove(
  fen: string,
  from: Square,
  to: Square,
  promotion: AnalysisPieceType = 'q',
): { fen: string; move: AnalysisMoveRecord } | null {
  const board = parseAnalysisBoard(fen);
  if (!getAnalysisTargets(board, from).has(to)) return null;

  const fromFile = files.indexOf(from[0]);
  const fromRow = 8 - Number(from[1]);
  const toFile = files.indexOf(to[0]);
  const toRow = 8 - Number(to[1]);
  const piece = board[fromRow]?.[fromFile];
  if (!piece) return null;

  const captured = board[toRow]?.[toFile] ?? undefined;
  const nextBoard = board.map((row) => [...row]);
  const reachesBackRank = piece.type === 'p' && (toRow === 0 || toRow === 7);
  const movedPiece = reachesBackRank ? { ...piece, type: promotion } : piece;
  nextBoard[fromRow]![fromFile] = null;
  nextBoard[toRow]![toFile] = movedPiece;

  const nextTurn: ChessSide = piece.color === 'w' ? 'b' : 'w';
  const parts = fen.split(' ');
  const fullmove = Math.max(1, Number(parts[5]) || 1) + (piece.color === 'b' ? 1 : 0);
  return {
    fen: `${boardToFen(nextBoard)} ${nextTurn} - - 0 ${fullmove}`,
    move: {
      from,
      to,
      piece,
      ...(captured ? { captured } : {}),
      ...(reachesBackRank ? { promotion } : {}),
    },
  };
}
