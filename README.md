# Hexfield

Hexfield is a hex-combat simulator and playtest table. Start it with `npm run dev`; build the static application with `npm run build`.

## Live multiplayer

1. Deploy the built application to a publicly reachable HTTPS address. A `localhost` URL points to each person's own computer and cannot be used as a remote invitation.
2. In Play, select **Online link**. The host chooses the turn mode (and first mover only for alternating turns), places both armies, and selects **Create room**.
3. The host shares the invitation. The guest can open it directly or paste it into the invitation field. Once both show **Connected**, the host starts the battle. The host controls Army A; the guest controls Army B.
4. Both tabs must remain open. In simultaneous mode each side locks orders independently; the host resolves the round after both lock. In alternating mode each action synchronizes immediately. In simultaneous rounds every legal attack resolves before any movement (a targeted unit cannot move away), mutual attacks kill both, and two units fighting for one hex both stay put.

Opening deployments are checked against every legal enemy attack. Auto-deploy will not put units into an immediate attack; manual placements are rejected if either side could attack at setup, and Start Battle validates again.

The app uses PeerJS's public signaling service and a WebRTC data channel. Service outages, firewalls, or restrictive NATs can prevent connections. A TURN relay may be necessary on some networks. This is a peer-hosted session, not an authoritative persistent game server: the host must stay online and a closed host tab ends the room.

Old `?g=` snapshot links are not live rooms. Create and share a new `?room=` invitation instead.

For a custom signaling service, set `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, and `VITE_PEER_SECURE` at build time. Optional `VITE_TURN_URL`, `VITE_TURN_USERNAME`, and `VITE_TURN_CREDENTIAL` configure a TURN relay. Build-time values are public, so do not embed long-lived private credentials. For local development only, `npx peerjs --port 9000 --path /` starts a PeerServer; launch Vite with `VITE_PEER_HOST=127.0.0.1 VITE_PEER_PORT=9000 VITE_PEER_SECURE=false`.

## Simulation

By default, training fixtures and measured battles use a browser worker pool, capped at eight workers. **Low power** uses one worker with the same AI and game rules. Browser scheduling and actual CPU limits determine speedup. Custom patterns, eras and unit profiles are copied into each worker before a task. A pattern or profile edit invalidates stale learned unit weights; subsequent training starts from the authored rules. The bundled older reports are marked historical when their rules differ.

The AI searches a selective three-move beam for both sides, not the complete game tree. Opponent plies are scored pessimistically over their two best replies, rollout results are memoized by position, and self-play samples near-tied candidates to keep strategy diversity. Repeated deterministic positions and an emergency round limit are adjudicated by surviving material and city pressure; they are reported as attrition, not played indefinitely.

Run regression checks with `npx tsx scripts/test-engine.ts` and the TypeScript check with `npx tsc --noEmit`.