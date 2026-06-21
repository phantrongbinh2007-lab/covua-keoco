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
            currentSeed: null, // Lưu lại bài tập hiện tại để Reconnect
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
            currentSeed: null,
            isBye: true
        });
    }

    room.currentRoundMatches = matches;
    room.bracket.push(matches);
}

io.on('connection', (socket) => {
    console.log('🔥 Có kỳ thủ kết nối mạng:', socket.id);

    // XỬ LÝ RECONNECT
    socket.on('reconnectUser', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return; // Phòng đã giải tán hoặc không tồn tại

        // Tìm người chơi dựa trên Token (Căn cước ngầm)
        const player = room.players.find(p => p.token === data.token);
        if (!player) return;

        // Cập nhật socket.id mới cho người chơi này
        player.id = socket.id;
        socket.join(data.roomCode);
        console.log(`🔄 Kỳ thủ [${player.name}] vừa Reconnect thành công vào phòng [${data.roomCode}]`);

        // Đưa người chơi về đúng màn hình họ đang đứng
        if (room.status === 'waiting') {
            socket.emit('roomCreated', { roomCode: data.roomCode, isHost: room.hostToken === data.token });
            socket.emit('updateWaitingRoom', room.players);
        } else if (room.status === 'playing') {
            let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
            
            if (match && !match.winner && !match.isBye && match.currentSeed !== null) {
                // Đang trong trận đánh dở -> Quăng lại vào bàn cờ
                let isP1 = match.p1.token === data.token;
                let opponent = isP1 ? match.p2 : match.p1;
                socket.emit('gameStart', {
                    level: room.level, winScore: room.winScore,
                    puzzleSeed: match.currentSeed, puzzleRound: match.puzzleRound, ropePosition: match.ropePosition,
                    isP1: isP1, opponentName: opponent ? opponent.name : '---'
                });
            } else {
                // Đang ở nhánh đấu chờ xem kết quả
                socket.emit('showBracket', room.bracket);
            }
        }
    });

    socket.on('createRoom', (settings) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const winScore = parseInt(settings.winScore) || 3;

        rooms[roomCode] = {
            hostToken: settings.token,
            players: [{ id: socket.id, token: settings.token, name: settings.playerName }],
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
            // Chống spam: Nếu token này đã có trong phòng thì không add thêm
            const existingPlayer = room.players.find(p => p.token === data.token);
            if (existingPlayer) {
                existingPlayer.id = socket.id; // Cập nhật ID mới
                existingPlayer.name = data.playerName;
            } else {
                room.players.push({ id: socket.id, token: data.token, name: data.playerName });
            }
            
            socket.join(data.roomCode);
            socket.emit('roomCreated', { roomCode: data.roomCode, isHost: false });
            io.to(data.roomCode).emit('updateWaitingRoom', room.players);
        } else {
            socket.emit('errorMsg', 'Mã phòng không tồn tại hoặc giải đấu đã bắt đầu!');
        }
    });

    socket.on('startTournament', (roomCode) => {
        const room = rooms[roomCode];
        // Chỉ Host (kiểm tra qua token) mới được bấm bắt đầu
        const player = room.players.find(p => p.id === socket.id);
        if (room && player && room.hostToken === player.token && room.players.length >= 2) {
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
                    match.currentSeed = seed; // Lưu vết cho Reconnect
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

        let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner || match.puzzleRound !== data.puzzleRound) return;

        match.puzzleRound++; 

        if (data.token === match.p1.token) match.ropePosition -= 1;
        else if (data.token === match.p2.token) match.ropePosition += 1;

        let matchOver = false;
        if (match.ropePosition <= -room.winScore) { match.winner = match.p1; matchOver = true; }
        else if (match.ropePosition >= room.winScore) { match.winner = match.p2; matchOver = true; }

        if (matchOver) {
            io.to(match.p1.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            io.to(match.p2.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            checkAndAdvanceTournament(room, data.roomCode);
        } else {
            const nextSeed = Math.floor(Math.random() * 1000000);
            match.currentSeed = nextSeed; // Lưu vết bài tập mới
            io.to(match.p1.id).emit('update_game', { ropePosition: match.ropePosition, puzzleSeed: nextSeed, puzzleRound: match.puzzleRound });
            io.to(match.p2.id).emit('update_game', { ropePosition: match.ropePosition, puzzleSeed: nextSeed, puzzleRound: match.puzzleRound });
        }
    });

    socket.on('sendEmoji', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        let match = room.currentRoundMatches.find(m => m.p1?.token === data.token || m.p2?.token === data.token);
        if (!match || match.winner) return;

        let opponentId = (data.token === match.p1.token) ? match.p2.id : match.p1.id;
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
        console.log('❌ Một socket đã ngắt kết nối:', socket.id);
        // Không xóa dữ liệu phòng vì họ có thể Reconnect lại bằng Token
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Giải Đấu đang chạy cực mượt tại cổng: ${PORT}`);
});