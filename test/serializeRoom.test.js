const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.CHESS_TOW_TEST = '1';
process.env.TOW_TOURNAMENT_COUNTDOWN = '0';
process.env.TOW_ROUND_COUNTDOWN = '0';

const { serializeRoom, serializeMatch } = require('../server');

describe('serializeRoom — JSON-safe khi có Timer', () => {
    it('không crash khi match.timerId và player.disconnectTimer là Timeout', () => {
        const p1 = {
            id: 's1', token: 't1', name: 'A', compete: true,
            disconnectTimer: setTimeout(() => {}, 60000)
        };
        const p2 = {
            id: 's2', token: 't2', name: 'B', compete: true,
            disconnectTimer: setTimeout(() => {}, 60000)
        };
        const match = {
            id: 'm1',
            p1,
            p2,
            winner: null,
            scoreP1: 4,
            scoreP2: 2,
            puzzleRound: 7,
            currentSeed: 12,
            timerId: setTimeout(() => {}, 60000),
            progress: { t1: ['e2e4'], t2: [] },
            log: { puzzles: [] }
        };
        const room = {
            roomCode: '1234',
            hostToken: 't1',
            players: [p1, p2],
            activePlayers: [p1, p2],
            bracket: [[match]],
            currentRoundMatches: [match],
            level: 1,
            winScore: 5,
            status: 'playing',
            initialPlayerCount: 2,
            eliminationOrder: [],
            advanceTimer: setTimeout(() => {}, 60000)
        };

        let json;
        assert.doesNotThrow(() => {
            json = JSON.stringify(serializeRoom(room));
        });
        const parsed = JSON.parse(json);
        assert.equal(parsed.currentRoundMatches[0].scoreP1, 4);
        assert.equal(parsed.currentRoundMatches[0].timerId, undefined);
        assert.equal(parsed.currentRoundMatches[0].p1.disconnectTimer, undefined);
        assert.equal(parsed.players[0].disconnectTimer, undefined);

        clearTimeout(p1.disconnectTimer);
        clearTimeout(p2.disconnectTimer);
        clearTimeout(match.timerId);
        clearTimeout(room.advanceTimer);
    });

    it('serializeMatch slim player fields', () => {
        const t1 = setTimeout(() => {}, 60000);
        const t2 = setTimeout(() => {}, 60000);
        const m = serializeMatch({
            id: 'x',
            p1: { token: 'a', name: 'A', id: '1', disconnectTimer: t1, extra: 'nope' },
            p2: null,
            timerId: t2,
            scoreP1: 1
        });
        assert.equal(m.p1.token, 'a');
        assert.equal(m.p1.disconnectTimer, undefined);
        assert.equal(m.p1.extra, undefined);
        assert.equal(m.timerId, undefined);
        clearTimeout(t1);
        clearTimeout(t2);
    });
});
