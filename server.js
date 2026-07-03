const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { init: initFirebase, dbGet, dbSet, dbRemove, isUsingAdmin } = require('./firebaseDb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

initFirebase();

const rooms = {};
const MAX_PLAYERS = 64;
const WAITING_DISCONNECT_GRACE_MS = 60 * 1000;
const TOURNAMENT_START_COUNTDOWN = 10;
const ROUND_START_COUNTDOWN = 5;
const REGULAR_PUZZLE_TIME_MS = 60 * 1000;
const SUDDEN_DEATH_TIME_MS = 30 * 1000;
const MAX_REGULAR_DRAWS = 3;

let leaderboard = { daily: {}, weekly: {}, monthly: {} };
const puzzleCache = {};

function loadPuzzleCache() {
    for (let level = 1; level <= 5; level++) {
        const filePath = path.join(__dirname, 'public', `puzzles_level${level}.json`);
        if (fs.existsSync(filePath)) {
            puzzleCache[level] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            console.log(`📦 Cache puzzle cấp ${level}: ${puzzleCache[level].length} bài`);
        }
    }
}

app.get('/api/puzzles/:level', (req, res) => {
    const level = parseInt(req.params.level, 10);
    if (puzzleCache[level]) {
        res.set('Cache-Control', 'public, max-age=3600');
        return res.json(puzzleCache[level]);
    }
    res.status(404).json({ error: 'Không tìm thấy bài tập' });
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        rooms: Object.keys(rooms).length,
        firebaseAdmin: isUsingAdmin(),
        puzzleLevels: Object.keys(puzzleCache).length
    });
});

dbGet('leaderboard').then((data) => {
    if (data) {
        leaderboard = data;
        console.log('☁️ Đã tải Bảng Xếp Hạng từ Firebase!');
    } else {
        dbSet('leaderboard', leaderboard);
    }
}).catch((error) => { console.error('❌ Lỗi Firebase leaderboard:', error.message); });

function saveLeaderboard() {
    dbSet('leaderboard', leaderboard).catch(console.error);
    io.emit('updateLeaderboard', leaderboard);
}

function addScore(playerName, points) {
    if (!leaderboard) leaderboard = { daily: {}, weekly: {}, monthly: {} };
    if (!leaderboard.daily) leaderboard.daily = {};
    if (!leaderboard.weekly) leaderboard.weekly = {};
    if (!leaderboard.monthly) leaderboard.monthly = {};

    leaderboard.daily[playerName] = (leaderboard.daily[playerName] || 0) + points;
    leaderboard.weekly[playerName] = (leaderboard.weekly[playerName] || 0) + points;
    leaderboard.monthly[playerName] = (leaderboard.monthly[playerName] || 0) + points;
    saveLeaderboard();
}

function normalizeRoomCode(code) {
    if (code == null) return '';
    return String(code).trim().replace(/\D/g, '');
}

function playerTokenRoom(token) {
    return token ? `user_${token}` : null;
}

function joinPlayerChannels(socket, token, roomCode) {
    socket.join(roomCode);
    if (token) socket.join(playerTokenRoom(token));
}

function emitToToken(token, event, data) {
    if (!token) return;
    io.to(playerTokenRoom(token)).emit(event, data);
}

function isNameTaken(room, name, excludeToken) {
    const normalized = name.trim().toLowerCase();
    return room.players.some(
        p => p.token !== excludeToken && p.name.trim().toLowerCase() === normalized
    );
}

function makeMatchId() {
    return Math.random().toString(36).substr(2, 9);
}

function makeMatch(p1, p2) {
    return {
        id: makeMatchId(), p1, p2, winner: null, ropePosition: 0,
        puzzleRound: 1, currentSeed: null, isBye: false
    };
}

function makeByeMatch(p1) {
    return {
        id: makeMatchId(), p1, p2: null, winner: p1, ropePosition: 0,
        puzzleRound: 1, currentSeed: null, isBye: true
    };
}

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function generateNextRound(room) {
    const players = [...room.activePlayers];
    const n = players.length;
    const matches = [];
    const isFirstRound = room.bracket.length === 0;

    if (isFirstRound) {
        const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(n, 2))));
        const numByes = bracketSize - n;

        if (numByes > 0) {
            const shuffled = shuffleArray(players);
            const byePlayers = shuffled.slice(0, numByes);
            const playingPlayers = shuffled.slice(numByes);
            for (const p of byePlayers) {
                matches.push(makeByeMatch(p));
            }
            for (let i = 0; i + 1 < playingPlayers.length; i += 2) {
                matches.push(makeMatch(playingPlayers[i], playingPlayers[i + 1]));
            }
            shuffleArray(matches);
        } else if (n === 1) {
            matches.push(makeByeMatch(players[0]));
        } else {
            for (let i = 0; i + 1 < n; i += 2) {
                matches.push(makeMatch(players[i], players[i + 1]));
            }
        }
    } else {
        const shuffled = shuffleArray(players);
        let idx = 0;
        while (idx + 1 < shuffled.length) {
            matches.push(makeMatch(shuffled[idx], shuffled[idx + 1]));
            idx += 2;
        }
        if (idx < shuffled.length) {
            matches.push(makeByeMatch(shuffled[idx]));
        }
    }

    room.currentRoundMatches = matches;
    room.bracket.push(matches);
}

function serializeMatch(match) {
    if (!match) return match;
    const { timerId, ...rest } = match;
    return rest;
}

function serializeRoom(room) {
    return {
        roomCode: room.roomCode,
        hostToken: room.hostToken,
        players: room.players.map(p => ({ id: p.id, token: p.token, name: p.name })),
        activePlayers: (room.activePlayers || []).map(p => ({ id: p.id, token: p.token, name: p.name })),
        bracket: (room.bracket || []).map(round => round.map(serializeMatch)),
        currentRoundMatches: (room.currentRoundMatches || []).map(serializeMatch),
        level: room.level,
        winScore: room.winScore,
        status: room.status,
        initialPlayerCount: room.initialPlayerCount || 0,
        eliminationOrder: room.eliminationOrder || [],
        savedAt: Date.now()
    };
}

function deserializeRoom(code, data) {
    return {
        ...data,
        roomCode: code,
        players: (data.players || []).map(p => ({ ...p, disconnectTimer: null })),
        activePlayers: data.activePlayers || [],
        bracket: (data.bracket || []).map(round => round.map(m => ({ ...m, timerId: null }))),
        eliminationOrder: data.eliminationOrder || [],
        currentRoundMatches: (data.currentRoundMatches || []).map(m => ({ ...m, timerId: null }))
    };
}

function persistRoom(roomCode) {
    const room = rooms[roomCode];
    if (!room) return Promise.resolve();
    return dbSet(`rooms/${roomCode}`, serializeRoom(room)).catch(err => {
        console.error(`❌ Lưu phòng [${roomCode}]:`, err.message);
    });
}

function removeRoom(roomCode) {
    delete rooms[roomCode];
    dbRemove(`rooms/${roomCode}`).catch(err => {
        console.error(`❌ Xóa phòng [${roomCode}]:`, err.message);
    });
}

async function fetchRoomFromFirebase(roomCode) {
    try {
        const data = await dbGet(`rooms/${roomCode}`);
        if (!data) return null;
        return deserializeRoom(roomCode, data);
    } catch (err) {
        console.error(`❌ Đọc phòng [${roomCode}]:`, err.message);
        return null;
    }
}

async function ensureRoom(roomCode) {
    if (rooms[roomCode]) return rooms[roomCode];
    const room = await fetchRoomFromFirebase(roomCode);
    if (room) {
        rooms[roomCode] = room;
        if (room.status === 'playing') restorePlayingRoomTimers(roomCode, room);
    }
    return room;
}

async function loadRoomsFromFirebase() {
    try {
        const data = await dbGet('rooms');
        if (!data) return;
        let count = 0;
        for (const [code, roomData] of Object.entries(data)) {
            rooms[code] = deserializeRoom(code, roomData);
            if (rooms[code].status === 'playing') {
                restorePlayingRoomTimers(code, rooms[code]);
            }
            count++;
        }
        console.log(`☁️ Đã khôi phục ${count} phòng từ Firebase`);
    } catch (err) {
        console.error('❌ Lỗi tải phòng Firebase:', err.message);
    }
}

function buildBracketPayload(room) {
    return {
        bracket: room.bracket,
        currentRoundIndex: Math.max(0, room.bracket.length - 1)
    };
}

function runCountdown(roomCode, seconds, eventName, onDone) {
    let remaining = seconds;
    io.to(roomCode).emit(eventName, { seconds: remaining });
    const interval = setInterval(() => {
        remaining--;
        if (remaining > 0) {
            io.to(roomCode).emit(eventName, { seconds: remaining });
        } else {
            clearInterval(interval);
            io.to(roomCode).emit(eventName, { seconds: 0, done: true });
            onDone();
        }
    }, 1000);
}

function recordElimination(room, loserPlayer) {
    if (!loserPlayer || loserPlayer.isDoubleLoss) return;
    if (!room.eliminationOrder) room.eliminationOrder = [];
    room.eliminationOrder.push(loserPlayer.name);
}

function formatResultsText(top8, champion, room) {
    const lines = [
        `🏆 KẾT QUẢ GIẢI CỜ VUA KÉO CO`,
        `Mã giải: ${room.roomCode}`,
        `Số kỳ thủ: ${room.initialPlayerCount || room.players.length}`,
        `Thời gian: ${new Date().toLocaleString('vi-VN')}`,
        ''
    ];
    top8.forEach(p => lines.push(`${p.medal} Hạng ${p.rank}: ${p.name}`));
    lines.push('', `👑 VÔ ĐỊCH: ${champion}`, '', '— Vua Lang Thang —');
    return lines.join('\n');
}

function buildTournamentResults(room, championName) {
    const eliminated = [...(room.eliminationOrder || [])];
    const rankings = [];
    if (championName && !championName.includes('Không có nhà vô địch')) {
        rankings.push(championName);
    }
    for (let i = eliminated.length - 1; i >= 0; i--) {
        if (!rankings.includes(eliminated[i])) rankings.push(eliminated[i]);
    }
    const top8 = rankings.slice(0, 8).map((name, i) => ({
        rank: i + 1,
        name,
        medal: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`
    }));
    const results = {
        roomCode: room.roomCode,
        champion: championName,
        top8,
        totalPlayers: room.initialPlayerCount || room.players.length,
        finishedAt: new Date().toISOString()
    };
    results.exportText = formatResultsText(top8, championName, room);
    return results;
}

async function saveTournamentResults(results) {
    const id = `${results.roomCode}_${Date.now()}`;
    try {
        await dbSet(`tournamentResults/${id}`, results);
        console.log(`📋 Đã lưu kết quả giải [${results.roomCode}]`);
    } catch (err) {
        console.error('❌ Lưu kết quả giải:', err.message);
    }
}

function clearMatchTimer(match) {
    if (match.timerId) {
        clearTimeout(match.timerId);
        match.timerId = null;
    }
}

function decideDoubleLoss(match) {
    match.winner = { token: null, id: null, name: 'Đồng thua', isDoubleLoss: true };
}

function sanitizePlayers(players) {
    return players.map(({ id, token, name }) => ({ id, token, name }));
}

function emitWaitingRoomUpdate(roomCode, room) {
    io.to(roomCode).emit('updateWaitingRoom', {
        players: sanitizePlayers(room.players),
        maxPlayers: MAX_PLAYERS
    });
}

function clearPlayerDisconnectTimer(player) {
    if (player && player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
    }
}

function scheduleWaitingRoomDisconnect(roomCode, room, player, socketId) {
    clearPlayerDisconnectTimer(player);
    const token = player.token;
    const playerName = player.name;
    player.disconnectTimer = setTimeout(() => {
        if (!rooms[roomCode] || room.status !== 'waiting') return;
        const idx = room.players.findIndex(p => p.token === token);
        if (idx === -1) return;
        const p = room.players[idx];
        if (p.id !== socketId) return;

        const wasHost = room.hostToken === token;
        room.players.splice(idx, 1);
        console.log(`👻 Đã xóa [${playerName}] khỏi phòng [${roomCode}]`);

        if (room.players.length === 0) {
            removeRoom(roomCode);
            return;
        }
        if (wasHost) {
            room.hostToken = room.players[0].token;
            io.to(roomCode).emit('hostChanged', {
                message: `${room.players[0].name} là chủ giải mới.`,
                hostToken: room.hostToken
            });
        }
        persistRoom(roomCode);
        emitWaitingRoomUpdate(roomCode, room);
    }, WAITING_DISCONNECT_GRACE_MS);
}

async function finishTournament(room, roomCode, championName) {
    const results = buildTournamentResults(room, championName);
    await saveTournamentResults(results);
    io.to(roomCode).emit('tournamentOver', results);
    removeRoom(roomCode);
}

function checkAndAdvanceTournament(room, roomCode) {
    io.to(roomCode).emit('updateBracketOnly', buildBracketPayload(room));
    persistRoom(roomCode);

    if (room.currentRoundMatches.every(m => m.winner !== null)) {
        room.currentRoundMatches.forEach(clearMatchTimer);
        room.activePlayers = room.currentRoundMatches
            .map(m => (m.winner && !m.winner.isDoubleLoss ? m.winner : null))
            .filter(Boolean);

        const realMatchCount = room.currentRoundMatches.filter(m => !m.isBye).length;

        if (room.activePlayers.length === 1) {
            if (realMatchCount > 1) {
                setTimeout(() => { startNewRound(room, roomCode); }, 2000);
            } else {
                addScore(room.activePlayers[0].name, 10);
                finishTournament(room, roomCode, room.activePlayers[0].name);
            }
        } else if (room.activePlayers.length > 1) {
            setTimeout(() => { startNewRound(room, roomCode); }, 2000);
        } else {
            finishTournament(room, roomCode, 'Không có nhà vô địch (đồng thua)');
        }
    }
}

function resolveMatchWinner(room, roomCode, match, winner, reasonMessage) {
    clearMatchTimer(match);
    match.winner = winner;

    if (match.p1 && match.p2 && !winner.isDoubleLoss) {
        const loser = winner.token === match.p1.token ? match.p2 : match.p1;
        recordElimination(room, loser);
    }

    if (!winner.isDoubleLoss) addScore(winner.name, 2);

    const payload = {
        winner: winner.name,
        bracket: buildBracketPayload(room),
        reason: reasonMessage,
        isDoubleLoss: !!winner.isDoubleLoss
    };
    if (match.p1?.token) emitToToken(match.p1.token, 'matchResult', payload);
    if (match.p2?.token) emitToToken(match.p2.token, 'matchResult', payload);
    io.to('watch_' + match.id).emit('spectateEnd', payload);
    checkAndAdvanceTournament(room, roomCode);
}

function handlePuzzleTimeout(roomCode, match) {
    const room = rooms[roomCode];
    if (!room || match.winner) return;

    if (match.roundMode === 'sudden_death') {
        decideDoubleLoss(match);
        resolveMatchWinner(room, roomCode, match, match.winner, 'Hết giờ Sudden Death: đồng thua.');
        return;
    }

    match.drawStreak = (match.drawStreak || 0) + 1;
    match.puzzleRound += 1;

    if (match.drawStreak >= MAX_REGULAR_DRAWS) {
        assignNextPuzzle(match, roomCode, {
            mode: 'sudden_death',
            message: 'Sudden Death 30s: sai 1 nước là thua ngay.'
        });
        return;
    }

    assignNextPuzzle(match, roomCode, {
        mode: 'regular',
        message: 'Hết giờ: hòa puzzle, chuyển thế cờ mới.'
    });
}

function assignNextPuzzle(match, roomCode, options = {}) {
    const room = rooms[roomCode];
    if (!room) return;

    const mode = options.mode || 'regular';
    const timeLimitMs = mode === 'sudden_death' ? SUDDEN_DEATH_TIME_MS : REGULAR_PUZZLE_TIME_MS;
    clearMatchTimer(match);

    match.roundMode = mode;
    match.timeLimitMs = timeLimitMs;
    match.currentSeed = Math.floor(Math.random() * 1000000);
    match.deadlineAt = Date.now() + timeLimitMs;
    match.hadMoveP1 = false;
    match.hadMoveP2 = false;

    match.timerId = setTimeout(() => {
        handlePuzzleTimeout(roomCode, match);
    }, timeLimitMs);

    persistRoom(roomCode);

    if (!options.silent) {
        const payload = {
            ropePosition: match.ropePosition,
            puzzleSeed: match.currentSeed,
            puzzleRound: match.puzzleRound,
            roundMode: match.roundMode,
            timeLimitMs: match.timeLimitMs,
            deadlineAt: match.deadlineAt
        };
        if (options.message) payload.message = options.message;
        const event = options.payloadType || 'update_game';
        if (match.p1?.token) emitToToken(match.p1.token, event, payload);
        if (match.p2?.token) emitToToken(match.p2.token, event, payload);
        io.to('watch_' + match.id).emit(event, payload);
    }
}

function restorePlayingRoomTimers(roomCode, room) {
    room.currentRoundMatches.forEach(match => {
        if (match.winner || match.isBye || match.currentSeed === null) return;
        const remaining = (match.deadlineAt || 0) - Date.now();
        if (remaining > 0) {
            match.timerId = setTimeout(() => handlePuzzleTimeout(roomCode, match), remaining);
        } else {
            handlePuzzleTimeout(roomCode, match);
        }
    });
}

function launchRoundMatches(room, roomCode) {
    room.currentRoundMatches.forEach(match => {
        if (!match.isBye) {
            match.roundMode = 'regular';
            match.drawStreak = 0;
            match.puzzleRound = 1;
            match.ropePosition = 0;
            assignNextPuzzle(match, roomCode, { silent: true });
            const base = {
                level: room.level, winScore: room.winScore,
                ropePosition: 0, puzzleRound: match.puzzleRound,
                puzzleSeed: match.currentSeed, roundMode: match.roundMode,
                timeLimitMs: match.timeLimitMs, deadlineAt: match.deadlineAt
            };
            emitToToken(match.p1.token, 'gameStart', { ...base, isP1: true, opponentName: match.p2.name });
            emitToToken(match.p2.token, 'gameStart', { ...base, isP1: false, opponentName: match.p1.name });
        } else {
            emitToToken(match.p1.token, 'byeMatch');
        }
    });
    persistRoom(roomCode);
}

function startNewRound(room, roomCode) {
    generateNextRound(room);
    io.to(roomCode).emit('showBracket', buildBracketPayload(room));
    persistRoom(roomCode);

    runCountdown(roomCode, ROUND_START_COUNTDOWN, 'roundCountdown', () => {
        launchRoundMatches(room, roomCode);
    });
}

io.on('connection', (socket) => {
    socket.emit('updateLeaderboard', leaderboard);

    socket.on('reconnectUser', async (data) => {
        const roomCode = normalizeRoomCode(data.roomCode);
        if (!/^\d{4}$/.test(roomCode)) {
            socket.emit('reconnectFailed');
            return;
        }

        const room = await ensureRoom(roomCode);
        if (!room) {
            socket.emit('reconnectFailed');
            return;
        }
        const player = room.players.find(p => p.token === data.token);
        if (!player) {
            socket.emit('reconnectFailed');
            return;
        }

        clearPlayerDisconnectTimer(player);
        player.id = socket.id;
        joinPlayerChannels(socket, data.token, roomCode);

        if (room.status === 'waiting' || room.status === 'countdown') {
            socket.emit('roomCreated', {
                roomCode, isHost: room.hostToken === data.token,
                maxPlayers: MAX_PLAYERS, playerCount: room.players.length
            });
            emitWaitingRoomUpdate(roomCode, room);
        } else if (room.status === 'playing') {
            let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
            if (match && !match.winner && !match.isBye && match.currentSeed !== null) {
                let isP1 = match.p1.token === data.token;
                socket.emit('gameStart', {
                    level: room.level, winScore: room.winScore,
                    puzzleSeed: match.currentSeed, puzzleRound: match.puzzleRound, ropePosition: match.ropePosition,
                    isP1: isP1, opponentName: (isP1 ? match.p2 : match.p1)?.name || '---',
                    roundMode: match.roundMode || 'regular',
                    timeLimitMs: match.timeLimitMs || REGULAR_PUZZLE_TIME_MS,
                    deadlineAt: match.deadlineAt || null
                });
            } else {
                socket.emit('showBracket', buildBracketPayload(room));
            }
        }
    });

    socket.on('leaveRoom', (data) => {
        const rCode = normalizeRoomCode(data.roomCode);
        const room = rooms[rCode];
        if (!room) return;
        if (room.hostToken === data.token) {
            io.to(rCode).emit('errorMsg', 'Chủ phòng đã hủy giải đấu!');
            io.to(rCode).emit('roomDestroyed');
            removeRoom(rCode);
        } else {
            clearPlayerDisconnectTimer(room.players.find(p => p.token === data.token));
            room.players = room.players.filter(p => p.token !== data.token);
            persistRoom(rCode);
            emitWaitingRoomUpdate(rCode, room);
        }
    });

    socket.on('createRoom', async (settings, callback) => {
        const ack = typeof callback === 'function' ? callback : () => {};
        const playerName = (settings.playerName || '').trim();
        if (!playerName) {
            const err = 'Vui lòng nhập tên của bạn!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        let roomCode;
        let attempts = 0;
        do {
            roomCode = Math.floor(1000 + Math.random() * 9000).toString();
            attempts++;
        } while ((rooms[roomCode] || await fetchRoomFromFirebase(roomCode)) && attempts < 50);

        let winScore = parseInt(settings.winScore) || 3;
        if (winScore < 3) winScore = 3;
        if (winScore > 10) winScore = 10;

        rooms[roomCode] = {
            roomCode,
            hostToken: settings.token,
            players: [{ id: socket.id, token: settings.token, name: playerName }],
            activePlayers: [],
            bracket: [],
            currentRoundMatches: [],
            eliminationOrder: [],
            level: settings.level,
            winScore: winScore,
            status: 'waiting'
        };
        joinPlayerChannels(socket, settings.token, roomCode);
        await persistRoom(roomCode);
        socket.emit('roomCreated', {
            roomCode, isHost: true,
            maxPlayers: MAX_PLAYERS, playerCount: 1
        });
        emitWaitingRoomUpdate(roomCode, rooms[roomCode]);
        console.log(`🏠 Giải đấu [${roomCode}] được tạo bởi ${playerName}.`);
        ack({ ok: true, roomCode, isHost: true, playerCount: 1, maxPlayers: MAX_PLAYERS });
    });

    socket.on('joinRoom', async (data, callback) => {
        const roomCode = normalizeRoomCode(data.roomCode);
        const playerName = (data.playerName || '').trim();
        const ack = typeof callback === 'function' ? callback : () => {};

        if (!/^\d{4}$/.test(roomCode)) {
            const err = 'Mã phòng phải có đúng 4 chữ số!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }
        if (!playerName) {
            const err = 'Vui lòng nhập tên của bạn!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        let room = await ensureRoom(roomCode);
        if (!room) {
            await new Promise(r => setTimeout(r, 400));
            room = await ensureRoom(roomCode);
        }

        if (!room) {
            const err = 'Không tìm thấy mã phòng. Kiểm tra lại 4 chữ số hoặc nhờ chủ giải chia sẻ mã mới!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        if (room.status !== 'waiting' && room.status !== 'countdown') {
            const err = 'Giải đấu đã bắt đầu — không thể vào phòng lúc này. Hãy vào trước khi chủ giải bấm Bắt Đầu!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        const existingPlayer = room.players.find(p => p.token === data.token);

        if (isNameTaken(room, playerName, data.token)) {
            const err = 'Tên này đã có người khác dùng trong phòng. Hãy thêm số hoặc ký tự (vd: Minh2)!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        if (!existingPlayer && room.players.length >= MAX_PLAYERS) {
            const err = `Phòng đã đủ ${MAX_PLAYERS} người!`;
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        if (existingPlayer) {
            clearPlayerDisconnectTimer(existingPlayer);
            existingPlayer.id = socket.id;
            existingPlayer.name = playerName;
        } else {
            room.players.push({ id: socket.id, token: data.token, name: playerName });
        }

        joinPlayerChannels(socket, data.token, roomCode);
        await persistRoom(roomCode);
        const roomPayload = {
            roomCode, isHost: room.hostToken === data.token,
            maxPlayers: MAX_PLAYERS, playerCount: room.players.length
        };
        socket.emit('roomCreated', roomPayload);
        emitWaitingRoomUpdate(roomCode, room);
        console.log(`✅ [${playerName}] vào phòng [${roomCode}] (${room.players.length}/${MAX_PLAYERS})`);
        ack({ ok: true, ...roomPayload });
    });

    socket.on('startTournament', (data) => {
        const roomCode = normalizeRoomCode(typeof data === 'object' ? data.roomCode : data);
        const token = typeof data === 'object' ? data.token : null;
        const room = rooms[roomCode];
        if (!room || room.status !== 'waiting') return;

        const player = token
            ? room.players.find(p => p.token === token)
            : room.players.find(p => p.id === socket.id);
        if (!player || room.hostToken !== player.token) return;
        if (room.players.length < 2) {
            socket.emit('waitNotice', 'Cần ít nhất 2 người để bắt đầu giải!');
            return;
        }

        player.id = socket.id;
        joinPlayerChannels(socket, player.token, roomCode);
        room.status = 'countdown';
        room.initialPlayerCount = room.players.length;
        room.eliminationOrder = [];
        room.activePlayers = [...room.players].sort(() => Math.random() - 0.5);
        persistRoom(roomCode);

        runCountdown(roomCode, TOURNAMENT_START_COUNTDOWN, 'tournamentCountdown', () => {
            room.status = 'playing';
            persistRoom(roomCode);
            startNewRound(room, roomCode);
        });
    });

    socket.on('watchMatch', (data) => {
        const room = rooms[normalizeRoomCode(data.roomCode)];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.id === data.matchId);
        if (match && !match.isBye && !match.winner) {
            socket.join('watch_' + match.id);
            socket.emit('spectateStart', {
                level: room.level, winScore: room.winScore, puzzleSeed: match.currentSeed,
                puzzleRound: match.puzzleRound, ropePosition: match.ropePosition,
                p1Name: match.p1.name, p2Name: match.p2.name,
                roundMode: match.roundMode || 'regular',
                timeLimitMs: match.timeLimitMs || REGULAR_PUZZLE_TIME_MS,
                deadlineAt: match.deadlineAt || null
            });
        }
    });

    socket.on('solved_puzzle', (data) => {
        const rCode = normalizeRoomCode(data.roomCode);
        const room = rooms[rCode];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner || match.puzzleRound !== data.puzzleRound) return;

        clearMatchTimer(match);
        if (data.token === match.p1.token) match.hadMoveP1 = true;
        else if (data.token === match.p2.token) match.hadMoveP2 = true;
        match.puzzleRound++;

        if (match.roundMode === 'sudden_death') {
            match.drawStreak = 0;
            const winner = data.token === match.p1.token ? match.p1 : match.p2;
            resolveMatchWinner(room, rCode, match, winner, 'Sudden Death: giải đúng trước và chiến thắng!');
            return;
        }

        if (data.token === match.p1.token) match.ropePosition -= 1;
        else if (data.token === match.p2.token) match.ropePosition += 1;

        let matchOver = false;
        if (match.ropePosition <= -room.winScore) { match.winner = match.p1; matchOver = true; }
        else if (match.ropePosition >= room.winScore) { match.winner = match.p2; matchOver = true; }

        if (matchOver) {
            match.drawStreak = 0;
            resolveMatchWinner(room, rCode, match, match.winner, 'Đã đạt mốc kéo dây.');
        } else {
            match.drawStreak = 0;
            assignNextPuzzle(match, rCode, { mode: 'regular' });
        }
    });

    socket.on('playerMistake', (data) => {
        const rCode = normalizeRoomCode(data.roomCode);
        const room = rooms[rCode];
        if (!room) return;
        const match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner || match.puzzleRound !== data.puzzleRound || match.roundMode !== 'sudden_death') return;

        if (data.token === match.p1.token) {
            match.hadMoveP1 = true;
            resolveMatchWinner(room, rCode, match, match.p2, 'Sudden Death: đối thủ đi sai nước và thua ngay!');
        } else {
            match.hadMoveP2 = true;
            resolveMatchWinner(room, rCode, match, match.p1, 'Sudden Death: đối thủ đi sai nước và thua ngay!');
        }
    });

    socket.on('sendEmoji', (data) => {
        const room = rooms[normalizeRoomCode(data.roomCode)];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner) return;
        const opponentToken = data.token === match.p1.token ? match.p2.token : match.p1.token;
        emitToToken(opponentToken, 'receiveEmoji', data.emoji);
    });

    socket.on('disconnect', () => {
        for (const [code, room] of Object.entries(rooms)) {
            if (room.status !== 'waiting') continue;
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                scheduleWaitingRoomDisconnect(code, room, player, socket.id);
                break;
            }
        }
    });
});

loadPuzzleCache();

loadRoomsFromFirebase().then(() => {
    server.listen(process.env.PORT || 3000, () => {
        console.log(`🚀 Server chạy! (tối đa ${MAX_PLAYERS} người/giải, Admin SDK: ${isUsingAdmin() ? 'ON' : 'OFF'})`);
    });
});
