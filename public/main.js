const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 1000,
    timeout: 20000
});
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
let currentRoundMode = 'regular';
let puzzleDeadlineAt = null;
let puzzleTimerInterval = null;

let globalLeaderboard = { daily: {}, weekly: {}, monthly: {} };
let currentLbTab = 'daily';
let puzzleCacheByLevel = {};
let lastTournamentResults = null;

let myToken = localStorage.getItem('chessTugToken');
if (!myToken) {
    myToken = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('chessTugToken', myToken);
}

function normalizeRoomCode(raw) {
    return (raw || '').trim().replace(/\D/g, '');
}

function escapeHtml(text) {
    return $('<span>').text(text || '').html();
}

let pendingJoin = null;
let joinTimeoutId = null;
let pendingCreate = null;
let createTimeoutId = null;
let autoReconnectCancelled = false;
const MAX_PLAYERS = 64;

function applyJoinedRoom(data) {
    if (!data || !data.roomCode) return;
    clearPendingJoin();
    clearPendingCreate();
    myRoomCode = data.roomCode;
    sessionStorage.setItem('currentRoomCode', myRoomCode);
    $('#lobbyMsg').text('');
    $('#lobby').hide();
    $('#bracketArea').hide();
    $('#gameArea').hide();
    $('#waitingRoom').show();
    $('#waitRoomCode').text(data.roomCode);
    $('#startTournamentBtn').prop('disabled', true);
    if (data.isHost) {
        $('#startTournamentBtn').show().text('Bắt Đầu Bốc Thăm & Đấu');
        $('#waitStatus').text('Bạn là chủ giải — chia sẻ mã phòng cho tối đa 64 người!');
    } else {
        $('#startTournamentBtn').hide();
        $('#waitStatus').text('Đang chờ chủ phòng bắt đầu...');
    }
    $('#waitPlayerCount').text(`${data.playerCount || 1}/${data.maxPlayers || MAX_PLAYERS} người`);
}

function clearPendingJoin() {
    pendingJoin = null;
    if (joinTimeoutId) {
        clearTimeout(joinTimeoutId);
        joinTimeoutId = null;
    }
}

function attemptJoinRoom(code, name) {
    clearPendingJoin();
    pendingJoin = { code, name, retries: 0 };
    doJoinRoom();
}

function doJoinRoom() {
    if (!pendingJoin || myRoomCode) return;

    const { code, name, retries } = pendingJoin;
    $('#lobbyMsg').text(retries > 0 ? `Đang vào phòng (thử lại lần ${retries})...` : 'Đang vào phòng...');

    if (joinTimeoutId) clearTimeout(joinTimeoutId);
    joinTimeoutId = setTimeout(() => {
        if (myRoomCode || !pendingJoin) return;
        if (pendingJoin.retries < 3) {
            pendingJoin.retries++;
            if (socket.connected) {
                doJoinRoom();
            } else {
                whenSocketReady(doJoinRoom);
            }
        } else {
            clearPendingJoin();
            $('#lobbyMsg').text('Không nhận được phản hồi từ máy chủ. Kiểm tra mạng rồi bấm Vào Giải lại.');
        }
    }, 8000);

    socket.emit('joinRoom', { roomCode: code, playerName: name, token: myToken }, (res) => {
        if (joinTimeoutId) {
            clearTimeout(joinTimeoutId);
            joinTimeoutId = null;
        }
        if (res && res.ok) {
            applyJoinedRoom(res);
        } else if (res && !res.ok) {
            clearPendingJoin();
            if ($('#lobby').is(':visible')) {
                $('#lobbyMsg').text(res.error || 'Không vào được phòng.');
            }
        }
    });
}

function clearPendingCreate() {
    pendingCreate = null;
    if (createTimeoutId) {
        clearTimeout(createTimeoutId);
        createTimeoutId = null;
    }
}

function attemptCreateRoom(settings) {
    clearPendingCreate();
    pendingCreate = { settings, retries: 0 };
    doCreateRoom();
}

function doCreateRoom() {
    if (!pendingCreate || myRoomCode) return;

    const { settings, retries } = pendingCreate;
    $('#lobbyMsg').text(retries > 0 ? `Đang tạo giải đấu (thử lại lần ${retries})...` : 'Đang tạo giải đấu...');

    if (createTimeoutId) clearTimeout(createTimeoutId);
    createTimeoutId = setTimeout(() => {
        if (myRoomCode || !pendingCreate) return;
        if (pendingCreate.retries < 3) {
            pendingCreate.retries++;
            if (socket.connected) {
                doCreateRoom();
            } else {
                whenSocketReady(doCreateRoom);
            }
        } else {
            clearPendingCreate();
            $('#lobbyMsg').text('Không nhận được phản hồi từ máy chủ. Kiểm tra mạng rồi thử tạo lại.');
        }
    }, 8000);

    socket.emit('createRoom', settings, (res) => {
        if (createTimeoutId) {
            clearTimeout(createTimeoutId);
            createTimeoutId = null;
        }
        if (res && res.ok) {
            applyJoinedRoom(res);
        } else if (res && !res.ok) {
            clearPendingCreate();
            if ($('#lobby').is(':visible')) {
                $('#lobbyMsg').text(res.error || 'Không tạo được giải đấu.');
            }
        }
    });
}

function renderWaitingRoom(data) {
    const players = Array.isArray(data) ? data : (data.players || []);
    const maxPlayers = data.maxPlayers || MAX_PLAYERS;
    $('#waitPlayerCount').text(`${players.length}/${maxPlayers} người`);
    $('#playerList').empty();
    players.forEach(p => {
        $('#playerList').append(`<li>👦 ${escapeHtml(p.name)}</li>`);
    });

    const isHost = $('#startTournamentBtn').is(':visible');
    if (isHost) {
        const canStart = players.length >= 2;
        $('#startTournamentBtn').prop('disabled', !canStart);
        if (!canStart) {
            $('#waitStatus').text('Cần ít nhất 2 người để bắt đầu giải.');
        } else if (players.length >= maxPlayers) {
            $('#waitStatus').text('Đủ người! Bạn có thể bắt đầu giải đấu.');
        } else {
            $('#waitStatus').text(`Đã có ${players.length} người — tối đa ${maxPlayers}. Bấm Bắt đầu khi sẵn sàng!`);
        }
    } else if (players.length >= maxPlayers) {
        $('#waitStatus').text('Phòng đã đủ người! Đang chờ chủ phòng bắt đầu...');
    }
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

function stopPuzzleTimer() {
    if (puzzleTimerInterval) {
        clearInterval(puzzleTimerInterval);
        puzzleTimerInterval = null;
    }
}

function startPuzzleTimer(deadlineAt, timeLimitMs) {
    puzzleDeadlineAt = deadlineAt || (Date.now() + (timeLimitMs || 60000));
    stopPuzzleTimer();

    const render = () => {
        const remainingMs = Math.max(0, puzzleDeadlineAt - Date.now());
        const seconds = Math.ceil(remainingMs / 1000);
        const modeLabel = currentRoundMode === 'sudden_death' ? '⚡ SD' : '⏱️';
        $('#puzzleTimer').text(`${modeLabel} ${seconds}s`);
        if (remainingMs <= 0) stopPuzzleTimer();
    };

    render();
    puzzleTimerInterval = setInterval(render, 250);
}

function loadPuzzlesForLevel(level, callback) {
    if (puzzleCacheByLevel[level]) {
        callback(puzzleCacheByLevel[level]);
        return;
    }
    $.getJSON(`/api/puzzles/${level}`, function(puzzles) {
        puzzleCacheByLevel[level] = puzzles;
        callback(puzzles);
    }).fail(() => {
        $('#status').text('Không tải được bài tập. Thử tải lại trang.');
    });
}

function showCountdownOverlay(label, seconds) {
    $('#countdownLabel').text(label);
    if (seconds > 0) {
        $('#countdownNumber').text(seconds);
        $('#countdownOverlay').css('display', 'flex');
    } else {
        $('#countdownNumber').text('GO!');
        setTimeout(() => $('#countdownOverlay').hide(), 600);
    }
}

function renderTournamentResults(data) {
    lastTournamentResults = data;
    let html = `<p><strong>Mã giải:</strong> ${escapeHtml(data.roomCode || '')} | <strong>${data.totalPlayers || 0} kỳ thủ</strong></p>`;
    html += '<table class="results-table"><thead><tr><th>Hạng</th><th>Kỳ thủ</th></tr></thead><tbody>';
    (data.top8 || []).forEach(p => {
        html += `<tr><td>${p.medal}</td><td>${escapeHtml(p.name)}</td></tr>`;
    });
    html += '</tbody></table>';
    $('#resultsPanel').html(html);
}

$(document).ready(function() {
    const savedRoom = normalizeRoomCode(sessionStorage.getItem('currentRoomCode'));
    if (savedRoom.length === 4) {
        whenSocketReady(() => {
            if (autoReconnectCancelled) return;
            socket.emit('reconnectUser', { roomCode: savedRoom, token: myToken });
        });
    } else if (sessionStorage.getItem('currentRoomCode')) {
        sessionStorage.removeItem('currentRoomCode');
    }

    $('#showRulesBtn').on('click', () => { $('#rulesModal').css('display', 'flex'); });
    $('#closeRulesBtn').on('click', () => { $('#rulesModal').hide(); });

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
        let winScore = parseInt($('#winScoreInput').val());
        if (isNaN(winScore) || winScore < 3) winScore = 3;

        whenSocketReady(() => {
            autoReconnectCancelled = true;
            sessionStorage.removeItem('currentRoomCode');
            myRoomCode = null;
            attemptCreateRoom({ playerName: name, level: selectedLevel, winScore: winScore, token: myToken });
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
            autoReconnectCancelled = true;
            sessionStorage.removeItem('currentRoomCode');
            myRoomCode = null;
            attemptJoinRoom(code, name);
        });
    });

    $('#leaveRoomBtn').on('click', () => {
        socket.emit('leaveRoom', { roomCode: myRoomCode, token: myToken });
        sessionStorage.removeItem('currentRoomCode');
        window.location.reload();
    });

    $('#startTournamentBtn').on('click', () => {
        socket.emit('startTournament', { roomCode: myRoomCode, token: myToken });
    });
    $('#backToLobbyBtn').on('click', () => { sessionStorage.removeItem('currentRoomCode'); window.location.reload(); });

    $('#copyResultsBtn').on('click', () => {
        if (!lastTournamentResults?.exportText) return;
        navigator.clipboard.writeText(lastTournamentResults.exportText).then(() => {
            $('#copyResultsBtn').text('✅ Đã copy!');
            setTimeout(() => $('#copyResultsBtn').text('📋 Copy kết quả'), 2000);
        });
    });

    $('#downloadResultsBtn').on('click', () => {
        if (!lastTournamentResults?.exportText) return;
        const blob = new Blob([lastTournamentResults.exportText], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ket-qua-giai-${lastTournamentResults.roomCode || 'keoco'}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
    });
    
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

    $('#bracketContent').on('click', '.bracket-toggle', function() {
        const $round = $(this).closest('.bracket-round-collapsed');
        const $details = $round.find('.round-details');
        const $icon = $(this).find('.toggle-icon');
        $details.slideToggle(200, function() {
            $icon.text($details.is(':visible') ? '▼' : '▶');
        });
    });

    $('#exitSpectateBtn').on('click', () => {
        stopPuzzleTimer();
        isSpectator = false;
        $('#gameArea').hide();
        $('#bracketArea').show();
    });
});

socket.on('connect', () => {
    if (pendingJoin && !myRoomCode) {
        doJoinRoom();
        return;
    }
    if (pendingCreate && !myRoomCode) {
        doCreateRoom();
        return;
    }
    if (myRoomCode) {
        socket.emit('reconnectUser', { roomCode: myRoomCode, token: myToken });
        return;
    }
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
    stopPuzzleTimer();
    if ($('#lobby').is(':visible')) {
        $('#lobbyMsg').text('Mất kết nối máy chủ. Đang thử kết nối lại...');
    }
});

socket.on('reconnectFailed', () => {
    sessionStorage.removeItem('currentRoomCode');
    myRoomCode = null;
    if ($('#lobby').is(':visible')) {
        $('#lobbyMsg').text('Phiên phòng cũ đã hết hạn. Nhập mã phòng mới để vào giải.');
    }
});

socket.on('roomCreated', (data) => {
    applyJoinedRoom(data);
});
socket.on('updateLeaderboard', (data) => {
    globalLeaderboard = data || { daily: {}, weekly: {}, monthly: {} };
    if ($('#leaderboardModal').is(':visible')) renderLeaderboard();
});

socket.on('errorMsg', (msg) => {
    clearPendingJoin();
    clearPendingCreate();
    stopPuzzleTimer();
    sessionStorage.removeItem('currentRoomCode');
    myRoomCode = null;
    $('#lobby').show();
    $('#waitingRoom').hide();
    $('#bracketArea').hide();
    $('#gameArea').hide();
    $('#startTournamentBtn').hide();
    $('#lobbyMsg').text(msg);
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

socket.on('roomDestroyed', () => { stopPuzzleTimer(); sessionStorage.removeItem('currentRoomCode'); window.location.reload(); });
socket.on('updateWaitingRoom', (data) => { renderWaitingRoom(data); });
socket.on('hostChanged', (data) => {
    $('#waitStatus').text(data.message || 'Chủ giải đã thay đổi.');
    if (data.hostToken === myToken) {
        $('#startTournamentBtn').show().text('Bắt Đầu Bốc Thăm & Đấu');
    } else {
        $('#startTournamentBtn').hide();
    }
});
socket.on('waitNotice', (msg) => { $('#waitStatus').text(msg); });

socket.on('tournamentCountdown', (data) => {
    $('#startTournamentBtn').prop('disabled', true);
    if (data.seconds > 0) {
        $('#waitStatus').text(`Giải bắt đầu sau ${data.seconds} giây...`);
        showCountdownOverlay('🔥 Giải sắp bắt đầu!', data.seconds);
    } else {
        $('#waitingRoom').hide();
        $('#countdownOverlay').hide();
    }
});

socket.on('roundCountdown', (data) => {
    if (data.seconds > 0) {
        $('#bracketStatus').text(`Trận đấu bắt đầu sau ${data.seconds}s...`);
    } else {
        $('#bracketStatus').text('⚔️ Bắt đầu!');
    }
});

socket.on('showBracket', (bracket) => {
    stopPuzzleTimer();
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#gameArea').hide(); $('#countdownOverlay').hide();
    $('#bracketArea').show();
    renderBracket(bracket);
    $('#bracketStatus').text('Chuẩn bị vào trận đấu...');
});
socket.on('updateBracketOnly', (data) => { renderBracket(data); });

function renderMatchHtml(m) {
    let p1Name = escapeHtml(m.p1 ? m.p1.name : '---');
    let p2Name = escapeHtml(m.p2 ? m.p2.name : '---');
    let winnerText = m.winner ? `<span class="winner-text">🏆 ${escapeHtml(m.winner.name)}</span>` : '';
    if (m.isBye) {
        return `<div class="match-bye"><div class="match-player">${p1Name}</div><div class="match-vs">(Đặc cách)</div>${winnerText}</div>`;
    }
    let watchBtnHtml = (!m.winner && !m.isBye) ? `<button class="watch-btn" data-match="${m.id}">👀 Xem</button>` : '';
    return `<div class="match-box"><div class="match-player">${p1Name}</div><div class="match-vs">VS</div><div class="match-player">${p2Name}</div>${winnerText}${watchBtnHtml}</div>`;
}

function renderBracket(data) {
    const rounds = Array.isArray(data) ? data : (data.bracket || []);
    const currentRoundIndex = Array.isArray(data) ? rounds.length - 1 : (data.currentRoundIndex ?? rounds.length - 1);
    let html = '';

    rounds.forEach((round, rIdx) => {
        const isPast = rIdx < currentRoundIndex;
        const isCurrent = rIdx === currentRoundIndex;
        const doneCount = round.filter(m => m.winner).length;
        const totalCount = round.length;

        if (isPast) {
            html += `<div class="bracket-round bracket-round-collapsed">`;
            html += `<h3 class="bracket-toggle"><span class="toggle-icon">▶</span> Vòng ${rIdx + 1} <span class="round-summary">(${doneCount}/${totalCount} trận xong — nhấn để xem)</span></h3>`;
            html += `<div class="round-details" style="display:none"><div class="bracket-matches-grid">`;
            round.forEach(m => { html += renderMatchHtml(m); });
            html += `</div></div></div>`;
        } else if (isCurrent) {
            html += `<div class="bracket-round bracket-round-active">`;
            html += `<h3>🔴 Vòng ${rIdx + 1} — ĐANG ĐẤU <span class="round-summary">(${doneCount}/${totalCount} trận xong)</span></h3>`;
            html += `<div class="bracket-matches-grid">`;
            round.forEach(m => { html += renderMatchHtml(m); });
            html += `</div></div>`;
        }
    });

    $('#bracketContent').html(html);
    const $active = $('.bracket-round-active');
    if ($active.length) {
        $('#bracketContent').scrollTop($active.position().top + $('#bracketContent').scrollTop() - 20);
    }
}

socket.on('gameStart', (data) => {
    isSpectator = false;
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').show();
    $('#exitSpectateBtn').hide(); $('#emojiPanel').show(); 
    currentWinScore = data.winScore; currentPuzzleRound = data.puzzleRound; amIP1 = data.isP1; 
    currentRoundMode = data.roundMode || 'regular';
    $('#displayWinScore').text(currentWinScore); $('.player').eq(0).text("👦 Bạn"); $('#opponentNameDisplay').text(data.opponentName + " 👧");
    $('#status').text("Đang tải dữ liệu cờ...");
    startPuzzleTimer(data.deadlineAt, data.timeLimitMs);
    initBoard();
    loadPuzzlesForLevel(data.level, function(puzzles) {
        puzzleList = puzzles; isMyTurnToSolve = true;
        updateRopeUI(data.ropePosition); loadPuzzle(data.puzzleSeed);
    });
});

socket.on('spectateStart', (data) => {
    isSpectator = true;
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').show();
    $('#exitSpectateBtn').show(); $('#emojiPanel').hide(); 
    currentWinScore = data.winScore; currentPuzzleRound = data.puzzleRound; amIP1 = true; 
    currentRoundMode = data.roundMode || 'regular';
    $('#displayWinScore').text(currentWinScore); $('.player').eq(0).text(data.p1Name + " (P1)"); $('#opponentNameDisplay').text(data.p2Name + " (P2)");
    $('#status').text("📺 Đang truyền hình trực tiếp...");
    startPuzzleTimer(data.deadlineAt, data.timeLimitMs);
    initBoard();
    loadPuzzlesForLevel(data.level, function(puzzles) {
        puzzleList = puzzles; isMyTurnToSolve = false;
        updateRopeUI(data.ropePosition); loadPuzzle(data.puzzleSeed);
    });
});

socket.on('spectateEnd', (data) => {
    if (isSpectator) {
        stopPuzzleTimer();
        isSpectator = false; $('#gameArea').hide(); $('#bracketArea').show();
        renderBracket(data.bracket); alert(`Trận đấu kết thúc! Vị trí chiến thắng thuộc về: ${data.winner}`);
    }
});

socket.on('byeMatch', () => { $('#bracketStatus').html("<strong style='color:green;'>Bạn được đặc cách vòng này! Đang chờ đối thủ khác thi đấu...</strong>"); });
socket.on('update_game', (data) => {
    if (data.roundMode) currentRoundMode = data.roundMode;
    currentPuzzleRound = data.puzzleRound; updateRopeUI(data.ropePosition);
    startPuzzleTimer(data.deadlineAt, data.timeLimitMs);
    $('#status').text(isSpectator ? "📺 Thế trận vừa thay đổi!" : "Thế trận đã thay đổi!"); loadPuzzle(data.puzzleSeed);
    if (data.message) {
        $('#status').text(data.message);
    }
});
socket.on('matchResult', (data) => {
    stopPuzzleTimer();
    isMyTurnToSolve = false; $('#gameArea').hide(); $('#bracketArea').show(); $('#bracketStatus').text(`Đang chờ các nhánh khác...`);
    renderBracket(data.bracket);
    if (data.reason) {
        $('#bracketStatus').text(data.reason);
    }
});
socket.on('tournamentOver', (data) => {
    stopPuzzleTimer();
    sessionStorage.removeItem('currentRoomCode');
    const champion = data.champion || data;
    const name = typeof champion === 'string' ? champion : champion.name;
    $('#victoryText').html(`🏆 CHÚC MỪNG 🏆<br>${escapeHtml(name)} ĐÃ VÔ ĐỊCH!`);
    if (data.top8) renderTournamentResults(data);
    $('#victoryModal').css('display', 'flex');
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
            if (!isSpectator && currentRoundMode === 'sudden_death') {
                isMyTurnToSolve = false;
                socket.emit('playerMistake', { roomCode: myRoomCode, token: myToken, puzzleRound: currentPuzzleRound });
                $('#status').text("Bạn đi sai trong Sudden Death! Chờ kết quả...");
            }
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
        if (!isSpectator && currentRoundMode === 'sudden_death') {
            isMyTurnToSolve = false;
            socket.emit('playerMistake', { roomCode: myRoomCode, token: myToken, puzzleRound: currentPuzzleRound });
            $('#status').text("Bạn đi sai trong Sudden Death! Chờ kết quả...");
        }
        return 'snapback'; 
    }
}

function initBoard() {
    if (board) { board.position('start', false); return; }
    board = Chessboard('board', { draggable: true, position: 'start', onDragStart: onDragStart, onDrop: onDrop, pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png' });
}
