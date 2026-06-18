const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Cấu trúc mới: Quản lý giải đấu
const rooms = {};

// Hàm tạo vòng đấu mới (1vs8, 2vs7...)
function generateNextRound(room) {
    let players = room.activePlayers;
    let matches = [];
    let left = 0;
    let right = players.length - 1;

    // Bắt cặp từ ngoài vào trong
    while (left < right) {
        matches.push({
            id: Math.random().toString(36).substr(2, 9),
            p1: players[left],
            p2: players[right],
            winner: null,
            ropePosition: 0,
            puzzleRound: 1, // Fix lỗi đứng game: Quản lý số thứ tự bài tập
            isBye: false
        });
        left++;
        right--;
    }
    
    // Nếu lẻ người, người ở giữa được đặc cách (Bye)
    if (left === right) {
        matches.push({
            id: Math.random().toString(36).substr(2, 9),
            p1: players[left],
            p2: null,
            winner: players[left], // Tự động thắng
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

    // 1. TẠO PHÒNG
    socket.on('createRoom', (settings) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const winScore = parseInt(settings.winScore) || 3;

        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: settings.playerName }],
            activePlayers: [], // Những người còn trụ lại
            bracket: [], // Lịch sử nhánh đấu
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

    // 2. VÀO PHÒNG
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

    // 3. CHỦ PHÒNG BẤM BẮT ĐẦU GIẢI ĐẤU
    socket.on('startTournament', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id && room.players.length >= 2) {
            room.status = 'playing';
            room.activePlayers = [...room.players]; // Copy danh sách
            
            // Xáo trộn ngẫu nhiên thứ tự người chơi để bốc thăm
            room.activePlayers.sort(() => Math.random() - 0.5); 
            
            startNewRound(room, roomCode);
            console.log(`⚔️ Giải đấu [${roomCode}] chính thức khởi tranh với ${room.players.length} kỳ thủ!`);
        }
    });

    function startNewRound(room, roomCode) {
        generateNextRound(room);
        // Bắn giao diện nhánh đấu cho tất cả cùng xem
        io.to(roomCode).emit('showBracket', room.bracket);

        // Chờ 5 giây cho anh em ngắm nhánh đấu rồi tung bài tập
        setTimeout(() => {
            room.currentRoundMatches.forEach(match => {
                if (!match.isBye) {
                    const seed = Math.floor(Math.random() * 1000000);
                    const matchData = {
                        level: room.level, winScore: room.winScore,
                        puzzleSeed: seed, puzzleRound: match.puzzleRound, ropePosition: 0
                    };
                    // Phát lệnh riêng cho từng cặp
                    io.to(match.p1.id).emit('gameStart', { ...matchData, isP1: true, opponentName: match.p2.name });
                    io.to(match.p2.id).emit('gameStart', { ...matchData, isP1: false, opponentName: match.p1.name });
                } else {
                    io.to(match.p1.id).emit('byeMatch'); // Báo cho người được đặc cách
                }
            });
        }, 5000);
    }

    // 4. KIỂM TRA ĐÁP ÁN (FIX LỖI RACE CONDITION)
    socket.on('solved_puzzle', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;

        // Tìm trận đấu mà user này đang tham gia
        let match = room.currentRoundMatches.find(m => m.p1?.id === socket.id || m.p2?.id === socket.id);
        
        // Chặn spam tín hiệu: Chỉ nhận nếu đúng vòng puzzle hiện tại
        if (!match || match.winner || match.puzzleRound !== data.puzzleRound) return;

        match.puzzleRound++; // Tăng vòng bài tập để chặn đáp án trễ từ người kia

        // Cập nhật vị trí dây (p1 kéo âm, p2 kéo dương)
        if (socket.id === match.p1.id) match.ropePosition -= 1;
        else if (socket.id === match.p2.id) match.ropePosition += 1;

        // Kiểm tra thắng bại của cặp này
        let matchOver = false;
        if (match.ropePosition <= -room.winScore) { match.winner = match.p1; matchOver = true; }
        else if (match.ropePosition >= room.winScore) { match.winner = match.p2; matchOver = true; }

        if (matchOver) {
            io.to(match.p1.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            io.to(match.p2.id).emit('matchResult', { winner: match.winner.name, bracket: room.bracket });
            checkAndAdvanceTournament(room, data.roomCode);
        } else {
            // Nạp bài mới ngay lập tức
            const nextSeed = Math.floor(Math.random() * 1000000);
            io.to(match.p1.id).emit('update_game', { ropePosition: match.ropePosition, puzzleSeed: nextSeed, puzzleRound: match.puzzleRound });
            io.to(match.p2.id).emit('update_game', { ropePosition: match.ropePosition, puzzleSeed: nextSeed, puzzleRound: match.puzzleRound });
        }
    });

    function checkAndAdvanceTournament(room, roomCode) {
        // Cập nhật lại Bracket cho mọi người xem tiến độ
        io.to(roomCode).emit('updateBracketOnly', room.bracket);

        // Kiểm tra xem tất cả các cặp trong vòng này đã đánh xong chưa?
        const allFinished = room.currentRoundMatches.every(m => m.winner !== null);
        if (allFinished) {
            // Lọc ra những người thắng cuộc để đi tiếp
            room.activePlayers = room.currentRoundMatches.map(m => m.winner);
            
            if (room.activePlayers.length === 1) {
                // TÌM RA NHÀ VÔ ĐỊCH
                io.to(roomCode).emit('tournamentOver', { champion: room.activePlayers[0].name });
                delete rooms[roomCode];
            } else {
                // Bắt đầu vòng tiếp theo sau 3 giây
                setTimeout(() => { startNewRound(room, roomCode); }, 3000);
            }
        }
    }

    socket.on('disconnect', () => {
        console.log('❌ Một kỳ thủ đã ngắt kết nối:', socket.id);
        // Trong thực tế sẽ cần logic xử lý xử thua (forfeit) ở đây, nhưng bản này giữ gọn gàng.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Giải Đấu đang chạy cực mượt tại cổng: ${PORT}`);
});