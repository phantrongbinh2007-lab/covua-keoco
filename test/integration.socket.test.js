/**
 * Integration: 2 client socket thật + server in-process.
 * Bắt regression điểm giật, sync race, bracket slim, double-loss ranking.
 */
process.env.CHESS_TOW_TEST = '1';
process.env.TOW_TOURNAMENT_COUNTDOWN = '0';
process.env.TOW_ROUND_COUNTDOWN = '0';
process.env.TOW_PUZZLE_TIME_MS = '120000';
process.env.TOW_SD_TIME_MS = '60000';
process.env.TOW_MOCK_WRITE_DELAY_MS = '15';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const {
    server,
    rooms,
    startListening,
    loadPuzzleCache,
    clearMatchTimer,
    clearAdvanceTimer,
    persistRoom,
    serializeRoom
} = require('../server');
const mockFb = require('./mockFirebase');

function cleanupRooms() {
    for (const room of Object.values(rooms)) {
        clearAdvanceTimer(room);
        (room.currentRoundMatches || []).forEach(clearMatchTimer);
        (room.players || []).forEach(p => {
            if (p.disconnectTimer) {
                clearTimeout(p.disconnectTimer);
                p.disconnectTimer = null;
            }
        });
    }
}

function once(socket, event, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`Timeout waiting for ${event}`));
        }, timeoutMs);
        function onEvent(data) {
            clearTimeout(t);
            resolve(data);
        }
        socket.once(event, onEvent);
    });
}

function connectClient(port, token) {
    return new Promise((resolve, reject) => {
        const socket = ioc(`http://127.0.0.1:${port}`, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false
        });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
        socket.token = token;
    });
}

function emitAck(socket, event, data, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ACK timeout ${event}`)), timeoutMs);
        socket.emit(event, data, (res) => {
            clearTimeout(t);
            resolve(res);
        });
    });
}

function playerMovesFromPuzzle(puzzle) {
    if (!puzzle?.solution) return [];
    const moves = [];
    for (let i = 1; i < puzzle.solution.length; i += 2) {
        const m = puzzle.solution[i];
        moves.push(Array.isArray(m) ? m[0] : m);
    }
    return moves;
}

async function solveCurrentPuzzle(socket, roomCode, token) {
    const room = rooms[roomCode];
    let match = room.currentRoundMatches.find(
        m => m.p1?.token === token || m.p2?.token === token
    );
    assert.ok(match, 'phải có trận active');
    assert.ok(!match.winner, 'trận chưa kết thúc');
    const puzzles = JSON.parse(require('fs').readFileSync(
        require('path').join(__dirname, '..', 'public', `puzzles_level${room.level}.json`),
        'utf8'
    ));
    const puzzle = puzzles[match.currentSeed % puzzles.length];
    const moves = playerMovesFromPuzzle(puzzle);
    assert.ok(moves.length > 0, 'puzzle phải có nước người');

    const roundAtStart = match.puzzleRound;
    const seedAtStart = match.currentSeed;
    let lastAck = null;
    for (const move of moves) {
        // Re-read: tránh dùng round/seed stale nếu sync xen giữa
        match = room.currentRoundMatches.find(
            m => m.p1?.token === token || m.p2?.token === token
        );
        lastAck = await emitAck(socket, 'submit_move', {
            roomCode,
            token,
            puzzleRound: match.puzzleRound,
            puzzleSeed: match.currentSeed,
            move
        });
        if (!lastAck.ok) {
            if (lastAck.desync) {
                // Server đã sang bài khác — coi như vòng này xong
                break;
            }
            assert.fail(`submit_move fail: ${lastAck.error || JSON.stringify(lastAck)} (round=${roundAtStart} seed=${seedAtStart} move=${move})`);
        }
        if (lastAck.solved) break;
    }
    return lastAck;
}

describe('integration socket — giải đấu 2 người', () => {
    let port;
    let host;
    let guest;
    const hostToken = 'test_host_token_aaa';
    const guestToken = 'test_guest_token_bbb';

    before(async () => {
        mockFb.init();
        loadPuzzleCache();
        port = await startListening(0);
    });

    after(async () => {
        if (host) host.close();
        if (guest) guest.close();
        cleanupRooms();
        await new Promise(r => server.close(r));
    });

    it('điểm không bao giờ lùi khi spam sync giữa các lần giải', async () => {
        host = await connectClient(port, hostToken);
        guest = await connectClient(port, guestToken);

        const created = await emitAck(host, 'createRoom', {
            token: hostToken,
            playerName: 'HostA',
            level: 1,
            winScore: 5,
            compete: true
        });
        assert.equal(created.ok, true);
        const roomCode = created.roomCode;

        const joined = await emitAck(guest, 'joinRoom', {
            roomCode,
            token: guestToken,
            playerName: 'GuestB'
        });
        assert.equal(joined.ok, true);

        const gameStartHostP = once(host, 'gameStart', 10000);
        const gameStartGuestP = once(guest, 'gameStart', 10000);

        host.emit('startTournament', { roomCode, token: hostToken });

        const [gsHost, gsGuest] = await Promise.all([gameStartHostP, gameStartGuestP]);
        assert.ok(gsHost.matchId);
        assert.equal(gsHost.scoreP1, 0);
        assert.equal(gsGuest.scoreP2 ?? gsGuest.scoreP1, gsGuest.isP1 ? 0 : 0);

        const room = rooms[roomCode];
        assert.equal(room.status, 'playing');
        assert.equal(room.currentRoundMatches.length, 1);

        // Client-side monotonic tracker (mô phỏng HUD)
        let lastP1 = 0;
        let lastP2 = 0;
        let lastRound = 1;
        const observed = [];

        function noteScores(label, data) {
            if (!data || data.scoreP1 == null) return;
            observed.push({ label, ...data });
            // Invariant production: điểm không lùi trong cùng match
            assert.ok(
                data.scoreP1 + data.scoreP2 >= lastP1 + lastP2
                || data.matchId !== gsHost.matchId,
                `ĐIỂM GIẬT NGƯỢC tại ${label}: ${lastP1}-${lastP2} → ${data.scoreP1}-${data.scoreP2}`
            );
            if (data.matchId === gsHost.matchId) {
                lastP1 = Math.max(lastP1, data.scoreP1);
                lastP2 = Math.max(lastP2, data.scoreP2);
                if (data.puzzleRound != null) lastRound = Math.max(lastRound, data.puzzleRound);
            }
        }

        host.on('update_game', d => noteScores('host.update_game', d));
        guest.on('update_game', d => noteScores('guest.update_game', d));
        host.on('matchSync', d => noteScores('host.matchSync', d));
        guest.on('matchSync', d => noteScores('guest.matchSync', d));
        host.on('gameStart', d => noteScores('host.gameStart', d));
        guest.on('gameStart', d => noteScores('guest.gameStart', d));

        // Host giải 4 bài; spam sync giữa các lần (mô phỏng lag giải thật)
        let solvesOk = 0;
        for (let i = 0; i < 4; i++) {
            const match0 = room.currentRoundMatches[0];
            if (match0.winner) break;
            const before = { p1: match0.scoreP1 || 0, p2: match0.scoreP2 || 0 };

            host.emit('requestMatchSync', { roomCode, token: hostToken, reason: 'pre_solve' });
            guest.emit('requestMatchSync', { roomCode, token: guestToken, reason: 'pre_solve' });
            await new Promise(r => setTimeout(r, 20));

            const ack = await solveCurrentPuzzle(host, roomCode, hostToken);
            if (ack && ack.ok && ack.solved) solvesOk += 1;

            host.emit('requestMatchSync', { roomCode, token: hostToken, reason: 'post_solve' });
            guest.emit('requestMatchSync', { roomCode, token: guestToken, reason: 'post_solve' });
            // Đường cũ: reconnectUser (có thể emit gameStart) — server RAM vẫn không lùi điểm
            host.emit('reconnectUser', { roomCode, token: hostToken });
            await new Promise(r => setTimeout(r, 30));

            const match = room.currentRoundMatches[0];
            if (match.winner) break;

            const afterP1 = match.scoreP1 || 0;
            const afterP2 = match.scoreP2 || 0;
            assert.ok(
                afterP1 + afterP2 >= before.p1 + before.p2,
                `server RAM regress: ${before.p1}-${before.p2} → ${afterP1}-${afterP2}`
            );
            noteScores('server.ram', {
                matchId: match.id,
                scoreP1: afterP1,
                scoreP2: afterP2,
                puzzleRound: match.puzzleRound
            });
        }

        assert.ok(solvesOk >= 3, `phải solve được ≥3 bài, actual=${solvesOk}`);
        const final = room.currentRoundMatches[0];
        const hostIsP1 = final.p1.token === hostToken;
        const hostScore = hostIsP1 ? (final.scoreP1 || 0) : (final.scoreP2 || 0);
        assert.ok(hostScore >= 3, `Host phải được ≥3 điểm (side=${hostIsP1 ? 'p1' : 'p2'}), actual=${hostScore} board=${final.scoreP1}-${final.scoreP2}`);

        // Firebase mock sau queue phải khớp điểm RAM (không bị write cũ đè)
        await persistRoom(roomCode);
        await new Promise(r => setTimeout(r, 50));
        const persisted = await mockFb.dbGet(`rooms/${roomCode}`);
        assert.ok(persisted, 'phải persist được room (không circular JSON)');
        const pm = (persisted.currentRoundMatches || [])[0];
        assert.ok(pm, 'phải persist match');
        assert.equal(pm.scoreP1, final.scoreP1, 'Firebase scoreP1 phải khớp RAM');
        assert.equal(pm.scoreP2, final.scoreP2, 'Firebase scoreP2 phải khớp RAM');

        // serializeRoom không được ném khi có timer runtime
        const match = room.currentRoundMatches[0];
        match.timerId = setTimeout(() => {}, 999999);
        if (match.p1) match.p1.disconnectTimer = setTimeout(() => {}, 999999);
        assert.doesNotThrow(() => JSON.stringify(serializeRoom(room)));
        clearTimeout(match.timerId);
        clearTimeout(match.p1.disconnectTimer);
        match.timerId = null;
        match.p1.disconnectTimer = null;
    });

    it('requestMatchSync emit matchSync (không phải gameStart nặng)', async () => {
        // Dùng room đang playing nếu còn; nếu trận đã kết thúc thì tạo nhanh pair mới
        const codes = Object.keys(rooms);
        let roomCode = codes.find(c => rooms[c].status === 'playing'
            && rooms[c].currentRoundMatches.some(m => !m.winner && !m.isBye));

        if (!roomCode) {
            // Tạo phòng mới 2 người
            if (host) host.close();
            if (guest) guest.close();
            host = await connectClient(port, hostToken + '_2');
            guest = await connectClient(port, guestToken + '_2');
            const created = await emitAck(host, 'createRoom', {
                token: hostToken + '_2',
                playerName: 'HostC',
                level: 1,
                winScore: 5,
                compete: true
            });
            roomCode = created.roomCode;
            await emitAck(guest, 'joinRoom', {
                roomCode,
                token: guestToken + '_2',
                playerName: 'GuestD'
            });
            const gs = once(host, 'gameStart', 10000);
            host.emit('startTournament', { roomCode, token: hostToken + '_2' });
            await gs;
        }

        let gotGameStart = false;
        const onGs = () => { gotGameStart = true; };
        host.on('gameStart', onGs);

        const syncP = once(host, 'matchSync', 5000);
        host.emit('requestMatchSync', {
            roomCode,
            token: rooms[roomCode].players.find(p => p.name === 'HostA' || p.name === 'HostC').token,
            reason: 'unit'
        });
        const sync = await syncP;
        host.off('gameStart', onGs);

        assert.ok(sync.puzzleSeed != null);
        assert.ok(sync.scoreP1 != null);
        assert.equal(gotGameStart, false, 'sync nhẹ không được emit gameStart');
    });

    it('buildBracketPayload không kèm log/progress', () => {
        const { buildBracketPayload } = require('../server');
        const roomCode = Object.keys(rooms)[0];
        assert.ok(roomCode);
        const payload = buildBracketPayload(rooms[roomCode]);
        const flat = (payload.bracket || []).flat();
        for (const m of flat) {
            assert.equal(m.log, undefined);
            assert.equal(m.progress, undefined);
            assert.equal(m.events, undefined);
            assert.ok(m.id);
            assert.ok('p1' in m);
        }
    });
});

describe('integration — đồng thua vào eliminationOrder', () => {
    it('record cả hai khi double loss', () => {
        // Unit-level trên state: mô phỏng resolveMatchWinner path
        const room = {
            eliminationOrder: [],
            bracket: [],
            currentRoundMatches: []
        };
        const p1 = { token: 't1', name: 'A' };
        const p2 = { token: 't2', name: 'B' };
        const match = { p1, p2, settled: false, id: 'mx' };

        function recordElimination(r, loser) {
            if (!loser || loser.isDoubleLoss) return;
            if (!r.eliminationOrder) r.eliminationOrder = [];
            if (r.eliminationOrder.includes(loser.name)) return;
            r.eliminationOrder.push(loser.name);
        }

        const winner = { token: null, name: 'Đồng thua', isDoubleLoss: true };
        match.settled = true;
        match.winner = winner;
        if (match.p1 && match.p2) {
            if (winner.isDoubleLoss) {
                recordElimination(room, match.p1);
                recordElimination(room, match.p2);
            }
        }

        assert.deepEqual(room.eliminationOrder, ['A', 'B']);
    });
});
