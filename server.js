const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function generateNextRound(room) {
    let players = room.activePlayers;
    let matches = [];
    let left = 0;
    let right = players.length - 1;

    while (left < right) {
        matches.push({
            id: Math.random().toString(36).substr(2, 9),
            p1: players[left],
            p2: players[right],
            winner: null,
            ropePosition: 0,
            puzzleRound: 1, 
            isBye: false
        });
        left++;
        right--;
    }
    
    if (left === right) {
        matches.push({
            id: Math.random().toString(36).substr(2, 9),
            p1: players[left],
            p2: null,
            winner: players[left], 
            ropePosition: 0,
            puzzleRound: 1,
            isBye: true
        });
    }

    room.currentRoundMatches = matches;
    room.bracket.push(matches);
}

io.on('connection', (socket) => {
    console.log('🔥 Có kỳ thủ kết nối mạng:', socket.id);

    socket.on('createRoom', (settings) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const winScore = parseInt(settings.winScore) || 3;

        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: settings.playerName }],
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
        console.log(`🏠 Giải đấu [${roomCode}] được tạo bởi ${settings.playerName}.`);
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.status === 'waiting') {
            room.players.push({ id: socket.id, name: data.playerName });
            socket.join(data.roomCode);
            socket.emit('roomCreated', { roomCode: data.roomCode, isHost: false });
            io.to(data.roomCode).emit('updateWaitingRoom', room.players);
        } else {
            socket.emit('errorMsg', 'Mã phòng không tồn tại hoặc giải đấu đã bắt đầu!');
        }
    });

    socket.on('startTournament', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id && room.players.length >= 2) {
            room.status = 'playing';
            room.activePlayers = [...room.players]; 
            room.activePlayers.sort(() => Math.random() - 0.5); 
            startNewRound(room, roomCode);
            console.log(`⚔️ Giải đấu [${roomCode}] chính thức khởi tranh với ${room.players.length} kỳ thủ!`);
        }
    });

    function startNewRound(room, roomCode) {
        generateNextRound(room);
        io.to(roomCode).emit('showBracket', room.bracket);

        setTimeout(() => {
            room.currentRoundMatches.forEach(match => {
                if (!match.isBye) {
                    const seed = Math.floor(Math.random() * 1000000);
                    const matchData = {
                        level: room.level, winScore: room.winScore,
                        puzzleSeed: seed, puzzleRound: match.puzzleRound, ropePosition: 0
                    };
                    io.to(match.p1.id).emit('gameStart', { ...matchData, isP1: true, opponentName: match.p2.name });
                    io.to(match.p2.id).emit('gameStart', { ...matchData, isP1: false, opponentName: match.p1.name });
                } else {
                    io.to(match.p1.id).emit('byeMatch'); 
                }
            });
        }, 5000);
    }

    socket.on('solved_puzzle', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;

        let match = room.currentRoundMatches.find(m => m.p1?.id === socket.id || m.p2?.id === socket.id);
        if (!match || match.winner || match.puzzleRound !== data.puzzleRound) return;

        match.puzzleRound++; 

        if (socket.id === match.p1.id) match.ropePosition -= 1;
        else if (socket.id === match.p2.id) match.ropePosition += 1;

        let matchOver = false;
        if (match.ropePosition <= -room.winScore) { match.winner = match.p1; matchOver = true; }
        else if (match.ropePosition >= room.winScore) { match.winner = match.p2; matchOver = true; }

        if (matchOver) {
            io.to(match.p1.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            io.to(match.p2.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            checkAndAdvanceTournament(room, data.roomCode);
        } else {
            const nextSeed = Math.floor(Math.random() * 1000000);
            io.to(match.p1.id).emit('update_game', { ropePosition: match.ropePosition, puzzleSeed: nextSeed, puzzleRound: match.puzzleRound });
            io.to(match.p2.id).emit('update_game', { ropePosition: match.ropePosition, puzzleSeed: nextSeed, puzzleRound: match.puzzleRound });
        }
    });

    // 🚀 TÍNH NĂNG MỚI: Bắn tín hiệu Emoji sang đối thủ
    socket.on('sendEmoji', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.p1?.id === socket.id || m.p2?.id === socket.id);
        if (!match || match.winner) return;

        // Tìm ID của đối thủ
        let opponentId = (socket.id === match.p1.id) ? match.p2.id : match.p1.id;
        
        // Bắn emoji sang cho người kia
        io.to(opponentId).emit('receiveEmoji', data.emoji);
    });

    function checkAndAdvanceTournament(room, roomCode) {
        io.to(roomCode).emit('updateBracketOnly', room.bracket);

        const allFinished = room.currentRoundMatches.every(m => m.winner !== null);
        if (allFinished) {
            room.activePlayers = room.currentRoundMatches.map(m => m.winner);
            
            if (room.activePlayers.length === 1) {
                io.to(roomCode).emit('tournamentOver', { champion: room.activePlayers[0].name });
                delete rooms[roomCode];
            } else {
                setTimeout(() => { startNewRound(room, roomCode); }, 3000);
            }
        }
    }

    socket.on('disconnect', () => {
        console.log('❌ Một kỳ thủ đã ngắt kết nối:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Giải Đấu đang chạy cực mượt tại cổng: ${PORT}`);
});