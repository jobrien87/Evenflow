import { useParams } from 'react-router-dom';
import GameShell from '../breakRoom/GameShell';
import { GAME_LABELS } from '../breakRoom/games';

export default function BreakRoomPlayPage() {
  const { gameType } = useParams();
  if (!GAME_LABELS[gameType]) {
    return <div style={{ color: 'var(--text-muted)' }}>Unknown game.</div>;
  }
  return <GameShell gameType={gameType} />;
}
