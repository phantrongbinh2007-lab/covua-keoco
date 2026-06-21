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
let isSpectator = false; 

let globalLeaderboard = { daily: {}, weekly: {}, monthly: {} };
let currentLbTab = 'daily';

let myToken = localStorage.getItem('chessTugToken');
if (!myToken) {
    myToken = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('chessTugToken', myToken);
}

$(document).ready(function() {
    let savedRoom = sessionStorage.getItem('currentRoomCode');
    if (savedRoom) {
        myRoomCode = savedRoom;
        socket.emit('reconnectUser', { roomCode: savedRoom, token: myToken });
    }

    $('#showLbBtn').on('click', () => {
        $('#leaderboardModal').css('display', 'flex');
        renderLeaderboard();
    });
    $('#closeLbBtn').on('click', () => { $('#leaderboardModal').hide(); });
    $('.lb-tab').on('click', function() {
        $('.lb-tab').removeClass('active');
        $(this).addClass('active');
        currentLbTab = $(this).attr('data-tab');
        renderLeaderboard();
    });

    $('#createBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");
        const selectedLevel = $('#levelSelect').val();
        let winScore = parseInt($('#winScoreInput').val()) || 3;
        socket.emit('createRoom', { playerName: name, level: selectedLevel, winScore: winScore, token: myToken });
    });

    $('#joinBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");
        const code = String($('#roomCode').val()).trim(); 
        if (code.length === 4) {
            socket.emit('joinRoom', { roomCode: code, playerName: name, token: myToken });
            myRoomCode = code;
        } else {
            $('#lobbyMsg').text("Nhập đủ 4 số mã phòng!");
        }
    });

    $('#leaveRoomBtn').on('click', () => {
        socket.emit('leaveRoom', { roomCode: myRoomCode, token: myToken });
        sessionStorage.removeItem('currentRoomCode');
        window.location.reload();
    });

    $('#startTournamentBtn').on('click', () => { socket.emit('startTournament', myRoomCode); });
    $('#backToLobbyBtn').on('click', () => { sessionStorage.removeItem('currentRoomCode'); window.location.reload(); });
    
    $('#board').on('click', '.square-55d63', function() {
        if (isSpectator) return; 
        let square = $(this).attr('data-square');
        if (square) handleSquareClick(square);
    });

    $('.emoji-btn').on('click', function() {
        if (isSpectator) return;
        let emoji = $(this).attr('data-emoji');
        socket.emit('sendEmoji', { roomCode: myRoomCode, token: myToken, emoji: emoji });
        showFloatingEmoji(emoji, 'me');
    });

    $('#bracketContent').on('click', '.watch-btn', function() {
        let matchId = $(this).attr('data-match');
        socket.emit('watchMatch', { roomCode: myRoomCode, matchId: matchId });
    });

    $('#exitSpectateBtn').on('click', () => {
        isSpectator = false;
        $('#gameArea').hide(); $('#bracketArea').show();
    });
});

socket.on('updateLeaderboard', (data) => {
    globalLeaderboard = data || { daily: {}, weekly: {}, monthly: {} };
    if ($('#leaderboardModal').is(':visible')) renderLeaderboard();
});

function renderLeaderboard() {
    if (!globalLeaderboard) globalLeaderboard = { daily: {}, weekly: {}, monthly: {} };
    let dataObj = globalLeaderboard[currentLbTab] || {};
    let sortedArr = Object.keys(dataObj).map(name => ({ name: name, score: dataObj[name] })).sort((a, b) => b.score - a.score);

    let html = '';
    if (sortedArr.length === 0) {
        html = '<tr><td colspan="3" style="text-align:center;">Chưa có dữ liệu thi đấu</td></tr>';
    } else {
        sortedArr.forEach((player, index) => {
            let medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
            html += `<tr><td>${medal}</td><td>${player.name}</td><td><strong>${player.score}</strong></td></tr>`;
        });
    }
    $('#lbTable tbody').html(html);
}

socket.on('reconnectFailed', () => {
    sessionStorage.removeItem('currentRoomCode');
    $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').hide(); $('#lobby').show();
});
socket.on('roomDestroyed', () => { sessionStorage.removeItem('currentRoomCode'); window.location.reload(); });
socket.on('roomCreated', (data) => { 
    myRoomCode = data.roomCode; sessionStorage.setItem('currentRoomCode', myRoomCode);
    $('#lobby').hide(); $('#bracketArea').hide(); $('#gameArea').hide(); $('#waitingRoom').show();
    $('#waitRoomCode').text(data.roomCode);
    if (data.isHost) { $('#startTournamentBtn').show(); $('#waitStatus').text("Bạn là chủ giải, hãy bấm Bắt đầu khi đủ người!"); }
});
socket.on('updateWaitingRoom', (players) => {
    $('#playerList').empty(); players.forEach(p => { $('#playerList').append(`<li>👦 ${p.name}</li>`); });
});
socket.on('errorMsg', (msg) => { $('#lobbyMsg').text(msg); sessionStorage.removeItem('currentRoomCode'); });

socket.on('showBracket', (bracket) => {
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#gameArea').hide(); $('#bracketArea').show();
    renderBracket(bracket);
    let count = 5; $('#bracketStatus').text(`Trận đấu bắt đầu sau ${count}s...`);
    let iv = setInterval(() => { count--; $('#bracketStatus').text(`Trận đấu bắt đầu sau ${count}s...`); if (count <= 0) clearInterval(iv); }, 1000);
});
socket.on('updateBracketOnly', (bracket) => { renderBracket(bracket); });

function renderBracket(bracket) {
    let html = '';
    bracket.forEach((round, rIdx) => {
        html += `<div class="bracket-round"><h3>Vòng ${rIdx + 1}</h3>`;
        round.forEach(m => {
            let p1Name = m.p1 ? m.p1.name : '---'; let p2Name = m.p2 ? m.p2.name : '---';
            let winnerText = m.winner ? `<span class="winner-text">🏆 Thắng: ${m.winner.name}</span>` : '';
            if (m.isBye) { html += `<div class="match-bye"><div class="match-player">${p1Name}</div><div class="match-vs">(Đặc cách vòng này)</div>${winnerText}</div>`; } 
            else {
                let watchBtnHtml = (!m.winner && !m.isBye) ? `<button class="watch-btn" data-match="${m.id}">👀 Xem</button>` : '';
                html += `<div class="match-box"><div class="match-player">${p1Name}</div><div class="match-vs">VS</div><div class="match-player">${p2Name}</div>${winnerText}${watchBtnHtml}</div>`;
            }
        });
        html += `</div>`;
    });
    $('#bracketContent').html(html);
}

socket.on('gameStart', (data) => {
    isSpectator = false;
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').show();
    $('#exitSpectateBtn').hide(); $('#emojiPanel').show(); 
    currentWinScore = data.winScore; currentPuzzleRound = data.puzzleRound; amIP1 = data.isP1; 
    $('#displayWinScore').text(currentWinScore); $('.player').eq(0).text("👦 Bạn"); $('#opponentNameDisplay').text(data.opponentName + " 👧");
    $('#status').text("Đang tải dữ liệu cờ...");
    initBoard();
    $.getJSON(`puzzles_level${data.level}.json`, function(puzzles) {
        puzzleList = puzzles; isMyTurnToSolve = true;
        updateRopeUI(data.ropePosition); loadPuzzle(data.puzzleSeed);
    });
});

socket.on('spectateStart', (data) => {
    isSpectator = true;
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').show();
    $('#exitSpectateBtn').show(); $('#emojiPanel').hide(); 
    currentWinScore = data.winScore; currentPuzzleRound = data.puzzleRound; amIP1 = true; 
    $('#displayWinScore').text(currentWinScore); $('.player').eq(0).text(data.p1Name + " (P1)"); $('#opponentNameDisplay').text(data.p2Name + " (P2)");
    $('#status').text("📺 Đang truyền hình trực tiếp...");
    initBoard();
    $.getJSON(`puzzles_level${data.level}.json`, function(puzzles) {
        puzzleList = puzzles; isMyTurnToSolve = false;
        updateRopeUI(data.ropePosition); loadPuzzle(data.puzzleSeed);
    });
});

socket.on('spectateEnd', (data) => {
    if (isSpectator) {
        isSpectator = false; $('#gameArea').hide(); $('#bracketArea').show();
        renderBracket(data.bracket); alert(`Trận đấu kết thúc! Vị trí chiến thắng thuộc về: ${data.winner}`);
    }
});

socket.on('byeMatch', () => { $('#bracketStatus').html("<strong style='color:green;'>Bạn được đặc cách vòng này! Đang chờ đối thủ khác thi đấu...</strong>"); });
socket.on('update_game', (data) => {
    currentPuzzleRound = data.puzzleRound; updateRopeUI(data.ropePosition);
    $('#status').text(isSpectator ? "📺 Thế trận vừa thay đổi!" : "Thế trận đã thay đổi!"); loadPuzzle(data.puzzleSeed);
});
socket.on('matchResult', (data) => {
    isMyTurnToSolve = false; $('#gameArea').hide(); $('#bracketArea').show(); $('#bracketStatus').text(`Đang chờ các nhánh khác...`);
    renderBracket(data.bracket);
});
socket.on('tournamentOver', (data) => {
    sessionStorage.removeItem('currentRoomCode'); 
    $('#victoryText').html(`🏆 CHÚC MỪNG 🏆<br>${data.champion} ĐÃ VÔ ĐỊCH GIẢI ĐẤU!`); $('#victoryModal').css('display', 'flex');
});
socket.on('receiveEmoji', (emoji) => { showFloatingEmoji(emoji, 'opponent'); });

function showFloatingEmoji(emoji, side) {
    let $emoji = $('<div class="floating-emoji"></div>').text(emoji);
    if (side === 'me') { $emoji.css({ bottom: '-20px', left: '10%' }); } else { $emoji.css({ bottom: '-20px', right: '10%' }); }
    $('#tugOfWar').append($emoji); setTimeout(() => { $emoji.remove(); }, 1500);
}

function updateRopeUI(position) {
    let visualPos = amIP1 ? position : -position;
    let percent = 50 + (visualPos * (45 / currentWinScore));
    $('#marker').css('left', percent + '%');
}

function loadPuzzle(seed) {
    if (!puzzleList || puzzleList.length === 0) return;
    currentPuzzle = puzzleList[seed % puzzleList.length];
    currentMoveIndex = 0; selectedSquare = null; $('.square-55d63').removeClass('highlight-square');
    game.load(currentPuzzle.fen); board.position(currentPuzzle.fen, false);
    board.orientation(game.turn() === 'w' ? 'black' : 'white');
    if (computerMoveTimer) clearTimeout(computerMoveTimer);
    computerMoveTimer = setTimeout(makeComputerMove, 600); 
}

function makeComputerMove() {
    if (!currentPuzzle || currentMoveIndex >= currentPuzzle.solution.length) return;
    let moveRaw = currentPuzzle.solution[currentMoveIndex];
    let move = Array.isArray(moveRaw) ? moveRaw[0] : moveRaw; 
    game.move({ from: move.substring(0, 2), to: move.substring(2, 4), promotion: move.length > 4 ? move[4] : 'q' });
    board.position(game.fen()); currentMoveIndex++; 
    if (!isSpectator) { $('#status').text(currentMoveIndex === 1 ? "🔥 Nước đi sai lầm của địch! Trừng phạt ngay!" : "Địch đáp trả! Tính tiếp đi!"); }
}

function handleSquareClick(square) {
    if (isSpectator || !isMyTurnToSolve || currentMoveIndex % 2 === 0) return; 
    let piece = game.get(square); let turnColor = game.turn();

    if (!selectedSquare) {
        if (piece && piece.color === turnColor) {
            selectedSquare = square; 
            $('.square-55d63').removeClass('highlight-square'); 
            $('.square-' + square).addClass('highlight-square');
        } return;
    }

    // Nếu nhấp lại vào chính quân cờ đó -> Bỏ chọn
    if (selectedSquare === square) {
        selectedSquare = null; $('.square-55d63').removeClass('highlight-square');
        return;
    }

    let expectedMoves = currentPuzzle.solution[currentMoveIndex];
    if (!Array.isArray(expectedMoves)) expectedMoves = [expectedMoves];

    let matchExpected = expectedMoves.find(m => m.length === 5 && m.startsWith(selectedSquare + square));
    let promoPiece = matchExpected ? matchExpected[4] : 'q';
    let move = game.move({ from: selectedSquare, to: square, promotion: promoPiece });
    
    if (move) {
        $('.square-55d63').removeClass('highlight-square');
        let moveStr = selectedSquare + square + (move.promotion ? move.promotion : '');
        selectedSquare = null;

        if (expectedMoves.includes(moveStr)) {
            board.position(game.fen()); currentMoveIndex++;
            if (currentMoveIndex === currentPuzzle.solution.length) {
                $('#status').text("Tuyệt vời! Đang giật dây kéo co...");
                socket.emit('solved_puzzle', { roomCode: myRoomCode, token: myToken, puzzleRound: currentPuzzleRound });
            } else {
                $('#status').text("Chính xác! Đợi máy phản đòn...");
                if (computerMoveTimer) clearTimeout(computerMoveTimer); computerMoveTimer = setTimeout(makeComputerMove, 600);
            }
        } else { 
            game.undo(); $('#status').text("Đi sai rồi. Tính lại đi!"); 
            board.position(game.fen()); 
        }
    } else {
        if (piece && piece.color === turnColor) {
            selectedSquare = square; $('.square-55d63').removeClass('highlight-square'); $('.square-' + square).addClass('highlight-square');
        } else { selectedSquare = null; $('.square-55d63').removeClass('highlight-square'); }
    }
}

function onDragStart(source, piece, position, orientation) {
    if (isSpectator || !isMyTurnToSolve || currentMoveIndex % 2 === 0) return false; 
    if ((orientation === 'white' && piece.search(/^b/) !== -1) || (orientation === 'black' && piece.search(/^w/) !== -1)) return false;
    selectedSquare = null; $('.square-55d63').removeClass('highlight-square');
}

function onDrop(source, target) {
    if (currentMoveIndex % 2 === 0) return 'snapback';
    
    let expectedMoves = currentPuzzle.solution[currentMoveIndex];
    if (!Array.isArray(expectedMoves)) expectedMoves = [expectedMoves];

    let matchExpected = expectedMoves.find(m => m.length === 5 && m.startsWith(source + target));
    let promoPiece = matchExpected ? matchExpected[4] : 'q';
    let move = game.move({ from: source, to: target, promotion: promoPiece });
    
    if (!move) return 'snapback'; 
    
    let moveStr = source + target + (move.promotion ? move.promotion : '');

    if (expectedMoves.includes(moveStr)) {
        currentMoveIndex++;
        if (currentMoveIndex === currentPuzzle.solution.length) {
            $('#status').text("Tuyệt vời! Đang giật dây kéo co...");
            socket.emit('solved_puzzle', { roomCode: myRoomCode, token: myToken, puzzleRound: currentPuzzleRound });
        } else {
            $('#status').text("Chính xác! Đợi máy phản đòn...");
            if (computerMoveTimer) clearTimeout(computerMoveTimer); computerMoveTimer = setTimeout(makeComputerMove, 600);
        }
    } else { 
        game.undo(); $('#status').text("Đi sai rồi. Tính lại đi!"); 
        return 'snapback'; 
    }
}

function initBoard() {
    if (board) { board.position('start', false); return; }
    board = Chessboard('board', { draggable: true, position: 'start', onDragStart: onDragStart, onDrop: onDrop, pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png' });
}
