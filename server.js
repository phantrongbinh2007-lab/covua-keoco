const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { init: initFirebase, dbGet, dbSet, dbRemove, isUsingAdmin } = require('./firebaseDb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use('/vendor/chessground', express.static(
    path.join(__dirname, 'node_modules', '@lichess-org', 'chessground')
));

initFirebase();

const rooms = {};
const playerRegistry = {};
const MAX_PLAYERS = 64;
const WAITING_DISCONNECT_GRACE_MS = 60 * 1000;
const PLAYING_DISCONNECT_GRACE_MS = 45 * 1000;
const TOURNAMENT_START_COUNTDOWN = 10;
const ROUND_START_COUNTDOWN = 5;
const REGULAR_PUZZLE_TIME_MS = 60 * 1000;
const SUDDEN_DEATH_TIME_MS = 30 * 1000;
const MAX_REGULAR_DRAWS = 3;
const MAX_NAME_LENGTH = 15;

let leaderboard = {
    daily: {},
    weekly: {},
    monthly: {},
    periods: { daily: null, weekly: null, monthly: null }
};
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

app.get('/api/matches/:id', async (req, res) => {
    try {
        const log = await dbGet(`matchLogs/${req.params.id}`);
        if (!log) return res.status(404).json({ error: 'Không tìm thấy nhật ký trận.' });
        res.json(log);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/player/:token', (req, res) => {
    const profile = playerRegistry[req.params.token];
    if (!profile) return res.status(404).json({ error: 'Chưa đăng ký' });
    res.json({
        name: profile.name,
        shortId: shortPlayerId(req.params.token),
        locked: true
    });
});

dbGet('leaderboard').then((data) => {
    if (data) {
        leaderboard = normalizeLeaderboard(data);
        console.log('☁️ Đã tải Bảng Xếp Hạng từ Firebase!');
    }
    ensureLeaderboardPeriods(true);
}).catch((error) => { console.error('❌ Lỗi Firebase leaderboard:', error.message); });

dbGet('players').then((data) => {
    if (data && typeof data === 'object') {
        Object.assign(playerRegistry, data);
        console.log(`☁️ Đã tải ${Object.keys(playerRegistry).length} hồ sơ kỳ thủ`);
    }
}).catch((error) => { console.error('❌ Lỗi Firebase players:', error.message); });

setInterval(() => ensureLeaderboardPeriods(), 60 * 1000);

function getPeriodKeys(date = new Date()) {
    const vn = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    const y = vn.getUTCFullYear();
    const m = String(vn.getUTCMonth() + 1).padStart(2, '0');
    const d = String(vn.getUTCDate()).padStart(2, '0');
    const daily = `${y}-${m}-${d}`;
    const monthly = `${y}-${m}`;

    const tmp = new Date(Date.UTC(y, vn.getUTCMonth(), vn.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const weekYear = tmp.getUTCFullYear();
    const yearStart = new Date(Date.UTC(weekYear, 0, 1));
    const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    const weekly = `${weekYear}-W${String(week).padStart(2, '0')}`;
    return { daily, weekly, monthly };
}

function normalizeLeaderboard(data) {
    return {
        daily: data.daily || {},
        weekly: data.weekly || {},
        monthly: data.monthly || {},
        periods: {
            daily: (data.periods && data.periods.daily) || null,
            weekly: (data.periods && data.periods.weekly) || null,
            monthly: (data.periods && data.periods.monthly) || null
        }
    };
}

function publicLeaderboard() {
    ensureLeaderboardPeriods();
    return {
        daily: leaderboard.daily,
        weekly: leaderboard.weekly,
        monthly: leaderboard.monthly,
        periods: { ...leaderboard.periods }
    };
}

function ensureLeaderboardPeriods(forceSave = false) {
    if (!leaderboard.periods) leaderboard.periods = { daily: null, weekly: null, monthly: null };
    if (!leaderboard.daily) leaderboard.daily = {};
    if (!leaderboard.weekly) leaderboard.weekly = {};
    if (!leaderboard.monthly) leaderboard.monthly = {};

    const keys = getPeriodKeys();
    let changed = false;

    if (leaderboard.periods.daily !== keys.daily) {
        leaderboard.daily = {};
        leaderboard.periods.daily = keys.daily;
        changed = true;
        console.log(`🔄 Reset BXH ngày → ${keys.daily}`);
    }
    if (leaderboard.periods.weekly !== keys.weekly) {
        leaderboard.weekly = {};
        leaderboard.periods.weekly = keys.weekly;
        changed = true;
        console.log(`🔄 Reset BXH tuần → ${keys.weekly}`);
    }
    if (leaderboard.periods.monthly !== keys.monthly) {
        leaderboard.monthly = {};
        leaderboard.periods.monthly = keys.monthly;
        changed = true;
        console.log(`🔄 Reset BXH tháng → ${keys.monthly}`);
    }

    if (changed || forceSave) saveLeaderboard();
    return changed;
}

function saveLeaderboard() {
    dbSet('leaderboard', leaderboard).catch(console.error);
    io.emit('updateLeaderboard', publicLeaderboard());
}

function addScore(playerName, points) {
    ensureLeaderboardPeriods();
    leaderboard.daily[playerName] = (leaderboard.daily[playerName] || 0) + points;
    leaderboard.weekly[playerName] = (leaderboard.weekly[playerName] || 0) + points;
    leaderboard.monthly[playerName] = (leaderboard.monthly[playerName] || 0) + points;
    saveLeaderboard();
}

function shortPlayerId(token) {
    if (!token) return '------';
    return String(token).slice(0, 6).toLowerCase();
}

function sanitizePlayerName(raw) {
    return String(raw || '').trim().slice(0, MAX_NAME_LENGTH);
}

function savePlayerRegistry(token) {
    if (!token || !playerRegistry[token]) return;
    dbSet(`players/${token}`, playerRegistry[token]).catch(console.error);
}

function resolvePlayerIdentity(token, requestedName) {
    const name = sanitizePlayerName(requestedName);
    if (!token) return { ok: false, error: 'Thiếu mã định danh kỳ thủ.' };
    if (!name) return { ok: false, error: 'Vui lòng nhập tên của bạn!' };

    const existing = playerRegistry[token];
    if (existing && existing.name) {
        return {
            ok: true,
            name: existing.name,
            shortId: shortPlayerId(token),
            nameLocked: true,
            renamed: existing.name !== name
        };
    }

    const takenByOther = Object.entries(playerRegistry).some(
        ([t, p]) => t !== token && p.name && p.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (takenByOther) {
        return { ok: false, error: 'Tên này đã được đăng ký bởi kỳ thủ khác. Hãy chọn tên khác!' };
    }

    playerRegistry[token] = {
        name,
        createdAt: Date.now(),
        lastSeenAt: Date.now()
    };
    savePlayerRegistry(token);
    return { ok: true, name, shortId: shortPlayerId(token), nameLocked: true, renamed: false };
}

function touchPlayer(token) {
    if (!token || !playerRegistry[token]) return;
    playerRegistry[token].lastSeenAt = Date.now();
    savePlayerRegistry(token);
}

function getPuzzleForMatch(room, match) {
    const list = puzzleCache[Number(room.level)];
    if (!list || !list.length || match.currentSeed == null) return null;
    return list[match.currentSeed % list.length];
}

function normalizeMoveUci(move) {
    return String(move || '').toLowerCase();
}

function isMoveAllowed(expected, actual) {
    const options = Array.isArray(expected) ? expected : [expected];
    const actualNorm = normalizeMoveUci(actual);
    return options.some(o => normalizeMoveUci(o) === actualNorm);
}

function countPlayerMovesInSolution(solution) {
    if (!Array.isArray(solution)) return 0;
    let count = 0;
    for (let i = 1; i < solution.length; i += 2) count++;
    return count;
}

function getExpectedPlayerMove(puzzle, playerMoveIndex) {
    const solutionIndex = playerMoveIndex * 2 + 1;
    if (!puzzle || !puzzle.solution || solutionIndex >= puzzle.solution.length) return null;
    return puzzle.solution[solutionIndex];
}

function initMatchProgress(match) {
    match.progress = {};
    if (match.p1?.token) match.progress[match.p1.token] = [];
    if (match.p2?.token) match.progress[match.p2.token] = [];
}

function initMatchLog(match, room) {
    match.log = {
        matchId: match.id,
        roomCode: room.roomCode,
        level: room.level,
        winScore: room.winScore,
        p1: match.p1 ? { token: match.p1.token, name: match.p1.name, shortId: shortPlayerId(match.p1.token) } : null,
        p2: match.p2 ? { token: match.p2.token, name: match.p2.name, shortId: shortPlayerId(match.p2.token) } : null,
        startedAt: Date.now(),
        endedAt: null,
        winner: null,
        reason: null,
        puzzles: [],
        events: []
    };
}

function appendMatchEvent(match, event) {
    if (!match.log) return;
    match.log.events.push({ t: Date.now(), ...event });
}

function startPuzzleLog(match) {
    if (!match.log) return;
    match.log.puzzles.push({
        seed: match.currentSeed,
        round: match.puzzleRound,
        mode: match.roundMode || 'regular',
        startedAt: Date.now(),
        endedAt: null,
        solvedBy: null,
        moves: {},
        outcome: null
    });
}

function currentPuzzleLog(match) {
    if (!match.log || !match.log.puzzles.length) return null;
    return match.log.puzzles[match.log.puzzles.length - 1];
}

function finishPuzzleLog(match, outcome, solvedByToken) {
    const entry = currentPuzzleLog(match);
    if (!entry) return;
    entry.endedAt = Date.now();
    entry.outcome = outcome;
    entry.solvedBy = solvedByToken || null;
    if (match.progress) {
        entry.moves = { ...match.progress };
    }
}

async function persistMatchLog(match) {
    if (!match?.log) return;
    try {
        await dbSet(`matchLogs/${match.id}`, match.log);
    } catch (err) {
        console.error(`❌ Lưu match log [${match.id}]:`, err.message);
    }
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
        scoreP1: 0, scoreP2: 0,
        puzzleRound: 1, currentSeed: null, isBye: false,
        progress: {}, log: null
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

function pairPlayersIntoMatches(players, { allowBye = true } = {}) {
    const shuffled = shuffleArray(players);
    const matches = [];
    let idx = 0;
    while (idx + 1 < shuffled.length) {
        matches.push(makeMatch(shuffled[idx], shuffled[idx + 1]));
        idx += 2;
    }
    if (idx < shuffled.length && allowBye) {
        matches.push(makeByeMatch(shuffled[idx]));
    }
    return matches;
}

function generateNextRound(room) {
    const players = [...room.activePlayers];
    const n = players.length;
    let matches = [];
    const isFirstRound = room.bracket.length === 0;

    if (n <= 0) {
        room.currentRoundMatches = [];
        return;
    }

    if (n === 1) {
        // Không tạo vòng "đặc cách" chỉ để crowning — caller sẽ kết thúc giải.
        room.currentRoundMatches = [];
        return;
    }

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
            // Người lẻ còn lại (edge case) cũng được đặc cách, không bị bỏ sót.
            if (playingPlayers.length % 2 === 1) {
                matches.push(makeByeMatch(playingPlayers[playingPlayers.length - 1]));
            }
            matches = shuffleArray(matches);
        } else {
            matches = pairPlayersIntoMatches(players, { allowBye: false });
        }
    } else {
        // Vòng sau: chỉ bye khi số người lẻ (ví dụ đồng thua làm lệch bracket).
        matches = pairPlayersIntoMatches(players, { allowBye: true });
    }

    room.currentRoundMatches = matches;
    room.bracket.push(matches);
}

function serializeMatch(match) {
    if (!match) return match;
    const { timerId, ...rest } = match;
    if (rest.winner && !rest.settled) rest.settled = true;
    return rest;
}

function serializeRoom(room) {
    // Khi còn cùng reference, lưu một lần rồi dùng lại để tránh lệch dữ liệu.
    const bracket = (room.bracket || []).map(round => round.map(serializeMatch));
    const lastRound = bracket.length ? bracket[bracket.length - 1] : [];
    const currentIsLast =
        room.currentRoundMatches &&
        room.bracket &&
        room.bracket.length &&
        room.currentRoundMatches === room.bracket[room.bracket.length - 1];

    return {
        roomCode: room.roomCode,
        hostToken: room.hostToken,
        players: room.players.map(p => ({
            id: p.id, token: p.token, name: p.name, compete: p.compete !== false
        })),
        activePlayers: (room.activePlayers || []).map(p => ({
            id: p.id, token: p.token, name: p.name, compete: p.compete !== false
        })),
        bracket,
        currentRoundMatches: currentIsLast
            ? lastRound
            : (room.currentRoundMatches || []).map(serializeMatch),
        level: room.level,
        winScore: room.winScore,
        status: room.status,
        initialPlayerCount: room.initialPlayerCount || 0,
        eliminationOrder: room.eliminationOrder || [],
        savedAt: Date.now()
    };
}

function hydrateMatch(m) {
    return {
        ...m,
        timerId: null,
        settled: !!(m && (m.settled || m.winner))
    };
}

function deserializeRoom(code, data) {
    const bracket = (data.bracket || []).map(round => round.map(hydrateMatch));
    let currentRoundMatches = (data.currentRoundMatches || []).map(hydrateMatch);

    // Giữ cùng reference với vòng hiện tại để winner cập nhật không bị lệch UI bracket.
    if (bracket.length > 0) {
        const lastRound = bracket[bracket.length - 1];
        const liveById = new Map(currentRoundMatches.map(m => [m.id, m]));
        for (let i = 0; i < lastRound.length; i++) {
            const live = liveById.get(lastRound[i].id);
            if (live) {
                lastRound[i] = hydrateMatch({ ...lastRound[i], ...live });
            }
        }
        currentRoundMatches = lastRound;
    }

    return {
        ...data,
        roomCode: code,
        players: (data.players || []).map(p => ({ ...p, disconnectTimer: null })),
        activePlayers: data.activePlayers || [],
        bracket,
        eliminationOrder: data.eliminationOrder || [],
        currentRoundMatches,
        advanceTimer: null
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
    const room = rooms[roomCode];
    if (room) {
        clearAdvanceTimer(room);
        (room.currentRoundMatches || []).forEach(clearMatchTimer);
    }
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

function sanitizePlayers(players, hostToken) {
    return players.map(({ id, token, name, compete }) => ({
        id,
        token,
        name,
        shortId: shortPlayerId(token),
        compete: compete !== false,
        isHost: !!(hostToken && token === hostToken)
    }));
}

function getCompetitors(room) {
    return (room.players || []).filter(p => p && p.compete !== false);
}

function emitWaitingRoomUpdate(roomCode, room) {
    const competitors = getCompetitors(room);
    io.to(roomCode).emit('updateWaitingRoom', {
        players: sanitizePlayers(room.players, room.hostToken),
        maxPlayers: MAX_PLAYERS,
        competitorCount: competitors.length,
        hostToken: room.hostToken
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

function findActiveMatchForPlayer(room, token) {
    return room.currentRoundMatches.find(m =>
        !m.winner && !m.isBye && (m.p1?.token === token || m.p2?.token === token)
    ) || null;
}

function schedulePlayingDisconnectForfeit(roomCode, room, player, socketId) {
    clearPlayerDisconnectTimer(player);
    const token = player.token;
    const playerName = player.name;
    const match = findActiveMatchForPlayer(room, token);

    if (match) {
        const opponent = match.p1.token === token ? match.p2 : match.p1;
        if (opponent?.token) {
            emitToToken(opponent.token, 'opponentDisconnected', {
                name: playerName,
                graceMs: PLAYING_DISCONNECT_GRACE_MS
            });
        }
        appendMatchEvent(match, { type: 'disconnect', token, name: playerName });
    }

    player.disconnectTimer = setTimeout(() => {
        if (!rooms[roomCode] || room.status !== 'playing') return;
        const p = room.players.find(x => x.token === token);
        if (!p || p.id !== socketId) return;

        const activeMatch = findActiveMatchForPlayer(room, token);
        if (!activeMatch || !activeMatch.p1 || !activeMatch.p2) return;

        const winner = activeMatch.p1.token === token ? activeMatch.p2 : activeMatch.p1;
        finishPuzzleLog(activeMatch, 'forfeit_disconnect', null);
        appendMatchEvent(activeMatch, {
            type: 'forfeit',
            token,
            name: playerName,
            reason: 'disconnect_timeout'
        });
        resolveMatchWinner(
            room,
            roomCode,
            activeMatch,
            winner,
            `${playerName} mất kết nối quá lâu — đối thủ thắng.`
        );
    }, PLAYING_DISCONNECT_GRACE_MS);
}

async function finishTournament(room, roomCode, championName) {
    const results = buildTournamentResults(room, championName);
    await saveTournamentResults(results);
    io.to(roomCode).emit('tournamentOver', results);
    removeRoom(roomCode);
}

function clearAdvanceTimer(room) {
    if (room.advanceTimer) {
        clearTimeout(room.advanceTimer);
        room.advanceTimer = null;
    }
}

function scheduleNextRound(room, roomCode) {
    clearAdvanceTimer(room);
    room.advanceTimer = setTimeout(() => {
        room.advanceTimer = null;
        if (!rooms[roomCode] || rooms[roomCode] !== room) return;
        startNewRound(room, roomCode);
    }, 2000);
}

function checkAndAdvanceTournament(room, roomCode) {
    io.to(roomCode).emit('updateBracketOnly', buildBracketPayload(room));
    persistRoom(roomCode);

    if (!room.currentRoundMatches.length) return;
    if (!room.currentRoundMatches.every(m => m.winner !== null)) return;

    room.currentRoundMatches.forEach(clearMatchTimer);
    room.activePlayers = room.currentRoundMatches
        .map(m => (m.winner && !m.winner.isDoubleLoss ? m.winner : null))
        .filter(Boolean);

    if (room.activePlayers.length === 1) {
        // Còn 1 người = vô địch. Không tạo vòng đặc cách thừa.
        clearAdvanceTimer(room);
        addScore(room.activePlayers[0].name, 10);
        finishTournament(room, roomCode, room.activePlayers[0].name);
    } else if (room.activePlayers.length > 1) {
        scheduleNextRound(room, roomCode);
    } else {
        clearAdvanceTimer(room);
        finishTournament(room, roomCode, 'Không có nhà vô địch (đồng thua)');
    }
}

function resolveMatchWinner(room, roomCode, match, winner, reasonMessage) {
    // Dùng settled (không check winner): decideDoubleLoss gán winner trước khi gọi hàm này.
    if (!match || match.settled) return;
    match.settled = true;
    clearMatchTimer(match);
    match.winner = winner;

    if (match.p1 && match.p2 && !winner.isDoubleLoss) {
        const loser = winner.token === match.p1.token ? match.p2 : match.p1;
        recordElimination(room, loser);
    }

    if (!winner.isDoubleLoss) addScore(winner.name, 2);

    if (match.log) {
        match.log.endedAt = Date.now();
        match.log.winner = winner.isDoubleLoss
            ? { name: winner.name, isDoubleLoss: true }
            : { token: winner.token, name: winner.name, shortId: shortPlayerId(winner.token) };
        match.log.reason = reasonMessage;
        appendMatchEvent(match, {
            type: 'match_end',
            winner: match.log.winner,
            reason: reasonMessage
        });
        persistMatchLog(match);
    }

    const payload = {
        winner: winner.name,
        bracket: buildBracketPayload(room),
        reason: reasonMessage,
        isDoubleLoss: !!winner.isDoubleLoss,
        matchId: match.id,
        hasReplay: !!match.log
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
        finishPuzzleLog(match, 'timeout_double_loss', null);
        decideDoubleLoss(match);
        resolveMatchWinner(room, roomCode, match, match.winner, 'Hết giờ Sudden Death: đồng thua.');
        return;
    }

    match.drawStreak = (match.drawStreak || 0) + 1;
    finishPuzzleLog(match, 'timeout_draw', null);
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
    match.currentSeed = crypto.randomInt(0, 1000000);
    match.deadlineAt = Date.now() + timeLimitMs;
    match.hadMoveP1 = false;
    match.hadMoveP2 = false;
    initMatchProgress(match);
    startPuzzleLog(match);
    appendMatchEvent(match, {
        type: 'puzzle_start',
        seed: match.currentSeed,
        round: match.puzzleRound,
        mode
    });

    match.timerId = setTimeout(() => {
        handlePuzzleTimeout(roomCode, match);
    }, timeLimitMs);

    persistRoom(roomCode);

    if (!options.silent) {
        const payload = {
            ropePosition: match.ropePosition,
            scoreP1: match.scoreP1 || 0,
            scoreP2: match.scoreP2 || 0,
            winScore: room.winScore,
            puzzleSeed: match.currentSeed,
            puzzleRound: match.puzzleRound,
            roundMode: match.roundMode,
            timeLimitMs: match.timeLimitMs,
            deadlineAt: match.deadlineAt,
            lastScorer: options.lastScorer || null,
            scoredSide: options.scoredSide || null
        };
        if (options.message) payload.message = options.message;
        const event = options.payloadType || 'update_game';
        if (match.p1?.token) emitToToken(match.p1.token, event, payload);
        if (match.p2?.token) emitToToken(match.p2.token, event, payload);
        io.to('watch_' + match.id).emit(event, payload);
    }
}

function applySolvedPuzzle(room, roomCode, match, token) {
    clearMatchTimer(match);
    if (token === match.p1.token) match.hadMoveP1 = true;
    else if (token === match.p2.token) match.hadMoveP2 = true;

    finishPuzzleLog(match, 'solved', token);
    appendMatchEvent(match, { type: 'solved', token, puzzleRound: match.puzzleRound });
    match.puzzleRound++;

    if (match.roundMode === 'sudden_death') {
        match.drawStreak = 0;
        const winner = token === match.p1.token ? match.p1 : match.p2;
        resolveMatchWinner(room, roomCode, match, winner, 'Sudden Death: giải đúng trước và chiến thắng!');
        return;
    }

    const scoredSide = token === match.p1.token ? 'p1' : 'p2';
    if (scoredSide === 'p1') {
        match.scoreP1 = (match.scoreP1 || 0) + 1;
        match.ropePosition -= 1;
    } else {
        match.scoreP2 = (match.scoreP2 || 0) + 1;
        match.ropePosition += 1;
    }

    let matchOver = false;
    if (match.ropePosition <= -room.winScore) { match.winner = match.p1; matchOver = true; }
    else if (match.ropePosition >= room.winScore) { match.winner = match.p2; matchOver = true; }

    if (matchOver) {
        match.drawStreak = 0;
        if (match.p1?.token) {
            emitToToken(match.p1.token, 'scoreUpdate', {
                scoreP1: match.scoreP1, scoreP2: match.scoreP2,
                ropePosition: match.ropePosition, winScore: room.winScore,
                lastScorer: token, scoredSide
            });
        }
        if (match.p2?.token) {
            emitToToken(match.p2.token, 'scoreUpdate', {
                scoreP1: match.scoreP1, scoreP2: match.scoreP2,
                ropePosition: match.ropePosition, winScore: room.winScore,
                lastScorer: token, scoredSide
            });
        }
        io.to('watch_' + match.id).emit('scoreUpdate', {
            scoreP1: match.scoreP1, scoreP2: match.scoreP2,
            ropePosition: match.ropePosition, winScore: room.winScore,
            lastScorer: token, scoredSide
        });
        resolveMatchWinner(room, roomCode, match, match.winner, 'Đã đạt mốc kéo dây.');
    } else {
        match.drawStreak = 0;
        assignNextPuzzle(match, roomCode, {
            mode: 'regular',
            lastScorer: token,
            scoredSide,
            message: scoredSide === 'p1'
                ? `${match.p1.name} giải xong! Dây lệch về phía họ.`
                : `${match.p2.name} giải xong! Dây lệch về phía họ.`
        });
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
            match.scoreP1 = 0;
            match.scoreP2 = 0;
            initMatchLog(match, room);
            assignNextPuzzle(match, roomCode, { silent: true });
            const base = {
                level: room.level, winScore: room.winScore,
                ropePosition: 0, scoreP1: 0, scoreP2: 0,
                puzzleRound: match.puzzleRound,
                puzzleSeed: match.currentSeed, roundMode: match.roundMode,
                timeLimitMs: match.timeLimitMs, deadlineAt: match.deadlineAt,
                matchId: match.id
            };
            emitToToken(match.p1.token, 'gameStart', { ...base, isP1: true, opponentName: match.p2.name });
            emitToToken(match.p2.token, 'gameStart', { ...base, isP1: false, opponentName: match.p1.name });
        } else {
            emitToToken(match.p1.token, 'byeMatch');
        }
    });
    persistRoom(roomCode);
    // Bye đã có winner sẵn — nếu cả vòng chỉ còn bye (hoặc vừa xong hết) thì tiến vòng.
    checkAndAdvanceTournament(room, roomCode);
}

function startNewRound(room, roomCode) {
    generateNextRound(room);
    if (!room.currentRoundMatches.length) {
        if (room.activePlayers.length === 1) {
            addScore(room.activePlayers[0].name, 10);
            finishTournament(room, roomCode, room.activePlayers[0].name);
        } else {
            finishTournament(room, roomCode, 'Không có nhà vô địch (đồng thua)');
        }
        return;
    }

    io.to(roomCode).emit('showBracket', buildBracketPayload(room));
    persistRoom(roomCode);

    runCountdown(roomCode, ROUND_START_COUNTDOWN, 'roundCountdown', () => {
        if (!rooms[roomCode] || rooms[roomCode] !== room) return;
        launchRoundMatches(room, roomCode);
    });
}

io.on('connection', (socket) => {
    socket.emit('updateLeaderboard', publicLeaderboard());

    socket.on('getPlayerProfile', (data, callback) => {
        const ack = typeof callback === 'function' ? callback : () => {};
        const token = data && data.token;
        const profile = token ? playerRegistry[token] : null;
        if (!profile) {
            ack({ ok: true, registered: false, shortId: shortPlayerId(token) });
            return;
        }
        ack({
            ok: true,
            registered: true,
            name: profile.name,
            shortId: shortPlayerId(token),
            nameLocked: true
        });
    });

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
        touchPlayer(data.token);
        joinPlayerChannels(socket, data.token, roomCode);

        if (room.status === 'playing') {
            const match = findActiveMatchForPlayer(room, data.token);
            if (match) {
                const opponent = match.p1.token === data.token ? match.p2 : match.p1;
                if (opponent?.token) {
                    emitToToken(opponent.token, 'opponentReconnected', { name: player.name });
                }
                appendMatchEvent(match, { type: 'reconnect', token: data.token, name: player.name });
            }
        }

        if (room.status === 'waiting' || room.status === 'countdown') {
            socket.emit('roomCreated', {
                roomCode, isHost: room.hostToken === data.token,
                maxPlayers: MAX_PLAYERS,
                playerCount: getCompetitors(room).length,
                competitorCount: getCompetitors(room).length,
                compete: player.compete !== false,
                shortId: shortPlayerId(data.token), playerName: player.name
            });
            emitWaitingRoomUpdate(roomCode, room);
        } else if (room.status === 'playing') {
            let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
            if (match && !match.winner && !match.isBye && match.currentSeed !== null) {
                let isP1 = match.p1.token === data.token;
                const progress = (match.progress && match.progress[data.token]) || [];
                socket.emit('gameStart', {
                    level: room.level, winScore: room.winScore,
                    puzzleSeed: match.currentSeed, puzzleRound: match.puzzleRound,
                    ropePosition: match.ropePosition,
                    scoreP1: match.scoreP1 || 0, scoreP2: match.scoreP2 || 0,
                    isP1: isP1, opponentName: (isP1 ? match.p2 : match.p1)?.name || '---',
                    roundMode: match.roundMode || 'regular',
                    timeLimitMs: match.timeLimitMs || REGULAR_PUZZLE_TIME_MS,
                    deadlineAt: match.deadlineAt || null,
                    matchId: match.id,
                    acceptedMoves: progress
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
        const identity = resolvePlayerIdentity(settings.token, settings.playerName);
        if (!identity.ok) {
            socket.emit('errorMsg', identity.error);
            ack({ ok: false, error: identity.error });
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

        // compete !== false: vừa tổ chức vừa đấu. false = chỉ ban tổ chức.
        const compete = settings.compete !== false && settings.compete !== 'false';

        rooms[roomCode] = {
            roomCode,
            hostToken: settings.token,
            players: [{
                id: socket.id,
                token: settings.token,
                name: identity.name,
                compete
            }],
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
        const competitorCount = compete ? 1 : 0;
        const roomPayload = {
            roomCode, isHost: true,
            maxPlayers: MAX_PLAYERS,
            playerCount: competitorCount,
            competitorCount,
            compete,
            shortId: identity.shortId, playerName: identity.name,
            nameLocked: true
        };
        socket.emit('roomCreated', roomPayload);
        emitWaitingRoomUpdate(roomCode, rooms[roomCode]);
        console.log(`🏠 Giải đấu [${roomCode}] tạo bởi ${identity.name} (#${identity.shortId}) — ${compete ? 'cũng tham gia đấu' : 'chỉ tổ chức'}.`);
        ack({ ok: true, ...roomPayload });
    });

    socket.on('joinRoom', async (data, callback) => {
        const roomCode = normalizeRoomCode(data.roomCode);
        const ack = typeof callback === 'function' ? callback : () => {};

        if (!/^\d{4}$/.test(roomCode)) {
            const err = 'Mã phòng phải có đúng 4 chữ số!';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        const identity = resolvePlayerIdentity(data.token, data.playerName);
        if (!identity.ok) {
            socket.emit('errorMsg', identity.error);
            ack({ ok: false, error: identity.error });
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

        if (isNameTaken(room, identity.name, data.token)) {
            const err = 'Tên đã đăng ký của bạn đang có người khác dùng trong phòng này. Liên hệ chủ giải.';
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        const competitorCount = getCompetitors(room).length;
        if (!existingPlayer && competitorCount >= MAX_PLAYERS) {
            const err = `Phòng đã đủ ${MAX_PLAYERS} kỳ thủ!`;
            socket.emit('errorMsg', err);
            ack({ ok: false, error: err });
            return;
        }

        if (existingPlayer) {
            clearPlayerDisconnectTimer(existingPlayer);
            existingPlayer.id = socket.id;
            existingPlayer.name = identity.name;
            // Giữ nguyên compete (host tổ chức-only không bị thành player khi reconnect)
        } else {
            room.players.push({
                id: socket.id,
                token: data.token,
                name: identity.name,
                compete: true
            });
        }

        touchPlayer(data.token);
        joinPlayerChannels(socket, data.token, roomCode);
        await persistRoom(roomCode);
        const me = room.players.find(p => p.token === data.token);
        const competitorsNow = getCompetitors(room).length;
        const roomPayload = {
            roomCode, isHost: room.hostToken === data.token,
            maxPlayers: MAX_PLAYERS,
            playerCount: competitorsNow,
            competitorCount: competitorsNow,
            compete: me ? me.compete !== false : true,
            shortId: identity.shortId, playerName: identity.name,
            nameLocked: true
        };
        socket.emit('roomCreated', roomPayload);
        emitWaitingRoomUpdate(roomCode, room);
        console.log(`✅ [${identity.name}#${identity.shortId}] vào phòng [${roomCode}] (${competitorsNow}/${MAX_PLAYERS} kỳ thủ)`);
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

        const competitors = getCompetitors(room);
        if (competitors.length < 2) {
            socket.emit('waitNotice', 'Cần ít nhất 2 kỳ thủ thi đấu (không tính ban tổ chức) để bắt đầu!');
            return;
        }

        player.id = socket.id;
        joinPlayerChannels(socket, player.token, roomCode);
        clearAdvanceTimer(room);
        room.status = 'countdown';
        room.initialPlayerCount = competitors.length;
        room.eliminationOrder = [];
        room.bracket = [];
        room.currentRoundMatches = [];
        room.activePlayers = shuffleArray(competitors);
        persistRoom(roomCode);

        runCountdown(roomCode, TOURNAMENT_START_COUNTDOWN, 'tournamentCountdown', () => {
            if (!rooms[roomCode] || rooms[roomCode] !== room) return;
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
                scoreP1: match.scoreP1 || 0, scoreP2: match.scoreP2 || 0,
                p1Name: match.p1.name, p2Name: match.p2.name,
                roundMode: match.roundMode || 'regular',
                timeLimitMs: match.timeLimitMs || REGULAR_PUZZLE_TIME_MS,
                deadlineAt: match.deadlineAt || null,
                matchId: match.id
            });
        }
    });

    socket.on('submit_move', (data, callback) => {
        const ack = typeof callback === 'function' ? callback : () => {};
        const rCode = normalizeRoomCode(data.roomCode);
        const room = rooms[rCode];
        if (!room) {
            ack({ ok: false, error: 'Không tìm thấy phòng.' });
            return;
        }

        const match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner || match.isBye) {
            ack({ ok: false, error: 'Trận không còn hiệu lực.' });
            return;
        }
        if (match.puzzleRound !== data.puzzleRound) {
            ack({ ok: false, error: 'Puzzle đã đổi — đồng bộ lại.' });
            return;
        }

        const puzzle = getPuzzleForMatch(room, match);
        if (!puzzle) {
            ack({ ok: false, error: 'Không tải được puzzle trên server.' });
            return;
        }

        if (!match.progress) initMatchProgress(match);
        if (!match.progress[data.token]) match.progress[data.token] = [];

        const playerMoves = match.progress[data.token];
        const expected = getExpectedPlayerMove(puzzle, playerMoves.length);
        if (expected == null) {
            ack({ ok: false, error: 'Đã hết nước cần giải.' });
            return;
        }

        const move = normalizeMoveUci(data.move);
        appendMatchEvent(match, {
            type: 'move_attempt',
            token: data.token,
            move,
            puzzleRound: match.puzzleRound,
            index: playerMoves.length
        });

        if (!isMoveAllowed(expected, move)) {
            if (match.roundMode === 'sudden_death') {
                finishPuzzleLog(match, 'mistake', data.token);
                const winner = data.token === match.p1.token ? match.p2 : match.p1;
                resolveMatchWinner(room, rCode, match, winner, 'Sudden Death: đối thủ đi sai nước và thua ngay!');
                ack({ ok: false, error: 'Sai nước — thua Sudden Death.', mistake: true, matchOver: true });
                return;
            }
            ack({ ok: false, error: 'Nước đi không đúng lời giải.' });
            return;
        }

        playerMoves.push(move);
        const totalNeeded = countPlayerMovesInSolution(puzzle.solution);
        const solved = playerMoves.length >= totalNeeded;

        if (solved) {
            applySolvedPuzzle(room, rCode, match, data.token);
            ack({ ok: true, solved: true });
            return;
        }

        persistRoom(rCode);
        ack({ ok: true, solved: false, acceptedCount: playerMoves.length });
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
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;

            if (room.status === 'waiting') {
                scheduleWaitingRoomDisconnect(code, room, player, socket.id);
            } else if (room.status === 'playing') {
                schedulePlayingDisconnectForfeit(code, room, player, socket.id);
            }
            break;
        }
    });
});

loadPuzzleCache();

loadRoomsFromFirebase().then(() => {
    server.listen(process.env.PORT || 3000, () => {
        console.log(`🚀 Server chạy! (tối đa ${MAX_PLAYERS} người/giải, Admin SDK: ${isUsingAdmin() ? 'ON' : 'OFF'})`);
    });
});
