const socket = io(); 
let game = new Chess();
let board = null;
let myRoomCode = null;
let isMyTurnToSolve = false; 
let puzzleList = [];
let currentPuzzle = null;
let currentMoveIndex = 0; 
let currentWinScore = 3; 

// Biến chống lỗi tương tranh
let currentPuzzleRound = 1; 
let computerMoveTimer = null; 
let amIP1 = true; // Trạng thái kéo cờ

$(document).ready(function() {
    $('#createBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");
        
        const selectedLevel = $('#levelSelect').val();
        let winScore = parseInt($('#winScoreInput').val());
        if (isNaN(winScore) || winScore < 3) winScore = 3;
        
        socket.emit('createRoom', { playerName: name, level: selectedLevel, winScore: winScore });
    });

    $('#joinBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");
        
        const code = $('#roomCode').val();
        if (code.length === 4) {
            socket.emit('joinRoom', { roomCode: code, playerName: name });
            myRoomCode = code;
        } else {
            $('#lobbyMsg').text("Nhập đủ 4 số mã phòng!");
        }
    });

    $('#startTournamentBtn').on('click', () => {
        socket.emit('startTournament', myRoomCode);
    });

    $('#backToLobbyBtn').on('click', () => { window.location.reload(); });
});

// Chuyển UI
socket.on('roomCreated', (data) => { 
    myRoomCode = data.roomCode; 
    $('#lobby').hide();
    $('#waitingRoom').show();
    $('#waitRoomCode').text(data.roomCode);
    if (data.isHost) {
        $('#startTournamentBtn').show();
        $('#waitStatus').text("Bạn là chủ giải, hãy bấm Bắt đầu khi đủ người!");
    }
});

socket.on('updateWaitingRoom', (players) => {
    $('#playerList').empty();
    players.forEach(p => {
        $('#playerList').append(`<li>👦 ${p.name}</li>`);
    });
});

socket.on('errorMsg', (msg) => { $('#lobbyMsg').text(msg); });

// Hiển thị Sơ đồ nhánh đấu
socket.on('showBracket', (bracket) => {
    $('#waitingRoom').hide();
    $('#gameArea').hide();
    $('#bracketArea').show();
    renderBracket(bracket);
    let count = 5;
    $('#bracketStatus').text(`Trận đấu bắt đầu sau ${count}s...`);
    let iv = setInterval(() => {
        count--;
        $('#bracketStatus').text(`Trận đấu bắt đầu sau ${count}s...`);
        if (count <= 0) clearInterval(iv);
    }, 1000);
});

socket.on('updateBracketOnly', (bracket) => {
    renderBracket(bracket);
});

function renderBracket(bracket) {
    let html = '';
    bracket.forEach((round, rIdx) => {
        html += `<div class="bracket-round"><h3>Vòng ${rIdx + 1}</h3>`;
        round.forEach(m => {
            let p1Name = m.p1 ? m.p1.name : '---';
            let p2Name = m.p2 ? m.p2.name : '---';
            let winnerText = m.winner ? `<span class="winner-text">🏆 Thắng: ${m.winner.name}</span>` : '';
            
            if (m.isBye) {
                html += `<div class="match-bye"><div class="match-player">${p1Name}</div><div class="match-vs">(Đặc cách vòng này)</div>${winnerText}</div>`;
            } else {
                html += `<div class="match-box"><div class="match-player">${p1Name}</div><div class="match-vs">VS</div><div class="match-player">${p2Name}</div>${winnerText}</div>`;
            }
        });
        html += `</div>`;
    });
    $('#bracketContent').html(html);
}

// Bắt đầu 1 Match
socket.on('gameStart', (data) => {
    $('#bracketArea').hide();
    $('#gameArea').show();
    
    currentWinScore = data.winScore;
    currentPuzzleRound = data.puzzleRound;
    amIP1 = data.isP1; // Cực kỳ quan trọng để lật ngược hướng kéo co

    $('#displayWinScore').text(currentWinScore);
    $('#opponentNameDisplay').text(data.opponentName + " 👧");
    $('#status').text("Đang tải dữ liệu cờ...");
    
    initBoard();

    $.getJSON(`puzzles_level${data.level}.json`, function(puzzles) {
        puzzleList = puzzles;
        isMyTurnToSolve = true;
        updateRopeUI(data.ropePosition);
        loadPuzzle(data.puzzleSeed);
    }).fail(() => {
        $('#status').text(`LỖI: Thiếu file "puzzles_level${data.level}.json"!`);
    });
});

// Dành cho người bị lẻ
socket.on('byeMatch', () => {
    $('#bracketStatus').html("<strong style='color:green;'>Bạn được đặc cách vòng này! Đang chờ đối thủ khác thi đấu...</strong>");
});

// Đồng bộ game
socket.on('update_game', (data) => {
    currentPuzzleRound = data.puzzleRound;
    updateRopeUI(data.ropePosition);
    $('#status').text("Thế trận đã thay đổi!");
    loadPuzzle(data.puzzleSeed);
});

// Trận nhỏ kết thúc, trở về nhánh
socket.on('matchResult', (data) => {
    isMyTurnToSolve = false; 
    $('#gameArea').hide();
    $('#bracketArea').show();
    $('#bracketStatus').text(`Đang chờ các nhánh khác...`);
    renderBracket(data.bracket);
});

// Toàn giải kết thúc
socket.on('tournamentOver', (data) => {
    $('#victoryText').html(`🏆 CHÚC MỪNG 🏆<br>${data.champion} ĐÃ VÔ ĐỊCH GIẢI ĐẤU!`);
    $('#victoryModal').css('display', 'flex');
});

// Logic kéo co (Luôn ép cờ dịch trái/phải chính xác theo phe)
function updateRopeUI(position) {
    // Nếu bạn là P1 (âm là thắng), P2 (dương là thắng). 
    // Trick: Đảo ngược position nếu là P2, để UI luôn hiểu BẠN kéo về bên trái.
    let visualPos = amIP1 ? position : -position;
    let stepPercentage = 45 / currentWinScore; 
    let percent = 50 + (visualPos * stepPercentage);
    $('#marker').css('left', percent + '%');
}

function loadPuzzle(seed) {
    if (!puzzleList || puzzleList.length === 0) return;
    let index = seed % puzzleList.length;
    currentPuzzle = puzzleList[index];
    currentMoveIndex = 0; 
    
    game.load(currentPuzzle.fen);
    board.position(currentPuzzle.fen, false);
    
    let playerColor = game.turn() === 'w' ? 'white' : 'black';
    board.orientation(playerColor);

    if (computerMoveTimer) clearTimeout(computerMoveTimer);
    computerMoveTimer = setTimeout(makeComputerMove, 600); 
}

function makeComputerMove() {
    if (!currentPuzzle || currentMoveIndex >= currentPuzzle.solution.length) return;
    
    let move = currentPuzzle.solution[currentMoveIndex];
    let fromSq = move.substring(0, 2), toSq = move.substring(2, 4);
    let promo = move.length > 4 ? move[4] : 'q';

    game.move({ from: fromSq, to: toSq, promotion: promo });
    board.position(game.fen());
    currentMoveIndex++; 
    
    $('#status').text(currentMoveIndex === 1 ? "🔥 Nước đi sai lầm của địch! Trừng phạt ngay!" : "Địch đáp trả! Tính tiếp đi!");
}

function onDragStart(source, piece, position, orientation) {
    if (!isMyTurnToSolve || currentMoveIndex % 2 === 0) return false; 
    if ((orientation === 'white' && piece.search(/^b/) !== -1) ||
        (orientation === 'black' && piece.search(/^w/) !== -1)) return false;
}

function onDrop(source, target) {
    if (currentMoveIndex % 2 === 0) return 'snapback';
    
    let expectedMove = currentPuzzle.solution[currentMoveIndex];
    let promoPiece = 'q';
    if (expectedMove && expectedMove.length === 5 && (source + target) === expectedMove.substring(0, 4)) {
        promoPiece = expectedMove[4]; 
    }

    let move = game.move({ from: source, to: target, promotion: promoPiece });
    if (!move) return 'snapback'; 
    
    let moveStr = source + target + (move.promotion ? move.promotion : '');

    if (moveStr === expectedMove) {
        currentMoveIndex++;
        if (currentMoveIndex === currentPuzzle.solution.length) {
            $('#status').text("Tuyệt vời! Đang giật dây kéo co...");
            // Gửi kèm puzzleRound để chống lỗi Race Condition
            socket.emit('solved_puzzle', { roomCode: myRoomCode, puzzleRound: currentPuzzleRound });
        } else {
            $('#status').text("Chính xác! Đợi máy phản đòn...");
            if (computerMoveTimer) clearTimeout(computerMoveTimer);
            computerMoveTimer = setTimeout(makeComputerMove, 600);
        }
    } else {
        game.undo();
        $('#status').text("Đi sai rồi. Tính lại đi!");
        return 'snapback';
    }
}

function initBoard() {
    if (board) { board.position('start'); return; }
    board = Chessboard('board', { draggable: true, position: 'start', onDragStart: onDragStart, onDrop: onDrop, pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png' });
}