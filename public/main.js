import { Chessground } from '/vendor/chessground/dist/chessground.min.js';

const $ = window.jQuery;
const Chess = window.Chess;
const io = window.io;

const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 1000,
    timeout: 20000
});
let game = new Chess();
let ground = null;
let myRoomCode = null;
let isMyTurnToSolve = false; 
let puzzleList = [];
let currentPuzzle = null;
let currentMoveIndex = 0; 
let currentWinScore = 3; 
let currentPuzzleRound = 1; 
let computerMoveTimer = null; 
let amIP1 = true; 
let isSpectator = false; 
let currentRoundMode = 'regular';
let puzzleDeadlineAt = null;
let puzzleTimerInterval = null;
let boardOrientation = 'white';

let globalLeaderboard = { daily: {}, weekly: {}, monthly: {}, periods: {} };
let currentLbTab = 'daily';
let puzzleCacheByLevel = {};
let lastTournamentResults = null;
let myShortId = null;
let nameLocked = false;
let currentMatchId = null;
let moveSubmitPending = false;

let myToken = localStorage.getItem('chessTugToken');
if (!myToken) {
    myToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('chessTugToken', myToken);
}

function shortIdFromToken(token) {
    return String(token || '').slice(0, 6).toLowerCase();
}

function updatePlayerIdentityUI(profile) {
    myShortId = (profile && profile.shortId) || shortIdFromToken(myToken);
    $('#playerIdHint').text(`ID kỳ thủ: #${myShortId}`);
    if (profile && profile.registered && profile.name) {
        nameLocked = true;
        $('#playerName').val(profile.name).prop('readonly', true);
        $('#playerIdHint').addClass('locked').text(`ID kỳ thủ: #${myShortId} (tên đã khóa)`);
        localStorage.setItem('chessTugName', profile.name);
    }
}

function normalizeRoomCode(raw) {
    return (raw || '').trim().replace(/\D/g, '');
}

function buildInviteLink(roomCode) {
    return `${location.origin}${location.pathname}?room=${roomCode}`;
}

function updateInviteLink(roomCode) {
    if (!roomCode) return;
    $('#inviteLink').val(buildInviteLink(roomCode));
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
    updateInviteLink(data.roomCode);
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
        const sid = p.shortId || shortIdFromToken(p.token);
        $('#playerList').append(
            `<li>👦 ${escapeHtml(p.name)}<span class="player-short-id">#${escapeHtml(sid)}</span></li>`
        );
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
        const $timer = $('#puzzleTimer');
        $('#timerSeconds').text(seconds);
        $timer.toggleClass('sudden', currentRoundMode === 'sudden_death');
        $timer.toggleClass('urgent', seconds <= 10 && currentRoundMode !== 'sudden_death');
        $('.timer-icon').text(currentRoundMode === 'sudden_death' ? '⚡' : '⏱️');
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
    const savedName = (localStorage.getItem('chessTugName') || '').trim();
    if (savedName) $('#playerName').val(savedName);
    $('#playerIdHint').text(`ID kỳ thủ: #${shortIdFromToken(myToken)}`);

    whenSocketReady(() => {
        socket.emit('getPlayerProfile', { token: myToken }, (res) => {
            if (res && res.ok) updatePlayerIdentityUI(res);
        });
    });

    const inviteRoom = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
    const savedRoom = normalizeRoomCode(sessionStorage.getItem('currentRoomCode'));

    if (savedRoom.length === 4 && (!inviteRoom || inviteRoom === savedRoom)) {
        whenSocketReady(() => {
            if (autoReconnectCancelled) return;
            socket.emit('reconnectUser', { roomCode: savedRoom, token: myToken });
        });
    } else {
        if (sessionStorage.getItem('currentRoomCode')) {
            sessionStorage.removeItem('currentRoomCode');
        }
        if (inviteRoom.length === 4) {
            $('#roomCode').val(inviteRoom);
            history.replaceState({}, '', location.pathname);
            if (savedName) {
                $('#lobbyMsg').text(`Bạn được mời vào giải ${inviteRoom}. Đang vào...`);
                whenSocketReady(() => {
                    autoReconnectCancelled = true;
                    myRoomCode = null;
                    attemptJoinRoom(inviteRoom, savedName);
                });
            } else {
                $('#lobbyMsg').text(`Bạn được mời vào giải ${inviteRoom}! Nhập tên rồi bấm "Vào Giải".`);
                $('#playerName').focus();
            }
        }
    }

    $('#showRulesBtn').on('click', () => { $('#rulesModal').css('display', 'flex'); });
    $('#closeRulesBtn').on('click', () => { $('#rulesModal').hide(); });

    $('#showLbBtn').on('click', () => {
        $('#leaderboardModal').css('display', 'flex');
        renderLeaderboard();
    });
    $('#closeLbBtn').on('click', () => { $('#leaderboardModal').hide(); });
    $('#closeReplayBtn').on('click', () => { $('#replayModal').hide(); });
    $('.lb-tab').on('click', function() {
        $('.lb-tab').removeClass('active');
        $(this).addClass('active');
        currentLbTab = $(this).attr('data-tab');
        renderLeaderboard();
    });

    $('#createBtn').on('click', () => {
        const name = $('#playerName').val().trim();
        if (!name) return $('#lobbyMsg').text("Vui lòng nhập tên của bạn!");
        localStorage.setItem('chessTugName', name);

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
        localStorage.setItem('chessTugName', name);

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

    $('#copyInviteBtn').on('click', async () => {
        if (!myRoomCode) return;
        const link = buildInviteLink(myRoomCode);
        const flashCopied = () => {
            const $btn = $('#copyInviteBtn');
            $btn.addClass('copied').text('✅ Đã sao chép!');
            setTimeout(() => $btn.removeClass('copied').text('🔗 Sao chép link mời'), 2000);
        };

        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Giải Cờ Vua Kéo Co',
                    text: `Vào giải cờ vua kéo co (mã ${myRoomCode}):`,
                    url: link
                });
                return;
            } catch (err) {
                if (err && err.name === 'AbortError') return;
            }
        }

        try {
            await navigator.clipboard.writeText(link);
            flashCopied();
        } catch (err) {
            const input = document.getElementById('inviteLink');
            input.focus();
            input.select();
            try {
                document.execCommand('copy');
                flashCopied();
            } catch (e) {
                $('#waitStatus').text('Không tự sao chép được — hãy copy link thủ công phía trên.');
            }
        }
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

    $('#bracketContent').on('click', '.replay-btn', function() {
        const matchId = $(this).attr('data-match');
        openReplay(matchId);
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
    if (data.playerName) {
        updatePlayerIdentityUI({
            registered: true,
            name: data.playerName,
            shortId: data.shortId || shortIdFromToken(myToken)
        });
    }
    applyJoinedRoom(data);
});
socket.on('updateLeaderboard', (data) => {
    globalLeaderboard = data || { daily: {}, weekly: {}, monthly: {}, periods: {} };
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
    if (!globalLeaderboard) globalLeaderboard = { daily: {}, weekly: {}, monthly: {}, periods: {} };
    const periods = globalLeaderboard.periods || {};
    const periodLabel = {
        daily: periods.daily ? `Kỳ: ${periods.daily}` : 'Reset mỗi ngày (GMT+7)',
        weekly: periods.weekly ? `Kỳ: ${periods.weekly}` : 'Reset mỗi tuần (GMT+7)',
        monthly: periods.monthly ? `Kỳ: ${periods.monthly}` : 'Reset mỗi tháng (GMT+7)'
    };
    $('#lbPeriodHint').text(periodLabel[currentLbTab] || '');

    let dataObj = globalLeaderboard[currentLbTab] || {};
    let sortedArr = Object.keys(dataObj).map(name => ({ name: name, score: dataObj[name] })).sort((a, b) => b.score - a.score);

    let html = '';
    if (sortedArr.length === 0) {
        html = '<tr><td colspan="3" style="text-align:center;">Chưa có dữ liệu thi đấu kỳ này</td></tr>';
    } else {
        sortedArr.forEach((player, index) => {
            let medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
            html += `<tr><td>${medal}</td><td>${escapeHtml(player.name)}</td><td><strong>${player.score}</strong></td></tr>`;
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
    let replayBtnHtml = (m.winner && !m.isBye) ? `<button class="replay-btn" data-match="${m.id}">📼 Xem lại</button>` : '';
    return `<div class="match-box"><div class="match-player">${p1Name}</div><div class="match-vs">VS</div><div class="match-player">${p2Name}</div>${winnerText}${watchBtnHtml}${replayBtnHtml}</div>`;
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
    moveSubmitPending = false;
    currentMatchId = data.matchId || null;
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').show();
    $('#exitSpectateBtn').hide(); $('#emojiPanel').show(); 
    currentWinScore = data.winScore; currentPuzzleRound = data.puzzleRound; amIP1 = data.isP1; 
    currentRoundMode = data.roundMode || 'regular';
    window._lastScoreP1 = data.scoreP1 || 0;
    window._lastScoreP2 = data.scoreP2 || 0;
    $('#myNameDisplay').text('Bạn');
    $('#opponentNameDisplay').text(data.opponentName || 'Đối thủ');
    $('#status').text("Đang tải dữ liệu cờ...").removeClass('disconnect-warn');
    startPuzzleTimer(data.deadlineAt, data.timeLimitMs);
    loadPuzzlesForLevel(data.level, function(puzzles) {
        puzzleList = puzzles; isMyTurnToSolve = true;
        updateMatchHud(data);
        loadPuzzle(data.puzzleSeed, data.acceptedMoves || []);
    });
});

socket.on('spectateStart', (data) => {
    isSpectator = true;
    moveSubmitPending = false;
    currentMatchId = data.matchId || null;
    $('#lobby').hide(); $('#waitingRoom').hide(); $('#bracketArea').hide(); $('#gameArea').show();
    $('#exitSpectateBtn').show(); $('#emojiPanel').hide(); 
    currentWinScore = data.winScore; currentPuzzleRound = data.puzzleRound; amIP1 = true; 
    currentRoundMode = data.roundMode || 'regular';
    window._lastScoreP1 = data.scoreP1 || 0;
    window._lastScoreP2 = data.scoreP2 || 0;
    $('#myNameDisplay').text((data.p1Name || 'P1') + ' (P1)');
    $('#opponentNameDisplay').text((data.p2Name || 'P2') + ' (P2)');
    $('#status').text("📺 Đang truyền hình trực tiếp...").removeClass('disconnect-warn');
    startPuzzleTimer(data.deadlineAt, data.timeLimitMs);
    loadPuzzlesForLevel(data.level, function(puzzles) {
        puzzleList = puzzles; isMyTurnToSolve = false;
        updateMatchHud(data);
        loadPuzzle(data.puzzleSeed);
    });
});

socket.on('spectateEnd', (data) => {
    if (isSpectator) {
        stopPuzzleTimer();
        isSpectator = false; $('#gameArea').hide(); $('#bracketArea').show();
        renderBracket(data.bracket);
        $('#bracketStatus').text(`Trận đấu kết thúc! Thắng: ${data.winner}`);
    }
});

socket.on('byeMatch', () => { $('#bracketStatus').html("<strong style='color:green;'>Bạn được đặc cách vòng này! Đang chờ đối thủ khác thi đấu...</strong>"); });
socket.on('update_game', (data) => {
    moveSubmitPending = false;
    if (data.roundMode) currentRoundMode = data.roundMode;
    currentPuzzleRound = data.puzzleRound;
    updateMatchHud(data);
    startPuzzleTimer(data.deadlineAt, data.timeLimitMs);
    $('#status').text(isSpectator ? "📺 Thế trận vừa thay đổi!" : "Thế trận đã thay đổi!").removeClass('disconnect-warn');
    loadPuzzle(data.puzzleSeed);
    if (data.message) {
        $('#status').text(data.message);
    }
});
socket.on('scoreUpdate', (data) => {
    updateMatchHud(data);
});
socket.on('matchResult', (data) => {
    stopPuzzleTimer();
    moveSubmitPending = false;
    isMyTurnToSolve = false; $('#gameArea').hide(); $('#bracketArea').show(); $('#bracketStatus').text(`Đang chờ các nhánh khác...`);
    renderBracket(data.bracket);
    if (data.reason) {
        $('#bracketStatus').text(data.reason);
    }
    if (data.matchId) currentMatchId = data.matchId;
});
socket.on('opponentDisconnected', (data) => {
    const secs = Math.ceil((data.graceMs || 45000) / 1000);
    $('#status').addClass('disconnect-warn').text(
        `⚠️ ${data.name || 'Đối thủ'} mất kết nối — còn ${secs}s trước khi xử thua.`
    );
});
socket.on('opponentReconnected', (data) => {
    $('#status').removeClass('disconnect-warn').text(
        `✅ ${data.name || 'Đối thủ'} đã kết nối lại. Tiếp tục đấu!`
    );
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

function openReplay(matchId) {
    if (!matchId) return;
    $('#replayPanel').html('<p>Đang tải nhật ký...</p>');
    $('#replayModal').css('display', 'flex');
    $.getJSON(`/api/matches/${matchId}`)
        .done((log) => {
            let html = `<p><strong>${escapeHtml(log.p1?.name || '?')}</strong> vs <strong>${escapeHtml(log.p2?.name || '?')}</strong></p>`;
            html += `<p>Kết quả: <strong>${escapeHtml(log.winner?.name || '---')}</strong></p>`;
            if (log.reason) html += `<p>${escapeHtml(log.reason)}</p>`;
            (log.puzzles || []).forEach((p, idx) => {
                html += `<div class="replay-block"><h4>Puzzle ${idx + 1} · seed ${p.seed} · ${p.mode}</h4>`;
                html += `<div>Kết quả: ${escapeHtml(p.outcome || '---')}</div>`;
                const moves = p.moves || {};
                Object.keys(moves).forEach(token => {
                    const label = token === log.p1?.token ? log.p1.name : (token === log.p2?.token ? log.p2.name : shortIdFromToken(token));
                    html += `<div>${escapeHtml(label)}: ${(moves[token] || []).join(', ') || '(chưa có nước)'}</div>`;
                });
                html += `</div>`;
            });
            if (!(log.puzzles || []).length) {
                html += '<p>Chưa có dữ liệu puzzle.</p>';
            }
            $('#replayPanel').html(html);
        })
        .fail(() => {
            $('#replayPanel').html('<p>Không tải được nhật ký trận (có thể trận cũ trước khi bật log).</p>');
        });
}

function showFloatingEmoji(emoji, side) {
    let $emoji = $('<div class="floating-emoji"></div>').text(emoji);
    if (side === 'me') { $emoji.css({ bottom: '-20px', left: '10%' }); } else { $emoji.css({ bottom: '-20px', right: '10%' }); }
    $('#tugOfWar').append($emoji); setTimeout(() => { $emoji.remove(); }, 1500);
}

function updateRopeUI(position, scores) {
    updateMatchHud({
        ropePosition: position,
        scoreP1: scores ? scores.scoreP1 : undefined,
        scoreP2: scores ? scores.scoreP2 : undefined,
        winScore: currentWinScore,
        puzzleRound: currentPuzzleRound,
        roundMode: currentRoundMode
    });
}

function buildPips(containerSel, filledCount, sideClass) {
    const $box = $(containerSel);
    $box.empty();
    for (let i = 0; i < currentWinScore; i++) {
        const filled = i < filledCount;
        $box.append(`<span class="score-pip${filled ? ' filled ' + sideClass : ''}"></span>`);
    }
}

function rebuildRopeTicks() {
    const $ticks = $('#ropeTicks');
    $ticks.empty();
    for (let i = -currentWinScore; i <= currentWinScore; i++) {
        if (i === 0) continue;
        const visual = amIP1 ? i : -i;
        const percent = 50 + (visual * (45 / currentWinScore));
        const isGoal = Math.abs(i) === currentWinScore;
        $ticks.append(`<span class="rope-tick${isGoal ? ' goal' : ''}" style="left:${percent}%"></span>`);
    }
}

function flashScore(side) {
    const $flash = $('#pullFlash');
    const $fighter = side === 'me' ? $('#fighterMe') : $('#fighterOpp');
    const $marker = $('#marker');
    $flash.removeClass('show-me show-opp');
    $fighter.removeClass('just-scored');
    $marker.removeClass('yank');
    if ($flash[0]) void $flash[0].offsetWidth;
    $flash.addClass(side === 'me' ? 'show-me' : 'show-opp');
    $fighter.addClass('just-scored');
    $marker.addClass('yank');
}

function updateMatchHud(data) {
    if (!data) return;
    if (data.winScore) currentWinScore = data.winScore;
    if (data.puzzleRound) currentPuzzleRound = data.puzzleRound;
    if (data.roundMode) currentRoundMode = data.roundMode;

    const scoreP1 = data.scoreP1 != null ? data.scoreP1 : (window._lastScoreP1 || 0);
    const scoreP2 = data.scoreP2 != null ? data.scoreP2 : (window._lastScoreP2 || 0);
    if (data.scoreP1 != null) window._lastScoreP1 = data.scoreP1;
    if (data.scoreP2 != null) window._lastScoreP2 = data.scoreP2;

    const myScore = amIP1 ? scoreP1 : scoreP2;
    const oppScore = amIP1 ? scoreP2 : scoreP1;
    const position = data.ropePosition != null ? data.ropePosition : 0;
    const visualPos = amIP1 ? position : -position;
    const myLead = Math.max(0, -visualPos);
    const oppLead = Math.max(0, visualPos);

    $('#myScoreNum').text(myScore);
    $('#oppScoreNum').text(oppScore);
    $('#scoreMyBig').text(myScore);
    $('#scoreOppBig').text(oppScore);
    $('#roundBadge').text(`Bài #${currentPuzzleRound}`);
    const isSD = currentRoundMode === 'sudden_death';
    $('#modeBadge').text(isSD ? '⚡ Sudden Death' : 'Thường').toggleClass('sudden', isSD);
    $('#leadHint').text(
        isSD
            ? 'Sudden Death: giải đúng trước hoặc sai 1 nước là thua!'
            : `Cần dẫn ${currentWinScore} vạch để thắng · Bạn ${myLead}/${currentWinScore} · Địch ${oppLead}/${currentWinScore}`
    );

    buildPips('#myScorePips', myLead, 'me');
    buildPips('#oppScorePips', oppLead, 'opp');
    rebuildRopeTicks();

    const percent = 50 + (visualPos * (45 / Math.max(currentWinScore, 1)));
    $('#marker').css('left', percent + '%');

    const fillScale = 45 / Math.max(currentWinScore, 1);
    $('#ropeFillMe').css('width', `${Math.max(0, -visualPos) * fillScale}%`);
    $('#ropeFillOpp').css('width', `${Math.max(0, visualPos) * fillScale}%`);

    $('#fighterMe').toggleClass('leading', myLead > oppLead);
    $('#fighterOpp').toggleClass('leading', oppLead > myLead);

    if (data.scoredSide) {
        const iScored = (data.scoredSide === 'p1' && amIP1) || (data.scoredSide === 'p2' && !amIP1);
        // Spectator: amIP1=true means left is P1
        const flashSide = isSpectator
            ? (data.scoredSide === 'p1' ? 'me' : 'opp')
            : (iScored ? 'me' : 'opp');
        flashScore(flashSide);
    }
}

function applyUciMove(uci) {
    if (!uci || uci.length < 4) return false;
    const move = game.move({
        from: uci.substring(0, 2),
        to: uci.substring(2, 4),
        promotion: uci.length > 4 ? uci[4] : 'q'
    });
    return !!move;
}

function toDests(chess) {
    const dests = new Map();
    chess.SQUARES.forEach((sq) => {
        const ms = chess.moves({ square: sq, verbose: true });
        if (ms.length) dests.set(sq, ms.map((m) => m.to));
    });
    return dests;
}

function canPlayerMoveNow() {
    return !isSpectator && isMyTurnToSolve && !moveSubmitPending
        && !!currentPuzzle && (currentMoveIndex % 2 === 1)
        && currentMoveIndex < currentPuzzle.solution.length;
}

function syncGround(extra = {}) {
    if (!ground) return;
    const turnColor = game.turn() === 'w' ? 'white' : 'black';
    const playable = canPlayerMoveNow();
    ground.set({
        fen: game.fen(),
        orientation: boardOrientation,
        turnColor,
        check: game.in_check(),
        lastMove: extra.lastMove || undefined,
        viewOnly: isSpectator,
        movable: {
            color: playable ? turnColor : undefined,
            dests: playable ? toDests(game) : new Map(),
            free: false,
            showDests: true,
            events: { after: onCgAfterMove }
        },
        draggable: { enabled: playable, distance: 3, autoDistance: true, showGhost: true },
        selectable: { enabled: playable },
        premovable: { enabled: false },
        animation: { enabled: true, duration: 180 }
    });
}

function onCgAfterMove(orig, dest) {
    if (!canPlayerMoveNow()) {
        syncGround();
        return;
    }

    let expectedMoves = currentPuzzle.solution[currentMoveIndex];
    if (!Array.isArray(expectedMoves)) expectedMoves = [expectedMoves];

    const matchExpected = expectedMoves.find(m => m.length >= 4 && m.startsWith(orig + dest));
    const promoPiece = matchExpected && matchExpected.length > 4 ? matchExpected[4] : 'q';
    const move = game.move({ from: orig, to: dest, promotion: promoPiece });

    if (!move) {
        syncGround();
        return;
    }

    const moveStr = orig + dest + (move.promotion ? move.promotion : '');

    if (expectedMoves.includes(moveStr)) {
        syncGround({ lastMove: [orig, dest] });
        submitPlayerMove(moveStr, () => {
            game.undo();
            syncGround();
        });
        return;
    }

    // Sai lời giải
    game.undo();
    if (!isSpectator && currentRoundMode === 'sudden_death') {
        syncGround();
        submitPlayerMove(moveStr, () => {});
        return;
    }
    $('#status').text('Đi sai rồi. Tính lại đi!');
    syncGround();
}

function loadPuzzle(seed, acceptedMoves) {
    if (!puzzleList || puzzleList.length === 0) return;
    currentPuzzle = puzzleList[seed % puzzleList.length];
    currentMoveIndex = 0;
    moveSubmitPending = false;
    if (!isSpectator) isMyTurnToSolve = true;

    game.load(currentPuzzle.fen);

    const restored = Array.isArray(acceptedMoves) ? acceptedMoves : [];
    const totalApplied = restored.length * 2;
    let lastMove = null;
    for (let i = 0; i < totalApplied && i < currentPuzzle.solution.length; i++) {
        let uci;
        if (i % 2 === 1) {
            uci = restored[(i - 1) / 2];
        } else {
            const moveRaw = currentPuzzle.solution[i];
            uci = Array.isArray(moveRaw) ? moveRaw[0] : moveRaw;
        }
        if (applyUciMove(uci)) {
            lastMove = [uci.substring(0, 2), uci.substring(2, 4)];
            currentMoveIndex = i + 1;
        }
    }

    const startTurn = (currentPuzzle.fen.split(' ')[1] || 'w');
    boardOrientation = startTurn === 'w' ? 'black' : 'white';
    initBoard();

    if (computerMoveTimer) {
        clearTimeout(computerMoveTimer);
        computerMoveTimer = null;
    }

    if (currentMoveIndex >= currentPuzzle.solution.length) {
        isMyTurnToSolve = false;
        syncGround({ lastMove });
        return;
    }

    if (currentMoveIndex % 2 === 0) {
        syncGround({ lastMove });
        computerMoveTimer = setTimeout(makeComputerMove, restored.length ? 200 : 500);
    } else {
        syncGround({ lastMove });
        if (!isSpectator) {
            $('#status').text(currentMoveIndex === 1
                ? '🔥 Nước đi sai lầm của địch! Trừng phạt ngay!'
                : 'Địch đáp trả! Tính tiếp đi!');
        }
    }
}

function makeComputerMove() {
    if (!currentPuzzle || currentMoveIndex >= currentPuzzle.solution.length) return;
    if (currentMoveIndex % 2 !== 0) return;

    let moveRaw = currentPuzzle.solution[currentMoveIndex];
    let moveUci = Array.isArray(moveRaw) ? moveRaw[0] : moveRaw;
    const from = moveUci.substring(0, 2);
    const to = moveUci.substring(2, 4);
    const promo = moveUci.length > 4 ? moveUci[4] : 'q';

    if (!game.move({ from, to, promotion: promo })) {
        console.warn('Computer move failed', moveUci);
        return;
    }
    currentMoveIndex++;
    syncGround({ lastMove: [from, to] });

    if (!isSpectator) {
        $('#status').text(currentMoveIndex === 1
            ? '🔥 Nước đi sai lầm của địch! Trừng phạt ngay!'
            : 'Địch đáp trả! Tính tiếp đi!');
    }
}

function submitPlayerMove(moveStr, onReject) {
    if (moveSubmitPending || isSpectator) return;
    moveSubmitPending = true;
    syncGround();

    const safety = setTimeout(() => {
        if (!moveSubmitPending) return;
        moveSubmitPending = false;
        $('#status').text('Máy chủ phản hồi chậm — thử lại nước đi.');
        syncGround();
    }, 8000);

    socket.emit('submit_move', {
        roomCode: myRoomCode,
        token: myToken,
        puzzleRound: currentPuzzleRound,
        move: moveStr
    }, (res) => {
        clearTimeout(safety);
        moveSubmitPending = false;
        if (!res || !res.ok) {
            if (typeof onReject === 'function') onReject(res);
            if (res && res.mistake) {
                isMyTurnToSolve = false;
                $('#status').text(res.error || 'Bạn đi sai trong Sudden Death!');
            } else {
                $('#status').text((res && res.error) || 'Nước không được chấp nhận.');
            }
            syncGround();
            return;
        }
        currentMoveIndex++;
        if (res.solved) {
            isMyTurnToSolve = false;
            $('#status').text('Tuyệt vời! Đang giật dây kéo co...');
            syncGround();
        } else {
            $('#status').text('Chính xác! Đợi máy phản đòn...');
            syncGround();
            if (computerMoveTimer) clearTimeout(computerMoveTimer);
            computerMoveTimer = setTimeout(makeComputerMove, 500);
        }
    });
}

function initBoard() {
    const el = document.getElementById('board');
    if (!el) return;
    if (ground) {
        try { ground.destroy(); } catch (e) { /* ignore */ }
        ground = null;
        el.innerHTML = '';
    }
    ground = Chessground(el, {
        fen: game.fen(),
        orientation: boardOrientation,
        coordinates: true,
        addPieceZIndex: true,
        blockTouchScroll: true,
        highlight: { lastMove: true, check: true },
        animation: { enabled: true, duration: 180 },
        movable: {
            free: false,
            color: undefined,
            dests: new Map(),
            showDests: true,
            events: { after: onCgAfterMove }
        },
        draggable: { enabled: true, distance: 3, autoDistance: true, showGhost: true },
        selectable: { enabled: true },
        premovable: { enabled: false },
        drawable: { enabled: false }
    });
}
