/**
 * Logic chặn packet cũ ghi đè điểm/HUD.
 * Dùng chung cho client và unit test — không phụ thuộc DOM/socket.
 */

export function matchStateVersion(data) {
    if (!data) return 0;
    const round = data.puzzleRound != null ? Number(data.puzzleRound) : 0;
    const s1 = data.scoreP1 != null ? Number(data.scoreP1) : 0;
    const s2 = data.scoreP2 != null ? Number(data.scoreP2) : 0;
    return round * 1000 + s1 + s2;
}

/**
 * @param {object} data
 * @param {{ allowNewMatch?: boolean, currentMatchId?: string|null, lastMatchStateVersion?: number, lastScoreP1?: number, lastScoreP2?: number }} ctx
 * @returns {boolean} true = bỏ qua payload (cũ hơn state đang hiển thị)
 */
export function isStaleMatchPayload(data, ctx = {}) {
    if (!data) return true;
    const currentMatchId = ctx.currentMatchId ?? null;
    const lastMatchStateVersion = ctx.lastMatchStateVersion ?? 0;
    const lastScoreP1 = ctx.lastScoreP1 ?? 0;
    const lastScoreP2 = ctx.lastScoreP2 ?? 0;
    const allowNewMatch = !!ctx.allowNewMatch;

    if (allowNewMatch && data.matchId && data.matchId !== currentMatchId) {
        return false;
    }
    if (currentMatchId && data.matchId && data.matchId !== currentMatchId) {
        return true;
    }
    if (data.puzzleRound == null) {
        if (data.scoreP1 == null && data.scoreP2 == null) return false;
        const incoming = (data.scoreP1 != null ? data.scoreP1 : lastScoreP1)
            + (data.scoreP2 != null ? data.scoreP2 : lastScoreP2);
        const current = lastScoreP1 + lastScoreP2;
        return incoming < current;
    }
    return matchStateVersion(data) < lastMatchStateVersion;
}

/**
 * @returns {number} version mới sau khi commit
 */
export function nextMatchStateVersion(data, ctx = {}) {
    const lastMatchStateVersion = ctx.lastMatchStateVersion ?? 0;
    const currentPuzzleRound = ctx.currentPuzzleRound ?? 0;
    const lastScoreP1 = ctx.lastScoreP1 ?? 0;
    const lastScoreP2 = ctx.lastScoreP2 ?? 0;
    if (!data) return lastMatchStateVersion;
    if (data.puzzleRound != null) {
        return Math.max(lastMatchStateVersion, matchStateVersion(data));
    }
    if (data.scoreP1 != null || data.scoreP2 != null) {
        const s1 = data.scoreP1 != null ? data.scoreP1 : lastScoreP1;
        const s2 = data.scoreP2 != null ? data.scoreP2 : lastScoreP2;
        return Math.max(lastMatchStateVersion, currentPuzzleRound * 1000 + s1 + s2);
    }
    return lastMatchStateVersion;
}

/**
 * Áp điểm HUD: không cho tổng điểm lùi trong cùng trận.
 * @returns {{ scoreP1: number, scoreP2: number, rejectedRegression: boolean }}
 */
export function resolveHudScores(data, lastScoreP1 = 0, lastScoreP2 = 0) {
    let scoreP1 = data.scoreP1 != null ? data.scoreP1 : lastScoreP1;
    let scoreP2 = data.scoreP2 != null ? data.scoreP2 : lastScoreP2;
    if (data.scoreP1 == null && data.scoreP2 == null) {
        return { scoreP1: lastScoreP1, scoreP2: lastScoreP2, rejectedRegression: false };
    }
    const incoming = scoreP1 + scoreP2;
    const current = lastScoreP1 + lastScoreP2;
    if (incoming < current) {
        return { scoreP1: lastScoreP1, scoreP2: lastScoreP2, rejectedRegression: true };
    }
    return {
        scoreP1: data.scoreP1 != null ? data.scoreP1 : lastScoreP1,
        scoreP2: data.scoreP2 != null ? data.scoreP2 : lastScoreP2,
        rejectedRegression: false
    };
}
