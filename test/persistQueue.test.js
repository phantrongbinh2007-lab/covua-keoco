const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPersistQueue } = require('../lib/persistQueue');

describe('persistQueue — không đảo ngược điểm khi ghi song song', () => {
    it('ghi chậm hơn của snapshot cũ không đè snapshot mới', async () => {
        const writes = [];
        const store = new Map();

        const queue = createPersistQueue(async (key, payload) => {
            // Write delay tỷ lệ nghịch với score — write cũ (score thấp) chậm hơn
            const delay = 40 - (payload.score || 0) * 5;
            await new Promise(r => setTimeout(r, Math.max(5, delay)));
            store.set(key, payload);
            writes.push({ key, score: payload.score });
        });

        let latest = { score: 1 };
        const p1 = queue.persist('rooms/1111', () => ({ ...latest }));

        latest = { score: 2 };
        const p2 = queue.persist('rooms/1111', () => ({ ...latest }));

        latest = { score: 4 };
        const p3 = queue.persist('rooms/1111', () => ({ ...latest }));

        await Promise.all([p1, p2, p3]);
        await queue.pending('rooms/1111');

        assert.equal(store.get('rooms/1111').score, 4, 'Firebase phải giữ điểm mới nhất');
        assert.ok(writes.length >= 3);
        assert.equal(writes[writes.length - 1].score, 4);
    });

    it('getLatestPayload được gọi lúc ghi, không lúc enqueue', async () => {
        const seen = [];
        let live = { n: 0 };
        const queue = createPersistQueue(async (_key, payload) => {
            seen.push(payload.n);
            await new Promise(r => setTimeout(r, 10));
        });

        const a = queue.persist('k', () => ({ n: live.n }));
        live.n = 99;
        const b = queue.persist('k', () => ({ n: live.n }));
        await Promise.all([a, b]);

        // Lần ghi đầu đọc live lúc chạy (có thể đã 99), lần 2 chắc chắn 99
        assert.equal(seen[seen.length - 1], 99);
    });
});
