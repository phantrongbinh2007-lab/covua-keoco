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
                    isP1: isP1, opponentName: (isP1 ? match.p2 : match.p1)?.name || '---'
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

    function startNewRound(room, roomCode) {
        generateNextRound(room); io.to(roomCode).emit('showBracket', room.bracket);
        setTimeout(() => {
            room.currentRoundMatches.forEach(match => {
                if (!match.isBye) {
                    match.currentSeed = Math.floor(Math.random() * 1000000); 
                    const matchData = { level: room.level, winScore: room.winScore, puzzleSeed: match.currentSeed, puzzleRound: match.puzzleRound, ropePosition: 0 };
                    io.to(match.p1.id).emit('gameStart', { ...matchData, isP1: true, opponentName: match.p2.name });
                    io.to(match.p2.id).emit('gameStart', { ...matchData, isP1: false, opponentName: match.p1.name });
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
                puzzleRound: match.puzzleRound, ropePosition: match.ropePosition, p1Name: match.p1.name, p2Name: match.p2.name
            });
        }
    });

    socket.on('solved_puzzle', (data) => {
        const rCode = String(data.roomCode).trim();
        const room = rooms[rCode];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner || match.puzzleRound !== data.puzzleRound) return;

        match.puzzleRound++; 
        if (data.token === match.p1.token) match.ropePosition -= 1;
        else if (data.token === match.p2.token) match.ropePosition += 1;

        let matchOver = false;
        if (match.ropePosition <= -room.winScore) { match.winner = match.p1; matchOver = true; }
        else if (match.ropePosition >= room.winScore) { match.winner = match.p2; matchOver = true; }

        if (matchOver) {
            addScore(match.winner.name, 2); 
            io.to(match.p1.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            io.to(match.p2.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            io.to('watch_' + match.id).emit('spectateEnd', { winner: match.winner.name, bracket: room.bracket }); 
            checkAndAdvanceTournament(room, rCode);
        } else {
            match.currentSeed = Math.floor(Math.random() * 1000000); 
            const updateData = { ropePosition: match.ropePosition, puzzleSeed: match.currentSeed, puzzleRound: match.puzzleRound };
            io.to(match.p1.id).emit('update_game', updateData);
            io.to(match.p2.id).emit('update_game', updateData);
            io.to('watch_' + match.id).emit('update_game', updateData); 
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
            room.activePlayers = room.currentRoundMatches.map(m => m.winner);
            if (room.activePlayers.length === 1) {
                addScore(room.activePlayers[0].name, 10); 
                io.to(roomCode).emit('tournamentOver', { champion: room.activePlayers[0].name });
                delete rooms[roomCode];
            } else { setTimeout(() => { startNewRound(room, roomCode); }, 3000); }
        }
    }
});

server.listen(process.env.PORT || 3000, () => { console.log(`🚀 Server chạy cực mượt!`); });
