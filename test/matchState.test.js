const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadMatchState() {
    const file = pathToFileURL(path.join(__dirname, '..', 'public', 'matchState.mjs')).href;
    return import(file);
}

describe('matchState — chặn điểm giật ngược (4→3)', () => {
    it('từ chối gameStart/update cùng trận với puzzleRound thấp hơn', async () => {
        const { isStaleMatchPayload } = await loadMatchState();
        const stale = isStaleMatchPayload(
            { matchId: 'm1', puzzleRound: 3, scoreP1: 3, scoreP2: 1 },
            {
                currentMatchId: 'm1',
                lastMatchStateVersion: 4 * 1000 + 4 + 1, // đã ở round 4, tổng 5
                lastScoreP1: 4,
                lastScoreP2: 1
            }
        );
        assert.equal(stale, true);
    });

    it('từ chối payload cùng round nhưng tổng điểm thấp hơn', async () => {
        const { isStaleMatchPayload } = await loadMatchState();
        const stale = isStaleMatchPayload(
            { matchId: 'm1', puzzleRound: 5, scoreP1: 3, scoreP2: 1 },
            {
                currentMatchId: 'm1',
                lastMatchStateVersion: 5 * 1000 + 4 + 1,
                lastScoreP1: 4,
                lastScoreP2: 1
            }
        );
        assert.equal(stale, true);
    });

    it('chấp nhận payload mới hơn (round/điểm tăng)', async () => {
        const { isStaleMatchPayload } = await loadMatchState();
        const stale = isStaleMatchPayload(
            { matchId: 'm1', puzzleRound: 5, scoreP1: 4, scoreP2: 1 },
            {
                currentMatchId: 'm1',
                lastMatchStateVersion: 4 * 1000 + 3 + 1,
                lastScoreP1: 3,
                lastScoreP2: 1
            }
        );
        assert.equal(stale, false);
    });

    it('cho phép trận mới (matchId khác) reset điểm về 0', async () => {
        const { isStaleMatchPayload } = await loadMatchState();
        const stale = isStaleMatchPayload(
            { matchId: 'm2', puzzleRound: 1, scoreP1: 0, scoreP2: 0 },
            {
                allowNewMatch: true,
                currentMatchId: 'm1',
                lastMatchStateVersion: 8 * 1000 + 4 + 3,
                lastScoreP1: 4,
                lastScoreP2: 3
            }
        );
        assert.equal(stale, false);
    });

    it('từ chối scoreUpdate làm điểm lùi', async () => {
        const { isStaleMatchPayload } = await loadMatchState();
        const stale = isStaleMatchPayload(
            { matchId: 'm1', scoreP1: 3, scoreP2: 1 },
            {
                currentMatchId: 'm1',
                lastMatchStateVersion: 5000,
                lastScoreP1: 4,
                lastScoreP2: 1
            }
        );
        assert.equal(stale, true);
    });

    it('resolveHudScores giữ điểm cũ khi packet regress', async () => {
        const { resolveHudScores } = await loadMatchState();
        const r = resolveHudScores({ scoreP1: 3, scoreP2: 0 }, 4, 0);
        assert.equal(r.rejectedRegression, true);
        assert.equal(r.scoreP1, 4);
        assert.equal(r.scoreP2, 0);
    });

    it('resolveHudScores chấp nhận điểm tăng', async () => {
        const { resolveHudScores } = await loadMatchState();
        const r = resolveHudScores({ scoreP1: 4, scoreP2: 1 }, 3, 1);
        assert.equal(r.rejectedRegression, false);
        assert.equal(r.scoreP1, 4);
        assert.equal(r.scoreP2, 1);
    });
});
