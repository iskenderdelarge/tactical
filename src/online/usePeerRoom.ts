import { useCallback, useEffect, useRef, useState } from 'react';
import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { RoomMessage } from './match';

export type RoomRole = 'host' | 'guest' | null;
export type RoomStatus = 'idle' | 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error';

function peerOptions(): PeerOptions {
  // PeerJS cloud is used by default. Optional Vite environment variables let
  // deployments use their own signaling service without changing game code.
  const host = import.meta.env.VITE_PEER_HOST as string | undefined;
  const options: PeerOptions = {};
  if (host) Object.assign(options, { host, port: Number(import.meta.env.VITE_PEER_PORT || 443),
    path: import.meta.env.VITE_PEER_PATH || '/', secure: import.meta.env.VITE_PEER_SECURE !== 'false' });
  const turn = import.meta.env.VITE_TURN_URL as string | undefined;
  if (turn) options.config = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: turn, username: import.meta.env.VITE_TURN_USERNAME || '', credential: import.meta.env.VITE_TURN_CREDENTIAL || '' },
  ] };
  return options;
}

export function roomIdFromLink(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text, window.location.href);
    const id = url.searchParams.get('room');
    if (id && /^[a-zA-Z0-9_-]{1,80}$/.test(id)) return id;
  } catch { /* A bare room code is also accepted. */ }
  return /^[a-zA-Z0-9_-]{1,80}$/.test(text) ? text : null;
}

export function usePeerRoom() {
  const [role, setRole] = useState<RoomRole>(null);
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [message, setMessage] = useState('');
  const [invite, setInvite] = useState('');
  const peerRef = useRef<Peer | null>(null);
  const connectionRef = useRef<DataConnection | null>(null);
  const handlerRef = useRef<(message: RoomMessage) => void>(() => {});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const close = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    timerRef.current = null;
    heartbeatRef.current = null;
    connectionRef.current?.close();
    connectionRef.current = null;
    peerRef.current?.destroy();
    peerRef.current = null;
    setRole(null);
    setStatus('idle');
    setInvite('');
    setMessage('');
  }, []);

  useEffect(() => {
    const disconnect = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      connectionRef.current?.close();
      peerRef.current?.destroy();
    };
    window.addEventListener('pagehide', disconnect);
    return () => { window.removeEventListener('pagehide', disconnect); disconnect(); };
  }, []);

  const attach = useCallback((connection: DataConnection, owner: Peer) => {
    // Rejoining should replace a stale data channel instead of being rejected.
    connectionRef.current?.close();
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    connectionRef.current = connection;
    setStatus('connecting');
    let lastReceived = Date.now();
    connection.on('open', () => {
      if (peerRef.current !== owner || connectionRef.current !== connection) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      setStatus('connected');
      setMessage('Connected. Your moves are sent directly to the other player.');
      lastReceived = Date.now();
      heartbeatRef.current = setInterval(() => {
        if (connectionRef.current !== connection) return;
        // Browsers can throttle background tabs to roughly one timer per
        // minute. Allow that without falsely disconnecting a thinking player.
        if (Date.now() - lastReceived > 90000) {
          connection.close();
          return;
        }
        if (connection.open) connection.send({ type: 'heartbeat' });
      }, 5000);
    });
    connection.on('data', (data: unknown) => {
      if (connectionRef.current !== connection) return;
      lastReceived = Date.now();
      if (data && typeof data === 'object' && 'type' in data && data.type === 'heartbeat') return;
      if (data && typeof data === 'object' && 'type' in data) handlerRef.current(data as RoomMessage);
    });
    connection.on('close', () => {
      if (peerRef.current !== owner || connectionRef.current !== connection) return;
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      connectionRef.current = null;
      setStatus('disconnected');
      setMessage('The other player disconnected. The host can keep this room open while they rejoin.');
    });
    connection.on('error', (error) => {
      if (peerRef.current !== owner || connectionRef.current !== connection) return;
      setStatus('error');
      setMessage(`Connection failed: ${error.message}. Try reconnecting or another network.`);
    });
  }, []);

  const makePeer = useCallback((nextRole: 'host' | 'guest') => {
    close();
    const peer = new Peer(peerOptions());
    peerRef.current = peer;
    setRole(nextRole);
    setStatus('connecting');
    setMessage('Connecting to the signaling service...');
    peer.on('error', (error) => {
      if (peerRef.current !== peer) return;
      setStatus('error');
      setMessage(error.type === 'peer-unavailable'
        ? 'Room not found. Ask the host to keep the game open and send a new link.'
        : `Online connection failed: ${error.message}. Check your network and try again.`);
    });
    peer.on('disconnected', () => {
      if (peerRef.current !== peer || connectionRef.current?.open) return;
      setStatus('disconnected');
      setMessage('Lost connection to the signaling service. Create or join the room again.');
    });
    return peer;
  }, [close]);

  const create = useCallback(() => {
    const peer = makePeer('host');
    peer.on('open', (id) => {
      if (peerRef.current !== peer) return;
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('room', id);
      setInvite(url.toString());
      setStatus('waiting');
      setMessage('Room created. Keep this tab open and share the invite with your opponent.');
    });
    peer.on('connection', (connection) => attach(connection, peer));
  }, [attach, makePeer]);

  const join = useCallback((raw: string) => {
    const id = roomIdFromLink(raw);
    if (!id) {
      setStatus('error');
      setMessage('Enter a valid room link or room code.');
      return;
    }
    const peer = makePeer('guest');
    peer.on('open', () => {
      if (peerRef.current !== peer) return;
      attach(peer.connect(id, { reliable: true, serialization: 'json' }), peer);
      timerRef.current = setTimeout(() => {
        if (peerRef.current === peer && !connectionRef.current?.open) {
          setStatus('error');
          setMessage('The connection timed out. Keep the host tab open; strict networks may require a TURN relay.');
        }
      }, 20000);
    });
  }, [attach, makePeer]);

  const send = useCallback((payload: RoomMessage): boolean => {
    if (!connectionRef.current?.open) {
      setMessage('Not connected. Wait for your opponent or reconnect before submitting.');
      return false;
    }
    connectionRef.current.send(payload);
    return true;
  }, []);

  const setHandler = useCallback((handler: (payload: RoomMessage) => void) => {
    handlerRef.current = handler;
  }, []);

  return { role, status, message, invite, create, join, send, close, setHandler };
}