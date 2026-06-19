const socket = io(); 
let game = new Chess();
let board = null;
let myRoomCode = null;
let isMyTurnToSolve = false; 
let puzzleList = [];
let currentPuzzle = null;
let currentMoveIndex = 0; 
let currentWinScore = 3; 
let currentPuzzleRound = 1; 
let computerMoveTimer = null; 
let amIP1 = true; 
let selectedSquare = null;

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

    $('#board').on('click', '.square-55d63', function() {
        let square = $(this).attr('data-square');
        if (square) handleSquareClick(square);
    });

    // SỰ KIỆN: BẤM NÚT GỬI EMOJI
    $('.emoji-btn').on('click', function() {
        let emoji = $(this).attr('data-emoji');
        socket.emit('sendEmoji', { roomCode: myRoomCode, emoji: emoji });
        showFloatingEmoji(emoji, 'me'); // Hiện lên ở phe mình
    });
});

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

socket.on('gameStart', (data) => {
    $('#bracketArea').hide();
    $('#gameArea').show();
    currentWinScore = data.winScore;
    currentPuzzleRound = data.puzzleRound;
    amIP1 = data.isP1; 
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

socket.on('byeMatch', () => {
    $('#bracketStatus').html("<strong style='color:green;'>Bạn được đặc cách vòng này! Đang chờ đối thủ khác thi đấu...</strong>");
});

socket.on('update_game', (data) => {
    currentPuzzleRound = data.puzzleRound;
    updateRopeUI(data.ropePosition);
    $('#status').text("Thế trận đã thay đổi!");
    loadPuzzle(data.puzzleSeed);
});

socket.on('matchResult', (data) => {
    isMyTurnToSolve = false; 
    $('#gameArea').hide();
    $('#bracketArea').show();
    $('#bracketStatus').text(`Đang chờ các nhánh khác...`);
    renderBracket(data.bracket);
});

socket.on('tournamentOver', (data) => {
    $('#victoryText').html(`🏆 CHÚC MỪNG 🏆<br>${data.champion} ĐÃ VÔ ĐỊCH GIẢI ĐẤU!`);
    $('#victoryModal').css('display', 'flex');
});

// SỰ KIỆN: NHẬN EMOJI TỪ ĐỐI THỦ
socket.on('receiveEmoji', (emoji) => {
    showFloatingEmoji(emoji, 'opponent');
});

// Hàm tạo hiệu ứng Emoji bay lượn
function showFloatingEmoji(emoji, side) {
    let $emoji = $('<div class="floating-emoji"></div>').text(emoji);
    
    if (side === 'me') {
        $emoji.css({ bottom: '-20px', left: '10%' }); // Bay lên từ chữ "Bạn"
    } else {
        $emoji.css({ bottom: '-20px', right: '10%' }); // Bay lên từ chữ "Đối thủ"
    }

    $('#tugOfWar').append($emoji);
    
    // Xóa emoji sau khi hết animation
    setTimeout(() => { $emoji.remove(); }, 1500);
}

function updateRopeUI(position) {
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
    selectedSquare = null; 
    $('.square-55d63').removeClass('highlight-square');
    
    game.load(currentPuzzle.fen);
    board.position(currentPuzzle.fen, false);
    
    let playerColor = game.turn() === 'w' ? 'black' : 'white';
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

function handleSquareClick(square) {
    if (!isMyTurnToSolve || currentMoveIndex % 2 === 0) return;
    let piece = game.get(square);
    let turnColor = game.turn();

    if (!selectedSquare) {
        if (piece && piece.color === turnColor) {
            selectedSquare = square;
            $('.square-55d63').removeClass('highlight-square');
            $('.square-' + square).addClass('highlight-square');
        }
        return;
    }

    let expectedMove = currentPuzzle.solution[currentMoveIndex];
    let promoPiece = 'q';
    if (expectedMove && expectedMove.length === 5 && (selectedSquare + square) === expectedMove.substring(0, 4)) {
        promoPiece = expectedMove[4]; 
    }

    let move = game.move({ from: selectedSquare, to: square, promotion: promoPiece });
    
    if (move) {
        $('.square-55d63').removeClass('highlight-square');
        let moveStr = selectedSquare + square + (move.promotion ? move.promotion : '');
        selectedSquare = null;

        if (moveStr === expectedMove) {
            board.position(game.fen());
            currentMoveIndex++;
            if (currentMoveIndex === currentPuzzle.solution.length) {
                $('#status').text("Tuyệt vời! Đang giật dây kéo co...");
                socket.emit('solved_puzzle', { roomCode: myRoomCode, puzzleRound: currentPuzzleRound });
            } else {
                $('#status').text("Chính xác! Đợi máy phản đòn...");
                if (computerMoveTimer) clearTimeout(computerMoveTimer);
                computerMoveTimer = setTimeout(makeComputerMove, 600);
            }
        } else {
            game.undo();
            $('#status').text("Đi sai rồi. Tính lại đi!");
        }
    } else {
        if (piece && piece.color === turnColor) {
            selectedSquare = square;
            $('.square-55d63').removeClass('highlight-square');
            $('.square-' + square).addClass('highlight-square');
        } else {
            selectedSquare = null;
            $('.square-55d63').removeClass('highlight-square');
        }
    }
}

function onDragStart(source, piece, position, orientation) {
    if (!isMyTurnToSolve || currentMoveIndex % 2 === 0) return false; 
    if ((orientation === 'white' && piece.search(/^b/) !== -1) ||
        (orientation === 'black' && piece.search(/^w/) !== -1)) return false;
        
    selectedSquare = null;
    $('.square-55d63').removeClass('highlight-square');
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
    board = Chessboard('board', { 
        draggable: true, 
        position: 'start', 
        onDragStart: onDragStart, 
        onDrop: onDrop, 
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png' 
    });
}