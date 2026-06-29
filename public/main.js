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

// HỆ THỐNG TOKEN (RECONNECT)
let myToken = localStorage.getItem('chessTugToken');
if (!myToken) {
    myToken = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('chessTugToken', myToken);
}

function normalizeRoomCode(raw) {
    return (raw || '').trim().replace(/\D/g, '');
}

function whenSocketReady(callback) {
    if (socket.connected) {
        callback();
        return;
    }
    $('#lobbyMsg').text('Đang kết nối máy chủ...');
    const onConnect = () => {
        socket.off('connect_error', onError);
        $('#lobbyMsg').text('');
        callback();
    };
    const onError = () => {
        socket.off('connect', onConnect);
        $('#lobbyMsg').text('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    if (!socket.active) socket.connect();
}

$(document).ready(function() {
    const savedRoom = normalizeRoomCode(sessionStorage.getItem('currentRoomCode'));
    if (savedRoom.length === 4) {
        whenSocketReady(() => {
            myRoomCode = savedRoom;
            socket.emit('reconnectUser', { roomCode: savedRoom, token: myToken });
        });
    } else if (sessionStorage.getItem('currentRoomCode')) {
        sessionStorage.removeItem('currentRoomCode');
    }

    $('#createBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");

        const selectedLevel = $('#levelSelect').val();
        let winScore = parseInt($('#winScoreInput').val());
        if (isNaN(winScore) || winScore < 3) winScore = 3;

        whenSocketReady(() => {
            sessionStorage.removeItem('currentRoomCode');
            myRoomCode = null;
            $('#lobbyMsg').text('Đang tạo giải đấu...');
            socket.emit('createRoom', { playerName: name, level: selectedLevel, winScore: winScore, token: myToken });
        });
    });

    $('#joinBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");

        const code = normalizeRoomCode($('#roomCode').val());
        if (code.length !== 4) {
            return $('#lobbyMsg').text("Nhập đủ 4 chữ số mã phòng!");
        }
        $('#roomCode').val(code);

        whenSocketReady(() => {
            sessionStorage.removeItem('currentRoomCode');
            myRoomCode = null;
            $('#lobbyMsg').text('Đang vào phòng...');
            socket.emit('joinRoom', { roomCode: code, playerName: name, token: myToken });
        });
    });

    $('#startTournamentBtn').on('click', () => {
        socket.emit('startTournament', myRoomCode);
    });

    $('#backToLobbyBtn').on('click', () => { 
        sessionStorage.removeItem('currentRoomCode'); // Xóa phòng khi game over
        window.location.reload(); 
    });

    $('#board').on('click', '.square-55d63', function() {
        let square = $(this).attr('data-square');
        if (square) handleSquareClick(square);
    });

    $('.emoji-btn').on('click', function() {
        let emoji = $(this).attr('data-emoji');
        socket.emit('sendEmoji', { roomCode: myRoomCode, token: myToken, emoji: emoji });
        showFloatingEmoji(emoji, 'me');
    });
});

socket.on('connect', () => {
    if ($('#lobby').is(':visible') && !$('#lobbyMsg').text().includes('Đang')) {
        $('#lobbyMsg').text('');
    }
});

socket.on('connect_error', () => {
    if ($('#lobby').is(':visible')) {
        $('#lobbyMsg').text('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    }
});

socket.on('disconnect', () => {
    if ($('#lobby').is(':visible')) {
        $('#lobbyMsg').text('Mất kết nối máy chủ. Đang thử kết nối lại...');
    }
});

socket.on('reconnectFailed', () => {
    sessionStorage.removeItem('currentRoomCode');
    myRoomCode = null;
});

socket.on('roomCreated', (data) => { 
    myRoomCode = data.roomCode; 
    sessionStorage.setItem('currentRoomCode', myRoomCode);
    $('#lobbyMsg').text('');
    $('#lobby').hide();
    $('#bracketArea').hide();
    $('#gameArea').hide();
    $('#waitingRoom').show();
    $('#waitRoomCode').text(data.roomCode);
    if (data.isHost) {
        $('#startTournamentBtn').show();
        $('#waitStatus').text("Bạn là chủ giải, hãy bấm Bắt đầu khi đủ người!");
    } else {
        $('#startTournamentBtn').hide();
        $('#waitStatus').text("Đang chờ chủ phòng bắt đầu...");
    }
});

socket.on('updateWaitingRoom', (players) => {
    $('#playerList').empty();
    players.forEach(p => {
        $('#playerList').append(`<li>👦 ${p.name}</li>`);
    });
});

socket.on('errorMsg', (msg) => { 
    sessionStorage.removeItem('currentRoomCode');
    myRoomCode = null;
    $('#lobby').show();
    $('#waitingRoom').hide();
    $('#bracketArea').hide();
    $('#gameArea').hide();
    $('#startTournamentBtn').hide();
    $('#lobbyMsg').text(msg);
});

socket.on('showBracket', (bracket) => {
    $('#lobby').hide();
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
    $('#lobby').hide();
    $('#waitingRoom').hide();
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
        loadPuzzle(data.puzzleSeed); // Nếu Reconnect, nó sẽ tải đúng Puzzle dở dang
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
    sessionStorage.removeItem('currentRoomCode'); 
    $('#victoryText').html(`🏆 CHÚC MỪNG 🏆<br>${data.champion} ĐÃ VÔ ĐỊCH GIẢI ĐẤU!`);
    $('#victoryModal').css('display', 'flex');
});

socket.on('receiveEmoji', (emoji) => {
    showFloatingEmoji(emoji, 'opponent');
});

function showFloatingEmoji(emoji, side) {
    let $emoji = $('<div class="floating-emoji"></div>').text(emoji);
    if (side === 'me') {
        $emoji.css({ bottom: '-20px', left: '10%' }); 
    } else {
        $emoji.css({ bottom: '-20px', right: '10%' }); 
    }
    $('#tugOfWar').append($emoji);
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
                socket.emit('solved_puzzle', { roomCode: myRoomCode, token: myToken, puzzleRound: currentPuzzleRound });
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
            socket.emit('solved_puzzle', { roomCode: myRoomCode, token: myToken, puzzleRound: currentPuzzleRound });
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