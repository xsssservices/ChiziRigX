import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { ArrowLeftRight, Undo2, Redo2, RefreshCw, Lightbulb, Hand } from 'lucide-react';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import stockfishScriptUrl from 'stockfish/src/stockfish-nnue-16-single.js?url';
import stockfishWasmUrl from 'stockfish/src/stockfish-nnue-16-single.wasm?url';
import { ChessPiece } from '@/components/chess-piece';
import {
  applyFreeAnalysisMove,
  getAnalysisTargets,
  parseAnalysisBoard,
  type AnalysisMoveRecord,
  type ChessSide,
} from '@/lib/analysis-board';

type Side = ChessSide;
type EngineState = 'loading' | 'ready' | 'failed';
type Mode = 'play' | 'analysis';
type MoveInfo = { from: Square; to: Square; san: string; color: Side; piece: string; flags?: string; captured?: string; promotion?: string };
type Premove = { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' };
type Suggestion = { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n'; fen: string; mode: Mode };
type PieceIdentityMap = Record<string, string>;
type EvaluationMap = Record<string, number>;

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const glyphs: Record<string, string> = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};
const ENGINE_SKILL_LEVEL = 20;
const ENGINE_SEARCH_DEPTH = 20;
const pieceNames: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

function pieceIdentityMapFromFen(fen: string): PieceIdentityMap {
  const board = parseAnalysisBoard(fen);
  const identities: PieceIdentityMap = {};
  board.forEach((row, rowIndex) => row.forEach((piece, fileIndex) => {
    if (!piece) return;
    const square = `${files[fileIndex]}${8 - rowIndex}`;
    identities[square] = `${piece.color}-${piece.type}-${square}`;
  }));
  return identities;
}

function movePieceIdentity(
  previous: PieceIdentityMap,
  from: Square,
  to: Square,
  flags = '',
  color: Side = 'w',
): PieceIdentityMap {
  const next = { ...previous };
  const relocate = (source: string, destination: string) => {
    const identity = next[source];
    delete next[source];
    delete next[destination];
    if (identity) next[destination] = identity;
  };

  relocate(from, to);
  if (flags.includes('e')) delete next[`${to[0]}${from[1]}`];
  if (flags.includes('k') || flags.includes('q')) {
    const rank = color === 'w' ? '1' : '8';
    relocate(flags.includes('k') ? `h${rank}` : `a${rank}`, flags.includes('k') ? `f${rank}` : `d${rank}`);
  }
  return next;
}

function squareCenter(square: Square, flipped: boolean) {
  const file = files.indexOf(square[0]);
  const rank = Number(square[1]);
  const column = flipped ? 7 - file : file;
  const row = flipped ? rank - 1 : 8 - rank;
  return { x: column * 100 + 50, y: row * 100 + 50 };
}

function App() {
  const prefersReducedMotion = useReducedMotion();
  const gameRef = useRef(new Chess());
  const workerRef = useRef<Worker | null>(null);
  const searchFenRef = useRef<string | null>(null);
  const searchPurposeRef = useRef<'game' | 'suggestion' | null>(null);
  const searchModeRef = useRef<Mode>('play');
  const autoSuggestionKeyRef = useRef<string | null>(null);
  const modeRef = useRef<Mode>('play');
  const pendingPremoveRef = useRef<Premove | null>(null);
  const redoMovesRef = useRef<string[]>([]);
  const [redoCount, setRedoCount] = useState(0);
  const analysisRedoRef = useRef<Array<{ fen: string; move: AnalysisMoveRecord }>>([]);
  const currentSearchEvalRef = useRef<number | null>(null);
  const [fen, setFen] = useState(gameRef.current.fen());
  const [playPieceIds, setPlayPieceIds] = useState<PieceIdentityMap>(() => pieceIdentityMapFromFen(gameRef.current.fen()));
  const [mode, setMode] = useState<Mode>('play');
  const [analysisFen, setAnalysisFen] = useState(() => new Chess().fen());
  const [analysisPieceIds, setAnalysisPieceIds] = useState<PieceIdentityMap>(() => pieceIdentityMapFromFen(new Chess().fen()));
  const [analysisMoveHistory, setAnalysisMoveHistory] = useState<AnalysisMoveRecord[]>([]);
  const [analysisFenHistory, setAnalysisFenHistory] = useState<string[]>([]);
  const [playerColor, setPlayerColor] = useState<Side>('w');
  const [moveBothSides, setMoveBothSides] = useState(false);
  const [engineState, setEngineState] = useState<EngineState>('loading');
  const [engineError, setEngineError] = useState('');
  const [thinking, setThinking] = useState(false);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square; color: Side } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [premoveArmed, setPremoveArmed] = useState(false);
  const [pendingPremove, setPendingPremove] = useState<Premove | null>(null);
  const [premoveNotice, setPremoveNotice] = useState('');
  const [evaluations, setEvaluations] = useState<EvaluationMap>({});
  const [historyViewPly, setHistoryViewPly] = useState<number | null>(null);

  modeRef.current = mode;
  const analysisFenRef = useRef(analysisFen);
  analysisFenRef.current = analysisFen;
  const game = gameRef.current;
  const history = useMemo(() => game.history({ verbose: true }) as MoveInfo[], [fen]);
  const playViewGame = useMemo(() => {
    const viewedGame = new Chess();
    const visiblePly = historyViewPly === null ? history.length : Math.min(historyViewPly, history.length);
    history.slice(0, visiblePly).forEach((move) => viewedGame.move({
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion as 'q' | 'r' | 'b' | 'n' } : {}),
    }));
    return viewedGame;
  }, [history, historyViewPly]);
  const lastMove = history[historyViewPly === null ? history.length - 1 : historyViewPly - 1];
  const viewedAnalysisFen = historyViewPly !== null && historyViewPly < analysisMoveHistory.length
    ? analysisFenHistory[historyViewPly] ?? analysisFen
    : analysisFen;
  const displayedAnalysisBoard = useMemo(() => parseAnalysisBoard(viewedAnalysisFen), [viewedAnalysisFen]);
  const displayedFen = mode === 'analysis' ? viewedAnalysisFen : playViewGame.fen();
  const viewedPieceIds = useMemo(() => pieceIdentityMapFromFen(displayedFen), [displayedFen]);
  const currentTurn = mode === 'analysis' ? displayedFen.split(' ')[1] as Side : playViewGame.turn();
  const gameOver = mode === 'play' && playViewGame.isGameOver();
  const playerTurn = currentTurn === playerColor;
  const boardPosition = mode === 'analysis' ? displayedAnalysisBoard : playViewGame.board();
  const activePieceIds = historyViewPly === null
    ? mode === 'analysis' ? analysisPieceIds : playPieceIds
    : viewedPieceIds;
  let checkedName: string | null = null;
  if (mode === 'play' && playViewGame.isCheck()) {
    boardPosition.forEach((row, rowIndex) => row.forEach((piece, fileIndex) => {
      if (piece?.type === 'k' && piece.color === currentTurn) checkedName = `${files[fileIndex]}${8 - rowIndex}`;
    }));
  }
  const canMoveCurrentSide = moveBothSides || playerTurn;
  const possibleMoves = mode === 'play' && selected && canMoveCurrentSide
    ? playViewGame.moves({ square: selected, verbose: true })
    : [];
  const targetMoves = new Map(possibleMoves.map((move) => [move.to, move]));
  const analysisTargets = mode === 'analysis' && selected
    ? getAnalysisTargets(displayedAnalysisBoard, selected)
    : new Map<Square, boolean>();
  const activeFen = displayedFen;
  const currentEvaluation = evaluations[activeFen];
  const whiteShare = 50 + (Math.max(-5, Math.min(5, currentEvaluation ?? 0)) * 5);
  const evaluationLabel = currentEvaluation === undefined
    ? thinking ? 'Analyzing…' : 'Waiting for evaluation'
    : Math.abs(currentEvaluation) >= 9
      ? `${currentEvaluation > 0 ? '+' : '−'}MATE`
      : `${currentEvaluation > 0 ? '+' : ''}${currentEvaluation.toFixed(1)}`;

  const refreshGame = useCallback(() => {
    setFen(gameRef.current.fen());
    setSelected(null);
    setPromotion(null);
    setHistoryViewPly(null);
  }, []);

  useEffect(() => {
    let worker: Worker;
    try {
      const workerUrl = new URL(stockfishScriptUrl, window.location.href);
      workerUrl.hash = encodeURIComponent(stockfishWasmUrl);
      worker = new Worker(workerUrl);
    } catch {
      setEngineError('This browser could not create the local Stockfish worker.');
      setEngineState('failed');
      return;
    }
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<string>) => {
      const line = String(event.data);
      if (line.startsWith('engine-error:')) {
        setEngineError(line.slice('engine-error:'.length));
        setEngineState('failed');
        setThinking(false);
        return;
      }
      if (line === 'uciok') {
        worker.postMessage('isready');
        return;
      }
      if (line === 'readyok') {
        setEngineState('ready');
        return;
      }
      if (line.startsWith('info ') && searchFenRef.current) {
        const score = line.match(/\bscore (cp|mate) (-?\d+)/);
        if (score) {
          const raw = Number(score[2]);
          const pawns = score[1] === 'mate'
            ? Math.sign(raw || 1) * (10 - Math.min(Math.abs(raw), 9) * 0.1)
            : raw / 100;
          currentSearchEvalRef.current = (searchFenRef.current.split(' ')[1] === 'b' ? -1 : 1) * pawns;
        }
        return;
      }
      if (line.startsWith('bestmove')) {
        const expectedFen = searchFenRef.current;
        const purpose = searchPurposeRef.current;
        const searchMode = searchModeRef.current;
        searchFenRef.current = null;
        searchPurposeRef.current = null;
        setThinking(false);
        const coordinate = line.split(/\s+/)[1];
        if (!coordinate || coordinate === '(none)' || !expectedFen || !purpose) return;
        if (modeRef.current !== searchMode) return;
        const currentFen = searchMode === 'analysis' ? analysisFenRef.current : gameRef.current.fen();
        if (currentFen !== expectedFen) return;
        const completedEvaluation = currentSearchEvalRef.current;
        currentSearchEvalRef.current = null;
        if (completedEvaluation !== null) {
          setEvaluations((previous) => ({ ...previous, [expectedFen]: completedEvaluation }));
        }
        const engineMove = {
          from: coordinate.slice(0, 2) as Square,
          to: coordinate.slice(2, 4) as Square,
          ...(coordinate.length > 4 ? { promotion: coordinate[4] as 'q' | 'r' | 'b' | 'n' } : {}),
        };
        if (purpose === 'suggestion') {
          setSuggestion({ ...engineMove, fen: expectedFen, mode: searchMode });
          return;
        }
        if (searchMode !== 'play') return;
        try {
          const move = gameRef.current.move(engineMove);
          if (!move) return;
          redoMovesRef.current = [];
          setRedoCount(0);
          setPlayPieceIds((previous) => movePieceIdentity(previous, move.from, move.to, move.flags, move.color));
          autoSuggestionKeyRef.current = null;
          const queued = pendingPremoveRef.current;
          if (queued) {
            pendingPremoveRef.current = null;
            setPendingPremove(null);
            setPremoveArmed(false);
            try {
              const premove = gameRef.current.move(queued);
              redoMovesRef.current = [];
              setRedoCount(0);
              setPlayPieceIds((previous) => movePieceIdentity(previous, premove.from, premove.to, premove.flags, premove.color));
              autoSuggestionKeyRef.current = null;
              setPremoveNotice(`Premove played: ${queued.from} to ${queued.to}.`);
            } catch {
              setPremoveNotice(`Premove ${queued.from} to ${queued.to} was no longer legal and was canceled.`);
            }
          }
          setSuggestion(null);
          refreshGame();
        } catch {
          setEngineError('Stockfish returned a move that could not be applied. Start a new game to continue.');
          setEngineState('failed');
        }
      }
    };
    worker.onerror = () => {
      setEngineError('The local Stockfish worker could not load. Check that the browser supports WebAssembly workers.');
      setEngineState('failed');
      setThinking(false);
    };
    worker.postMessage('uci');
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [refreshGame]);

  useEffect(() => {
    if (engineState !== 'ready' || gameOver || thinking || historyViewPly !== null) return;
    const worker = workerRef.current;
    if (!worker) return;
    const purpose = mode === 'play' && !moveBothSides && !playerTurn ? 'game' : 'suggestion';
    const position = activeFen;
    const suggestionKey = `${mode}|${position}`;
    if (purpose === 'suggestion' && autoSuggestionKeyRef.current === suggestionKey) return;
    if (purpose === 'suggestion') autoSuggestionKeyRef.current = suggestionKey;
    searchFenRef.current = position;
    searchPurposeRef.current = purpose;
    searchModeRef.current = mode;
    currentSearchEvalRef.current = null;
    setSuggestion(null);
    setThinking(true);
    // Full-strength Stockfish chooses the quickest forced mate it can see.
    worker.postMessage(`setoption name Skill Level value ${ENGINE_SKILL_LEVEL}`);
    worker.postMessage(`position fen ${position}`);
    worker.postMessage(`go depth ${ENGINE_SEARCH_DEPTH}`);
  }, [activeFen, engineState, gameOver, historyViewPly, mode, moveBothSides, playerTurn, thinking]);

  const cancelActiveSearch = useCallback(() => {
    if (searchPurposeRef.current) {
      searchFenRef.current = null;
      searchPurposeRef.current = null;
      workerRef.current?.postMessage('stop');
      return;
    }
    setThinking(false);
  }, []);

  const setPositionFromMove = useCallback((from: Square, to: Square) => {
    const candidate = gameRef.current.moves({ square: from, verbose: true }).find((move) => move.to === to);
    if (!candidate) return false;
    if (candidate.promotion) {
      setPromotion({ from, to, color: gameRef.current.turn() });
      return true;
    }
    try {
      const move = gameRef.current.move({ from, to });
      redoMovesRef.current = [];
      setRedoCount(0);
      setPlayPieceIds((previous) => movePieceIdentity(previous, move.from, move.to, move.flags, move.color));
      autoSuggestionKeyRef.current = null;
      setSuggestion(null);
      setPremoveNotice('');
      refreshGame();
      return true;
    } catch {
      return false;
    }
  }, [refreshGame]);

  const applyAnalysisMove = useCallback((from: Square, to: Square, promoteTo?: 'q' | 'r' | 'b' | 'n') => {
    if (searchPurposeRef.current === 'suggestion') cancelActiveSearch();
    const result = applyFreeAnalysisMove(analysisFen, from, to, promoteTo);
    if (!result) return false;
    setAnalysisFenHistory((previous) => [...previous, analysisFen]);
    analysisRedoRef.current = [];
    setRedoCount(0);
    setAnalysisMoveHistory((previous) => [...previous, result.move]);
    setAnalysisPieceIds((previous) => movePieceIdentity(previous, from, to));
    autoSuggestionKeyRef.current = null;
    analysisFenRef.current = result.fen;
    setAnalysisFen(result.fen);
    setSuggestion(null);
    setPremoveNotice('');
    setSelected(null);
    return true;
  }, [analysisFen, cancelActiveSearch]);

  const queuePremove = useCallback((from: Square, to: Square) => {
    const piece = gameRef.current.get(from);
    if (!piece || piece.color !== playerColor || from === to) return false;
    const premove: Premove = {
      from,
      to,
      ...(piece.type === 'p' && (to.endsWith('8') || to.endsWith('1')) ? { promotion: 'q' } : {}),
    };
    pendingPremoveRef.current = premove;
    setPendingPremove(premove);
    setPremoveArmed(false);
    setPremoveNotice(`Premove queued: ${from} to ${to}.`);
    setSelected(null);
    return true;
  }, [playerColor]);

  const moveFromTo = useCallback((from: Square, to: Square) => {
    if (mode === 'analysis') return applyAnalysisMove(from, to);
    if (gameOver || engineState === 'failed') return false;
    if (canMoveCurrentSide && (!thinking || searchPurposeRef.current === 'suggestion')) {
      if (thinking) cancelActiveSearch();
      autoSuggestionKeyRef.current = null;
      return setPositionFromMove(from, to);
    }
    if (!moveBothSides && !playerTurn && premoveArmed) return queuePremove(from, to);
    return false;
  }, [applyAnalysisMove, canMoveCurrentSide, cancelActiveSearch, engineState, gameOver, mode, moveBothSides, playerTurn, premoveArmed, queuePremove, setPositionFromMove, thinking]);

  const selectSquare = useCallback((square: Square) => {
    if (mode === 'analysis') {
      if (selected && moveFromTo(selected, square)) return;
      const row = 8 - Number(square[1]);
      const file = files.indexOf(square[0]);
      const piece = displayedAnalysisBoard[row]?.[file];
      setSelected(piece ? square : null);
      return;
    }
    if (gameOver || engineState === 'failed') return;
    if (canMoveCurrentSide && (!thinking || searchPurposeRef.current === 'suggestion')) {
      const piece = gameRef.current.get(square);
      if (selected && moveFromTo(selected, square)) return;
      setSelected(piece && (moveBothSides || piece.color === playerColor) ? square : null);
      return;
    }
    if (!moveBothSides && !playerTurn && premoveArmed) {
      const piece = gameRef.current.get(square);
      if (selected && moveFromTo(selected, square)) return;
      setSelected(piece?.color === playerColor ? square : null);
    }
  }, [canMoveCurrentSide, displayedAnalysisBoard, engineState, gameOver, mode, moveBothSides, moveFromTo, playerColor, playerTurn, premoveArmed, selected, thinking]);

  const choosePromotion = useCallback((piece: 'q' | 'r' | 'b' | 'n') => {
    if (!promotion) return;
    const move = gameRef.current.move({ from: promotion.from, to: promotion.to, promotion: piece });
    redoMovesRef.current = [];
    setRedoCount(0);
    setPlayPieceIds((previous) => movePieceIdentity(previous, move.from, move.to, move.flags, move.color));
    autoSuggestionKeyRef.current = null;
    setSuggestion(null);
    refreshGame();
  }, [promotion, refreshGame]);

  const changeMode = useCallback((nextMode: Mode) => {
    if (nextMode === mode) return;
    cancelActiveSearch();
    autoSuggestionKeyRef.current = null;
    searchModeRef.current = nextMode;
    modeRef.current = nextMode;
    pendingPremoveRef.current = null;
    setMode(nextMode);
    setSuggestion(null);
    setPremoveArmed(false);
    setPendingPremove(null);
    setPremoveNotice('');
    setSelected(null);
    setPromotion(null);
    setHistoryViewPly(null);
    if (nextMode === 'analysis') {
      const startingFen = gameRef.current.fen();
      setAnalysisPieceIds(pieceIdentityMapFromFen(startingFen));
      analysisFenRef.current = startingFen;
      setAnalysisFen(startingFen);
      setAnalysisMoveHistory([]);
      setAnalysisFenHistory([]);
      analysisRedoRef.current = [];
      setRedoCount(0);
    }
  }, [cancelActiveSearch, mode]);

  const requestSuggestion = useCallback(() => {
    const worker = workerRef.current;
    if (!worker || engineState !== 'ready' || thinking || gameOver || historyViewPly !== null || (mode === 'play' && !moveBothSides && !playerTurn)) return;
    autoSuggestionKeyRef.current = `${mode}|${activeFen}`;
    searchFenRef.current = activeFen;
    searchPurposeRef.current = 'suggestion';
    searchModeRef.current = mode;
    currentSearchEvalRef.current = null;
    setSuggestion(null);
    setPremoveNotice('');
    setThinking(true);
    worker.postMessage(`setoption name Skill Level value ${ENGINE_SKILL_LEVEL}`);
    worker.postMessage(`position fen ${activeFen}`);
    worker.postMessage(`go depth ${ENGINE_SEARCH_DEPTH}`);
  }, [activeFen, engineState, gameOver, historyViewPly, mode, moveBothSides, playerTurn, thinking]);

  const useSuggestion = useCallback(() => {
    if (!suggestion || suggestion.mode !== mode || suggestion.fen !== activeFen) return;
    if (mode === 'analysis') {
      applyAnalysisMove(suggestion.from, suggestion.to, suggestion.promotion);
      return;
    }
    if ((!moveBothSides && !playerTurn) || gameOver) return;
    try {
      const move = gameRef.current.move({
        from: suggestion.from,
        to: suggestion.to,
        ...(suggestion.promotion ? { promotion: suggestion.promotion } : {}),
      });
      redoMovesRef.current = [];
      setRedoCount(0);
      setPlayPieceIds((previous) => movePieceIdentity(previous, move.from, move.to, move.flags, move.color));
      autoSuggestionKeyRef.current = null;
      setSuggestion(null);
      refreshGame();
    } catch {
      setSuggestion(null);
      setPremoveNotice('That suggestion is no longer available in this position.');
    }
  }, [activeFen, applyAnalysisMove, gameOver, historyViewPly, mode, moveBothSides, playerTurn, refreshGame, suggestion]);

  const startNewGame = useCallback((color = playerColor) => {
    cancelActiveSearch();
    autoSuggestionKeyRef.current = null;
    searchModeRef.current = 'play';
    modeRef.current = 'play';
    gameRef.current = new Chess();
    setHistoryViewPly(null);
    setEvaluations({});
    redoMovesRef.current = [];
    setRedoCount(0);
    analysisRedoRef.current = [];
    setMode('play');
    setPlayPieceIds(pieceIdentityMapFromFen(gameRef.current.fen()));
    setPlayerColor(color);
    setThinking(false);
    setEngineError('');
    setFen(gameRef.current.fen());
    setSuggestion(null);
    setPremoveArmed(false);
    setPendingPremove(null);
    pendingPremoveRef.current = null;
    setPremoveNotice('');
    setSelected(null);
    setPromotion(null);
    const startingFen = new Chess().fen();
    setAnalysisPieceIds(pieceIdentityMapFromFen(startingFen));
    analysisFenRef.current = startingFen;
    setAnalysisFen(startingFen);
    setAnalysisMoveHistory([]);
    setAnalysisFenHistory([]);
  }, [cancelActiveSearch, playerColor]);

  const undoTurn = useCallback(() => {
    setHistoryViewPly(null);
    cancelActiveSearch();
    autoSuggestionKeyRef.current = null;
    setSuggestion(null);
    pendingPremoveRef.current = null;
    setPendingPremove(null);
    setPremoveArmed(false);
    setPremoveNotice('');
    if (mode === 'analysis') {
      if (!analysisFenHistory.length) return;
      const previousFen = analysisFenHistory[analysisFenHistory.length - 1];
      const undoneMove = analysisMoveHistory[analysisMoveHistory.length - 1];
      if (undoneMove) analysisRedoRef.current.unshift({ fen: analysisFen, move: undoneMove });
      setRedoCount(analysisRedoRef.current.length);
      setAnalysisPieceIds(pieceIdentityMapFromFen(previousFen));
      analysisFenRef.current = previousFen;
      setAnalysisFen(previousFen);
      setAnalysisFenHistory((previous) => previous.slice(0, -1));
      setAnalysisMoveHistory((previous) => previous.slice(0, -1));
      setSelected(null);
      return;
    }
    const current = gameRef.current;
    if (!current.history().length) return;
    const latest = current.undo();
    if (latest) {
      redoMovesRef.current.push(latest.san);
      if (latest.color !== playerColor && current.history().length) {
        const paired = current.undo();
        if (paired) redoMovesRef.current.push(paired.san);
      }
      setRedoCount(redoMovesRef.current.length);
    }
    setPlayPieceIds(pieceIdentityMapFromFen(current.fen()));
    refreshGame();
  }, [analysisFenHistory, analysisMoveHistory, cancelActiveSearch, mode, playerColor, refreshGame]);

  const redoMove = useCallback(() => {
    setHistoryViewPly(null);
    cancelActiveSearch();
    autoSuggestionKeyRef.current = null;
    setSuggestion(null);
    if (mode === 'analysis') {
      const next = analysisRedoRef.current.shift();
      if (!next) return;
      setRedoCount(analysisRedoRef.current.length);
      setAnalysisFenHistory((previous) => [...previous, analysisFen]);
      setAnalysisMoveHistory((previous) => [...previous, next.move]);
      setAnalysisPieceIds((previous) => movePieceIdentity(previous, next.move.from, next.move.to));
      analysisFenRef.current = next.fen;
      setAnalysisFen(next.fen);
      setSelected(null);
      return;
    }
    const san = redoMovesRef.current.pop();
    if (!san) return;
    try {
      const move = gameRef.current.move(san);
      setPlayPieceIds((previous) => movePieceIdentity(previous, move.from, move.to, move.flags, move.color));
      setRedoCount(redoMovesRef.current.length);
      refreshGame();
    } catch {
      redoMovesRef.current = [];
      setRedoCount(0);
    }
  }, [analysisFen, cancelActiveSearch, mode, refreshGame]);

  const resetAnalysis = useCallback(() => {
    cancelActiveSearch();
    autoSuggestionKeyRef.current = null;
    setHistoryViewPly(null);
    const startingFen = new Chess().fen();
    setAnalysisPieceIds(pieceIdentityMapFromFen(startingFen));
    analysisFenRef.current = startingFen;
    setAnalysisFen(startingFen);
    setAnalysisMoveHistory([]);
    setAnalysisFenHistory([]);
    analysisRedoRef.current = [];
    setRedoCount(0);
    setSuggestion(null);
    setSelected(null);
  }, [cancelActiveSearch]);

  const togglePremove = useCallback(() => {
    if (pendingPremove) {
      pendingPremoveRef.current = null;
      setPendingPremove(null);
      setPremoveNotice('Premove canceled.');
    } else {
      setPremoveArmed((armed) => !armed);
      setPremoveNotice(premoveArmed ? '' : 'Choose one of your pieces, then its destination.');
    }
    setSelected(null);
  }, [pendingPremove, premoveArmed]);

  const moveRows = useMemo(() => {
    const rows: Array<{ number: number; white?: MoveInfo; black?: MoveInfo }> = [];
    history.forEach((move, index) => {
      if (move.color === 'w') rows.push({ number: Math.floor(index / 2) + 1, white: move });
      else if (rows.length) rows[rows.length - 1].black = move;
      else rows.push({ number: 1, black: move });
    });
    return rows;
  }, [history]);

  const jumpToHistory = useCallback((ply: number, currentPly: number) => {
    cancelActiveSearch();
    autoSuggestionKeyRef.current = null;
    setSuggestion(null);
    setSelected(null);
    setPromotion(null);
    setHistoryViewPly(ply >= currentPly ? null : ply);
  }, [cancelActiveSearch]);

  const boardFiles = flipped ? [...files].reverse() : files;
  const boardRanks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const allCoords = `${boardFiles[0]}${boardRanks[0]}-${boardFiles[7]}${boardRanks[7]}`;
  const status = mode === 'analysis'
    ? thinking ? 'Stockfish is evaluating this position…'
      : `${currentTurn === 'w' ? 'White' : 'Black'} to move · free analysis`
    : game.isCheckmate()
    ? moveBothSides
      ? `Checkmate — ${currentTurn === 'w' ? 'Black' : 'White'} wins`
      : `${currentTurn === playerColor ? 'Checkmate — Stockfish wins' : 'Checkmate — you win'}`
      : game.isStalemate() ? 'Draw by stalemate'
        : game.isDraw() ? 'Game drawn'
          : thinking ? (searchPurposeRef.current === 'suggestion' ? 'Stockfish is finding a strong move…' : 'Stockfish is thinking…')
            : game.isCheck() ? `${currentTurn === playerColor ? 'Your king is' : 'Stockfish is'} in check`
              : moveBothSides ? `${currentTurn === 'w' ? 'White' : 'Black'} to move` : playerTurn ? 'Your move' : 'Stockfish to move';
  const stateLabel = engineState === 'ready' ? 'READY TO PLAY' : engineState === 'loading' ? 'WAKING UP' : 'UNAVAILABLE';
  const moveCount = mode === 'analysis' ? analysisMoveHistory.length : Math.ceil(history.length / 2);
  const suggestionSearching = thinking && searchPurposeRef.current === 'suggestion';
  const canInteract = historyViewPly === null && (mode === 'analysis'
    || (!gameOver && engineState !== 'failed' && (canMoveCurrentSide ? (!thinking || suggestionSearching) : premoveArmed)));
  const suggestionIsCurrent = Boolean(suggestion && suggestion.mode === mode && suggestion.fen === activeFen);
  const suggestionArrow = suggestionIsCurrent && suggestion
    ? (() => {
      const from = squareCenter(suggestion.from, flipped);
      const to = squareCenter(suggestion.to, flipped);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.hypot(dx, dy) || 1;
      return {
        from: { x: from.x + (dx / distance) * 18, y: from.y + (dy / distance) * 18 },
        to: { x: to.x - (dx / distance) * 30, y: to.y - (dy / distance) * 30 },
        unit: { x: dx / distance, y: dy / distance },
        normal: { x: -dy / distance, y: dx / distance },
      };
    })()
    : null;
  const undoDisabled = mode === 'analysis' ? analysisFenHistory.length === 0 : history.length === 0;
  const redoDisabled = mode === 'analysis' ? redoCount === 0 : redoCount === 0;

  function renderMove(move: MoveInfo | undefined, id: string, ply: number) {
    if (!move) return <span aria-hidden="true">—</span>;
    return <button type="button" className={`move-cell move-history-jump ${historyViewPly === ply ? 'active' : ''}`} onClick={() => jumpToHistory(ply, history.length)} aria-current={historyViewPly === ply ? 'step' : undefined} data-testid={`move-san-${move.color}-${id}`}>
      <span className="move-piece" aria-hidden="true">{glyphs[`${move.color}${move.piece}`]}</span>{move.san}
    </button>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">♞</div>
          <div><div className="brand-name"><span className="brand-rig">Rig</span><span className="brand-x">X</span></div></div>
        </div>
      </header>

      <div className="workspace">
        <section className="board-column" aria-label="Chess game">
          <div className="mode-switch" role="group" aria-label="Choose board mode">
            <button type="button" className={`mode-button ${mode === 'play' ? 'active' : ''}`} aria-pressed={mode === 'play'} onClick={() => changeMode('play')} data-testid="button-mode-play">Play</button>
            <button type="button" className={`mode-button ${mode === 'analysis' ? 'active' : ''}`} aria-pressed={mode === 'analysis'} onClick={() => changeMode('analysis')} data-testid="button-mode-analysis">Free analysis</button>
          </div>

          {mode === 'play' && <div className="player-strip" data-testid="player-opponent">
            <div className="avatar" aria-hidden="true">{moveBothSides ? '♟' : playerColor === 'w' ? '♚' : '♔'}</div>
            <div className="player-meta"><div className="player-name">{moveBothSides ? 'Two-player game' : 'ChiziRigX'}</div>{moveBothSides && <div className="player-detail">You control White and Black</div>}</div>
            <div className={`turn-indicator ${((moveBothSides || currentTurn !== playerColor) && !gameOver) ? 'active' : ''}`} aria-label={moveBothSides ? `${currentTurn === 'w' ? 'White' : 'Black'} to move` : currentTurn !== playerColor ? 'Opponent to move' : 'Waiting'} />
            <span className="clock">ENGINE</span>
          </div>}

          <div className="board-with-eval">
            <div className="evaluation-bar-column" aria-label={`Evaluation ${evaluationLabel}`} data-testid="evaluation-bar">
              <span className="evaluation-bar-label black-label" aria-hidden="true">♚</span>
              <div className="evaluation-bar-track">
                <div className="evaluation-bar-black" style={{ height: `${100 - whiteShare}%` }} />
                <div className="evaluation-bar-white" style={{ height: `${whiteShare}%` }} />
              </div>
              <span className="evaluation-bar-label white-label" aria-hidden="true">♔</span>
              <span className="evaluation-bar-value">{evaluationLabel}</span>
            </div>
            <div className="board-frame">
            <LayoutGroup id={`board-${mode}`}>
              <div className="chessboard" role="grid" aria-label={`Chessboard, ${allCoords} corner to corner`}>
                {boardRanks.flatMap((rank, rankIndex) => boardFiles.map((file, fileIndex) => {
                  const square = `${file}${rank}` as Square;
                  const piece = boardPosition[8 - rank]?.[files.indexOf(file)] ?? null;
                  const isLight = (files.indexOf(file) + rank) % 2 === 0;
                  const isSelected = selected === square;
                  const legalMove = targetMoves.get(square);
                  const freeTarget = analysisTargets.get(square);
                  const isTarget = Boolean(legalMove || freeTarget !== undefined);
                  const isCaptureTarget = Boolean(legalMove?.captured || freeTarget);
                  const isLast = mode === 'analysis'
                    ? analysisMoveHistory[analysisMoveHistory.length - 1]?.from === square || analysisMoveHistory[analysisMoveHistory.length - 1]?.to === square
                    : lastMove?.from === square || lastMove?.to === square;
                  const isCheck = checkedName === square;
                  const isSuggestionFrom = suggestionIsCurrent && suggestion?.from === square;
                  const isSuggestionTo = suggestionIsCurrent && suggestion?.to === square;
                  const isPremoveFrom = pendingPremove?.from === square;
                  const isPremoveTo = pendingPremove?.to === square;
                  const canDragSource = Boolean(piece && canInteract && (mode === 'analysis' || moveBothSides || piece.color === playerColor));
                  const label = `${file}${rank}, ${piece ? `${piece.color === 'w' ? 'white' : 'black'} ${pieceNames[piece.type]}` : 'empty'}${isSelected ? ', selected' : ''}${isTarget ? mode === 'analysis' ? ', free destination' : premoveArmed ? ', premove destination' : ', legal destination' : ''}${isSuggestionTo ? ', Stockfish suggestion destination' : ''}`;
                  return (
                    <button
                      type="button"
                      role="gridcell"
                      aria-label={label}
                      aria-selected={isSelected}
                      data-testid={`square-${square}`}
                      key={square}
                      className={`square ${isLight ? 'light' : 'dark'}${isLast ? ' last-move' : ''}${isSelected ? ' selected' : ''}${isCheck ? ' check' : ''}${isSuggestionFrom ? ' suggestion-from' : ''}${isSuggestionTo ? ' suggestion-to' : ''}${isPremoveFrom ? ' premove-from' : ''}${isPremoveTo ? ' premove-to' : ''}`}
                      onClick={() => selectSquare(square)}
                      disabled={!canInteract}
                      draggable={canDragSource}
                      onDragStart={(event) => {
                        if (!canDragSource) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.setData('text/plain', square);
                        event.dataTransfer.effectAllowed = 'move';
                        setSelected(square);
                      }}
                      onDragOver={(event) => {
                        if (canInteract) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const from = event.dataTransfer.getData('text/plain') as Square;
                        if (from && moveFromTo(from, square)) setSelected(null);
                      }}
                    >
                      {fileIndex === 0 && <span className="coord" aria-hidden="true">{rank}</span>}
                      {rankIndex === 7 && <span className="coord file" aria-hidden="true">{file}</span>}
                      {piece && (
                        <motion.span
                          layoutId={`${mode}-${activePieceIds[square] ?? square}`}
                          transition={{ layout: { duration: prefersReducedMotion ? 0.01 : 0.42, ease: [0.22, 1, 0.36, 1] } }}
                          className="piece"
                          data-testid={`piece-${square}`}
                          aria-hidden="true"
                        >
                          <ChessPiece type={piece.type} color={piece.color} />
                        </motion.span>
                      )}
                      {isTarget && <span className={`move-hint ${isCaptureTarget ? 'capture-hint' : ''}`} aria-hidden="true" />}
                    </button>
                  );
                }))}
                {suggestionArrow && suggestion && (
                  <svg
                    className="best-move-arrow"
                    viewBox="0 0 800 800"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    data-testid="best-move-arrow"
                  >
                    <path
                      d={(() => {
                        const { from, to, unit, normal } = suggestionArrow;
                        const headBase = { x: to.x - unit.x * 34, y: to.y - unit.y * 34 };
                        const point = (center: { x: number; y: number }, side: number, width: number) => `${center.x + normal.x * side * width},${center.y + normal.y * side * width}`;
                        return `M ${point(from, 1, 7)} L ${point(headBase, 1, 7)} L ${point(headBase, 1, 18)} L ${to.x},${to.y} L ${point(headBase, -1, 18)} L ${point(headBase, -1, 7)} L ${point(from, -1, 7)} Z`;
                      })()}
                      className="best-move-arrow-line"
                    />
                  </svg>
                )}
              </div>
            </LayoutGroup>
            </div>
          </div>

          <div className="player-strip bottom" data-testid="player-you">
            <div className="avatar" aria-hidden="true">{mode === 'analysis' ? (currentTurn === 'w' ? '♔' : '♚') : playerColor === 'w' ? '♔' : '♚'}</div>
            <div className="player-meta"><div className="player-name">{mode === 'analysis' ? `${currentTurn === 'w' ? 'White' : 'Black'} to move` : moveBothSides ? `${currentTurn === 'w' ? 'White' : 'Black'} to move` : `You · ${playerColor === 'w' ? 'White' : 'Black'}`}</div><div className="player-detail">{mode === 'analysis' ? 'No game rules enforced' : moveBothSides ? 'At the board' : playerTurn && !gameOver ? 'At the board' : 'Ready when you are'}</div></div>
            <div className={`turn-indicator ${mode === 'analysis' || (canMoveCurrentSide && !gameOver) ? 'active' : ''}`} aria-label={mode === 'analysis' ? 'Analysis turn' : canMoveCurrentSide ? 'Your turn' : 'Not your turn'} />
            <span className="clock">{mode === 'analysis' ? 'ANALYSIS' : gameOver ? 'FINISHED' : canMoveCurrentSide ? 'YOUR TURN' : 'WAITING'}</span>
          </div>

          <div className="board-footer">
            <div className="board-tools" aria-label="Board controls">
              <button className="icon-button" type="button" onClick={undoTurn} disabled={undoDisabled} aria-label="Undo last move" title="Undo last move" data-testid="button-undo"><Undo2 /></button>
              <button className="icon-button" type="button" onClick={redoMove} disabled={redoDisabled} aria-label="Redo move" title="Redo move" data-testid="button-redo"><Redo2 /></button>
              <button className="flip-button" type="button" onClick={() => setFlipped((value) => !value)} aria-label="Flip board" title="Flip board" data-testid="button-flip"><ArrowLeftRight /> <span>Flip board</span></button>
            </div>
          </div>
        </section>

        <aside className="side-panel" aria-label="Game controls and move history">
          <section className="panel-section">
            <div className="setting-label">Engine strategy</div>
            <div className="select-control" aria-label="Engine strategy">Full strength · deepest mate search</div>
            <button
              type="button"
              className={`two-side-toggle ${moveBothSides ? 'enabled' : ''}`}
              aria-pressed={moveBothSides}
              aria-label="Move both sides manually"
              data-testid="toggle-two-sides"
              onClick={() => {
                cancelActiveSearch();
                autoSuggestionKeyRef.current = null;
                setMoveBothSides((enabled) => !enabled);
                setSuggestion(null);
              }}
            >
              <span className="two-side-switch" aria-hidden="true"><span /></span>
              <span><strong>Move both sides</strong><small>{moveBothSides ? 'You make every move' : 'Stockfish moves automatically'}</small></span>
            </button>
            <div className="setting-label"><span>Play as</span><span>{playerColor === 'w' ? '♔ White' : '♚ Black'}</span></div>
            <div className="color-choice" role="group" aria-label="Choose your color">
              <button type="button" className={`choice-button ${playerColor === 'w' ? 'active' : ''}`} aria-pressed={playerColor === 'w'} onClick={() => startNewGame('w')} data-testid="button-play-white">♔ &nbsp;White</button>
              <button type="button" className={`choice-button ${playerColor === 'b' ? 'active' : ''}`} aria-pressed={playerColor === 'b'} onClick={() => startNewGame('b')} data-testid="button-play-black">♚ &nbsp;Black</button>
            </div>
            <button type="button" className="new-game" onClick={() => startNewGame()} data-testid="button-new-game"><RefreshCw /> New game</button>
            <div className="strategy-actions">
              <button
                type="button"
                className="suggest-button"
                onClick={requestSuggestion}
                disabled={engineState !== 'ready' || thinking || gameOver || historyViewPly !== null || (mode === 'play' && !moveBothSides && !playerTurn)}
                data-testid="button-suggest-move"
              >
                <Lightbulb />
                {thinking && searchPurposeRef.current === 'suggestion' ? 'Finding a move…' : 'Suggest best move'}
              </button>
              {mode === 'play' && !moveBothSides && !playerTurn && !gameOver && engineState === 'ready' && (
                <button
                  type="button"
                  className={`premove-button ${premoveArmed ? 'armed' : ''}`}
                  onClick={togglePremove}
                  data-testid="button-queue-premove"
                >
                  <Hand />
                  {pendingPremove ? 'Cancel premove' : premoveArmed ? 'Cancel premove' : 'Queue premove'}
                </button>
              )}
              {mode === 'analysis' && (
                <button type="button" className="premove-button" onClick={resetAnalysis} data-testid="button-reset-analysis">
                  <RefreshCw /> Reset analysis
                </button>
              )}
            </div>
            {premoveArmed && <div className="premove-help" role="status" data-testid="text-premove-help">Choose one of your pieces, then its destination. The move will play if it is legal after Stockfish replies.</div>}
            {premoveNotice && !premoveArmed && <div className="premove-notice" role="status" data-testid="text-premove-status">{premoveNotice}</div>}
            {suggestionIsCurrent && suggestion && (
              <div className="suggestion-card" data-testid="card-best-move">
                <span className="suggestion-eyebrow">STOCKFISH SUGGESTS</span>
                <strong>{suggestion.from} <span aria-hidden="true">→</span> {suggestion.to}{suggestion.promotion ? ` = ${suggestion.promotion.toUpperCase()}` : ''}</strong>
                <span className="suggestion-detail">{mode === 'analysis' ? 'Best move for the side to move' : 'Best move for your position'}</span>
                <button type="button" className="suggestion-apply" onClick={useSuggestion} data-testid="button-use-suggestion">
                  {mode === 'analysis' ? 'Apply to analysis' : 'Play this move'}
                </button>
              </div>
            )}
            {engineState === 'failed' && <div className="engine-error" role="alert" data-testid="text-engine-error">
              <strong>Stockfish didn’t start.</strong> {engineError || 'This browser could not load the local engine.'} Moves stay disabled until the real engine is available.
            </div>}
          </section>

          <section className="panel-section">
            <div className="section-heading"><h2>{mode === 'analysis' ? 'Analysis line' : 'Moves'}</h2><span data-testid="text-move-count">{mode === 'analysis' ? `${analysisMoveHistory.length} MOVES` : `${history.length} PLY`}</span></div>
            <div className="history-list" data-testid="list-move-history" aria-label="Move history">
              {mode === 'analysis' ? analysisMoveHistory.length ? (
                <div className="analysis-move-list">
                  {analysisMoveHistory.map((move, index) => (
                    <button type="button" className={`analysis-move-row history-jump ${historyViewPly === index + 1 ? 'active' : ''}`} aria-current={historyViewPly === index + 1 ? 'step' : undefined} onClick={() => jumpToHistory(index + 1, analysisMoveHistory.length)} key={`${move.from}-${move.to}-${index}`} data-testid={`row-analysis-move-${index + 1}`}>
                      <span className="move-no">{String(index + 1).padStart(2, '0')}</span>
                      <span className="move-piece" aria-hidden="true">{glyphs[`${move.piece.color}${move.piece.type}`]}</span>
                      <span>{move.from} <span aria-hidden="true">→</span> {move.to}{move.promotion ? ` = ${move.promotion.toUpperCase()}` : ''}</span>
                      {move.captured && <small>capture</small>}
                    </button>
                  ))}
                </div>
              ) : <div className="empty-history" data-testid="empty-analysis-history"><span className="empty-glyph" aria-hidden="true">♙</span><span>Move any piece to explore<br />a different position.</span></div> : moveRows.length ? <>
                <div className="history-header"><span>#</span><span>White</span><span>Black</span></div>
                {moveRows.map((row) => <div className="move-row" key={row.number} data-testid={`row-move-${row.number}`}>
                  <span className="move-no">{String(row.number).padStart(2, '0')}</span>{renderMove(row.white, `${row.number}-white`, (row.number - 1) * 2 + 1)}{renderMove(row.black, `${row.number}-black`, (row.number - 1) * 2 + 2)}
                </div>)}
              </> : <div className="empty-history" data-testid="empty-move-history"><span className="empty-glyph" aria-hidden="true">♙</span><span>Your first move starts<br />a new story.</span></div>}
            </div>
          </section>

        </aside>
      </div>

      {promotion && <div className="promotion-backdrop" role="presentation">
        <section className="promotion-dialog" role="dialog" aria-modal="true" aria-labelledby="promotion-title" data-testid="dialog-promotion">
          <h2 id="promotion-title">Choose a promotion</h2>
          <p>Your pawn reached the final rank. What should it become?</p>
          <div className="promotion-options">
            {(['q', 'r', 'b', 'n'] as const).map((piece) => <button key={piece} type="button" className="promotion-option" onClick={() => choosePromotion(piece)} aria-label={`Promote to ${pieceNames[piece]}`} data-testid={`button-promote-${piece}`}>
              <ChessPiece type={piece} color={promotion.color} />
            </button>)}
          </div>
        </section>
      </div>}
      <span className="sr-only" data-testid="text-board-coordinates">Board orientation {allCoords}</span>
    </main>
  );
}

export default App;
