const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, remove } = require('firebase/database');
const path = require('path');
const fs = require('fs');

const DATABASE_URL = 'https://covua-keoco-default-rtdb.asia-southeast1.firebasedatabase.app';

const firebaseConfig = {
    apiKey: "AIzaSyAXiDlB_oTmQBhGTbM8FqWH_YuZnQSek1A",
    authDomain: "covua-keoco.firebaseapp.com",
    projectId: "covua-keoco",
    storageBucket: "covua-keoco.firebasestorage.app",
    messagingSenderId: "108598813612",
    appId: "1:108598813612:web:91fb8e057714769ecd1009",
    databaseURL: DATABASE_URL
};

let adminDb = null;
let clientDb = null;
let usingAdmin = false;

function init() {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT
        || path.join(__dirname, 'firebase-service-account.json');

    if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: DATABASE_URL
            });
        }
        adminDb = admin.database();
        usingAdmin = true;
        console.log('☁️ Firebase Admin SDK — kết nối thành công (database được bảo vệ)');
        return;
    }

    const firebaseApp = initializeApp(firebaseConfig);
    clientDb = getDatabase(firebaseApp);
    console.warn('⚠️ Thiếu firebase-service-account.json — dùng Client SDK tạm thời.');
    console.warn('   Tải key từ Firebase Console → Project Settings → Service accounts → Generate new private key');
    console.warn('   Lưu file thành firebase-service-account.json trong thư mục project.');
}

async function dbGet(relPath) {
    if (usingAdmin) {
        const snap = await adminDb.ref(relPath).once('value');
        return snap.exists() ? snap.val() : null;
    }
    const snapshot = await get(ref(clientDb, relPath));
    return snapshot.exists() ? snapshot.val() : null;
}

async function dbSet(relPath, data) {
    if (usingAdmin) {
        await adminDb.ref(relPath).set(data);
        return;
    }
    await set(ref(clientDb, relPath), data);
}

async function dbRemove(relPath) {
    if (usingAdmin) {
        await adminDb.ref(relPath).remove();
        return;
    }
    await remove(ref(clientDb, relPath));
}

function isUsingAdmin() {
    return usingAdmin;
}

module.exports = { init, dbGet, dbSet, dbRemove, isUsingAdmin };
