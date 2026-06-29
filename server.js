const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get } = require('firebase/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ==========================================
// CẤU HÌNH FIREBASE 
const firebaseConfig = {
    apiKey: "AIzaSyAXiDlB_oTmQBhGTbM8FqWH_YuZnQSek1A",
    authDomain: "covua-keoco.firebaseapp.com",
    projectId: "covua-keoco",
    storageBucket: "covua-keoco.firebasestorage.app",
    messagingSenderId: "108598813612",
    appId: "1:108598813612:web:91fb8e057714769ecd1009",
    measurementId: "G-ZSGBNYGY1D",
    databaseURL: "https://covua-keoco-default-rtdb.asia-southeast1.firebasedatabase.app/"
};
// ==========================================

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const leaderboardRef = ref(db, 'leaderboard');

let leaderboard = { daily: {}, weekly: {}, monthly: {} };

get(leaderboardRef).then((snapshot) => {
    if (snapshot.exists() && snapshot.val()) {
        leaderboard = snapshot.val();
        console.log("☁️ Đã tải thành công Bảng Xếp Hạng từ Firebase!");
    } else {
        set(leaderboardRef, leaderboard);
    }
}).catch((error) => { console.error("❌ Lỗi Firebase:", error); });

function saveLeaderboard() {
    set(leaderboardRef, leaderboard).catch(console.error);
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

const rooms = {};
const REGULAR_PUZZLE_TIME_MS = 60 * 1000;
const SUDDEN_DEATH_TIME_MS = 30 * 1000;
const MAX_REGULAR_DRAWS = 3;

function normalizeRoomCode(code) {
    if (code == null) return '';
    return String(code).trim().replace(/\D/g, '');
}

function generateNextRound(room) {
    let players = room.activePlayers;
    let matches = [];
    let left = 0; let right = players.length - 1;

    while (left < right) {
        matches.push({
            id: Math.random().toString(36).substr(2, 9), p1: players[left], p2: players[right],
            winner: null, ropePosition: 0, puzzleRound: 1, currentSeed: null, isBye: false
        });
        left++; right--;
    }
    if (left === right) {
        matches.push({
            id: Math.random().toString(36).substr(2, 9), p1: players[left], p2: null,
            winner: players[left], ropePosition: 0, puzzleRound: 1, currentSeed: null, isBye: true
        });
    }
    room.currentRoundMatches = matches; room.bracket.push(matches);
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

io.on('connection', (socket) => {
    socket.emit('updateLeaderboard', leaderboard);

    socket.on('reconnectUser', (data) => {
        const roomCode = normalizeRoomCode(data.roomCode);
        if (!/^\d{4}$/.test(roomCode)) {
            socket.emit('reconnectFailed');
            return;
        }

        const room = rooms[roomCode];
        if (!room) {
            socket.emit('reconnectFailed');
            return;
        }
        const player = room.players.find(p => p.token === data.token);
        if (!player) {
            socket.emit('reconnectFailed');
            return;
        }

        player.id = socket.id;
        socket.join(roomCode);
        console.log(`🔄 Kỳ thủ [${player.name}] vừa Reconnect thành công vào phòng [${roomCode}]`);

        if (room.status === 'waiting') {
            socket.emit('roomCreated', { roomCode, isHost: room.hostToken === data.token });
            socket.emit('updateWaitingRoom', room.players);
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
            } else { socket.emit('showBracket', room.bracket); }
        }
    });

    socket.on('leaveRoom', (data) => {
        const rCode = String(data.roomCode).trim();
        const room = rooms[rCode];
        if (!room) return;
        if (room.hostToken === data.token) {
            io.to(rCode).emit('errorMsg', 'Chủ phòng đã hủy giải đấu!');
            io.to(rCode).emit('roomDestroyed');
            delete rooms[rCode];
        } else {
            room.players = room.players.filter(p => p.token !== data.token);
            io.to(rCode).emit('updateWaitingRoom', room.players);
        }
    });

    socket.on('createRoom', (settings) => {
        const playerName = (settings.playerName || '').trim();
        if (!playerName) {
            socket.emit('errorMsg', 'Vui lòng nhập tên của bạn!');
            return;
        }

        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const winScore = parseInt(settings.winScore) || 3;
        rooms[roomCode] = {
            hostToken: settings.token,
            players: [{ id: socket.id, token: settings.token, name: playerName }],
            activePlayers: [], 
            bracket: [], 
            currentRoundMatches: [],
            level: settings.level,
            winScore: winScore,
            status: 'waiting'
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, isHost: true });
        io.to(roomCode).emit('updateWaitingRoom', rooms[roomCode].players);
        console.log(`🏠 Giải đấu [${roomCode}] được tạo bởi ${playerName}.`);
    });

    socket.on('joinRoom', (data) => {
        const roomCode = normalizeRoomCode(data.roomCode);
        const playerName = (data.playerName || '').trim();

        if (!/^\d{4}$/.test(roomCode)) {
            socket.emit('errorMsg', 'Mã phòng phải có đúng 4 chữ số!');
            return;
        }
        if (!playerName) {
            socket.emit('errorMsg', 'Vui lòng nhập tên của bạn!');
            return;
        }

        const room = rooms[roomCode];
        if (room && room.status === 'waiting') {
            const existingPlayer = room.players.find(p => p.token === data.token);
            if (existingPlayer) {
                existingPlayer.id = socket.id;
                existingPlayer.name = playerName;
            } else {
                room.players.push({ id: socket.id, token: data.token, name: playerName });
            }

            socket.join(roomCode);
            socket.emit('roomCreated', { roomCode, isHost: false });
            io.to(roomCode).emit('updateWaitingRoom', room.players);
            console.log(`✅ [${playerName}] vào phòng [${roomCode}] (${room.players.length} người)`);
        } else {
            const reason = room ? 'đã bắt đầu' : 'không tồn tại';
            console.log(`❌ [${playerName}] không vào được phòng [${roomCode}] — ${reason}`);
            socket.emit('errorMsg', 'Mã phòng không tồn tại hoặc giải đấu đã bắt đầu!');
        }
    });

    socket.on('startTournament', (roomCode) => {
        roomCode = normalizeRoomCode(roomCode);
        const room = rooms[roomCode];
        // Chỉ Host (kiểm tra qua token) mới được bấm bắt đầu
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (room && player && room.hostToken === player.token && room.players.length >= 2) {
            room.status = 'playing';
            room.activePlayers = [...room.players].sort(() => Math.random() - 0.5); 
            startNewRound(room, roomCode);
        }
    });

    function assignNextPuzzle(match, roomCode, options = {}) {
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
            io.to(match.p1.id).emit(options.payloadType || 'update_game', payload);
            io.to(match.p2.id).emit(options.payloadType || 'update_game', payload);
            io.to('watch_' + match.id).emit(options.payloadType || 'update_game', payload);
        }
    }

    function resolveMatchWinner(room, roomCode, match, winner, reasonMessage) {
        clearMatchTimer(match);
        match.winner = winner;
        if (!winner.isDoubleLoss) addScore(winner.name, 2);
        io.to(match.p1.id).emit('matchResult', { winner: winner.name, bracket: room.bracket, reason: reasonMessage, isDoubleLoss: !!winner.isDoubleLoss });
        io.to(match.p2.id).emit('matchResult', { winner: winner.name, bracket: room.bracket, reason: reasonMessage, isDoubleLoss: !!winner.isDoubleLoss });
        io.to('watch_' + match.id).emit('spectateEnd', { winner: winner.name, bracket: room.bracket, reason: reasonMessage, isDoubleLoss: !!winner.isDoubleLoss });
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

    function startNewRound(room, roomCode) {
        generateNextRound(room); io.to(roomCode).emit('showBracket', room.bracket);
        setTimeout(() => {
            room.currentRoundMatches.forEach(match => {
                if (!match.isBye) {
                    match.roundMode = 'regular';
                    match.drawStreak = 0;
                    match.puzzleRound = 1;
                    match.ropePosition = 0;
                    assignNextPuzzle(match, roomCode, { silent: true });
                    io.to(match.p1.id).emit('gameStart', { level: room.level, winScore: room.winScore, isP1: true, opponentName: match.p2.name, ropePosition: 0, puzzleRound: match.puzzleRound, puzzleSeed: match.currentSeed, roundMode: match.roundMode, timeLimitMs: match.timeLimitMs, deadlineAt: match.deadlineAt });
                    io.to(match.p2.id).emit('gameStart', { level: room.level, winScore: room.winScore, isP1: false, opponentName: match.p1.name, ropePosition: 0, puzzleRound: match.puzzleRound, puzzleSeed: match.currentSeed, roundMode: match.roundMode, timeLimitMs: match.timeLimitMs, deadlineAt: match.deadlineAt });
                } else { io.to(match.p1.id).emit('byeMatch'); }
            });
        }, 5000);
    }

    socket.on('watchMatch', (data) => {
        const room = rooms[String(data.roomCode).trim()];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.id === data.matchId);
        if (match && !match.isBye && !match.winner) {
            socket.join('watch_' + match.id); 
            socket.emit('spectateStart', {
                level: room.level, winScore: room.winScore, puzzleSeed: match.currentSeed, 
                puzzleRound: match.puzzleRound, ropePosition: match.ropePosition, p1Name: match.p1.name, p2Name: match.p2.name,
                roundMode: match.roundMode || 'regular', timeLimitMs: match.timeLimitMs || REGULAR_PUZZLE_TIME_MS, deadlineAt: match.deadlineAt || null
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
        const room = rooms[String(data.roomCode).trim()];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner) return;
        io.to((data.token === match.p1.token) ? match.p2.id : match.p1.id).emit('receiveEmoji', data.emoji);
    });

    function checkAndAdvanceTournament(room, roomCode) {
        io.to(roomCode).emit('updateBracketOnly', room.bracket);
        if (room.currentRoundMatches.every(m => m.winner !== null)) {
            room.currentRoundMatches.forEach(clearMatchTimer);
            room.activePlayers = room.currentRoundMatches
                .map(m => (m.winner && !m.winner.isDoubleLoss ? m.winner : null))
                .filter(Boolean);

            if (room.activePlayers.length === 1) {
                addScore(room.activePlayers[0].name, 10); 
                io.to(roomCode).emit('tournamentOver', { champion: room.activePlayers[0].name });
                delete rooms[roomCode];
            } else if (room.activePlayers.length > 1) {
                setTimeout(() => { startNewRound(room, roomCode); }, 3000);
            } else {
                io.to(roomCode).emit('tournamentOver', { champion: 'Không có nhà vô địch (đồng thua)' });
                delete rooms[roomCode];
            }
        }
    }
});

server.listen(process.env.PORT || 3000, () => { console.log(`🚀 Server chạy cực mượt!`); });
