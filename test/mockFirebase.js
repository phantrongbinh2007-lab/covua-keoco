/** Firebase mock in-memory cho test — không gọi mạng. */
const store = new Map();
const writeLog = [];

function init() {
    store.clear();
    writeLog.length = 0;
}

function isUsingAdmin() {
    return false;
}

async function dbGet(path) {
    if (!store.has(path)) return null;
    return JSON.parse(JSON.stringify(store.get(path)));
}

async function dbSet(path, data) {
    // Giả lập độ trễ biến thiên để bắt race last-write-wins nếu queue hỏng
    const delay = Number(process.env.TOW_MOCK_WRITE_DELAY_MS || 0);
    if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
    }
    const snapshot = JSON.parse(JSON.stringify(data));
    store.set(path, snapshot);
    writeLog.push({ path, at: Date.now(), scoreSnapshot: extractScores(snapshot) });
    return true;
}

async function dbRemove(path) {
    store.delete(path);
}

function extractScores(room) {
    const matches = room?.currentRoundMatches || [];
    return matches.map(m => ({
        id: m.id,
        scoreP1: m.scoreP1 || 0,
        scoreP2: m.scoreP2 || 0,
        puzzleRound: m.puzzleRound
    }));
}

function getStore() {
    return store;
}

function getWriteLog() {
    return writeLog;
}

module.exports = {
    init,
    dbGet,
    dbSet,
    dbRemove,
    isUsingAdmin,
    getStore,
    getWriteLog
};
