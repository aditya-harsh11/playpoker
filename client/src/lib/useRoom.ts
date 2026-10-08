import { useEffect, useState } from 'react';
import type { Card, RoomState } from '@poker/shared';
import { socket, currentServerId } from './socket';

export interface RoomData {
  state: RoomState | null;
  yourCards: Card[];
  error: string | null;
  connected: boolean;
  /** Which load-balanced server this connection is on (e.g. "server-2"). */
  serverId: string | null;
  dismissError: () => void;
}

/** Subscribes to live room updates from the server. */
export function useRoom(): RoomData {
  const [state, setState] = useState<RoomState | null>(null);
  const [yourCards, setYourCards] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean>(socket.connected);
  const [serverId, setServerId] = useState<string | null>(currentServerId);

  useEffect(() => {
    const onState = (s: RoomState) => setState(s);
    const onCards = (c: Card[]) => setYourCards(c);
    const onError = (m: string) => setError(m);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onServerInfo = (info: { serverId: string }) => setServerId(info.serverId);

    socket.on('roomState', onState);
    socket.on('yourCards', onCards);
    socket.on('errorMsg', onError);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('serverInfo', onServerInfo);

    return () => {
      socket.off('roomState', onState);
      socket.off('yourCards', onCards);
      socket.off('errorMsg', onError);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('serverInfo', onServerInfo);
    };
  }, []);

  return { state, yourCards, error, connected, serverId, dismissError: () => setError(null) };
}
