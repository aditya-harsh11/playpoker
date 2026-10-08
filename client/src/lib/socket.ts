import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@poker/shared';

// Where to reach the game server:
//  - VITE_SERVER_URL wins (set it for a split client/server deploy)
//  - dev: the same host on port 3001 (the server runs separately from Vite)
//  - prod: same origin (nginx in front of the servers serves this build and the socket)
const serverUrl =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3001` : undefined);

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(serverUrl, {
  autoConnect: true,
  // WebSocket only: one long-lived connection stays on one server, so the load balancer
  // can spread connections round-robin without "sticky sessions" (polling would need them).
  transports: ['websocket'],
  // Keep trying forever on a dropped connection (phones sleep, wifi flaps, server cold-starts).
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
  randomizationFactor: 0.5,
  timeout: 20000,
});

/**
 * Which load-balanced server this connection is on. The server says so once per connection,
 * often before any page is listening, so remember it here.
 */
export let currentServerId: string | null = null;
socket.on('serverInfo', (info) => {
  currentServerId = info.serverId;
});
