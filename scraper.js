const fs = require('fs');
const readline = require('readline');

// Cấu hình 5 mốc Elo mà bro yêu cầu
const LEVELS = {
    level1: { min: 1400, max: 1500, data: [], limit: 2000, file: 'public/puzzles_level1.json' },
    level2: { min: 1501, max: 1700, data: [], limit: 2000, file: 'public/puzzles_level2.json' },
    level3: { min: 1701, max: 1800, data: [], limit: 2000, file: 'public/puzzles_level3.json' },
    level4: { min: 1801, max: 2000, data: [], limit: 2000, file: 'public/puzzles_level4.json' },
    level5: { min: 2001, max: 2300, data: [], limit: 2000, file: 'public/puzzles_level5.json' }
};

async function processPuzzles() {
    console.log("🚀 Bắt đầu đọc file database Lichess...");

    // Dùng Stream để đọc file siêu to mà không bị tràn RAM
    const fileStream = fs.createReadStream('lichess_db_puzzle.csv');
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let isFirstLine = true;
    let linesProcessed = 0;

    for await (const line of rl) {
        if (isFirstLine) {
            isFirstLine = false;
            continue; // Bỏ qua dòng tiêu đề của file CSV
        }

        linesProcessed++;
        
        // Báo cáo tiến độ cho đỡ chán
        if (linesProcessed % 100000 === 0) {
            console.log(`⏳ Đã quét qua ${linesProcessed} bài tập...`);
        }

        // Định dạng CSV Lichess: PuzzleId, FEN, Moves, Rating, ...
        const parts = line.split(',');
        if (parts.length < 4) continue;

        const fen = parts[1];
        const movesStr = parts[2];
        const rating = parseInt(parts[3], 10);

        // Phân loại vào rổ
        for (const key in LEVELS) {
            const lvl = LEVELS[key];
            if (rating >= lvl.min && rating <= lvl.max && lvl.data.length < lvl.limit) {
                lvl.data.push({
                    fen: fen,
                    solution: movesStr.split(' ') // Tự động tách chuỗi thành mảng combo nước đi
                });
                break; 
            }
        }

        // Kiểm tra xem đã đầy tất cả các giỏ (2000 bài mỗi level) chưa
        const isAllFull = Object.values(LEVELS).every(lvl => lvl.data.length >= lvl.limit);
        if (isAllFull) {
            console.log("🎯 Đã gom đủ quân số cho cả 5 Level. Dừng cào dữ liệu!");
            rl.close();
            break;
        }
    }

    // Ghi dữ liệu ra 5 file JSON trong thư mục public
    for (const key in LEVELS) {
        const lvl = LEVELS[key];
        fs.writeFileSync(lvl.file, JSON.stringify(lvl.data, null, 2));
        console.log(`✅ Đã xuất thành công ${lvl.data.length} bài vào: ${lvl.file}`);
    }
    
    console.log("🎉 Hoàn tất 100%! Anh em sẵn sàng chiến đấu!");
}

// Chạy thôi
processPuzzles();