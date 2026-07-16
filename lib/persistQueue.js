/**
 * Hàng đợi ghi persistence theo key — luôn serialize state mới nhất lúc ghi,
 * tránh last-write-wins đảo ngược điểm trên Firebase.
 */
function createPersistQueue(writeFn) {
    const chains = new Map();

    function persist(key, getLatestPayload) {
        if (!key) return Promise.resolve();
        const prev = chains.get(key) || Promise.resolve();
        const next = prev
            .catch(() => {})
            .then(() => {
                const payload = typeof getLatestPayload === 'function'
                    ? getLatestPayload()
                    : getLatestPayload;
                if (payload == null) return null;
                return writeFn(key, payload);
            });
        chains.set(key, next.catch(() => {}));
        return next;
    }

    function clear(key) {
        if (key) chains.delete(key);
        else chains.clear();
    }

    function pending(key) {
        return chains.get(key) || Promise.resolve();
    }

    return { persist, clear, pending, _chains: chains };
}

module.exports = { createPersistQueue };
