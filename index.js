const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ApplicationCommandOptionType,
    StringSelectMenuBuilder,
    PermissionsBitField,
    MessageFlags,
    ActivityType // Đã thêm ActivityType vào đây
} = require('discord.js');

const fs = require('fs'); 

const cron = require('node-cron');

// Hàm hỗ trợ tạo số ngẫu nhiên cho vé số
function randDigits(n) {
    return Math.floor(Math.random() * Math.pow(10, n)).toString().padStart(n, '0');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers // BẮT BUỘC để bắt sự kiện thành viên rời/vào lại & đổi role (chống lách tù)
    ]
});
// KHIÊN CHỐNG SẬP BOT KHI CÓ LỖI API DISCORD
client.on('error', (error) => {
    console.error('⚠️ [BỎ QUA] Lỗi nội bộ Discord API:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [BỎ QUA] Lỗi Promise không xác định:', reason);
});

// ==========================================
// QUẢN LÝ TRẠNG THÁI GAME (BỘ NHỚ TỔNG HỢP)
// ==========================================
const activeGames = {
    caro: new Map(),
    taixiu: null,
    xidach: null,
    baucua: null,
    xepgach: new Map(), 
    covua: new Map(),   
    masoi: new Map(),
    trade: new Map(),   // HỆ THỐNG NÔNG TRẠI: Lưu các phiên trao đổi vật phẩm !trade
    duangua: new Map()  // HỆ THỐNG ĐUA NGỰA: Lưu ván đua ngựa theo channelId
};

// ==========================================
// HỆ THỐNG ĐUA NGỰA (!duangua) - CẤU HÌNH
// ==========================================
const DH_HORSE_COUNT = 10;
const DH_TRACK_LEN = 18;
const DH_MIN_BET = 10;
const DH_NUMBER_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

function dhBuildTrackFrame(positions, finished) {
    let lines = '';
    for (let i = 0; i < DH_HORSE_COUNT; i++) {
        const pos = Math.min(positions[i], DH_TRACK_LEN);
        const behind = '▬'.repeat(pos);
        const ahead = '▬'.repeat(DH_TRACK_LEN - pos);
        const mark = finished.includes(i) ? '🏆' : '🐴';
        lines += `${DH_NUMBER_EMOJI[i]} \`${behind}${mark}${ahead}🏁\`\n`;
    }
    return lines;
}

function dhBuildBettingEmbed(game) {
    const betsByHorse = {};
    for (const [uid, b] of game.bets) {
        if (!betsByHorse[b.horse]) betsByHorse[b.horse] = [];
        betsByHorse[b.horse].push(`<@${uid}> (${b.amount.toLocaleString()}đ)`);
    }
    let desc = `<a:emoji_77:1526180317000630384> **ĐUA NGỰA** - Chủ ván: <@${game.hostId}>\n\n`;
    desc += `Chọn 1 con ngựa ở menu bên dưới để đặt cược (mỗi người chỉ được cược **1 con**).\n`;
    desc += `🥇 Về Nhất: nhận **x3** tiền cược | 🥈 Về Nhì: được **hoàn tiền** | Từ hạng 3 trở đi: mất cược.\n\n`;
    for (let i = 0; i < DH_HORSE_COUNT; i++) {
        const list = betsByHorse[i + 1];
        desc += `${DH_NUMBER_EMOJI[i]} Ngựa số ${i + 1}${list ? `: ${list.join(', ')}` : ''}\n`;
    }
    return new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('<a:emoji_77:1526180317000630384> TRƯỜNG ĐUA NGỰA <a:emoji_77:1526180317000630384>')
        .setDescription(desc)
        .setFooter({ text: 'Chủ ván bấm "▶️ Bắt Đầu Đua" khi đã đủ người cược' });
}

function dhBuildComponents(disabled = false) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('dh_pick')
        .setPlaceholder('🐎 Chọn ngựa để đặt cược')
        .setDisabled(disabled)
        .addOptions(Array.from({ length: DH_HORSE_COUNT }, (_, i) => ({
            label: `Ngựa số ${i + 1}`,
            value: String(i + 1),
            emoji: DH_NUMBER_EMOJI[i]
        })));
    const row1 = new ActionRowBuilder().addComponents(menu);
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dh_start').setLabel('▶️ Bắt Đầu Đua').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('dh_cancel').setLabel('❌ Hủy Ván').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );
    return [row1, row2];
}

function dhSleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ==========================================
// HỆ THỐNG CHỨNG KHOÁN - CẤU HÌNH
// ==========================================
const STOCK_START_PRICE = 100000;   // Giá khởi điểm mỗi cổ phiếu (VNĐ)
const STOCK_MIN_PRICE = 5000;       // Giá sàn, không cho rớt dưới mức này
const STOCK_MAX_CHANGE_PCT = 8;     // Biên độ dao động tối đa mỗi lần cập nhật (%)
const STOCK_TICK_MS = 60 * 1000;    // Cứ 1 phút giá lại thay đổi 1 lần
const STOCK_HISTORY_LEN = 14;       // Số ô biến động hiển thị, giữ đúng 1 hàng cho gọn

// Cấu hình 8 Độ Hiếm
const RARITIES = ['Thường', 'Không Phổ Biến', 'Hiếm', 'Sử Thi', 'Huyền Thoại', 'Thần Thoại', 'Tối Thượng', 'Độc Nhất'];

// ==========================================
// HỆ THỐNG TU TIÊN - HẰNG SỐ CẤU HÌNH
// ==========================================
// 👉 THAY ID CỦA BẠN VÀO ĐÂY để có quyền Chủ Bot (Developer) cho lệnh /tudev
const TT_OWNER_IDS = ['1020868400672686080'];

// 9 Đại Cảnh Giới, mỗi cảnh giới có 10 Tầng (Tầng 10 = Viên Mãn)
const CANH_GIOI = ['Luyện Khí', 'Trúc Cơ', 'Kim Đan', 'Nguyên Anh', 'Hóa Thần', 'Luyện Hư', 'Hợp Thể', 'Đại Thừa', 'Độ Kiếp'];
const TT_COLORS = ['#FFFFFF', '#2ecc71', '#f1c40f', '#9b59b6', '#e74c3c', '#1abc9c', '#3498db', '#e67e22', '#2c2f33'];

// Đan dược hỗ trợ Đột Phá / Hồi phục, bán trong Thương Các
const DAN_DUOC = {
    'truc_co_dan': { name: 'Trúc Cơ Đan', tiLe: 20, price: 800, desc: 'Tăng 20% tỉ lệ Đột Phá cho lần Lôi Kiếp tiếp theo' },
    'ti_loi_phu': { name: 'Tị Lôi Phù', tiLe: 15, price: 600, desc: 'Tăng 15% tỉ lệ Đột Phá cho lần Lôi Kiếp tiếp theo' },
    'hoi_khi_dan': { name: 'Hồi Khí Đan', tiLe: 0, heal: true, price: 400, desc: 'Trị ngay trạng thái Trọng Thương' }
};
// ==========================================

// Cấu hình 7 Loại Rương (Tỉ lệ % tương ứng với 8 độ hiếm ở trên)
const CHEST_CONFIG = {
    'ruong_go': { name: 'Rương Gỗ', price: 500000, icon: '🪵', rates: [50, 25, 13, 7, 3, 1.5, 0.4, 0.1], emptyChance: 0.10 },
    'ruong_bac': { name: 'Rương Bạc', price: 1500000, icon: '🥈', rates: [30, 35, 18, 10, 4, 2, 0.8, 0.2], emptyChance: 0.10 },
    'ruong_vang': { name: 'Rương Vàng', price: 3500000, icon: '🥇', rates: [10, 30, 30, 18, 8, 3, 0.8, 0.2], emptyChance: 0.10 },
    'ruong_kim_cuong': { name: 'Rương Kim Cương', price: 700000, icon: '💎', rates: [0, 20, 35, 25, 12, 5, 2, 1], emptyChance: 0.10 },
    // Từ Rương Huyền Thoại trở lên không có tỉ lệ rỗng (emptyChance: 0)
    'ruong_huyen_thoai': { name: 'Rương Huyền Thoại', price: 15000000, icon: '🟣', rates: [0, 0, 20, 35, 25, 12, 5, 3], emptyChance: 0 },
    'ruong_than_bi': { name: 'Rương Thần Bí', price: 30000000, icon: '🔴', rates: [0, 0, 0, 20, 40, 25, 10, 5], emptyChance: 0 },
    'ruong_toi_thuong': { name: 'Rương Tối Thượng', price: 500000000, icon: '🌈', rates: [0, 0, 0, 0, 20, 40, 25, 15], emptyChance: 0 }
};

const ROLE_IMAGES = {
    'Sói': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/masoi.png',
    'Tiên tri': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/tientri.png',
    'Bảo vệ': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/baove.png',
    'Dân làng': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/danlang.png',
    'Thợ săn': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/thosan.png',
    'Phù thủy': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/',
    'Cupid': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/thantinhyeu.png',
    'Già làng': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/gialanh.png',
    'Phản bội': 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/phuthuy.png'
};

const COVER_IMAGE = 'https://raw.githubusercontent.com/Naknohack/Naknohackclentvng/main/menu.png';

// ==========================================
// HỆ THỐNG NHÀ TÙ - CẤU HÌNH NHIỆM VỤ LAO ĐỘNG CÔNG ÍCH (6 nhiệm vụ)
// Lệnh gõ KHÔNG DẤU, VIẾT LIỀN theo đúng "cmd" bên dưới (VD: !ruabat)
// ==========================================
const PRISON_TASKS = [
    { key: 'quet_rac',   name: 'Quét rác',              emoji: '🧹', cmd: 'quetrac' },
    { key: 'trong_rau',  name: 'Trồng rau',             emoji: '🌱', cmd: 'trongrau' },
    { key: 've_sinh',    name: 'Vệ sinh nhà vệ sinh',   emoji: '🧻', cmd: 'vesinh' },
    { key: 'cho_heo_an', name: 'Cho heo ăn',            emoji: '🐷', cmd: 'choheoan' },
    { key: 'rua_bat',    name: 'Rửa bát',               emoji: '🍽️', cmd: 'ruabat' },
    { key: 'giat_do',    name: 'Giặt đồ',               emoji: '👕', cmd: 'giatdo' }
];

// Cooldown chống lách luật dùng auto-click spam lệnh nhiệm vụ (2 giây / người)
const PRISON_TASK_COOLDOWN_MS = 2000;
const prisonTaskCooldown = new Map();

// Tạo bộ nhiệm vụ mới (6 nhiệm vụ) với cùng 1 chỉ tiêu "required" cho mỗi loại
function buildPrisonTasks(required) {
    const tasks = {};
    for (const t of PRISON_TASKS) {
        tasks[t.key] = { current: 0, required };
    }
    return tasks;
}

// Kiểm tra xem tù nhân đã hoàn thành đủ chỉ tiêu của TẤT CẢ nhiệm vụ chưa
function isPrisonTasksFinished(tasks) {
    return PRISON_TASKS.every(t => tasks[t.key] && tasks[t.key].current >= tasks[t.key].required);
}

// Dựng bảng hiển thị nhiệm vụ + tên lệnh để tù nhân biết cần gõ lệnh gì
function buildPrisonTaskBoard(tasks) {
    let text = '';
    for (const t of PRISON_TASKS) {
        const d = tasks[t.key] || { current: 0, required: 0 };
        text += `• ${t.emoji} ${t.name}: \`${d.current}/${d.required}\` — Lệnh: \`!${t.cmd}\`\n`;
    }
    return text;
}

// ==========================================
// HỆ THỐNG CHẶN COPY TIN NHẮN BOT (ANTI-LEAK)
// ==========================================
// Chỉ chặn khi người chơi gần như copy nguyên văn tin nhắn riêng của bot.
// Tin nhắn chat bình thường như "bên A bảo bên B là gì?" sẽ không bị chặn
// vì nó không khớp sát nội dung private message của bot.
const BOT_ROLE_MESSAGES = [
    "Bạn là SÓI. Hãy chọn mục tiêu để cắn đêm nay.",
    "Bạn là TIÊN TRI. Hãy soi 1 người để biết phe của họ.",
    "Bạn là BẢO VỆ. Hãy chọn 1 người để bảo vệ đêm nay.",
    "Bạn là PHÙ THỦY. Bạn có 1 bình CỨU và 1 bình ĐỘC.",
    "Bạn là CUPID. Hãy chọn 2 người để ghép đôi",
    "Bạn là THỢ SĂN. Nếu bạn bị giết đêm nay hoặc bị treo cổ",
    "Bạn là GIÀ LÀNG. Bạn có 2 mạng khi bị sói cắn.",
    "Bạn là BÁN SÓI / KẺ PHẢN BỘI. Bạn sẽ thắng nếu phe Sói thắng."
];

function normalizeLeakText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isCopiedBotMessage(userMsg) {
    const cleanUser = normalizeLeakText(userMsg);
    if (!cleanUser) return false;

    for (const botMsg of BOT_ROLE_MESSAGES) {
        const cleanBot = normalizeLeakText(botMsg);
        if (!cleanBot) continue;

        // Khớp y nguyên hoặc gần như y nguyên => coi là copy
        if (cleanUser === cleanBot) return true;
        if (cleanUser.includes(cleanBot) && cleanBot.length >= 18) return true;

        const botWords = cleanBot.split(' ');
        const userWords = new Set(cleanUser.split(' '));
        let matchCount = 0;

        for (const word of botWords) {
            if (userWords.has(word)) matchCount++;
        }

        // Chỉ bắt khi mức trùng rất cao để tránh chặn nhầm chat bình thường
        const similarity = botWords.length ? (matchCount / botWords.length) * 100 : 0;
        if (similarity >= 85 && cleanUser.length >= cleanBot.length - 2) {
            return true;
        }
    }
    return false;
}

function getRoleConfig(playerCount) {
    if (playerCount === 1) return ['Sói'];
    if (playerCount === 2) return ['Sói', 'Tiên tri'];
    if (playerCount === 3) return ['Sói', 'Tiên tri', 'Bảo vệ'];
    if (playerCount === 4) return ['Sói', 'Tiên tri', 'Bảo vệ', 'Dân làng'];
    if (playerCount === 5) return ['Sói', 'Tiên tri', 'Bảo vệ', 'Phù thủy', 'Dân làng'];
    if (playerCount === 6) return ['Sói', 'Sói', 'Tiên tri', 'Bảo vệ', 'Phù thủy', 'Cupid'];
    if (playerCount === 7) return ['Sói', 'Sói', 'Tiên tri', 'Bảo vệ', 'Phù thủy', 'Thợ săn', 'Cupid'];
    if (playerCount === 8) return ['Sói', 'Sói', 'Tiên tri', 'Bảo vệ', 'Phù thủy', 'Thợ săn', 'Cupid', 'Già làng'];
    if (playerCount === 9) return ['Sói', 'Sói', 'Bán sói', 'Tiên tri', 'Bảo vệ', 'Phù thủy', 'Thợ săn', 'Cupid', 'Già làng'];
    if (playerCount >= 10) return ['Sói', 'Sói', 'Sói', 'Bán sói', 'Tiên tri', 'Bảo vệ', 'Phù thủy', 'Thợ săn', 'Cupid', 'Già làng', 'Dân làng', 'Dân làng'].slice(0, playerCount);
    return Array(playerCount).fill('Dân làng'); 
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// ==========================================
// DATABASE LƯU TRỮ RA FILE (1 FILE DUY NHẤT, TÁCH THEO SERVER)
// ==========================================
const DB_FILE = './database.json';
let db = {
    guilds: {},
    shop: {}
};

if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE, 'utf8');
        db = JSON.parse(rawData);
        if (!db.guilds) db.guilds = {};
        if (!db.shop) db.shop = {};
    } catch (err) {
        console.error('Lỗi khi đọc file database:', err);
    }
}

function saveData() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 4), 'utf8');
}

function getGuildData(guildId = 'global') {
    if (!db.guilds[guildId]) {
        db.guilds[guildId] = {
            balance: {},
            lastDaily: {},
            fishing: {},
            prisonConfig: {}, 
            prisonUsers: {},  
            debts: {}, // THÊM DÒNG NÀY ĐỂ LƯU NỢ (Nhớ có dấu phẩy ở đây nhé)
            
            // --- THÊM PHẦN NÀY CHO HỆ THỐNG RƯƠNG ---
            lootbox: { 
                pools: { 'Thường': [], 'Không Phổ Biến': [], 'Hiếm': [], 'Sử Thi': [], 'Huyền Thoại': [], 'Thần Thoại': [], 'Tối Thượng': [], 'Độc Nhất': [] }, 
                inventory: {} 
            }
            // ----------------------------------------
        };
        saveData();
    }

    const guildData = db.guilds[guildId];
    if (!guildData.balance) guildData.balance = {};
    if (!guildData.lastDaily) guildData.lastDaily = {};
    if (!guildData.fishing) guildData.fishing = {};
    if (!guildData.prisonConfig) guildData.prisonConfig = {};
    if (!guildData.prisonUsers) guildData.prisonUsers = {};
    if (!guildData.debts) guildData.debts = {}; // Đảm bảo không bị lỗi undefined
    
    // --- THÊM ĐOẠN NÀY ĐỂ CẬP NHẬT DATABASE CŨ KHÔNG BỊ LỖI ---
    if (!guildData.lootbox) {
        guildData.lootbox = { 
            pools: { 'Thường': [], 'Không Phổ Biến': [], 'Hiếm': [], 'Sử Thi': [], 'Huyền Thoại': [], 'Thần Thoại': [], 'Tối Thượng': [], 'Độc Nhất': [] }, 
            inventory: {} 
        };
    }
    if (!guildData.lootbox.pools) {
        guildData.lootbox.pools = { 'Thường': [], 'Không Phổ Biến': [], 'Hiếm': [], 'Sử Thi': [], 'Huyền Thoại': [], 'Thần Thoại': [], 'Tối Thượng': [], 'Độc Nhất': [] };
    }
    if (!guildData.lootbox.inventory) {
        guildData.lootbox.inventory = {};
    }
    // ----------------------------------------------------------

    // --- HỆ THỐNG TU TIÊN: KHỞI TẠO DỮ LIỆU NẾU CHƯA CÓ ---
    if (!guildData.tuTien) guildData.tuTien = {};
    if (!guildData.tuTienConfig) {
        guildData.tuTienConfig = {
            channelId: null,      // Kênh bind thông báo đột phá/PK
            roleBind: {},         // { 'Trúc Cơ': roleId, ... }
            globalBuff: { multiplier: 1, until: 0 },
            banned: []            // Danh sách userId bị cấm chơi Tu Tiên
        };
    }
    if (!guildData.tuTienConfig.roleBind) guildData.tuTienConfig.roleBind = {};
    if (!guildData.tuTienConfig.globalBuff) guildData.tuTienConfig.globalBuff = { multiplier: 1, until: 0 };
    if (!guildData.tuTienConfig.banned) guildData.tuTienConfig.banned = [];
    // -------------------------------------------------------

    // --- HỆ THỐNG NÔNG TRẠI: KHỞI TẠO DỮ LIỆU NẾU CHƯA CÓ ---
    if (!guildData.farm) {
        guildData.farm = {
            users: {},
            market: {},
            weather: { current: 'nang_dep', changedAt: Date.now() },
            specialTrader: null
        };
    }
    if (!guildData.farm.users) guildData.farm.users = {};
    if (!guildData.farm.market) guildData.farm.market = {};
    if (!guildData.farm.weather) guildData.farm.weather = { current: 'nang_dep', changedAt: Date.now() };
    // ---------------------------------------------------------

    // --- HỆ THỐNG CHỨNG KHOÁN: KHỞI TẠO DỮ LIỆU NẾU CHƯA CÓ ---
    if (!guildData.stock) {
        guildData.stock = {
            price: STOCK_START_PRICE,
            lastChange: 0,
            lastChangePercent: 0,
            history: [STOCK_START_PRICE],
            channelId: null,
            messageId: null,
            holdings: {}
        };
    }
    if (guildData.stock.price === undefined) guildData.stock.price = STOCK_START_PRICE;
    if (!guildData.stock.history) guildData.stock.history = [guildData.stock.price];
    if (!guildData.stock.holdings) guildData.stock.holdings = {};
    // -----------------------------------------------------------

    return guildData;
}

function getBalance(userId, guildId = 'global') {
    const guildData = getGuildData(guildId);
    if (guildData.balance[userId] === undefined) {
        guildData.balance[userId] = 1000;
        saveData();
    }
    return guildData.balance[userId];
}

function addBalance(userId, amount, guildId = 'global') {
    // guildId luôn được dùng làm khóa riêng biệt -> ví tiền của cùng 1 người
    // ở server A và server B đã tách biệt sẵn (db.guilds[guildId].balance).
    // FIX: thêm chặn sàn (floor) ở đây để không có thao tác nào (trừ nợ,
    // tịch thu, mua sắm...) có thể đẩy số dư xuống âm hàng tỷ như trong ảnh.
    const guildData = getGuildData(guildId);
    if (guildData.balance[userId] === undefined) guildData.balance[userId] = 1000;
    guildData.balance[userId] += amount;
    if (!Number.isFinite(guildData.balance[userId]) || guildData.balance[userId] < 0) {
        guildData.balance[userId] = 0;
    }
    saveData();
}

// Trừ sạch toàn bộ tiền của 1 người khi bị gắn role vào tù (tịch thu toàn bộ tài sản)
// Trả về số tiền đã bị tịch thu để có thể thông báo cho người dùng biết.
function seizeAllBalance(userId, guildId = 'global') {
    const guildData = getGuildData(guildId);
    const seized = guildData.balance[userId] || 0;
    guildData.balance[userId] = 0;
    saveData();
    return seized;
}

function saveFishingData() {
    saveData();
}

// ==========================================
// HỆ THỐNG CÂU CÁ (GHÉP TỪ SOURCE RIÊNG)
// ==========================================
const COMPONENTS = {
    lines: { 'Dây Cước Thường': 2000000, 'Dây Cước Bền': 5000000, 'Dây Carbon': 10000000, 'Dây Nano': 15000000, 'Dây Titan': 50000000, 'Dây Thiên Hà': 100000000, 'Dây Hư Không': 200000000, 'Dây Vũ Trụ': 500000000 },
    hooks: { 'Lưỡi Câu Sắt': 500000, 'Lưỡi Câu Thép': 2000000, 'Lưỡi Câu Bạc': 5000000, 'Lưỡi Câu Vàng': 10000000, 'Lưỡi Câu Titan': 30000000, 'Lưỡi Câu Poseidon': 100000000, 'Lưỡi Câu Thần Long': 200000000, 'Lưỡi Câu Sáng Thế': 500000000 },
    floats: { 'Phao Gỗ': 500000, 'Phao Tre': 1000000, 'Phao Nhựa': 1000000, 'Phao Carbon': 5000000, 'Phao Phát Sáng': 3000000, 'Phao Hải Thần': 50000000, 'Phao Thiên Hà': 100000000, 'Phao Vũ Trụ': 300000000 },
    reels: { 'Máy Câu Cũ': 10000000, 'Máy Câu Thường': 30000000, 'Máy Câu Chuyên Nghiệp': 100000000, 'Máy Câu Carbon': 200000000, 'Máy Câu Titan': 500000000, 'Máy Câu Hải Đế': 1000000000, 'Máy Câu Thần Long': 2000000000, 'Máy Câu Omega': 5000000000 },
    baits: { 'Trùn Đất': 500000, 'Tôm Nhỏ': 1000000, 'Cá Con': 1000000, 'Mồi Tổng Hợp': 2000000, 'Mồi Phát Sáng': 5000000, 'Mồi Đại Dương': 10000000, 'Mồi Huyền Thoại': 50000000, 'Mồi Thần Biển': 100000000 },
    buffs: { 'Bùa May Mắn': 50000000, 'Thuốc Rớt Đồ': 30000000 }
};

const RODS = {
    '🎣 Cần Tre': { price: 0, dur: 10, res: 5, req: null },
    '🎣 Cần Carbon Pro': { price: 5000, dur: 50, res: 15, req: {'Dây Carbon':10, 'Lưỡi Câu Thép':5, 'Máy Câu Cũ':2} },
    '🎣 Cần Bass Master': { price: 15000, dur: 80, res: 20, req: {'Dây Carbon':15, 'Lưỡi Câu Thép':10, 'Phao Carbon':5} },
    '🎣 Cần Predator': { price: 30000, dur: 120, res: 28, req: {'Dây Nano':20, 'Lưỡi Câu Bạc':10, 'Máy Câu Thường':5} },
    '🎣 Cần River King': { price: 40000, dur: 135, res: 30, req: {'Dây Nano':25, 'Lưỡi Câu Bạc':15, 'Phao Carbon':10} },
    '🎣 Cần Sea Hunter': { price: 50000, dur: 150, res: 35, req: {'Dây Titan':30, 'Lưỡi Câu Vàng':20, 'Máy Câu Chuyên Nghiệp':10} },
    '🔱 Cần Titan': { price: 120000, dur: 200, res: 45, req: {'Dây Titan':50, 'Lưỡi Câu Titan':25, 'Máy Câu Carbon':10} },  
    '🔱 Cần Long Vương': { price: 250000, dur: 250, res: 55, req: {'Vảy Rồng':10, 'Dây Titan':50, 'Phao Hải Thần':20} },  
    '🔱 Cần Hải Thần': { price: 350000, dur: 300, res: 60, req: {'Ngọc Đại Dương':20, 'Mồi Thần Biển':10, 'Dây Titan':50} },  
    '🔱 Cần Kraken': { price: 500000, dur: 350, res: 68, req: {'Xúc Tu Kraken':15, 'Dây Thiên Hà':30, 'Lưỡi Câu Poseidon':20} },  
    '🔱 Cần Ngân Hà': { price: 750000, dur: 450, res: 72, req: {'Đá Thiên Hà':50, 'Lõi Vũ Trụ':20, 'Dây Thiên Hà':30} },  
    '✨ Cần Poseidon': { price: 800000, dur: 500, res: 75, req: {'Ngọc Poseidon':25, 'Xúc Tu Kraken':20, 'Cá Thần Biển':10} },  
    '✨ Cần Leviathan': { price: 1500000, dur: 700, res: 80, req: {'Vảy Leviathan':30, 'Răng Megalodon':10, 'Tim Thủy Quái':5} },  
    '✨ Cần Atlantis': { price: 2200000, dur: 850, res: 82, req: {'Cổ Vật Atlantis':50, 'Ngọc Đại Dương':20, 'Cá Đại Dương Cổ Đại':10} },  
    '✨ Cần Hải Đế': { price: 2600000, dur: 900, res: 84, req: {'Ngọc Poseidon':50, 'Vảy Leviathan':30, 'Thần Ngư Poseidon':10} },  
    '✨ Cần Thiên Long': { price: 3000000, dur: 1000, res: 85, req: {'Vảy Rồng':50, 'Cá Thiên Long':20, 'Cá Hắc Long':10} },  
    '🌌 Cần Thần Long': { price: 5000000, dur: 1500, res: 90, req: {'Vảy Rồng':100, 'Tinh Thể Thiên Hà':50, 'Cá Thiên Long':20} },  
    '🌌 Cần Vũ Trụ': { price: 8000000, dur: 1800, res: 91, req: {'Lõi Vũ Trụ':50, 'Cá Vũ Trụ':30, 'Đá Thiên Hà':20} },  
    '🌌 Cần Hỗn Mang': { price: 12000000, dur: 2200, res: 92, req: {'Mảnh Hỗn Mang':50, 'Cá Hỗn Mang':20, 'Cá Vương Giả':10} },  
    '🌌 Cần Thiên Giới': { price: 16000000, dur: 3000, res: 94, req: {'Tinh Thể Thiên Hà':100, 'Cá Thiên Sứ':50, 'Cá Ánh Trăng':25} },  
    '🌌 Cần Sáng Thế': { price: 20000000, dur: 5000, res: 95, req: {'Cá Sáng Thế':1, 'Lõi Vũ Trụ':100, 'Tinh Thể Thiên Hà':100} },   
    '☄️ Cần Void': { price: 50000000, dur: 7000, res: 96, req: {'Mảnh Void':50, 'Cá Void':10, 'Cthulhu':5} },  
    '☄️ Cần Origin': { price: 100000000, dur: 9000, res: 97, req: {'Tinh Thể Origin':50, 'Cá Origin':10, 'Leviathan':5} },  
    '☄️ Cần Entity': { price: 250000000, dur: 12000, res: 98, req: {'Lõi Entity':50, 'Cá Entity':10, 'Kraken Hư Không':5} },  
    '☄️ Cần Null': { price: 500000000, dur: 15000, res: 99, req: {'Mảnh Null':50, 'Cá Null':10, 'Leviathan Tận Thế':5} },  
    '☄️ Cần Omega': { price: 1000000000, dur: 25000, res: 99, req: {'Mảnh Void':100, 'Tinh Thể Origin':100, 'Lõi Entity':100, 'Mảnh Null':100, 'Cá Omega':10, 'Leviathan Tận Thế':1} }
};

const ZONES = {
    'Ao Làng': { fee: 0, level: 1, maxRarity: 'Rare' }, 'Sông Lớn': { fee: 100000, level: 10, maxRarity: 'Epic' }, 'Hồ Bí Ẩn': { fee: 1000000, level: 25, maxRarity: 'Legendary' },
    'Biển Đông': { fee: 10000000, level: 50, maxRarity: 'Mythic' }, 'Rãnh Đại Dương': { fee: 100000000, level: 80, maxRarity: 'Secret' },
    'Atlantis': { fee: 1000000000, level: 100, maxRarity: 'Secret' }, 'Hư Không': { fee: 10000000000, level: 150, maxRarity: 'Secret' }
};

const RANK_VAL = { 'Uncommon': 1, 'Rare': 2, 'Epic': 3, 'Legendary': 4, 'Mythic': 5, 'Secret': 6 };

const BAIT_BUFFS = {
    "Trùn Đất": { target: 'Uncommon', bonus: 0 }, "Tôm Nhỏ": { target: 'Rare', bonus: 5 }, "Cá Con": { target: 'Rare', bonus: 10 },
    "Mồi Tổng Hợp": { target: 'Epic', bonus: 15 }, "Mồi Phát Sáng": { target: 'Epic', bonus: 20 }, "Mồi Đại Dương": { target: 'Legendary', bonus: 30 },
    "Mồi Huyền Thoại": { target: 'Mythic', bonus: 50 }, "Mồi Thần Biển": { target: 'Secret', bonus: 75 }
};

const FISH_DATA = {
    Uncommon: { chance: 50, minPrice: 30000, maxPrice: 150000, breakChance: 10, list: ['Cá Lóc Đồng', 'Cá Tra', 'Cá Rô Phi', 'Cá Rô Đồng', 'Cá Trê Lai', 'Cá Trê Trắng', 'Cá Trê Vàng', 'Cá Basa', 'Cá Trắm Cỏ', 'Cá Tai Tượng', 'Cá Chim Trắng', 'Cá Diêu Hồng', 'Cá Leo', 'Cá Chạch', 'Cá Thát Lát', 'Cá Bống Tượng', 'Cá Sặc Rằn', 'Cá Mè Hoa', 'Cá Chốt', 'Cá Ngát', 'Cá He', 'Cá Dứa', 'Cá Măng Sữa', 'Cá Nàng Hai', 'Cá Chày'], drops: ['Vảy Rồng', 'Ngọc Đại Dương'] },
    Rare: { chance: 25, minPrice: 150000, maxPrice: 500000, breakChance: 30, list: ['Cá Hô', 'Cá Vồ Đém', 'Cá Chình', 'Cá Ngạnh', 'Cá Nheo', 'Cá Koi', 'Cá Tầm', 'Cá Măng', 'Cá Anh Vũ', 'Cá Bông Lau Khổng Lồ', 'Cá Hồi', 'Cá Tầm Siberia', 'Cá Chép Kính', 'Cá Chình Điện', 'Cá Hổ Sông'], drops: ['Xúc Tu Kraken', 'Cổ Vật Atlantis'] },
    Epic: { chance: 15, minPrice: 500000, maxPrice: 2000000, breakChance: 50, list: ['Cá Rồng Đỏ', 'Cá Kiếm', 'Cá Ngừ Đại Dương', 'Cá Thu Hoàng Kim', 'Cá Mập Con', 'Cá Đuối Khổng Lồ', 'Cá Cờ Xanh', 'Cá Mặt Quỷ', 'Cá Hổ Biển', 'Cá Kình Non', 'Cá Hổ Vàng', 'Cá Rồng Bạc'], drops: ['Đá Thiên Hà', 'Lõi Vũ Trụ'] },
    Legendary: { chance: 8, minPrice: 2000000, maxPrice: 20000000, breakChance: 70, list: ['Cá Rồng Vàng', 'Cá Mập Trắng', 'Cá Hỏa Long', 'Cá Băng Long', 'Cá Đại Dương Cổ Đại', 'Cá Thiên Hà', 'Cá Hư Không', 'Cá Hoàng Gia', 'Cá Pha Lê', 'Cá Ngọc Bích', 'Cá Thần Sấm', 'Cá Thần Gió'], drops: ['Ngọc Poseidon', 'Răng Megalodon', 'Tim Thủy Quái'] },
    Mythic: { chance: 1.9, minPrice: 20000000, maxPrice: 200000000, breakChance: 85, list: ['Cá Koi Vàng', 'Cá Rồng Bạch Kim', 'Cá Mập Búa', 'Cá Ngọc Trai', 'Cá Hoàng Kim', 'Cá Kim Cương', 'Cá Ánh Trăng', 'Cá Mặt Trời', 'Cá Thiên Sứ', 'Cá Bóng Tối', 'Cá Hắc Long', 'Cá Thiên Long', 'Cá Ngân Hà', 'Cá Hỗn Mang', 'Cá Vương Giả'], drops: ['Vảy Leviathan', 'Tinh Thể Thiên Hà', 'Mảnh Hỗn Mang'] },
    Secret: { chance: 0.1, minPrice: 500000000, maxPrice: 100000000000, breakChance: 95, list: ['Cá Vũ Trụ', 'Kraken', 'Megalodon', 'Jormungandr', 'Cá Sáng Thế', 'Cá Tận Thế', 'Hắc Long Vương', 'Cá Void', 'Cá Origin', 'Cá Entity', 'Cá Null', 'Cthulhu', 'Titan Đại Dương', 'Quái Ngư Abyss', 'Rồng Biển Cổ Đại', 'Thần Ngư Poseidon', 'Leviathan', 'Leviathan Tận Thế', 'Kraken Hư Không', 'Cá Omega'], drops: ['Mảnh Void', 'Tinh Thể Origin', 'Lõi Entity', 'Mảnh Null'] }
};

// ==========================================
// DỮ LIỆU ĐÀI XỔ SỐ 3 MIỀN
// ==========================================
const XS_STATIONS = {
    'Bắc': [
        'Hà Nội', 'Bắc Ninh', 'Hải Phòng', 'Nam Định', 'Quảng Ninh'
    ],
    'Trung': [
        'Đà Nẵng', 'Khánh Hòa', 'Bình Định', 'Quảng Bình', 'Quảng Trị', 
        'Quảng Nam', 'Quảng Ngãi', 'Phú Yên', 'Gia Lai', 'Kon Tum', 
        'Đắk Lắk', 'Đắk Nông', 'Ninh Thuận', 'Thừa Thiên Huế'
    ],
    'Nam': [
        'TP. Hồ Chí Minh', 'An Giang', 'Bạc Liêu', 'Bến Tre', 'Bình Dương', 
        'Bình Phước', 'Bình Thuận', 'Cà Mau', 'Cần Thơ', 'Đà Lạt', 'Đồng Nai', 
        'Đồng Tháp', 'Hậu Giang', 'Kiên Giang', 'Long An', 'Sóc Trăng', 
        'Tây Ninh', 'Tiền Giang', 'Trà Vinh', 'Vĩnh Long', 'Vũng Tàu'
    ]
};
const ALL_XS_STATIONS = [...XS_STATIONS['Bắc'], ...XS_STATIONS['Trung'], ...XS_STATIONS['Nam']];

function ensureBalanceProxy(userObj, userId, guildId) {
    const desc = Object.getOwnPropertyDescriptor(userObj, 'balance');
    if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') return;

    Object.defineProperty(userObj, 'balance', {
        enumerable: true,
        configurable: true,
        get() {
            return getBalance(userId, guildId);
        },
        set(value) {
            const guildData = getGuildData(guildId);
            guildData.balance[userId] = value;
            saveData();
        }
    });
}

function fishingGetUser(userId, guildId = 'global') {
    const guildData = getGuildData(guildId);

    if (!guildData.fishing[userId]) {
        guildData.fishing[userId] = {
            level: 1,
            exp: 0,
            inventory: {},
            maxInv: 50,
            zone: 'Ao Làng',
            equip: { rod: '🎣 Cần Tre', rodPlus: 0, dur: 10, line: null, hook: null, float: null, reel: null, bait: null },
            buffs: { luck: 0, drop: 0 },
            lastDaily: 0
        };
        saveData();
    }

    const userObj = guildData.fishing[userId];
    ensureBalanceProxy(userObj, userId, guildId);

    if (userObj.lastDaily === undefined) userObj.lastDaily = 0;
    if (!userObj.inventory) userObj.inventory = {};
    if (!userObj.equip) {
        userObj.equip = { rod: '🎣 Cần Tre', rodPlus: 0, dur: 10, line: null, hook: null, float: null, reel: null, bait: null };
    }
    if (!userObj.buffs) userObj.buffs = { luck: 0, drop: 0 };
    if (userObj.maxInv === undefined) userObj.maxInv = 50;
    if (!userObj.zone) userObj.zone = 'Ao Làng';
    if (userObj.level === undefined) userObj.level = 1;
    if (userObj.exp === undefined) userObj.exp = 0;

    return userObj;
}

// ==========================================
// HỆ THỐNG TẢI TỪ ĐIỂN NỐI TỪ
// ==========================================
const vtWords = new Set();
const dictionaryFiles = ['Tudien.txt', 'Tudien2.txt', 'Tudien3.txt'];

let totalLoaded = 0;

for (const dictionaryFile of dictionaryFiles) {
    if (fs.existsSync(`./${dictionaryFile}`)) {
        const content = fs.readFileSync(`./${dictionaryFile}`, 'utf8');
        const lines = content.split(/\r?\n/);
        let count = 0;

        for (const line of lines) {
            const word = line.trim().toLowerCase();
            if (word) {
                if (!vtWords.has(word)) {
                    vtWords.add(word);
                    count++;
                }
            }
        }

        totalLoaded += count;
        console.log(`[NỐI TỪ] Đã nạp thành công ${count} từ từ file ${dictionaryFile}.`);
    } else {
        console.log(`[⚠️ CẢNH BÁO] Không tìm thấy file ${dictionaryFile}! Vui lòng tải file vào thư mục.`);
    }
}

console.log(`[NỐI TỪ - TỔNG KẾT] Đã tải tổng cộng ${vtWords.size} từ vựng vào bộ nhớ!`);

const PREFIX = '!';
const ADMIN_ID = '1020868400672686080';

client.once('clientReady', async (client) => {
    console.log(`🤖 Bot Game All-In-One Sẵn Sàng: ${client.user.tag}`);
    try {
            // Thiết lập vòng lặp cập nhật trạng thái
    setInterval(() => {
        // Ép thời gian của máy chủ về đúng múi giờ Việt Nam để không bị lệch ngày
        const vnTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' });
        const vnDate = new Date(vnTimeStr);
        
        // 1. Lấy "Thứ" chính xác theo giờ VN
        const days = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
        const dayName = days[vnDate.getDay()];
        
        // 2. Lấy Ngày/Tháng/Năm (định dạng 00/00/0000)
        const day = String(vnDate.getDate()).padStart(2, '0');
        const month = String(vnDate.getMonth() + 1).padStart(2, '0');
        const year = vnDate.getFullYear();
        const fullDate = `${day}/${month}/${year}`;
        
        // 3. Lấy Giờ:Phút:Giây (định dạng 00:00:00)
        const hours = String(vnDate.getHours()).padStart(2, '0');
        const minutes = String(vnDate.getMinutes()).padStart(2, '0');
        const seconds = String(vnDate.getSeconds()).padStart(2, '0');
        const fullTime = `${hours}:${minutes}:${seconds}`;

        // 4. Lấy tổng số server bot đang tham gia
        const serverCount = client.guilds.cache.size;

        // 5. Ghép chuỗi chuẩn: Thứ | Ngày/Tháng/Năm | Giờ:Phút:Giây
        const statusText = `${dayName} | ${fullDate} | ${fullTime} 🇻🇳 ${serverCount} Server`;

        // 6. Cập nhật trạng thái thành "Đang xem" (Watching)
        client.user.setActivity(statusText, { type: ActivityType.Watching });
        
    }, 8000); // 8000 = 8giây
    
        setInterval(async () => {
            for (const guildId in db.guilds) {
                const guildData = db.guilds[guildId];
                const guild = client.guilds.cache.get(guildId);
                if (!guild) continue;

                const prisonRole = guild.roles.cache.get(guildData.prisonConfig?.roleId);
                const prisonChannel = guild.channels.cache.get(guildData.prisonConfig?.channelId);

                // ==========================================
                // 1. KIỂM TRA ĐÒI NỢ (Quá hạn -> Bỏ tù)
                // ==========================================
                if (guildData.debts && Object.keys(guildData.debts).length > 0) {
                    for (const userId in guildData.debts) {
                        const debt = guildData.debts[userId];
                        
                        // Quá thời hạn vay mà chưa trả
                        if (Date.now() >= debt.deadline) {
                            const factor = debt.factor;
                            const prisonHours = factor * 5; // Tù 5 tiếng x factor
                            
                            // Tạo hồ sơ tù nhân (6 nhiệm vụ lao động công ích)
                            guildData.prisonUsers[userId] = {
                                releaseTime: Date.now() + (prisonHours * 60 * 60 * 1000),
                                tasks: buildPrisonTasks(factor)
                            };

                            // Gắn role tù nhân
                            try {
                                const member = await guild.members.fetch(userId).catch(() => null);
                                if (member && prisonRole) {
                                    await member.roles.add(prisonRole).catch(() => {});
                                }
                            } catch(e) {}

                            // Tịch thu (trừ sạch) toàn bộ số dư hiện có của con nợ khi bị tống giam
                            const seizedAmount = seizeAllBalance(userId, guildId);

                            // Xóa nợ do đã quy đổi thành hình phạt tù
                            delete guildData.debts[userId];
                            saveData();

                            // Thông báo ra kênh nhà tù + hiển thị bảng nhiệm vụ cần hoàn thành
                            if (prisonChannel) {
                                prisonChannel.send(`🚨 **CẢNH BÁO TÍN DỤNG ĐEN** 🚨\n<@${userId}> đã bùng khoản nợ **${debt.amount.toLocaleString()} VNĐ**! Hệ thống đã bắt giữ và tống giam đối tượng trong **${prisonHours} giờ** để lao động trừ nợ!\n💸 Toàn bộ số dư còn lại (**${seizedAmount.toLocaleString()}đ**) đã bị tịch thu sung công quỹ!\n\n📋 **BẢNG NHIỆM VỤ CẢI TẠO CẦN HOÀN THÀNH:**\n${buildPrisonTaskBoard(guildData.prisonUsers[userId].tasks)}\n👉 Hoàn thành **hết** các nhiệm vụ trên sẽ được hệ thống **tự động đặc xá**, gỡ role và trả tự do ngay lập tức!`).catch(() => {});
                            }
                        }
                    }
                }

                // ==========================================
                // 2. KIỂM TRA HẾT HẠN TÙ (Được thả tự do)
                // ==========================================
                if (guildData.prisonUsers && Object.keys(guildData.prisonUsers).length > 0) {
                    for (const userId in guildData.prisonUsers) {
                        const prisonData = guildData.prisonUsers[userId];
                        
                        if (Date.now() >= prisonData.releaseTime) {
                            try {
                                const member = await guild.members.fetch(userId).catch(() => null);
                                if (member && prisonRole) {
                                    await member.roles.remove(prisonRole).catch(() => {});
                                }
                            } catch(e) {}
                            
                            delete guildData.prisonUsers[userId];
                            saveData();

                            if (prisonChannel) {
                                prisonChannel.send(`⏰ <@${userId}> đã mãn hạn tù công ích, được trả tự do! Lần sau nhớ trả nợ đúng hạn nhé.`);
                            }
                        }
                    }
                }
                
            }
        }, 60000); // Quét mỗi 1 phút
        
           cron.schedule('30 17 * * *', async () => {
    console.log('⏳ [17H30] Hệ thống bắt đầu tiến hành mở thưởng xổ số Đa Đài...');
    
    for (const guildId in db.guilds) {
        const guildData = db.guilds[guildId];
        if (!guildData.lotteryConfig || !guildData.lotteryConfig.dais || guildData.lotteryConfig.dais.length === 0 || !guildData.lotteryConfig.channelId) continue;
        
        const channel = client.channels.cache.get(guildData.lotteryConfig.channelId);
        if (!channel) continue;

        const dais = guildData.lotteryConfig.dais;
        const results = {};

        // 1. Quay số ngẫu nhiên độc lập cho từng đài đã chọn
        dais.forEach(dai => {
            results[dai] = {
                g8: [randDigits(2)],
                g7: [randDigits(3)],
                g6: [randDigits(4), randDigits(4), randDigits(4)],
                g5: [randDigits(4)],
                g4: [randDigits(5), randDigits(5), randDigits(5), randDigits(5), randDigits(5), randDigits(5), randDigits(5)],
                g3: [randDigits(5), randDigits(5)],
                g2: [randDigits(5)],
                g1: [randDigits(5)],
                gdb: randDigits(6)
            };
        });

        const prizeMoney = {
            g8: 100000, g7: 200000, g6: 400000, g5: 1000000, g4: 3000000, 
            g3: 10000000, g2: 15000000, g1: 30000000, gdb: 2000000000,
            gphu: 50000000, gkk: 6000000
        };

        const prizesOrder = [
            { key: 'g8', name: 'Giải Tám (2 chữ số)' },
            { key: 'g7', name: 'Giải Bảy (3 chữ số)' },
            { key: 'g6', name: 'Giải Sáu (4 chữ số)' },
            { key: 'g5', name: 'Giải Năm (4 chữ số)' },
            { key: 'g4', name: 'Giải Tư (5 chữ số)' },
            { key: 'g3', name: 'Giải Ba (5 chữ số)' },
            { key: 'g2', name: 'Giải Nhì (5 chữ số)' },
            { key: 'g1', name: 'Giải Nhất (5 chữ số)' },
            { key: 'gdb', name: '💥 GIẢI ĐẶC BIỆT (6 chữ số) 💥' },
            { key: 'gphu', name: 'Giải Phụ Đặc Biệt' },
            { key: 'gkk', name: 'Giải Khuyến Khích' }
        ];

        // stationWinners[daiName][prizeKey] = Map<userId, soToTrung>
        const stationWinners = {};
        dais.forEach(dai => { stationWinners[dai] = {}; });
        // Tổng tiền thưởng từng người (gộp tất cả các đài) để tổng kết cuối cùng
        const totalWinMoney = {};

        // 2. Tiến hành dò số đa đài cho từng người chơi, gom kết quả theo TỪNG ĐÀI
        if (guildData.lotteryUsers) {
            for (const [userId, userLottery] of Object.entries(guildData.lotteryUsers)) {
                for (const [daiName, tickets] of Object.entries(userLottery)) {
                    if (!results[daiName] || !tickets || tickets.length === 0) continue;
                    const res = results[daiName];

                    const recordWin = (prizeKey, money) => {
                        if (!stationWinners[daiName][prizeKey]) stationWinners[daiName][prizeKey] = new Map();
                        const m = stationWinners[daiName][prizeKey];
                        m.set(userId, (m.get(userId) || 0) + 1);
                        totalWinMoney[userId] = (totalWinMoney[userId] || 0) + money;
                        addBalance(userId, money, guildId);
                    };

                    tickets.forEach(ticket => {
                        const checkPrize = (resArray, prizeKey, money) => {
                            for (let r of resArray) {
                                if (ticket.endsWith(r)) recordWin(prizeKey, money);
                            }
                        };

                        checkPrize(res.g8, 'g8', prizeMoney.g8);
                        checkPrize(res.g7, 'g7', prizeMoney.g7);
                        checkPrize(res.g6, 'g6', prizeMoney.g6);
                        checkPrize(res.g5, 'g5', prizeMoney.g5);
                        checkPrize(res.g4, 'g4', prizeMoney.g4);
                        checkPrize(res.g3, 'g3', prizeMoney.g3);
                        checkPrize(res.g2, 'g2', prizeMoney.g2);
                        checkPrize(res.g1, 'g1', prizeMoney.g1);

                        if (ticket === res.gdb) {
                            recordWin('gdb', prizeMoney.gdb);
                        } else if (ticket.slice(1) === res.gdb.slice(1)) {
                            recordWin('gphu', prizeMoney.gphu);
                        } else {
                            let matchCount = 0;
                            for (let i = 0; i < 6; i++) {
                                if (ticket[i] === res.gdb[i]) matchCount++;
                            }
                            if (matchCount === 5) recordWin('gkk', prizeMoney.gkk);
                        }
                    });
                }
            }

            // Tự động xóa dữ liệu vé cũ để chuẩn bị vòng lặp mới
            guildData.lotteryUsers = {};
        }

        // 🔒 Đóng quầy bán vé ngay sau khi chốt kết quả, chờ Admin mở lại bằng /vesomoi
        guildData.lotteryConfig.saleOpen = false;
        saveData();

        // 3. GỬI BẢNG KẾT QUẢ SỐ CHUNG (đã sửa lỗi dàn trang cho 3-4 đài)
        const embedResult = new EmbedBuilder()
            .setTitle(`📢 BẢNG KẾT QUẢ XỔ SỐ KIẾN THIẾT ĐA ĐÀI - 17H30 📢`)
            .setColor('#e74c3c')
            .setDescription(`**Các tỉnh mở thưởng hôm nay:** ${dais.map(d => `**${d}**`).join(' ⇄ ')}`)
            .setTimestamp();

        prizesOrder.filter(p => !['gphu', 'gkk'].includes(p.key)).forEach(p => {
            let rowContent = dais.map(dai => {
                const val = results[dai][p.key];
                const cleanVal = Array.isArray(val) ? val.join(' - ') : val;
                return `**[${dai.substring(0, 7)}]** \`${cleanVal}\``;
            }).join('\n');

            embedResult.addFields({ name: `🔹 ${p.name}`, value: rowContent.substring(0, 1024), inline: false });
        });

        await channel.send({ embeds: [embedResult] });

        // 4. GỬI THÔNG BÁO TRÚNG THƯỞNG RIÊNG CHO TỪNG ĐÀI, TAG NGƯỜI TRÚNG THEO SỐ TỜ (VD: ×4 tờ)
        let anyWinner = false;
        for (const dai of dais) {
            const prizeMap = stationWinners[dai];
            const hasWinner = Object.values(prizeMap).some(m => m && m.size > 0);
            if (!hasWinner) continue;
            anyWinner = true;

            let lines = [];
            for (const p of prizesOrder) {
                const winMap = prizeMap[p.key];
                if (!winMap || winMap.size === 0) continue;
                const tagList = Array.from(winMap.entries())
                    .map(([uid, count]) => `<@${uid}> ×${count} tờ`)
                    .join(', ');
                lines.push(`🔸 **${p.name}:** ${tagList}`);
            }

            // Chia nhỏ nếu quá dài để tránh vượt giới hạn 4096 ký tự description của Discord
            const chunkLines = [];
            let cur = '';
            for (const line of lines) {
                if ((cur + line + '\n').length > 3800) {
                    chunkLines.push(cur);
                    cur = '';
                }
                cur += line + '\n';
            }
            if (cur) chunkLines.push(cur);

            for (let i = 0; i < chunkLines.length; i++) {
                const stationEmbed = new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`🎉 KẾT QUẢ TRÚNG THƯỞNG - ĐÀI ${dai.toUpperCase()}${chunkLines.length > 1 ? ` (${i + 1}/${chunkLines.length})` : ''} 🎉`)
                    .setDescription(chunkLines[i]);
                await channel.send({ embeds: [stationEmbed] });
            }
        }

        if (!anyWinner) {
            await channel.send('😢 Kết quả đối chiếu: Hôm nay không có ai may mắn trúng số ở đài nào cả. Hẹn mọi người vào đài quay ngày mai nhé!');
        } else {
            // 5. Tổng kết số tiền mỗi người nhận được (gộp tất cả các đài)
            const totalLines = Object.entries(totalWinMoney)
                .sort((a, b) => b[1] - a[1])
                .map(([uid, money]) => `• <@${uid}>: **${money.toLocaleString()} VNĐ**`);

            const maxMsgLength = 1900;
            let currentMsg = `💰 **TỔNG TIỀN THƯỞNG ĐÃ PHÁT HÔM NAY:**\n`;
            for (const line of totalLines) {
                if (currentMsg.length + line.length > maxMsgLength) {
                    await channel.send(currentMsg);
                    currentMsg = `${line}\n`;
                } else {
                    currentMsg += `${line}\n`;
                }
            }
            if (currentMsg.trim() !== '') await channel.send(currentMsg);
        }

        // 6. Thông báo đóng quầy, chờ lệnh /vesomoi cho ngày mới
        await channel.send('🔒 **Đại lý vé số đã đóng cửa và phát thưởng xong!** Nút mua vé số sẽ ngừng hoạt động cho đến khi Admin dùng lệnh `/vesomoi` để mở bán cho ngày tiếp theo.');
    }
}, { timezone: "Asia/Ho_Chi_Minh" });

        const slashCommands = [
            {
                name: 'give',
                description: 'Tặng tiền cho người dùng khác',
                options: [{
                    name: 'money',
                    description: 'Chuyển tiền tài khoản',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        { name: 'user', description: 'Người nhận', type: ApplicationCommandOptionType.User, required: true },
                        { name: 'money', description: 'Số tiền', type: ApplicationCommandOptionType.Integer, required: true }
                    ]
                }]
            },
            {
                name: 'buff',
                description: 'Lệnh Admin: Bơm tiền ẩn danh',
                options: [
                    { name: 'user', description: 'Chọn người nhận', type: ApplicationCommandOptionType.User, required: true },
                    { name: 'money', description: 'Số tiền cấp', type: ApplicationCommandOptionType.Integer, required: true }
                ]
            },
            {
                name: 'sell',
                description: 'Lệnh Admin: Thêm role vào Cửa Hàng (Shop)',
                options: [
                    { name: 'role', description: 'Chọn role muốn bán', type: ApplicationCommandOptionType.Role, required: true },
                    { name: 'price', description: 'Mức giá bán ra (VNĐ)', type: ApplicationCommandOptionType.Integer, required: true },
                    { name: 'code', description: 'Mã số hàng hóa (VD: 404)', type: ApplicationCommandOptionType.String, required: true }
                ]
            },
            {
                name: 'nangcap',
                description: 'Nâng cấp chỉ số cần câu (+1, +2...)',
                options: []
            },
            {
                name: 'update',
                description: 'Lò rèn: Chế tạo/Tiến hóa Cần Câu (Cần có nguyên liệu)',
                options: []
            },
            {
                name: 'rest',
                description: 'Lệnh Admin: Thu hồi nợ/tịch thu tiền của Member',
                options: [
                    { name: 'user', description: 'Người bị thu hồi', type: ApplicationCommandOptionType.User, required: true },
                    { name: 'money', description: 'Số tiền thu', type: ApplicationCommandOptionType.Integer, required: true }
                ]
            },
            {
                name: 'capquyenkenh',
                description: 'Cài đặt kênh nhà tù và role hình phạt (Chỉ Admin/Owner)',
                options: [
                    { 
                        name: 'nha_tu', 
                        description: 'Chọn kênh văn bản làm khu vực nhà tù công ích', 
                        type: ApplicationCommandOptionType.Channel, 
                        required: true 
                    },
                    { 
                        name: 'role', 
                        description: 'Chọn role sẽ bị gắn khi người dùng bị bỏ tù', 
                        type: ApplicationCommandOptionType.Role, 
                        required: true 
                    }
                ]
            },
            {
    name: 'setup-pool',
    description: 'Chỉ Admin: Thêm phần thưởng vào 8 mốc độ hiếm',
    default_member_permissions: '8', // Đảm bảo dòng này nằm đúng chỗ
    options: [
        {
            name: 'rarity',
            description: 'Chọn độ hiếm',
            type: ApplicationCommandOptionType.String, // <--- BẮT BUỘC PHẢI CÓ
            required: true,
            choices: RARITIES.map(r => ({ name: r, value: r }))
        },
        { 
            name: 'role', 
            description: 'Chọn Role', 
            type: ApplicationCommandOptionType.Role, // <--- BẮT BUỘC PHẢI CÓ
            required: false 
        },
        { 
            name: 'money', 
            description: 'Số tiền', 
            type: ApplicationCommandOptionType.Integer, // <--- BẮT BUỘC PHẢI CÓ
            required: false 
        },
        { 
            name: 'can_cau', 
            description: 'Mã cần câu', 
            type: ApplicationCommandOptionType.String, // <--- BẮT BUỘC PHẢI CÓ
            required: false 
        },
        { 
            name: 'moi_cau', 
            description: 'Tên mồi câu', 
            type: ApplicationCommandOptionType.String, // <--- BẮT BUỘC PHẢI CÓ
            required: false 
        },
        { 
            name: 'so_luong', 
            description: 'Số lượng vật phẩm', 
            type: ApplicationCommandOptionType.Integer, // <--- BẮT BUỘC PHẢI CÓ
            required: false 
        }
    ]
},	
            {
                name: 'borrow',
                description: 'Vay tiền ngân hàng (Trả gấp 10 lần trong 20 phút, quá hạn sẽ bị đi tù)',
                options: [
                    { 
                        name: 'money', 
                        description: 'Số tiền muốn vay', 
                        type: ApplicationCommandOptionType.Integer, 
                        required: true 
                    }
                ]
            },
            {
                name: 'trano',
                description: 'Thanh toán nợ tín dụng đen (Trả x10 số tiền đã vay ban đầu)',
                options: []
            },
            {
                name: 'broadcast',
                description: 'Lệnh Admin: Trợ cấp tiền đồng loạt theo Role',
                options: [
                    { name: 'role', description: 'Role nhận tiền', type: ApplicationCommandOptionType.Role, required: true },
                    { name: 'money', description: 'Số tiền trợ cấp', type: ApplicationCommandOptionType.Integer, required: true }
                ]
            },
                        {
                name: 'doino',
                description: 'Lệnh Chủ Bot: Đòi nợ khẩn cấp và thiết lập thời gian chót (phút)',
                options: [
                    {
                        name: 'phut',
                        description: 'Số phút cuối cùng trước khi tất cả con nợ bị bỏ tù',
                        type: ApplicationCommandOptionType.Integer,
                        required: true
                    }
                ]
            },
                        {
                name: 'tratudo',
                description: 'Lệnh Admin/Owner: Đặc xá, trả tự do ngay lập tức cho 1 người đang ở tù',
                options: [
                    { 
                        name: 'user', 
                        description: 'Chọn người dùng muốn trả tự do', 
                        type: ApplicationCommandOptionType.User, 
                        required: true 
                    }
                ]
            },
            {
                name: 'vaotu',
                description: 'Lệnh Admin/Owner: Tống giam ngay lập tức 1 thành viên',
                options: [
                    {
                        name: 'user',
                        description: 'Chọn thành viên muốn tống giam',
                        type: ApplicationCommandOptionType.User,
                        required: true
                    },
                    {
                        name: 'phut',
                        description: 'Thời gian thụ án (phút). Mặc định 60 phút nếu bỏ trống',
                        type: ApplicationCommandOptionType.Integer,
                        required: false
                    },
                    {
                        name: 'ly_do',
                        description: 'Lý do bị tống giam',
                        type: ApplicationCommandOptionType.String,
                        required: false
                    }
                ]
            },
            {
    name: 'dailyveso',
    description: 'Chọn kênh Discord tự động báo kết quả xổ số (Chỉ Admin/Owner)',
    default_member_permissions: '8',
    options: [
        {
            name: 'kenhbaotrung',
            description: 'Chọn kênh văn bản để bot tự động báo kết quả',
            type: ApplicationCommandOptionType.Channel,
            required: true,
            channel_types: [0] // Chỉ cho phép chọn kênh Text
        }
    ]
},
            {
    name: 'vesomoi',
    description: 'Cài đặt các đài xổ số cho ngày mới và reset toàn bộ dữ liệu vé cũ (Chỉ Admin/Owner)',
    default_member_permissions: '8',
    options: [
        {
            name: 'mien',
            description: 'Chọn khu vực miền',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
                { name: 'Miền Bắc (5 đài)', value: 'Bắc' },
                { name: 'Miền Trung (14 đài)', value: 'Trung' },
                { name: 'Miền Nam (21 đài)', value: 'Nam' }
            ]
        },
        {
            name: 'dai1',
            description: 'Chọn đài xổ số thứ 1 (Bắt buộc)',
            type: ApplicationCommandOptionType.String,
            required: true,
            autocomplete: true
        },
        {
            name: 'dai2',
            description: 'Chọn đài xổ số thứ 2 (Tùy chọn)',
            type: ApplicationCommandOptionType.String,
            required: false,
            autocomplete: true
        },
        {
            name: 'dai3',
            description: 'Chọn đài xổ số thứ 3 (Tùy chọn)',
            type: ApplicationCommandOptionType.String,
            required: false,
            autocomplete: true
        },
        {
            name: 'dai4',
            description: 'Chọn đài xổ số thứ 4 (Tùy chọn)',
            type: ApplicationCommandOptionType.String,
            required: false,
            autocomplete: true
        }
    ]
},
            {
                name: 'tutien',
                description: '🧘 Mở bảng điều khiển Tu Tiên của bạn',
                options: []
            },
            {
                name: 'tudev',
                description: 'Lệnh Chủ Bot (Developer) cho hệ thống Tu Tiên',
                default_member_permissions: '8',
                options: [
                    {
                        name: 'give_item',
                        description: 'Cấp vật phẩm cho người chơi',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'user', description: 'Người nhận', type: ApplicationCommandOptionType.User, required: true },
                            { name: 'item_id', description: 'ID vật phẩm (VD: trucco_dan)', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'amount', description: 'Số lượng', type: ApplicationCommandOptionType.Integer, required: true }
                        ]
                    },
                    {
                        name: 'set_stats',
                        description: 'Set cứng chỉ số Tu Vi / Linh Thạch của người chơi',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'user', description: 'Người chơi', type: ApplicationCommandOptionType.User, required: true },
                            { name: 'loai', description: 'Loại chỉ số', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'Tu Vi', value: 'tuvi' }, { name: 'Linh Thạch', value: 'linhthach' }] },
                            { name: 'amount', description: 'Giá trị mới', type: ApplicationCommandOptionType.Integer, required: true }
                        ]
                    },
                    {
                        name: 'global_buff',
                        description: 'Bật sự kiện nhân đôi Tu Vi toàn server',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'exp_multiplier', description: 'Hệ số nhân Tu Vi (VD: 2)', type: ApplicationCommandOptionType.Integer, required: true },
                            { name: 'time', description: 'Thời gian hiệu lực (phút)', type: ApplicationCommandOptionType.Integer, required: true }
                        ]
                    },
                    {
                        name: 'ban',
                        description: 'Trục xuất vĩnh viễn kẻ gian lận khỏi hệ thống Tu Tiên',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'user', description: 'Người chơi bị cấm', type: ApplicationCommandOptionType.User, required: true }
                        ]
                    }
                ]
            },
            {
                name: 'tuconfig',
                description: 'Lệnh Admin: Cấu hình hệ thống Tu Tiên cho server',
                default_member_permissions: '8',
                options: [
                    {
                        name: 'bind_channel',
                        description: 'Ép thông báo đột phá/PK Tu Tiên chỉ hiện trong 1 kênh',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'channel', description: 'Kênh thông báo', type: ApplicationCommandOptionType.Channel, required: true }
                        ]
                    },
                    {
                        name: 'bind_role',
                        description: 'Tự động trao Role khi member đột phá lên cảnh giới này',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'canh_gioi', description: 'Chọn Đại Cảnh Giới', type: ApplicationCommandOptionType.String, required: true, choices: CANH_GIOI.map(c => ({ name: c, value: c })) },
                            { name: 'role', description: 'Role tương ứng', type: ApplicationCommandOptionType.Role, required: true }
                        ]
                    },
                    {
                        name: 'reset_cooldown',
                        description: 'Xóa thời gian chờ (bế quan/nhiệm vụ) cho một member',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'user', description: 'Người chơi', type: ApplicationCommandOptionType.User, required: true }
                        ]
                    }
                ]
            },
            {
                name: 'stock-prices',
                description: 'Chỉ Admin: Chọn kênh để bot cập nhật bảng giá chứng khoán (Mua/Bán)',
                default_member_permissions: '8',
                options: [
                    {
                        name: 'channel',
                        description: 'Chọn kênh văn bản để bot đăng và cập nhật bảng giá',
                        type: ApplicationCommandOptionType.Channel,
                        required: true,
                        channel_types: [0]
                    }
                ]
            }
        ];

        await client.application.commands.set(slashCommands);
        await Promise.all([...client.guilds.cache.values()].map(guild => guild.commands.set(slashCommands).catch(() => null)));
    } catch (e) {
        console.error(e);
    }
});
// ==========================================
// HỆ THỐNG CHỐNG LÁCH TÙ (ANTI-EVASION)
// ==========================================
// Mục đích: nếu 1 người đang thụ án (có mặt trong guildData.prisonUsers và
// releaseTime chưa tới) mà OUT SERVER rồi VÀO LẠI, hoặc role tù nhân của họ
// tự nhiên bị gỡ trong khi chưa mãn hạn, bot sẽ NGAY LẬP TỨC cấp lại role đó.

// 1. Vào lại server -> cấp lại role ngay nếu án tù còn hiệu lực
client.on('guildMemberAdd', async (member) => {
    try {
        const guildData = getGuildData(member.guild.id);
        const prisonData = guildData.prisonUsers && guildData.prisonUsers[member.id];
        if (!prisonData) return; // Không có án tù -> bỏ qua

        if (Date.now() >= prisonData.releaseTime) {
            // Án đã hết hạn trong lúc họ vắng mặt -> dọn dẹp hồ sơ, không cấp lại
            delete guildData.prisonUsers[member.id];
            saveData();
            return;
        }

        const prisonRole = member.guild.roles.cache.get(guildData.prisonConfig?.roleId);
        if (prisonRole) {
            await member.roles.add(prisonRole).catch(() => {});
        }

        const prisonChannel = member.guild.channels.cache.get(guildData.prisonConfig?.channelId);
        if (prisonChannel) {
            prisonChannel.send(`🚨 **PHÁT HIỆN LÁCH LUẬT** 🚨\n<@${member.id}> đã cố tình thoát server để trốn án tù nhưng đã bị hệ thống bắt lại ngay khi vào lại! Án phạt vẫn tiếp tục có hiệu lực.`).catch(() => {});
        }
    } catch (e) {
        console.error('Lỗi hệ thống chống lách tù (guildMemberAdd):', e);
    }
});

// 1.5. Rời server khi đang nợ tín dụng đen -> quy đổi ngay thành án tù
// (không chờ đến lúc đáo hạn nữa), để nếu quay lại server sẽ bị guildMemberAdd bắt lại ngay.
// Đồng thời tịch thu ngay số dư hiện có để hạn chế việc tẩu tán tiền trước khi thoát.
client.on('guildMemberRemove', async (member) => {
    try {
        const guildData = getGuildData(member.guild.id);
        const debt = guildData.debts && guildData.debts[member.id];
        if (!debt) return; // Không có nợ -> bỏ qua

        const factor = debt.factor;
        const prisonHours = factor * 5;

        guildData.prisonUsers[member.id] = {
            releaseTime: Date.now() + (prisonHours * 60 * 60 * 1000),
            tasks: buildPrisonTasks(factor)
        };

        // Tịch thu toàn bộ số dư còn lại ngay lập tức
        const seizedAmount = seizeAllBalance(member.id, member.guild.id);

        delete guildData.debts[member.id];
        saveData();

        const prisonChannel = member.guild.channels.cache.get(guildData.prisonConfig?.channelId);
        if (prisonChannel) {
            prisonChannel.send(`🚨 **CẢNH BÁO TẨU THOÁT** 🚨\n<@${member.id}> đã rời server trong khi đang nợ **${debt.amount.toLocaleString()} VNĐ**!\n💸 Số dư còn lại (**${seizedAmount.toLocaleString()}đ**) đã bị tịch thu.\n⛓️ Hồ sơ án tù **${prisonHours} giờ** đã được ghi nhận — nếu tài khoản này quay lại server sẽ bị bắt giam ngay lập tức.`).catch(() => {});
        }
    } catch (e) {
        console.error('Lỗi hệ thống xử lý nợ khi rời server (guildMemberRemove):', e);
    }
});

// 2. Đang ở trong server nhưng role tù nhân tự nhiên biến mất (bị gỡ thủ công,
// desync, bug...) trong khi án chưa mãn hạn -> cấp lại ngay lập tức
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        const guildData = getGuildData(newMember.guild.id);
        const prisonData = guildData.prisonUsers && guildData.prisonUsers[newMember.id];
        if (!prisonData) return;
        if (Date.now() >= prisonData.releaseTime) return; // Để vòng lặp 60s xử lý việc mãn hạn

        const prisonRoleId = guildData.prisonConfig?.roleId;
        if (!prisonRoleId) return;

        const hadRoleBefore = oldMember.roles.cache.has(prisonRoleId);
        const hasRoleNow = newMember.roles.cache.has(prisonRoleId);

        // Role vừa bị gỡ trong khi án tù vẫn còn hiệu lực -> cấp lại ngay
        if (hadRoleBefore && !hasRoleNow) {
            const prisonRole = newMember.guild.roles.cache.get(prisonRoleId);
            if (prisonRole) {
                await newMember.roles.add(prisonRole).catch(() => {});
            }
        }
    } catch (e) {
        console.error('Lỗi hệ thống chống lách tù (guildMemberUpdate):', e);
    }
});

// ==========================================
// HỆ THỐNG LỆNH TIN NHẮN (PREFIX COMMANDS)
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const userId = message.author.id;
    const guildId = message.guild?.id || 'global';
    const guildData = getGuildData(guildId);

    // ---------------------------------------------------------
    // [THÊM MỚI] CHẶN COPY TIN NHẮN BOT TRONG GAME MA SÓI
    // ---------------------------------------------------------
    if (activeGames.masoi && activeGames.masoi.has(guildId)) {
        const game = activeGames.masoi.get(guildId);

        // Chỉ kiểm tra người đang tham gia ván và chỉ chặn khi copy gần nguyên văn
        if (game.players.includes(userId) && isCopiedBotMessage(message.content)) {
            await message.delete().catch(() => {});
            const warnMsg = await message.reply(
                `🚨 **CẢNH BÁO GIAN LẬN!** 🚨\n<@${userId}> đã copy gần nguyên văn tin nhắn vai trò của bot.\n⛔ Tin nhắn đã bị chặn, nhưng **ván Ma Sói vẫn tiếp tục chạy bình thường**.`
            ).catch(() => null);

            if (warnMsg) {
                setTimeout(() => {
                    warnMsg.delete().catch(() => {});
                }, 5000);
            }

            return;
        }
    }

    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

        // ==========================================
    // HỆ THỐNG KIỂM TRA & LÀM NHIỆM VỤ NHÀ TÙ
    // ==========================================
    if (guildData.prisonUsers && guildData.prisonUsers[userId]) {
        const prisonData = guildData.prisonUsers[userId];
        const prisonRole = message.guild.roles.cache.get(guildData.prisonConfig?.roleId);

        // 1. Kiểm tra: Nếu hết thời gian phạt tù (Tự động gỡ án khi có tương tác chat)
        if (Date.now() >= prisonData.releaseTime) {
            delete guildData.prisonUsers[userId];
            saveData(); // Lưu lại data (thay thế bằng hàm lưu data thực tế của bạn nếu khác tên)
            if (prisonRole) await message.member.roles.remove(prisonRole).catch(() => {});
            return message.reply('⏰ **Thời tự do đã đến!** Thời gian thụ án của bạn đã kết thúc, hệ thống đã gỡ role nhà tù.');
        }

        const fullMsg = message.content.trim().toLowerCase();

        // Lệnh xem lại bảng nhiệm vụ bất cứ lúc nào
        if (fullMsg === '!nhiemvu') {
            return message.reply(`📋 **BẢNG NHIỆM VỤ CẢI TẠO CỦA BẠN:**\n${buildPrisonTaskBoard(prisonData.tasks)}`);
        }

        // Map lệnh (không dấu, viết liền) -> taskKey
        const taskCmdMap = {};
        for (const t of PRISON_TASKS) taskCmdMap['!' + t.cmd] = t;

        // 2. Xử lý khi người dùng gõ ĐÚNG lệnh nhiệm vụ nhà tù
        if (taskCmdMap[fullMsg]) {
            // Kiểm tra xem có đang làm nhiệm vụ đúng kênh nhà tù không (nếu có setup kênh)
            if (guildData.prisonConfig?.channelId && message.channel.id !== guildData.prisonConfig.channelId) {
                return message.reply(`⚠️ Bạn đang chịu án phạt tù! Vui lòng di chuyển sang kênh <#${guildData.prisonConfig.channelId}> để thực hiện lao động cải tạo.`);
            }

            // Chống lách luật dùng auto-click: mỗi nhiệm vụ phải cách nhau tối thiểu 2 giây
            const now = Date.now();
            const lastDone = prisonTaskCooldown.get(userId) || 0;
            if (now - lastDone < PRISON_TASK_COOLDOWN_MS) {
                const remain = ((PRISON_TASK_COOLDOWN_MS - (now - lastDone)) / 1000).toFixed(1);
                return message.reply(`⏳ Bạn thao tác quá nhanh! Vui lòng chờ thêm **${remain}s** trước khi làm nhiệm vụ tiếp theo (chống auto-click).`);
            }

            const taskInfo = taskCmdMap[fullMsg];
            const taskKey = taskInfo.key;
            const taskName = `${taskInfo.name} ${taskInfo.emoji}`;
            const currentTask = prisonData.tasks[taskKey];

            // Kiểm tra xem nhiệm vụ này đã đủ chỉ tiêu chưa
            if (currentTask.current >= currentTask.required) {
                return message.reply(`<a:emoji_75:1524039622668189806>Bạn đã hoàn thành hạn ngạch của công việc **${taskName}** rồi, hãy làm các công việc khác còn thiếu!\n📋 Gõ \`!nhiemvu\` để xem lại bảng nhiệm vụ.`);
            }

            // Cộng tiến độ nhiệm vụ + cập nhật cooldown
            currentTask.current += 1;
            prisonTaskCooldown.set(userId, now);
            saveData(); // Lưu lại data

            // Kiểm tra tổng thể: Xem tất cả 6 công việc đã đạt chỉ tiêu chưa
            const t = prisonData.tasks;

            // Nếu đã làm xong hết -> Tự động đặc xá (như lệnh /tratudo): gỡ role, trả tự do
            if (isPrisonTasksFinished(t)) {
                delete guildData.prisonUsers[userId];
                saveData();
                if (prisonRole) await message.member.roles.remove(prisonRole).catch(() => {});
                return message.reply(`🎉 **MÃN HẠN TÙ TRƯỚC THỜI HẠN!** Bạn đã hoàn thành toàn bộ lao động cải tạo một cách xuất sắc. Hệ thống đã **tự động đặc xá**, gỡ bỏ role nhà tù và trả lại tự do cho bạn!`);
            } else {
                // Nếu chưa xong hết -> Báo cáo tiến độ hiện tại
                return message.reply(`🛠️ Bạn vừa thực hiện: **${taskName}** thành công! (${currentTask.current}/${currentTask.required} lần).\n📊 **Tiến độ cải tạo hiện tại:**\n${buildPrisonTaskBoard(t)}`);
            }
        }
        
        // 3. Chặn các lệnh khác (Nhưng cho phép chat bình thường)
        // Lưu ý: Chữ "!" ở đây là prefix mặc định của bot, bạn có thể thay thế bằng biến prefix của riêng bạn (vd: config.prefix)
        if (fullMsg.startsWith('!')) {
            return message.reply('⚠️ **Bạn đang chịu án phạt tù!** Bạn bị tước quyền sử dụng các lệnh bot (câu cá, mini-game, ví tiền...). Vui lòng hoàn thành nhiệm vụ công ích để được trả tự do!');
        }
        
        // Trả về (return) nếu muốn người chơi bị cấm cả chat bình thường:
        // return message.reply('⚠️ Bọn tội phạm không được phép lên tiếng!'); 
    }
    
    if (command === 'diemdanh') {
        if (guildData.lastDaily[userId] && Date.now() - guildData.lastDaily[userId] < 86400000) {
            return message.reply('⏰ Bạn đã điểm danh hôm nay rồi!');
        }
        guildData.lastDaily[userId] = Date.now();
        saveData();
        addBalance(userId, 200, guildId);
        return message.reply(`🎉 **${message.author.username}** điểm danh nhận **200💸 VNĐ**!`);
    }
    
    if (command === 'vi' || command === 'money') {
        return message.reply(`👛 Ví của bạn: **${getBalance(userId, guildId)}💸 VNĐ**`);
    }

        if (command === 'xephang' || command === 'top') {
        // 1. Phản hồi ngay lập tức để người dùng không thấy bot bị đơ
        const loadingMsg = await message.reply("⏳ Đang tải bảng xếp hạng, chờ một chút nhé...");

        // 2. Lấy danh sách từ Database và sắp xếp TẤT CẢ từ cao xuống thấp trước
        const allBalances = Object.entries(guildData.balance).sort((a, b) => b[1] - a[1]);
        
        const top10 = [];

        // 3. Quét từ người giàu nhất xuống, tìm đủ 10 người TRONG SERVER thì dừng
        for (const [userId, bal] of allBalances) {
            if (top10.length >= 10) break; // Đã đủ 10 người thì thoát vòng lặp ngay lập tức

            try {
                // Ưu tiên check bộ nhớ tạm (cache) cực nhanh
                let member = message.guild.members.cache.get(userId);
                
                // Nếu không có trong cache, mới gọi API để check ĐÚNG 1 người này
                if (!member) {
                    member = await message.guild.members.fetch(userId).catch(() => null);
                }

                // Nếu người này có mặt trong server, đưa vào danh sách top
                if (member) {
                    top10.push([userId, bal]);
                }
            } catch (err) {
                // Bỏ qua nếu có lỗi (ví dụ user không tồn tại)
                continue;
            }
        }

        // 4. Format nội dung bảng xếp hạng
        let desc = top10.length === 0 
            ? 'Chưa có ai trong danh sách của server này.' 
            : top10.map((entry, index) => {
                let rank = index + 1;
                let medal = rank === 1 ? '🥇' : rank === 2 ? ' 🥈' : rank === 3 ? '🥉' : '🏅';
                return `${medal} **Top ${rank}:** <@${entry[0]}> \`${entry[1].toLocaleString()}💸\``;
            }).join('\n\n');

        const embed = new EmbedBuilder()
            .setColor('#2f3136')
            .setTitle(`🏆 BẢNG XẾP HẠNG ĐẠI GIA - ${message.guild.name.toUpperCase()} 🏆`)
            .setDescription(desc)
            .setTimestamp();
        
        // 5. Cập nhật lại tin nhắn "Đang tải..." thành Bảng xếp hạng
        return loadingMsg.edit({ content: null, embeds: [embed] });
    }

    if (command === 'shop') {
        const guildId = message.guild.id;
        const serverShop = db.shop[guildId] || {};
        const shopItems = Object.keys(serverShop);
        
        if (shopItems.length === 0) return message.reply('🛒 Hiện tại server này chưa có mặt hàng nào được bày bán!');
        
        let desc = 'Dưới đây là các Role đang được bày bán.\nBấm nút **Mua Role** bên dưới và nhập mã số để giao dịch!\n\n';
        for (const code of shopItems) {
            const item = serverShop[code];
            desc += `• <@&${item.roleId}>: **${item.price.toLocaleString()} VNĐ💸** (Mã: \`${code}\`)\n`;
        }

        const embed = new EmbedBuilder()
            .setColor('#f1c40f')
            .setTitle(`🛒 CỬA HÀNG GIAO DỊCH ROLE - ${message.guild.name.toUpperCase()} 🛒`)
            .setDescription(desc)
            .setFooter({ text: 'Bot tự động cấp role sau khi giao dịch thành công' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_buy_role').setLabel('🛒 Mua Role').setStyle(ButtonStyle.Success)
        );
        return message.reply({ embeds: [embed], components: [row] });
    }

    if (command === 'duangua' || command === 'horserace') {
        const channelId = message.channel.id;
        const existing = activeGames.duangua.get(channelId);
        if (existing && existing.status !== 'done') {
            return message.reply('⚠️ Kênh này đang có một ván **Đua Ngựa** chưa kết thúc rồi!');
        }

        const game = {
            hostId: userId,
            guildId,
            channelId,
            status: 'betting',
            bets: new Map(), // userId -> { horse, amount }
            messageId: null
        };
        activeGames.duangua.set(channelId, game);

        const sent = await message.reply({ embeds: [dhBuildBettingEmbed(game)], components: dhBuildComponents() });
        game.messageId = sent.id;
        return;
    }

    if (command === 'shoplinhkien') {
        const buildMenu = (id, placeholder, items) => {
            return new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(id)
                    .setPlaceholder(placeholder)
                    .addOptions(Object.entries(items).map(([k, v]) => ({
                        label: k.slice(0, 100),
                        description: `Giá: ${v.toLocaleString()} VNĐ`,
                        value: `buy_${k}`
                    })).slice(0, 25))
            );
        };

        const row1 = buildMenu('menu_linhkien_1', '🧵 Chọn Dây Câu & 🪝 Lưỡi Câu', { ...COMPONENTS.lines, ...COMPONENTS.hooks });
        const row2 = buildMenu('menu_linhkien_2', '🎈 Chọn Phao & ⚙️ Máy Câu', { ...COMPONENTS.floats, ...COMPONENTS.reels });
        const row3 = buildMenu('menu_linhkien_3', '🪱 Chọn Mồi & 💊 Buff', { ...COMPONENTS.baits, ...COMPONENTS.buffs });

        const content = '🛠️ **CỬA HÀNG LINH KIỆN & TÚI ĐỒ**\nNhấp vào các danh sách để mua trực tiếp:';
        return message.reply({ content, components: [row1, row2, row3] });
    }

    if (command === 'shopveso') {
    if (!guildData.lotteryConfig || !guildData.lotteryConfig.dais || guildData.lotteryConfig.dais.length === 0) {
        return message.reply('⚠️ Admin chưa thiết lập danh sách đài mở thưởng hôm nay (dùng lệnh `/vesomoi`)!');
    }
    if (guildData.lotteryConfig.saleOpen === false) {
        return message.reply('🔒 **Đại lý vé số đã đóng cửa!** Kết quả hôm nay đã được thông báo và phát thưởng xong. Vui lòng chờ Admin dùng lệnh `/vesomoi` để mở bán cho ngày tiếp theo.');
    }
    
    const dais = guildData.lotteryConfig.dais;
    const embed = new EmbedBuilder()
        .setTitle('🎫 ĐẠI LÝ VÉ SỐ KIẾN THIẾT MIỀN NAM - ĐA ĐÀI')
        .setDescription(`**Các đài hôm nay:**\n${dais.map((d, idx) => `**${idx + 1}.** Đài __${d}__`).join('\n')}\n\n**Giá vé:** 10,000 VNĐ 💸 / 1 tờ\n**Giờ quay thưởng:** 16:30 chiều hàng ngày.\n\n🎟️ *Hãy chọn đài bạn muốn mua ở các nút bấm phía dưới:*`)
        .setColor('#f1c40f')
        .setImage('https://i.imgur.com/uGzJkC0.png');

    const row = new ActionRowBuilder();
    dais.forEach((dai, index) => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`btnveso_${index}`)
                .setLabel(`Mua đài ${dai}`)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎫')
        );
    });

    return message.reply({ embeds: [embed], components: [row] });
}
    
        if (command === 'vesotoi') {
        if (!guildData.lotteryUsers || !guildData.lotteryUsers[userId] || Object.keys(guildData.lotteryUsers[userId]).length === 0) {
            return message.reply('🎫 Hôm nay bạn chưa mua tờ vé số nào cả! Hãy dùng lệnh `!shopveso` để mua ngay.');
        }

        const userLottery = guildData.lotteryUsers[userId];
        const embed = new EmbedBuilder()
            .setTitle('🎫 VÉ SỐ CÁ NHÂN HÔM NAY')
            .setDescription('Danh sách các tờ vé số bạn đang nắm giữ chờ giờ mở thưởng:')
            .setColor('#3498db')
            .setTimestamp();

        let countTotal = 0;
        let fieldCount = 0;
        let limitReached = false;

        for (const [daiName, tickets] of Object.entries(userLottery)) {
            if (limitReached) break;
            
            if (Array.isArray(tickets) && tickets.length > 0) {
                countTotal += tickets.length;
                
                // Cắt nhỏ mảng vé (mỗi phần 80 vé ~ 800 ký tự) để không vượt quá giới hạn 1024 của Discord
                const chunkSize = 80; 
                for (let i = 0; i < tickets.length; i += chunkSize) {
                    // Discord giới hạn tối đa 25 fields mỗi Embed, ta chừa 1 field để báo lỗi nếu quá nhiều
                    if (fieldCount >= 24) {
                        embed.addFields({
                            name: '⚠️ Lưu ý',
                            value: 'Số lượng vé của bạn quá khủng (vượt quá giới hạn hiển thị của Discord). Hãy chờ đến giờ quay thưởng để xem kết quả nhé!',
                            inline: false
                        });
                        limitReached = true;
                        break;
                    }

                    const chunk = tickets.slice(i, i + chunkSize);
                    const chunkString = `\`${chunk.join('`, `')}\``;
                    
                    const fieldName = (i === 0) 
                        ? `📍 Đài ${daiName} (${tickets.length} tờ)` 
                        : `📍 Đài ${daiName} (Tiếp theo...)`;
                        
                    embed.addFields({
                        name: fieldName,
                        value: chunkString,
                        inline: false
                    });
                    fieldCount++;
                }
            }
        }

        if (countTotal === 0) {
            return message.reply('🎫 Hôm nay bạn chưa sở hữu tờ vé số hợp lệ nào cả!');
        }
        
        return message.reply({ embeds: [embed] });
    }
    
    if (command === 'shopcan') {
        const embed = new EmbedBuilder().setColor('#f1c40f').setTitle('🏪 TẠP HÓA CẦN CÂU (MUA BẰNG TIỀN)');
        let desc = 'Đây là cửa hàng mua cần câu nhanh chóng bằng VNĐ.\n⚠️ **Lưu ý:** Mua xong sẽ vứt bỏ cần đang sử dụng và trang bị ngay lập tức cần mới!\n\n';
        const options = [];

        for (const [name, stats] of Object.entries(RODS)) {
            if (stats.price === 0) continue;
            desc += `**${name}**\n• Giá mua: ${stats.price.toLocaleString()} VNĐ 💸 | Độ bền: ${stats.dur} | Lực kéo: ${stats.res}\n`;
            if (options.length < 25) {
                options.push({
                    label: name.slice(0, 100),
                    description: `Lực kéo: ${stats.res} | Mua: ${stats.price.toLocaleString()} VNĐ`,
                    value: `buyrod_${name}`
                });
            }
        }
        embed.setDescription(desc.slice(0, 4000));
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('menu_shopcan_buy').setPlaceholder('🛒 Chọn cần câu muốn MUA NGAY').addOptions(options)
        );
        return message.reply({ embeds: [embed], components: [selectMenu] });
    }

    if (command === 'khuvuc' || command === 'doikhuvuccau') {
        const options = Object.entries(ZONES).map(([k, v]) => ({
            label: k.slice(0, 100),
            description: `Yêu cầu Lv: ${v.level} | Phí: ${v.fee.toLocaleString()} VNĐ`,
            value: `zone_${k}`
        }));
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('menu_doikhuvuc').setPlaceholder('🗺️ Chọn vùng biển muốn ra khơi!').addOptions(options.slice(0, 25))
        );
        return message.reply({ content: '🚤 **BẾN TÀU DI CHUYỂN**\nChọn khu vực bạn muốn cập bến từ danh sách:', components: [selectMenu] });
    }

    if (command === 'kho' || command === 'profile') {
        const user = fishingGetUser(userId, guildId);
        const embed = new EmbedBuilder().setColor('#2f3136').setTitle(`🎒 HỒ SƠ & TÚI ĐỒ: ${message.author.username}`);
        let equipStr = `🎣 Cần: **${user.equip.rod} (+${user.equip.rodPlus})** [Bền: ${user.equip.dur}/${RODS[user.equip.rod].dur}]\n🧵 Dây: **${user.equip.line || 'Trống'}**\n🪝 Lưỡi: **${user.equip.hook || 'Trống'}**\n🎈 Phao: **${user.equip.float || 'Trống'}**\n⚙️ Máy: **${user.equip.reel || 'Trống'}**\n🪱 Mồi: **${user.equip.bait || 'Trống'}** (Trong kho: ${user.inventory[user.equip.bait] || 0} mồi)`;
        let invStr = Object.entries(user.inventory).map(([k, v]) => `• ${k}: x${v}`).join('\n');
        if (!invStr) invStr = '*Túi đồ trống không.*';

        embed.addFields(
            { name: '👤 Cấp Độ & Tiền', value: `Cấp độ: **${user.level}** (EXP: ${user.exp})\nTài sản: **${user.balance.toLocaleString()} VNĐ 💸**\nKhu Vực Hiện Tại: **${user.zone}**`, inline: false },
            { name: '🛠️ Tình Trạng Trang Bị', value: equipStr, inline: false },
            { name: `📦 Kho Đồ Lưu Trữ (${Object.keys(user.inventory).length}/${user.maxInv})`, value: invStr.substring(0, 1024), inline: false }
        );

        const equipableItems = Object.keys(user.inventory).filter(item =>
            COMPONENTS.lines[item] || COMPONENTS.hooks[item] || COMPONENTS.floats[item] || COMPONENTS.reels[item] || COMPONENTS.baits[item]
        ).slice(0, 25);

        const componentsArr = [];
        if (equipableItems.length > 0) {
            const options = equipableItems.map(item => {
                let icon = '📦';
                if (COMPONENTS.lines[item]) icon = '🧵';
                if (COMPONENTS.hooks[item]) icon = '🪝';
                if (COMPONENTS.floats[item]) icon = '🎈';
                if (COMPONENTS.reels[item]) icon = '⚙️';
                if (COMPONENTS.baits[item]) icon = '🪱';
                return {
                    label: `${icon} ${item}`.slice(0, 100),
                    description: `Đang có: ${user.inventory[item]} cái`,
                    value: `equip_${item}`
                };
            });

            componentsArr.push(
                new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('menu_trangbi')
                        .setPlaceholder('🎒 Click để mang trang bị (Tick nhiều mục cùng lúc)')
                        .setMinValues(1)
                        .setMaxValues(Math.min(equipableItems.length, 5))
                        .addOptions(options)
                )
            );
        }

        return message.reply({ embeds: [embed], components: componentsArr });
    }

    if (command === 'suacan') {
        const user = fishingGetUser(userId, guildId);
        const rodData = RODS[user.equip.rod];
        if (user.equip.dur >= rodData.dur) return message.reply('✨ Cần câu của bạn vẫn nguyên vẹn!');
        const missing = rodData.dur - user.equip.dur;
        let fixCost = Math.floor(rodData.price * 0.15 * (missing / rodData.dur));
        if (fixCost === 0 && missing > 0) fixCost = 500;

        if (user.balance < fixCost) return message.reply(`❌ Bạn cần **${fixCost.toLocaleString()} VNĐ 💸** để bảo trì!`);
        user.balance -= fixCost;
        user.equip.dur = rodData.dur;
        saveFishingData();
        return message.reply(`🔧 Đã nhờ thợ rèn bảo dưỡng cần **${user.equip.rod}** với chi phí **${fixCost.toLocaleString()} VNĐ 💸**!`);
    }

    if (command === 'banca') {
        const user = fishingGetUser(userId, guildId);
        let totalEarned = 0; let log = []; let allFishes = {};
        for (let r in FISH_DATA) { FISH_DATA[r].list.forEach(f => { allFishes[f] = FISH_DATA[r]; }); }

        for (let [item, qty] of Object.entries(user.inventory)) {
            if (allFishes[item]) {
                let minP = allFishes[item].minPrice; let maxP = allFishes[item].maxPrice;
                let fishTotal = 0;
                for (let i = 0; i < qty; i++) fishTotal += Math.floor(Math.random() * (maxP - minP + 1)) + minP;
                totalEarned += fishTotal;
                log.push(`• Bán ${qty}x ${item}: **${fishTotal.toLocaleString()} VNĐ 💸**`);
                delete user.inventory[item];
            }
        }
        if (totalEarned === 0) return message.reply('❌ Giỏ cá trống không, lấy gì mà bán!');
        user.balance += totalEarned;
        saveFishingData();
        const embed = new EmbedBuilder().setColor('#2ecc71').setTitle('💰 HÓA ĐƠN THU MUA HẢI SẢN').setDescription(log.join('\n') + `\n\n**Tổng thu nhập bán cá:** \`${totalEarned.toLocaleString()} VNĐ 💸\``);
        return message.reply({ embeds: [embed] });
    }

    if (command === 'cauca' || command === 'fish') {
        const user = fishingGetUser(userId, guildId);
        // Thanh Năng Lượng 3.000kcal dùng CHUNG với Nông Trại: câu cá cũng tiêu hao dần, hết năng lượng = bị đói, không câu được
        const farmUser = fmGetUser(userId, guildId);
        if (!fmHasEnergy(farmUser, ENERGY_CONFIG.costs.cauca)) {
            return message.reply(`🍽️ Bạn đang **ĐÓI** (Năng lượng: ${farmUser.energy}/${farmUser.maxEnergy}kcal), không đủ sức quăng cần! Hãy dùng \`!an\` để ăn gì đó trước khi câu tiếp.`);
        }
        if (user.equip.dur <= 0) return message.reply('❌ Cần câu của bạn đã gãy! Hãy dùng `!suacan` để bảo trì.');
        if (!user.equip.line) return message.reply('❌ Cần câu chưa móc Dây Câu!');
        if (!user.equip.hook) return message.reply('❌ Cần câu chưa gắn Lưỡi Câu!');
        if (!user.equip.bait) return message.reply('❌ Bạn không thể thả câu chay mà không có Mồi!');
        if (!user.inventory[user.equip.bait] || user.inventory[user.equip.bait] <= 0) {
            user.equip.bait = null; saveFishingData(); return message.reply('❌ Mồi đã dùng hết sạch, hãy ghé shop mua thêm!');
        }

        user.inventory[user.equip.bait] -= 1;
        if (user.inventory[user.equip.bait] <= 0) delete user.inventory[user.equip.bait];
        user.equip.dur -= 1;

        // Tiêu hao năng lượng dùng chung mỗi lần thả câu
        fmSpendEnergy(farmUser, ENERGY_CONFIG.costs.cauca);
        saveData();

        const rodStats = RODS[user.equip.rod];
        const baitInfo = BAIT_BUFFS[user.equip.bait];
        const hasLuck = user.buffs.luck > Date.now();
        const hasDropBuff = user.buffs.drop > Date.now();
        // Thời tiết Trăng Tròn (dùng chung với Nông Trại) giúp tăng tỉ lệ cá hiếm khi câu
        const weather = fmGetWeather(guildId);
        const hasMoonLuck = !!weather.fishingLuckBonus;

        let chances = { Uncommon: 50, Rare: 25, Epic: 15, Legendary: 8, Mythic: 1.9, Secret: 0.1 };
        if (baitInfo && baitInfo.bonus > 0 && baitInfo.target) {
            if (user.equip.bait === 'Mồi Thần Biển') { chances.Mythic += 35; chances.Secret += 40; } 
            else { chances[baitInfo.target] += baitInfo.bonus; }
        }
        if (hasLuck) { chances.Mythic += 20; chances.Secret += 10; chances.Legendary += 30; }
        if (hasMoonLuck) { chances.Legendary += 10; chances.Mythic += 5; chances.Secret += 2; }

        let rarity = 'Uncommon';
        let roll = Math.random() * Object.values(chances).reduce((a, b) => a + b, 0);

        if (roll <= chances.Secret) rarity = 'Secret';
        else if (roll <= chances.Secret + chances.Mythic) rarity = 'Mythic';
        else if (roll <= chances.Secret + chances.Mythic + chances.Legendary) rarity = 'Legendary';
        else if (roll <= chances.Secret + chances.Mythic + chances.Legendary + chances.Epic) rarity = 'Epic';
        else if (roll <= chances.Secret + chances.Mythic + chances.Legendary + chances.Epic + chances.Rare) rarity = 'Rare';
        else rarity = 'Uncommon';

        const zoneMaxRarity = ZONES[user.zone].maxRarity;
        if (RANK_VAL[rarity] > RANK_VAL[zoneMaxRarity]) rarity = zoneMaxRarity;

        const fishCategory = FISH_DATA[rarity];
        const fishName = fishCategory.list[Math.floor(Math.random() * fishCategory.list.length)];
        let catchPower = rodStats.res + (user.equip.rodPlus * 2);
        let finalBreakChance = Math.max(4, Math.min(95, fishCategory.breakChance - catchPower));

        let breakText = ''; let caughtText = '';
        if (Math.random() * 100 < finalBreakChance) {
            breakText = `💥 Căng quá!! Cá quá khỏe làm đứt **${user.equip.line}** của bạn!`;
            user.equip.line = null;
            if (Math.random() < 0.5) { breakText += ` Bay màu luôn **${user.equip.hook}**!`; user.equip.hook = null; }
        } else {
            caughtText = `🎉 Đớp mồi rồi!! Kéo thành công **1x ${fishName}** [${rarity}].`;
            if (Math.random() * 100 < (hasDropBuff ? 60 : 15)) {
                let dropItem = fishCategory.drops[Math.floor(Math.random() * fishCategory.drops.length)];
                caughtText += `\n🎁 Quái ngư nhả ra: **1x ${dropItem}** (Nguyên liệu chế đồ).`;
                if (!user.inventory[dropItem] && Object.keys(user.inventory).length >= user.maxInv) {
                    caughtText += `\n⚠️ Kho đồ ĐẦY, đành vứt lại nguyên liệu này!`;
                } else { user.inventory[dropItem] = (user.inventory[dropItem] || 0) + 1; }
            }

            if (!user.inventory[fishName] && Object.keys(user.inventory).length >= user.maxInv) {
                caughtText += `\n⚠️ Túi đồ ĐẦY! Đành thả con cá này về biển...`;
            } else {
                user.inventory[fishName] = (user.inventory[fishName] || 0) + 1;
                user.exp += Math.floor(Math.random() * 20) + 10;
            }
        }

        if (user.equip.dur <= 0) breakText += `\n⚠️ **RẮC RẮC!** Cần câu đã cạn độ bền và nát bươm!`;
        let levelUpText = '';
        if (user.exp >= user.level * 100) {
            user.level += 1; user.exp = 0;
            levelUpText = `\n🌟 **TUYỆT VỜI! LÊN CẤP!** Kỹ năng câu cá đạt Level **${user.level}**.`;
        }
        saveFishingData();

        const moonText = hasMoonLuck ? '\n🌕 Trăng tròn đêm nay giúp tăng cơ hội câu được cá hiếm!' : '';
        const embed = new EmbedBuilder().setColor(breakText ? '#e74c3c' : '#3498db').setTitle(`🎣 ${message.author.username} đang quăng cần tại ${user.zone}...`).setDescription(`${caughtText}${breakText}${levelUpText}${moonText}\n\n*(Cần bền: ${user.equip.dur}/${rodStats.dur} | ⚡ Năng lượng: ${farmUser.energy}/${farmUser.maxEnergy}kcal)*`);
        return message.reply({ embeds: [embed] });
    }

    if (command === 'taixiu' || command === 'tx') {
        if (activeGames.taixiu) return message.reply('⚠️ Đang có một sòng Tài Xỉu chuẩn bị lắc rồi!');
        activeGames.taixiu = { status: 'betting', bets: [], mainMessage: null };
        const embed = new EmbedBuilder()
            .setColor('#2f3136')
            .setTitle('🎲 SÒNG BẠC TÀI XỈU 🎲')
            .setDescription('Vui lòng click các nút bên dưới để chọn cửa và đặt cược!\n\n**Danh sách đặt cược:**\n*Chưa có ai đặt cửa.*')
            .setFooter({ text: 'Thời gian đặt cược kết thúc sau 40 giây!' });
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tx_btn_tai').setLabel('Tài (11-17)').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('tx_btn_xiu').setLabel('Xỉu (4-10)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tx_btn_chan').setLabel('Chẵn').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tx_btn_le').setLabel('Lẻ').setStyle(ButtonStyle.Secondary)
        );
        const msg = await message.channel.send({ embeds: [embed], components: [row] });
        activeGames.taixiu.mainMessage = msg;

        setTimeout(async () => {
            try {
                const game = activeGames.taixiu;
                if (!game || game.status !== 'betting') return;

                if (game.bets.length === 0) {
                    activeGames.taixiu = null;
                    return await msg.edit({ content: '🎲 Sòng Tài Xỉu giải tán vì không có ai đặt cược!', embeds: [], components: [] }).catch(()=>{});
                }
                
                game.status = 'finished';
                const d1 = Math.floor(Math.random() * 6) + 1;
                const d2 = Math.floor(Math.random() * 6) + 1;
                const d3 = Math.floor(Math.random() * 6) + 1;
                const sum = d1 + d2 + d3;
                
                const isBao = (sum === 3 || sum === 18);
                const isTai = sum >= 11 && sum <= 17;
                const isXiu = sum >= 4 && sum <= 10;
                const isChan = sum % 2 === 0;
                const isLe = sum % 2 !== 0;
                
                const resultMain = isBao ? 'BÃO (Nhà cái ăn trọn)' : (isTai ? 'TÀI' : 'XỈU');
                const resultSub = isChan ? 'CHẴN' : 'LẺ';
                let logResult = `📊 **KẾT QUẢ XÚC XẮC:**\n 🎲 **${d1} - ${d2} - ${d3}** (Tổng: **${sum}**)\n➡️ **${resultMain}** | **${resultSub}**\n\n🏁 **BẢNG TRẢ THƯỞNG:**\n`;
                
                game.bets.forEach(b => {
                    let win = false;
                    if (!isBao) {
                        if (b.choice === 'tai' && isTai) win = true;
                        if (b.choice === 'xiu' && isXiu) win = true;
                        if (b.choice === 'chan' && isChan) win = true;
                        if (b.choice === 'le' && isLe) win = true;
                    }
                    if (win) {
                        // Thắng: hoàn lại vốn đã escrow + tiền thắng (net vẫn +amount như tỉ lệ trả thưởng gốc)
                        addBalance(b.userId, b.amount * 2, guildId);
                        logResult += `• <@${b.userId}> chọn **${b.choiceName}**: **THẮNG** 🎉 **+${b.amount}💸**\n`;
                    } else {
                        // Thua: KHÔNG trừ gì thêm, tiền đã bị escrow lúc đặt cược rồi -> chặn đường thua "miễn phí"
                        logResult += `• <@${b.userId}> chọn **${b.choiceName}**: **THUA** 💸 **-${b.amount}💸**\n`;
                    }
                });

                const endEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🏆 TỔNG KẾT TÀI XỈU 🏆').setDescription(logResult).setTimestamp();
                await msg.edit({ embeds: [endEmbed], components: [] }).catch(()=>{});
                activeGames.taixiu = null;
            } catch(e) { activeGames.taixiu = null; }
        }, 40000);
    }

    if (command === 'xepgach' || command === 'tetris') {
        if (activeGames.xepgach.has(userId)) {
            return message.reply('⚠️ Bạn đang có một ván xếp gạch đang diễn ra rồi! Hãy chơi xong hoặc bấm ⏹ để kết thúc.');
        }

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle('🎮 TRÒ CHƠI XẾP GẠCH 🎮')
            .setDescription('Đang khởi tạo bàn chơi...');
        const msg = await message.reply({ embeds: [embed] });
        
        const game = new TetrisGame(userId, msg);
        activeGames.xepgach.set(userId, game);
        game.start(); 
        return;
    }
    
    if (command === 'caro') {
        const opponent = message.mentions.users.first();
        if (!opponent || opponent.bot || opponent.id === userId) return message.reply("<a:emoji_76:1524195723996823612> Bạn phải tag một người chơi khác (không phải bot) để thách đấu!");
        if (activeGames.caro.has(message.channel.id)) return message.reply("⚠️ Kênh này đang có một ván Caro diễn ra, hãy đợi họ chơi xong!");
        
        const game = {
            p1: userId,
            p2: opponent.id,
            turn: userId,
            board: Array(9).fill('⬜')
        };
        activeGames.caro.set(message.channel.id, game);
        
        const embed = new EmbedBuilder()
            .setColor('#2f3136')
            .setTitle('Cờ Caro')
            .setDescription(`Ván đấu giữa <@${userId}> (<a:emoji_76:1524195723996823612>) và <@${opponent.id}> (⭕)\n*Cần 4 quân liên tiếp để chiến thắng.*\n\n👉 Lượt đánh hiện tại: <@${userId}> (<a:emoji_76:1524195723996823612>)`);
        return message.channel.send({ embeds: [embed], components: createCaroComponents(game.board, message.channel.id) });
    }

    if (command === 'xidach' || command === 'blackjack') {
        if (activeGames.xidach) return message.reply('⚠️ Đang có một sòng Xì Dách đang diễn ra, vui lòng chờ!');
        activeGames.xidach = { status: 'waiting', dealerId: userId, guildId: guildId, players: [], dealerCards: [], deck: createDeck(), mainMessage: null, escrowedDealerTotal: 0 };
        const embed = new EmbedBuilder()
            .setColor('#2f3136')
            .setTitle('🃏 SÒNG XÌ DÁCH')
            .setDescription(`👑 Nhà Cái: <@${userId}>\n\nBấm nút **Tham Gia** bên dưới để đặt cược.\n\n**Bàn cược:**\n*Trống.*`)
            .setFooter({ text: 'Tự động đóng đăng ký sau 30 giây!' });
        
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pvp_xd_join').setLabel('🙋 Tham Gia (Nhà Con)').setStyle(ButtonStyle.Primary));
        const msg = await message.channel.send({ embeds: [embed], components: [row] });
        activeGames.xidach.mainMessage = msg;

        setTimeout(async () => {
            const game = activeGames.xidach; 
            if (!game || game.status !== 'waiting') return;
            
            if (game.players.length === 0) { 
                activeGames.xidach = null; 
                return msg.edit({ content: '🃏 Sòng rã vì không ai tham gia.', embeds: [], components: [] }).catch(()=>{}); 
            }
            
            const totalBet = game.players.reduce((sum, p) => sum + p.bet, 0);
            if (getBalance(game.dealerId, guildId) < totalBet) { 
                // Hoàn lại tiền cược đã escrow của từng người chơi trước khi hủy sòng
                for (const p of game.players) addBalance(p.id, p.bet, guildId);
                activeGames.xidach = null; 
                return msg.edit({ content: `<a:emoji_76:1524195723996823612> Nhà Cái không đủ tiền bảo hiểm (Cần: ${totalBet}💸). Sòng bị hủy, tiền cược đã được hoàn lại!`, embeds: [], components: [] }).catch(()=>{}); 
            }
            
            // ESCROW: khóa luôn tiền bảo hiểm của Nhà Cái ngay khi đóng đăng ký, tránh việc rút/chuyển tiền
            // trong lúc ván đang chơi rồi thua "miễn phí" ở bước tổng kết.
            addBalance(game.dealerId, -totalBet, guildId);
            game.escrowedDealerTotal = totalBet;

            game.status = 'players_turn';
            game.players.forEach(p => p.cards.push(game.deck.pop(), game.deck.pop()));
            game.dealerCards.push(game.deck.pop(), game.deck.pop());
            
            const playEmbed = new EmbedBuilder()
                .setColor('#2f3136')
                .setTitle('🃏 SÒNG XÌ DÁCH')
                .setDescription(`👑 Nhà Cái: <@${game.dealerId}> [ Đang giấu bài ]\n\n**Bàn cược:**\n${game.players.map(p => `• <@${p.id}>: *Đang suy nghĩ...*`).join('\n')}\n\n*Bấm nút bên dưới để điều khiển bài kín đáo.*`);
                
            const rowPlay = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pvp_xd_check').setLabel('👁️ Kiểm Tra Bài & Thao Tác').setStyle(ButtonStyle.Success));
            await msg.edit({ embeds: [playEmbed], components: [rowPlay] }).catch(()=>{});
            
            setTimeout(async () => { 
                if (activeGames.xidach && activeGames.xidach.status === 'players_turn') await startDealerTurn(); 
            }, 50000);
        }, 30000);
    }

    if (command === 'masoi') {
        const guildId = message.guild.id;
        if (activeGames.masoi.has(guildId)) {
            return message.reply('⚠️ Đang có một ván Ma Sói diễn ra ở server này rồi!');
        }

        const gameData = {
            status: 'waiting',
            players: [],
            playerRoles: {},
            channel: message.channel
        };
        activeGames.masoi.set(guildId, gameData);

        const embed = new EmbedBuilder()
            .setTitle('🐺 TRÒ CHƠI MA SÓI SẮP BẮT ĐẦU 🐺')
            .setDescription('Nhấn nút bên dưới để tham gia! Trò chơi sẽ bắt đầu sau **40s**.')
            .setImage(COVER_IMAGE)
            .setColor('#2c3e50');
            
        const joinBtn = new ButtonBuilder()
            .setCustomId('join_masoi')
            .setLabel('Tham Gia')
            .setStyle(ButtonStyle.Primary);
            
        const row = new ActionRowBuilder().addComponents(joinBtn);
        const lobbyMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const collector = lobbyMsg.createMessageComponentCollector({ time: 40000 }); 

        collector.on('collect', async i => {
            if (i.replied || i.deferred) return; 
            if (i.customId === 'join_masoi') {
                if (!gameData.players.includes(i.user.id)) {
                    gameData.players.push(i.user.id);
                    await i.reply({ content: `Bạn đã tham gia! Hiện có ${gameData.players.length} người.`, ephemeral: true }).catch(()=>{});
                } else {
                    await i.reply({ content: 'Bạn đã ở trong phòng chờ rồi!', ephemeral: true }).catch(()=>{});
                }
            }
        });
        
        collector.on('end', async () => {
            if (gameData.players.length < 4) {
                message.channel.send('Không đủ người chơi (cần ít nhất 4 người). Hủy ván Ma Sói!');
                activeGames.masoi.delete(guildId);
                return;
            }
            startGame(guildId, gameData);
        });
        return;
    }
    
    if (command === 'baucua') {
        if (activeGames.baucua) return message.reply('⚠️ Đang có một sòng Bầu Cua chuẩn bị lắc rồi!');
        activeGames.baucua = { status: 'betting', bets: [], mainMessage: null };
        const embed = new EmbedBuilder()
            .setColor('#2f3136')
            .setTitle('🎲 SÒNG BẦU CUA TÔM CÁ 🎲')
            .setDescription('Vui lòng click nút **Đặt Cược** để chọn linh vật và nhập số tiền cược!\n\n**Danh sách đặt cược:**\n*Chưa có ai đặt cửa.*')
            .setFooter({ text: 'Thời gian đặt cược kết thúc sau 40 giây!' });
            
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('bc_btn_join').setLabel('💰 Tiến Hành Đặt Cược').setStyle(ButtonStyle.Primary));
        const msg = await message.channel.send({ embeds: [embed], components: [row] });
        activeGames.baucua.mainMessage = msg;

        setTimeout(async () => {
            try {
                const game = activeGames.baucua;
                if (!game || game.status !== 'betting') return;

                if (game.bets.length === 0) {
                    activeGames.baucua = null;
                    return await msg.edit({ content: '🎲 Sòng Bầu Cua giải tán vì không có ai đặt cược ván này!', embeds: [], components: [] });
                }

                game.status = 'finished';
                const items = [
                    { name: 'Bầu', emoji: '🍇' }, { name: 'Cua', emoji: '🦀' }, { name: 'Tôm', emoji: '🦐' }, 
                    { name: 'Cá', emoji: '🐟' }, { name: 'Gà', emoji: '🐓' }, { name: 'Nai', emoji: '🦌' }
                ];

                const d1 = items[Math.floor(Math.random() * items.length)];
                const d2 = items[Math.floor(Math.random() * items.length)];
                const d3 = items[Math.floor(Math.random() * items.length)];
                const results = [d1.name, d2.name, d3.name];
                
                let logResult = `📊 **KẾT QUẢ ĐĨA LẮC:**\n 🔹 ${d1.emoji} **${d1.name}** | ${d2.emoji} **${d2.name}** | ${d3.emoji} **${d3.name}**\n\n🏁 **BẢNG TRẢ THƯỞNG CHI TIẾT:**\n`;
                
                game.bets.forEach(b => {
                    const matchCount = results.filter(r => r === b.choice).length;
                    if (matchCount > 0) {
                        const winAmount = b.amount * matchCount;
                        // Thắng: hoàn lại vốn đã escrow (b.amount) + tiền thắng (winAmount) -> net vẫn +winAmount như gốc
                        addBalance(b.userId, b.amount + winAmount, guildId);
                        logResult += `• <@${b.userId}> chọn **${b.choice}**: **THẮNG** 🎉 **+${winAmount}💸**\n`;
                    } else {
                        // Thua: KHÔNG trừ gì thêm, tiền đã bị escrow lúc đặt cược rồi -> chặn đường thua "miễn phí"
                        logResult += `• <@${b.userId}> chọn **${b.choice}**: **THUA** 💸 **-${b.amount}💸**\n`;
                    }
                });
                
                const endEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🏆 TỔNG KẾT PHIÊN BẦU CUA 🏆').setDescription(logResult).setTimestamp();
                await msg.edit({ embeds: [endEmbed], components: [] });
                activeGames.baucua = null;
            } catch(e) { activeGames.baucua = null; }
        }, 40000);
    }
        // ==========================================
    // LỆNH GAME SLOT MACHINE (MÁY ĐÁNH BẠC)
    // ==========================================
    if (command === 'mayquaythuong' || (command === 'slot' && args[0] === 'machine')) {
        const embed = new EmbedBuilder()
            .setColor('#f1c40f')
            .setTitle('🎰 MÁY ĐÁNH BẠC (SLOT MACHINE) 🎰')
            .setDescription('Nhấn vào nút bên dưới để nhập số tiền cược!\n\n**Luật chơi:**\n🍎 Quay trúng **3 trái cây giống nhau**: Nhận **x2** tiền cược.\n💥 Ngược lại: Mất tiền cược.\n*(Sử dụng 10 loại trái cây nhiệt đới)*');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                // Gắn userId vào ID nút để tránh người khác bấm hộ
                .setCustomId(`btn_slot_bet_${message.author.id}`) 
                .setLabel('💰 Nhập Tiền Cược')
                .setStyle(ButtonStyle.Success)
        );

        return message.reply({ embeds: [embed], components: [row] });
    }
    
});

// ==========================================
// TỔNG HỢP XỬ LÝ SỰ KIỆN (INTERACTIONS)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        const userId = interaction.user.id;
        const guildId = interaction.guildId || 'global';
        const guildData = getGuildData(guildId);
        const id = interaction.customId || interaction.commandName || null;

        // --- 0. XỬ LÝ AUTOCOMPLETE (GỢI Ý TỰ ĐỘNG CHO ĐÀI XỔ SỐ) ---
        if (interaction.isAutocomplete()) {
            const commandName = interaction.commandName;
            if (commandName === 'vesomoi') {
                const focusedValue = interaction.options.getFocused().toLowerCase();
                const selectedMien = interaction.options.getString('mien'); // Lấy miền người dùng đã chọn trước đó

                let validStations = ALL_XS_STATIONS;
                // Nếu đã chọn miền, gợi ý đài sẽ bị khóa theo miền đó
                if (selectedMien && XS_STATIONS[selectedMien]) {
                    validStations = XS_STATIONS[selectedMien];
                }

                // Lọc theo từ khóa người dùng gõ (và luôn giới hạn trả về tối đa 25 theo luật Discord)
                const filtered = validStations
                    .filter(station => station.toLowerCase().includes(focusedValue))
                    .slice(0, 25);
                    
                await interaction.respond(
                    filtered.map(station => ({ name: station, value: station }))
                );
            }
            return;
        }
        
        // ---> ĐOẠN CODE THÊM MỚI Ở ĐÂY <---
        // KIỂM TRA TRẠNG THÁI TÙ GIAM ĐỂ CHẶN TƯƠNG TÁC BUTTON, MENU, SLASH COMMANDS
        if (guildData.prisonUsers && guildData.prisonUsers[userId]) {
            const prisonData = guildData.prisonUsers[userId];
            // Nếu vẫn đang trong thời gian phạt tù
            if (Date.now() < prisonData.releaseTime) {
                return interaction.reply({ 
                    content: '⚠️ **Bạn đang chịu án phạt tù!** Bạn không thể tương tác với nút bấm hoặc lệnh của bot lúc này.', 
                    ephemeral: true 
                });
            } else {
                // Nếu đã hết hạn tù thì gỡ án và cho đi tiếp
                const prisonRole = interaction.guild?.roles.cache.get(guildData.prisonConfig?.roleId);
                if (prisonRole) await interaction.member.roles.remove(prisonRole).catch(() => {});
                delete guildData.prisonUsers[userId];
                saveData();
            }
        }

        // --- 1. LỆNH SLASH COMMANDS ---
        if (interaction.isChatInputCommand()) {
            const { commandName, options, user } = interaction;

if (commandName === 'setup-pool') {
    const rarity = options.getString('rarity');
    const role = options.getRole('role');
    const money = options.getInteger('money');
    const rod = options.getString('can_cau');
    const bait = options.getString('moi_cau');
    const qty = options.getInteger('so_luong') || 1;

    let added = [];
    if (role) { guildData.lootbox.pools[rarity].push({ type: 'role', value: role.id }); added.push(`Role <@&${role.id}>`); }
    if (money) { guildData.lootbox.pools[rarity].push({ type: 'money', value: money }); added.push(`Tiền: ${money.toLocaleString()} VNĐ`); }
    if (rod) { guildData.lootbox.pools[rarity].push({ type: 'rod', value: rod }); added.push(`Cần câu: ${rod}`); }
    if (bait) { guildData.lootbox.pools[rarity].push({ type: 'bait', value: bait, qty: qty }); added.push(`Mồi: ${qty}x ${bait}`); }

    if (added.length === 0) return interaction.reply({ content: '❌ Bạn chưa chọn phần thưởng nào!', ephemeral: true });
    
    saveData();
    return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã thêm vào mốc **${rarity}**:\n- ${added.join('\n- ')}`, ephemeral: true });
}

                   if (commandName === 'dailyveso') {
            const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === interaction.user.id;
            if (!isAdmin) return interaction.reply({ content: '❌ Chỉ Quản trị viên mới có thể sử dụng lệnh này!', ephemeral: true });

            const channel = interaction.options.getChannel('kenhbaotrung');

            if (!guildData.lotteryConfig) guildData.lotteryConfig = {};
            guildData.lotteryConfig.channelId = channel.id;
            saveData();

            return interaction.reply({ 
                content: `<a:emoji_75:1524039622668189806>**Đã cập nhật kênh báo kết quả xổ số!**\n📣 Kênh thông báo kết quả: <#${channel.id}>\n\n_Dùng lệnh \`/vesomoi\` để chọn đài mở thưởng cho ngày mới._`, 
                ephemeral: true 
            });
        }

                   if (commandName === 'vesomoi') {
            const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === interaction.user.id;
            if (!isAdmin) return interaction.reply({ content: '❌ Chỉ Quản trị viên mới có thể sử dụng lệnh này!', ephemeral: true });

            const mien = interaction.options.getString('mien');
            const dais = [];

            for (let i = 1; i <= 4; i++) {
                const daiVal = interaction.options.getString(`dai${i}`);
                if (daiVal && !dais.includes(daiVal)) {
                    // Kiểm tra kỹ xem người dùng có nhập chuẩn tên đài không
                    if (ALL_XS_STATIONS.includes(daiVal)) {
                        dais.push(daiVal);
                    }
                }
            }

            if (dais.length === 0) {
                return interaction.reply({ content: '❌ Bạn chưa chọn đài hợp lệ nào! Hãy dùng danh sách gợi ý.', ephemeral: true });
            }

            // Giữ nguyên kênh báo kết quả đã cài bằng /dailyveso (nếu có)
            const existingChannelId = guildData.lotteryConfig ? guildData.lotteryConfig.channelId : null;

            if (!existingChannelId) {
                return interaction.reply({ 
                    content: '❌ Chưa có kênh báo kết quả nào được cài đặt! Vui lòng dùng lệnh `/dailyveso` để chọn kênh trước, sau đó mới dùng `/vesomoi`.', 
                    ephemeral: true 
                });
            }

            // 🧹 XÓA TOÀN BỘ DỮ LIỆU VÉ SỐ CŨ (vé đã mua, kết quả cũ...) để reset lại từ đầu cho ngày mới
            guildData.lotteryUsers = {};

            // Thiết lập lại đài mở thưởng mới, GIỮ NGUYÊN kênh báo kết quả
            guildData.lotteryConfig = {
                mien: mien,
                dais: dais,
                channelId: existingChannelId,
                saleOpen: true // 🔓 Mở lại quầy bán vé cho ngày mới
            };
            saveData();

            return interaction.reply({ 
                content: `<a:emoji_75:1524039622668189806>**Đã reset và cài đặt vé số cho ngày mới thành công!**\n🗺️ Khu vực: **Miền ${mien}**\n📍 Đài mở thưởng hôm nay: **${dais.join(', ')}**\n📣 Kênh báo kết quả: <#${existingChannelId}>\n🔓 Quầy bán vé đã mở, dùng \`!shopveso\` để mua vé!`, 
                ephemeral: true 
            });
        }

            
if (commandName === 'capquyenkenh') {
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === user.id;
    if (!isAdmin) return interaction.reply({ content: '❌ Chỉ Chủ Server hoặc Quản trị viên mới có thể sử dụng lệnh này!', ephemeral: true });

    const nhaTuChannel = options.getChannel('nha_tu');
    const prisonRole = options.getRole('role');

    guildData.prisonConfig = {
        channelId: nhaTuChannel.id,
        roleId: prisonRole.id
    };
    saveData();

    return interaction.reply({ 
        content: `<a:emoji_75:1524039622668189806>**Thiết lập hệ thống tù giam thành công!**\n📍 Kênh cải tạo: <#${nhaTuChannel.id}>\n🎭 Role tù nhân: <@&${prisonRole.id}>`, 
        ephemeral: true 
    });
}

if (commandName === 'borrow') {
    // FIX: biến "money" trước đây không được khai báo trong khối lệnh này
    // (nó chỉ tồn tại bên trong khối 'setup-pool' ở trên) -> gây lỗi
    // "Đã xảy ra lỗi hệ thống khi xử lý tương tác này" mỗi khi dùng /borrow.
    const money = options.getInteger('money');
    if (!money || money <= 0) {
        return interaction.reply({ content: '❌ Số tiền muốn vay phải lớn hơn 0!', ephemeral: true });
    }
    if (guildData.debts && guildData.debts[userId]) {
        return interaction.reply({ content: '❌ Bạn đang có một khoản nợ chưa trả! Hãy dùng `/trano` để thanh toán trước khi vay thêm.', ephemeral: true });
    }

    // ===== CHỐNG ACC CLONE / ACC RÁC =====
    // Yêu cầu tài khoản Discord đủ "tuổi" và đã tham gia server đủ lâu trước khi được vay,
    // để hạn chế việc tạo acc mới chỉ để vay-chuyển-bỏ.
    const ANTI_CLONE_MIN_ACCOUNT_AGE = 7 * 24 * 60 * 60 * 1000;  // acc Discord phải tạo > 7 ngày
    const ANTI_CLONE_MIN_JOIN_AGE = 3 * 24 * 60 * 60 * 1000;     // phải ở trong server > 3 ngày
    const memberObj = interaction.member;
    const accountAge = Date.now() - user.createdTimestamp;
    const joinAge = memberObj?.joinedTimestamp ? (Date.now() - memberObj.joinedTimestamp) : 0;
    if (accountAge < ANTI_CLONE_MIN_ACCOUNT_AGE || joinAge < ANTI_CLONE_MIN_JOIN_AGE) {
        return interaction.reply({ content: '❌ Tài khoản của bạn còn quá mới (hoặc mới tham gia server) nên chưa đủ điều kiện vay tín dụng đen!', ephemeral: true });
    }

    // ===== GIỚI HẠN SỐ TIỀN VAY =====
    // Không cho vay vượt quá một mức trần cố định, tránh vay số khủng rồi bùng.
    const BORROW_MAX_AMOUNT = 50000000; // chỉnh theo cân bằng game của bạn
    if (money > BORROW_MAX_AMOUNT) {
        return interaction.reply({ content: `❌ Số tiền vay tối đa cho phép là **${BORROW_MAX_AMOUNT.toLocaleString()} VNĐ**!`, ephemeral: true });
    }

        // Tính toán số nợ (x10) và thời gian (20 phút) -- CỐ ĐỊNH 20 phút dù vay bao nhiêu
    const debtAmount = money * 3; 
    const duration = 20 * 60 * 1000; // 20 phút 

    // CHỈNH SỬA Ở ĐÂY: Hệ số phạt dựa vào SỐ TIỀN PHẢI TRẢ (debtAmount)
    // Cứ 1.000.000đ (1 triệu) tiền NỢ sẽ tăng hệ số lên 1 (VD: Nợ 5 Triệu -> Hệ số 5 -> Tù 25 tiếng, mỗi nhiệm vụ trong 6 nhiệm vụ phải làm 5 lần)
    const factor = Math.max(1, Math.ceil(debtAmount / 1000000)); 

    // Lưu lại số dư TRƯỚC khi vay -> dùng để khóa lệnh /give (chống chuyển hết tiền vay đi rồi bùng)
    const balanceBeforeLoan = getBalance(userId, guildId);

    // Cộng tiền vay vào tài khoản người dùng
    addBalance(userId, money, guildId);

    // Ghi nhận nợ vào hệ thống
    guildData.debts[userId] = {
        amount: debtAmount, 
        originalAmount: money,
        deadline: Date.now() + duration, 
        factor: factor, // Lưu hệ số khủng này vào database
        balanceBeforeLoan: balanceBeforeLoan // Số dư trước khi vay, dùng để chặn /give vượt mức
    };
    saveData();

    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle('💸 HỢP ĐỒNG TÍN DỤNG ĐEN ĐÃ KÝ 💸')
        .setDescription(`👤 Người vay: <@${userId}>\n💰 Số tiền thực nhận: **${money.toLocaleString()} VNĐ**\n\n⚠️ **KHOẢN NỢ PHẢI TRẢ (x3):** **${debtAmount.toLocaleString()} VNĐ**\n⏳ **Thời hạn vay:** **20 phút**.\n\n👉 Hãy dùng lệnh \`/trano\` để thanh toán khoản nợ này trước khi hết hạn!\n🚨 *Nếu quá hạn 20 phút mà chưa trả, bạn sẽ bị bắt giam để đày lao động công ích!*`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

if (commandName === 'trano') {
    if (!guildData.debts || !guildData.debts[userId]) {
        return interaction.reply({ content: '<a:emoji_75:1524039622668189806>Hồ sơ trong sạch! Bạn hiện không có khoản nợ tín dụng đen nào.', ephemeral: true });
    }

    const debt = guildData.debts[userId];
    const currentBalance = getBalance(userId, guildId);

    // Kiểm tra tiền xem có đủ trả không
    if (currentBalance < debt.amount) {
        return interaction.reply({ content: `❌ Bạn không đủ tiền! Bạn cần **${debt.amount.toLocaleString()} VNĐ** để trả nợ. (Ví hiện tại: ${currentBalance.toLocaleString()} VNĐ)`, ephemeral: true });
    }

    // Trừ tiền trả nợ và xoá hồ sơ nợ
    addBalance(userId, -debt.amount, guildId);
    delete guildData.debts[userId];
    saveData();

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle('<a:emoji_75:1524039622668189806>THANH TOÁN NỢ THÀNH CÔNG')
        .setDescription(`Cảm ơn <@${userId}> đã thanh toán đủ khoản nợ **${debt.amount.toLocaleString()} VNĐ**.\nBạn đã an toàn không bị xã hội đen tìm tới và tống giam!`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

if (commandName === 'doino') {
    // ADMIN_ID đã được khai báo ở dòng 70 trong source của bạn
    if (userId !== ADMIN_ID) {
        return interaction.reply({ content: '❌ Bạn không phải là Chủ Bot (Đại Ca) để dùng lệnh này!', ephemeral: true });
    }

    const phut = options.getInteger('phut');
    if (phut <= 0) return interaction.reply({ content: '❌ Thời gian chót phải lớn hơn 0!', ephemeral: true });

    const debts = guildData.debts;
    if (!debts || Object.keys(debts).length === 0) {
        return interaction.reply({ content: '<a:emoji_75:1524039622668189806>Hiện tại server không có ai đang vay nặng lãi cả. Không cần đòi!', ephemeral: true });
    }

    const debtorIds = Object.keys(debts);
    const deadlineTime = Date.now() + (phut * 60 * 1000);
    let pings = [];

    // Duyệt qua tất cả con nợ
    for (const dId of debtorIds) {
        // 1. Gia hạn thời gian chót bằng với số phút Chủ bot yêu cầu
        debts[dId].deadline = deadlineTime;
        
        // 2. Tính lại hệ số phạt nặng hơn dựa trên SỐ TIỀN NỢ (đã x10)
        // Cứ mỗi 1.000.000đ (1 triệu) NỢ = 1 Hệ số. Nợ 5 triệu = Hệ số 5.
        const heavyFactor = Math.max(1, Math.ceil(debts[dId].amount / 1000000));
        debts[dId].factor = heavyFactor; 
        
        pings.push(`<@${dId}>`);
    }
    saveData();

    const embed = new EmbedBuilder()
        .setColor('#8b0000') // Màu đỏ sẫm
        .setTitle('🚨 TỐI HẬU THƯ TỪ CHỦ NỢ 🚨')
        .setDescription(`Đại ca <@${ADMIN_ID}> đã ra lệnh thu hồi nợ khẩn cấp!\n\nTất cả những người có tên dưới đây có đúng **${phut} phút** để thanh toán toàn bộ khoản nợ bằng lệnh \`/trano\`.\n\n⚠️ **CẢNH BÁO:** Nếu không trả đúng hạn, hệ thống sẽ tự động tống giam vào nhà tù.\n📈 **Nợ càng nhiều, thời gian thụ án càng lâu và khối lượng lao động công ích càng khổng lồ!**`)
        .addFields({ name: '👤 Danh sách con nợ bị truy nã:', value: pings.join(', ') })
        .setTimestamp();

    // Ping tất cả con nợ ở ngoài nội dung để họ nhận được thông báo đỏ
    return interaction.reply({ content: `🔔 **Kêu gọi:** ${pings.join(', ')}`, embeds: [embed] });
}

            if (commandName === 'tratudo') {
                // 1. Kiểm tra quyền hạn: Chỉ Admin hoặc Owner mới được dùng
                const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === user.id;
                if (!isAdmin) {
                    return interaction.reply({ content: '❌ Chỉ Chủ Server hoặc Quản trị viên mới có thể sử dụng lệnh này!', ephemeral: true });
                }

                // 2. Lấy thông tin user được tag
                const targetUser = options.getUser('user');
                const targetId = targetUser.id;

                // 3. Kiểm tra xem người này có đang ở trong tù không
                if (!guildData.prisonUsers || !guildData.prisonUsers[targetId]) {
                    return interaction.reply({ content: `⚠️ <@${targetId}> hiện tại đang là công dân lương thiện, không có án phạt tù nào!`, ephemeral: true });
                }

                // 4. Xóa dữ liệu tù nhân và lưu database
                delete guildData.prisonUsers[targetId];
                saveData();

                // 5. Gỡ Role nhà tù (nếu có setup)
                const prisonRole = interaction.guild.roles.cache.get(guildData.prisonConfig?.roleId);
                if (prisonRole) {
                    try {
                        const member = await interaction.guild.members.fetch(targetId).catch(() => null);
                        if (member) {
                            await member.roles.remove(prisonRole).catch(() => {});
                        }
                    } catch (e) {
                        console.error('Lỗi gỡ role khi trả tự do:', e);
                    }
                }

                // 6. Thông báo thành công
                const embed = new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle('🕊️ QUYẾT ĐỊNH ĐẶC XÁ 🕊️')
                    .setDescription(`Admin/Owner <@${user.id}> đã ban hành lệnh đặc xá!\n\nToàn bộ án phạt công ích của <@${targetId}> đã được gỡ bỏ. Đối tượng đã được trả lại toàn bộ quyền sử dụng bot và tương tác bình thường.`)
                    .setTimestamp();

                return interaction.reply({ embeds: [embed] });
            }

            if (commandName === 'vaotu') {
                // 1. Kiểm tra quyền hạn: Chỉ Admin hoặc Owner mới được dùng
                const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === user.id;
                if (!isAdmin) {
                    return interaction.reply({ content: '❌ Chỉ Chủ Server hoặc Quản trị viên mới có thể sử dụng lệnh này!', ephemeral: true });
                }

                // 2. Bắt buộc phải setup nhà tù trước (dùng /capquyenkenh)
                if (!guildData.prisonConfig || !guildData.prisonConfig.roleId || !guildData.prisonConfig.channelId) {
                    return interaction.reply({ content: '❌ Server chưa cài đặt hệ thống nhà tù! Hãy dùng `/capquyenkenh` trước.', ephemeral: true });
                }

                const targetUser = options.getUser('user');
                const targetId = targetUser.id;
                const phut = options.getInteger('phut') || 60; // Mặc định 60 phút nếu không nhập
                const lyDo = options.getString('ly_do') || 'Vi phạm nội quy server';

                if (phut <= 0) {
                    return interaction.reply({ content: '❌ Thời gian thụ án phải lớn hơn 0 phút!', ephemeral: true });
                }

                const prisonRole = interaction.guild.roles.cache.get(guildData.prisonConfig.roleId);
                const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
                if (!targetMember) {
                    return interaction.reply({ content: '❌ Không tìm thấy thành viên này trong server!', ephemeral: true });
                }

                // 3. Tạo hồ sơ tù nhân (hệ thống chống lách luật sẽ tự cấp lại role này
                // nếu người chơi out ra vào lại, hoặc nếu role bị gỡ trong khi chưa mãn hạn)
                guildData.prisonUsers[targetId] = {
                    releaseTime: Date.now() + (phut * 60 * 1000),
                    reason: lyDo,
                    tasks: buildPrisonTasks(1)
                };
                saveData();

                // 4. Gắn role tù nhân ngay lập tức
                if (prisonRole) {
                    await targetMember.roles.add(prisonRole).catch(() => {});
                }

                // 5. Tịch thu (trừ sạch) toàn bộ số dư hiện có của đối tượng bị tống giam
                const seizedAmount = seizeAllBalance(targetId, guildId);

                const embed = new EmbedBuilder()
                    .setColor('#8b0000')
                    .setTitle('🚔 LỆNH TỐNG GIAM 🚔')
                    .setDescription(`Admin/Owner <@${user.id}> đã tống giam <@${targetId}>!\n\n📄 **Lý do:** ${lyDo}\n⏳ **Thời hạn:** **${phut} phút**\n📍 **Khu vực cải tạo:** <#${guildData.prisonConfig.channelId}>\n💸 **Tài sản bị tịch thu:** **${seizedAmount.toLocaleString()}đ**\n\n📋 **BẢNG NHIỆM VỤ CẢI TẠO CẦN HOÀN THÀNH:**\n${buildPrisonTaskBoard(guildData.prisonUsers[targetId].tasks)}\n👉 Hoàn thành hết nhiệm vụ sẽ được **tự động đặc xá**, gỡ role và trả tự do ngay lập tức! (Gõ \`!nhiemvu\` để xem lại bảng này bất cứ lúc nào)\n\n🔒 *Hệ thống sẽ tự động cấp lại role tù nhân nếu đối tượng thoát server rồi vào lại, hoặc nếu role bị gỡ bỏ trong lúc chưa mãn hạn.*`)
                    .setTimestamp();

                return interaction.reply({ embeds: [embed] });
            }

            if (commandName === 'buff') {
                if (user.id !== ADMIN_ID) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Bạn không có quyền sử dụng lệnh này!', ephemeral: true });
                const targetUser = options.getUser('user'); 
                const amount = options.getInteger('money');
                addBalance(targetUser.id, amount, guildId);
                return interaction.reply({ content: `⚡ **[ADMIN SYSTEM]** Đã buff ẩn danh **+${amount}💸** cho <@${targetUser.id}>.\nSố dư mới: \`${getBalance(targetUser.id, guildId)}💸\``, ephemeral: true });
            }

            if (commandName === 'give') {
                const targetUser = options.getUser('user');
                const amount = options.getInteger('money');
                if (amount <= 0 || getBalance(user.id, guildId) < amount) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Số tiền không hợp lệ hoặc bạn không đủ số dư!', ephemeral: true });

                // ===== CHỐNG VAY-CHUYỂN-BÙNG =====
                // Nếu người gửi đang có nợ tín dụng đen chưa trả, không cho chuyển vượt quá
                // số dư mà họ có TRƯỚC KHI vay (tức không được tẩu tán tiền vừa vay đi).
                const senderDebt = guildData.debts && guildData.debts[user.id];
                if (senderDebt) {
                    const safeAmount = Math.max(0, senderDebt.balanceBeforeLoan || 0);
                    if (amount > safeAmount) {
                        return interaction.reply({ content: `❌ Bạn đang có khoản nợ tín dụng đen chưa trả! Trong lúc còn nợ, bạn chỉ được chuyển tối đa **${safeAmount.toLocaleString()} VNĐ** (số dư trước khi vay). Hãy \`/trano\` trả nợ trước đã.`, ephemeral: true });
                    }
                }

                addBalance(user.id, -amount, guildId); 
                addBalance(targetUser.id, amount, guildId);
                return interaction.reply({ content: `💸 <@${user.id}> đã chuyển **${amount}💸** cho <@${targetUser.id}>!` });
            }

            if (commandName === 'sell') {
                const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === user.id;
                if (!isAdmin) {
                    return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Chỉ Chủ Server hoặc Admin mới có thể sử dụng lệnh này!', ephemeral: true });
                }
                
                const role = options.getRole('role');
                const price = options.getInteger('price');
                const code = options.getString('code');
                const guildId = interaction.guildId;
                
                if (!db.shop[guildId]) db.shop[guildId] = {};
                db.shop[guildId][code] = { roleId: role.id, price: price };
                saveData();

                return interaction.reply({ 
                    content: `<a:emoji_75:1524039622668189806>  Thành công! Bạn đã đặt bán role <@&${role.id}> tại cửa hàng của server này.\n💸 Mức giá: **${price.toLocaleString()} VNĐ**\n📦 Mã hàng hóa: \`${code}\``, 
                    ephemeral: true 
                });
            }
        }

        // --- XỬ LÝ NÚT BẤM (BUTTON) ---
if (interaction.isButton()) {
    // 1. Nút Mua Rương -> Hiện bảng điền số lượng
    if (id.startsWith('buy_chest_')) {
        const chestId = id.replace('buy_chest_', '');
        const modal = new ModalBuilder().setCustomId(`modal_buy_${chestId}`).setTitle(`Mua ${CHEST_CONFIG[chestId].name}`);
        const qtyInput = new TextInputBuilder().setCustomId('qty').setLabel('Nhập số lượng:').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        await interaction.showModal(modal);
        return;
    }

    // 2. Nút Mở Rương -> Gacha!
    if (id.startsWith('open_chest_')) {
        const chestId = id.replace('open_chest_', '');
        let inv = guildData.lootbox.inventory[userId];
        if (!inv || !inv[chestId] || inv[chestId] <= 0) return interaction.reply({ content: '❌ Bạn không còn rương loại này!', ephemeral: true });

        // Trừ rương ngay lập tức
        inv[chestId] -= 1;
        saveData();

        const chestData = CHEST_CONFIG[chestId];

        // 💥 CƠ CHẾ 10% RỖNG CHO 4 RƯƠNG ĐẦU 💥
        if (chestData.emptyChance > 0 && Math.random() < chestData.emptyChance) {
            return interaction.reply({ content: `💥 **BÙM!** Rất tiếc, bạn mở **${chestData.name}** nhưng bên trong chẳng có gì! (Xui xẻo 10%)` });
        }

        // Bắt đầu quay độ hiếm dựa vào tỉ lệ của rương
        const rates = chestData.rates;
        const rand = Math.random() * 100;
        let cumulative = 0;
        let rolledRarity = RARITIES[0];

        for (let i = 0; i < rates.length; i++) {
            cumulative += rates[i];
            if (rand <= cumulative) {
                rolledRarity = RARITIES[i];
                break;
            }
        }

        // Lấy quà từ mốc tương ứng
        const pool = guildData.lootbox.pools[rolledRarity];
        if (!pool || pool.length === 0) {
            return interaction.reply({ content: `📦 Bạn mở **${chestData.name}** và đạt mốc **[${rolledRarity}]** nhưng Admin chưa thêm phần thưởng nào vào mốc này!` });
        }

        const reward = pool[Math.floor(Math.random() * pool.length)];
        let msg = `🎉 Keng! Bạn mở **${chestData.name}** và nhân phẩm đạt mốc **[${rolledRarity}]**!\n🎁 Nhận được: `;

        // Trao phần thưởng
        if (reward.type === 'money') {
            addBalance(userId, reward.value, guildId);
            msg += `**${reward.value.toLocaleString()} VNĐ** 💸!`;
        } 
        else if (reward.type === 'role') {
            const role = interaction.guild.roles.cache.get(reward.value);
            if (role) {
                await interaction.member.roles.add(role).catch(()=>{});
                msg += `Danh hiệu **${role.name}** 🎭!`;
            } else msg += 'Danh hiệu (Lỗi/Đã xóa)!';
        } 
        else if (reward.type === 'rod' || reward.type === 'bait') {
            const userFish = fishingGetUser(userId, guildId);
            const itemName = reward.value;
            const qty = reward.qty || 1;
            userFish.inventory[itemName] = (userFish.inventory[itemName] || 0) + qty;
            saveFishingData();
            msg += `**${qty}x ${itemName}** 🎒!`;
        }

        return interaction.reply({ content: msg });
    }
}

// --- XỬ LÝ BẢNG ĐIỀN SỐ LƯỢNG (MODAL) ---
if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_buy_') && CHEST_CONFIG[interaction.customId.replace('modal_buy_', '')]) {
        const chestId = interaction.customId.replace('modal_buy_', '');
        const qty = parseInt(interaction.fields.getTextInputValue('qty'));

        if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });

        const price = CHEST_CONFIG[chestId].price;
        const totalCost = price * qty;
        const currentBal = getBalance(userId, guildId);

        if (currentBal < totalCost) return interaction.reply({ content: `❌ Bạn cần **${totalCost.toLocaleString()} VNĐ** để mua ${qty} rương. Số dư không đủ!`, ephemeral: true });

        addBalance(userId, -totalCost, guildId);
        if (!guildData.lootbox.inventory[userId]) guildData.lootbox.inventory[userId] = {};
        guildData.lootbox.inventory[userId][chestId] = (guildData.lootbox.inventory[userId][chestId] || 0) + qty;
        saveData();

        return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mua **${qty}x ${CHEST_CONFIG[chestId].name}** thành công! Dùng lệnh \`!moruong\` để mở.`, ephemeral: true });
    }
}
                 if (interaction.isButton()) {
                 if (id && id.startsWith('btnveso_')) {
    const index = parseInt(id.split('_')[1]);
    if (!guildData.lotteryConfig || !guildData.lotteryConfig.dais || !guildData.lotteryConfig.dais[index]) {
        return interaction.reply({ content: '⚠️ Đài này không còn tồn tại hoặc dữ liệu cấu hình đã thay đổi!', ephemeral: true });
    }
    if (guildData.lotteryConfig.saleOpen === false) {
        return interaction.reply({ content: '🔒 **Đại lý vé số đã đóng cửa!** Kết quả đã được thông báo và phát thưởng xong, vui lòng chờ Admin dùng lệnh `/vesomoi` để mở bán cho ngày tiếp theo.', ephemeral: true });
    }
    const daiName = guildData.lotteryConfig.dais[index];

    const modal = new ModalBuilder()
        .setCustomId(`modalveso_${index}`)
        .setTitle(`Mua Vé Số - Đài ${daiName}`);

    const qtyInput = new TextInputBuilder()
        .setCustomId('veso_qty')
        .setLabel(`Số lượng mua đài ${daiName} (10k/tờ)`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ví dụ: 5')
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
    await interaction.showModal(modal);
    return;
}

            
                        // NÚT MỞ BẢNG NHẬP TIỀN SLOT MACHINE
            if (id.startsWith('btn_slot_bet_')) {
                const targetUserId = id.split('_')[3];
                
                // Kiểm tra xem có đúng người gõ lệnh bấm không
                if (interaction.user.id !== targetUserId) {
                    return interaction.reply({ content: '❌ Máy quay này không phải của bạn! Hãy tự gõ lệnh !mayquaythuong.', ephemeral: true });
                }

                const modal = new ModalBuilder()
                    .setCustomId('modal_slot_bet')
                    .setTitle('🎰 Đặt Cược Slot Machine');

                const input = new TextInputBuilder()
                    .setCustomId('slot_bet_amount')
                    .setLabel('Nhập số tiền bạn muốn cược:')
                    .setPlaceholder('Ví dụ: 100')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
                return;
            }
            
            // XỬ LÝ NÚT BẤM MỞ BẢNG MA SÓI (DẠNG ẨN)
            if (id.startsWith('masoi_panel_')) {
                const guildId = id.replace('masoi_panel_', '');
                const game = activeGames.masoi.get(guildId);
                
                if (!game || game.status !== 'night') {
                    return interaction.reply({ content: '❌ Hiện không phải ban đêm hoặc ván đấu đã kết thúc!', ephemeral: true });
                }
                
                if (!game.players.includes(userId) || !game.playerRoles[userId].alive) {
                    return interaction.reply({ content: '👻 Bạn không có quyền tham gia hoặc đã chết!', ephemeral: true });
                }

                if (!game.nightActionUsedUsers) game.nightActionUsedUsers = new Set();
                if (game.nightActionUsedUsers.has(userId)) {
                    return interaction.reply({ content: '⛔ Bạn đã mở và dùng kỹ năng đêm nay rồi. Mỗi người chỉ được thao tác **1 lần** mỗi đêm!', ephemeral: true });
                }
                game.nightActionUsedUsers.add(userId);

                const userRole = game.playerRoles[userId].role;
                const alivePlayers = game.players.filter(id => game.playerRoles[id].alive);

                let skillText = "Bạn không có kỹ năng đặc biệt. Hãy ngủ ngon!";
                let components = [];

                // Discord select menu chỉ hỗ trợ tối đa 25 lựa chọn.
                // Nếu phòng đông, ta vẫn hiển thị menu bằng cách rút gọn danh sách an toàn.
                const buildOptions = (ids, limit = 25) => ids.slice(0, limit).map(id => {
                    const u = client.users.cache.get(id);
                    const rawName = (u?.username || `Người chơi ${String(id).slice(-4)}`).toString();
                    return {
                        label: rawName.slice(0, 100),
                        value: id
                    };
                });

                const options = buildOptions(alivePlayers);

                if (userRole === 'Sói') {
                    skillText = "Bạn là SÓI. Hãy chọn mục tiêu để cắn đêm nay.";
                    components.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId(`wolf_${guildId}`).setPlaceholder('Chọn mục tiêu cắn...').addOptions(options)
                    ));
                } else if (userRole === 'Tiên tri') {
                    // Thêm điều kiện check xem Tiên tri đã soi chưa
                    if (game.nightActions.seerTarget) {
                        skillText = "Bạn là TIÊN TRI. Bạn đã sử dụng kỹ năng soi người trong đêm nay rồi, hãy ngủ ngon!";
                    } else {
                        skillText = "Bạn là TIÊN TRI. Hãy soi 1 người để biết phe của họ.";
                        components.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder().setCustomId(`seer_${guildId}`).setPlaceholder('Chọn người để soi...').addOptions(options)
                        ));
                    }
                } else if (userRole === 'Bảo vệ') {
                    skillText = "Bạn là BẢO VỆ. Hãy chọn 1 người để bảo vệ đêm nay.";
                    if (options.length > 0) {
                        components.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`guard_${guildId}`)
                                .setPlaceholder('Chọn người để bảo vệ...')
                                .addOptions(options)
                        ));
                        if (alivePlayers.length > 25) {
                            skillText += "\n\n⚠️ Danh sách đã được rút gọn còn 25 người đầu tiên do giới hạn của Discord.";
                        }
                    } else {
                        skillText += "\n\n⚠️ Không có người chơi nào khả dụng để bảo vệ.";
                    }
                } else if (userRole === 'Phù thủy') {
                    skillText = "Bạn là PHÙ THỦY. Bạn có 1 bình CỨU và 1 bình ĐỘC.\n*(Mẹo: Bạn có thể chọn cứu 1 người để bảo vệ họ khỏi Sói. Nếu muốn dùng cả 2 bình trong 1 đêm, hãy dùng 1 bình trước, sau đó bấm lại nút 'Xem Vai Trò' ở tin nhắn gốc để dùng bình còn lại).*";

                    // Menu Bình Cứu
                    if (!game.witchSaveUsed) {
                        const saveOptions = [...options, { label: '🧬 Bỏ qua (Không cứu)', value: 'skip_save' }];
                        components.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder().setCustomId(`witch_save_${guildId}`).setPlaceholder('Dùng Bình Cứu cho ai?').addOptions(saveOptions)
                        ));
                    } else {
                        skillText += "\n\n❌ **Bạn đã sử dụng hết Bình Cứu!**";
                    }

                    // Menu Bình Độc
                    if (!game.witchPoisonUsed) {
                        const poisonOptions = [...options, { label: '🧪 Bỏ qua (Không độc)', value: 'skip_poison' }];
                        components.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder().setCustomId(`witch_poison_${guildId}`).setPlaceholder('Tạt Bình Độc vào ai?').addOptions(poisonOptions)
                        ));
                    } else {
                        skillText += "\n\n❌ **Bạn đã sử dụng hết Bình Độc!**";
                    }
                } else if (userRole === 'Cupid') {
                    skillText = "Bạn là CUPID. Hãy chọn 2 người để ghép đôi (Họ sẽ sống chết có nhau).";
                    components.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId(`cupid_${guildId}`).setPlaceholder('Ghép đôi 2 người...').setMinValues(2).setMaxValues(2).addOptions(options)
                    ));
                } else if (userRole === 'Thợ săn') {
                    skillText = "Bạn là THỢ SĂN. Nếu bạn bị giết đêm nay hoặc bị treo cổ, bạn sẽ mang theo 1 người bất kỳ.";
                } else if (userRole === 'Già làng') {
                    skillText = `Bạn là GIÀ LÀNG. Bạn có 2 mạng khi bị sói cắn. Số mạng hiện tại: ${game.playerRoles[userId].hp}`;
                } else if (userRole === 'Bán sói' || userRole === 'Phản bội') {
                    skillText = "Bạn là BÁN SÓI / KẺ PHẢN BỘI. Bạn sẽ thắng nếu phe Sói thắng. Hãy trà trộn!";
                }

                const roleEmbed = new EmbedBuilder()
                    .setTitle('🎭 VAI TRÒ CỦA BẠN 🎭')
                    .setDescription(`Vai trò của bạn: **${userRole.toUpperCase()}**\n\n📌 **Nhiệm vụ:** ${skillText}\n\n*(Lưu ý: Bạn chỉ có thể chọn 1 lần duy nhất trong đêm)*`)
                    .setColor('#9b59b6');

                return interaction.reply({ embeds: [roleEmbed], components: components, ephemeral: true });
            }

            // GAME XẾP GẠCH
            if (id.startsWith('tetris_')) {
                const game = activeGames.xepgach.get(userId);
                if (!game) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Ván game này đã kết thúc hoặc không tồn tại!', ephemeral: true });
                const action = id.replace('tetris_', '');
                
                if (action === 'stop') {
                    game.gameOver(interaction);
                    return;
                }

                if (!game.isGameOver) {
                    if (action === 'left') game.move(-1, 0);
                    if (action === 'right') game.move(1, 0);
                    if (action === 'rotate') game.rotate();
                    if (action === 'down') game.hardDrop();
                    
                    game.resetTick();
                    game.render(interaction);
                }
                return;
            }
            
            if (id === 'btn_buy_role') {
                const modal = new ModalBuilder()
                    .setCustomId('modal_rolebuy')
                    .setTitle('Thanh Toán Cửa Hàng');
                const input = new TextInputBuilder()
                    .setCustomId('buy_code_input')
                    .setLabel('Nhập Mã Role Muốn Mua:')
                    .setPlaceholder('Ví dụ: 404')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                    
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
                return;
            }
            
            // GAME CARO
            if (id.startsWith('caro_')) {
                const parts = id.split('_');
                const channelId = parts[1]; 
                const index = parseInt(parts[2]);
                const game = activeGames.caro.get(channelId);
                
                if (!game) return interaction.reply({ content: 'Cờ Caro', ephemeral: true });
                if (userId !== game.turn) return interaction.reply({ content: '❌ Chưa đến lượt của bạn!', ephemeral: true });
                if (game.board[index] !== '⬜') return interaction.reply({ content: '❌Ô này đã được đánh rồi!', ephemeral: true });
                
                const symbol = game.turn === game.p1 ? '❌' : '⭕';
                game.board[index] = symbol;
                
                if (checkWin(game.board, symbol)) {
                    activeGames.caro.delete(channelId);
                    const embed = new EmbedBuilder().setColor('#2f3136').setTitle('Cờ caro').setDescription(`🎉 Chúc mừng <@${game.turn}> (${symbol}) đã giành chiến thắng chung cuộc!`);
                    return interaction.update({ embeds: [embed], components: createCaroComponents(game.board, channelId, true) });
                }

                if (!game.board.includes('⬜')) {
                    activeGames.caro.delete(channelId);
                    const embed = new EmbedBuilder().setColor('#2f3136').setTitle('Cờ Caro').setDescription(`🤝 Bàn cờ đã đầy! Trận đấu kết thúc với kết quả Hòa!`);
                    return interaction.update({ embeds: [embed], components: createCaroComponents(game.board, channelId, true) });
                }

                game.turn = game.turn === game.p1 ? game.p2 : game.p1;
                const nextSymbol = game.turn === game.p1 ? '❌' : '⭕';
                const embed = new EmbedBuilder().setColor('#2f3136').setTitle('Cờ Caro').setDescription(`Ván đấu giữa <@${game.p1}> (<a:emoji_76:1524195723996823612>) và <@${game.p2}> (⭕)\n*Cần 4 quân liên tiếp để chiến thắng.*\n\n👉 Đến lượt của: <@${game.turn}> (${nextSymbol})`);
                return interaction.update({ embeds: [embed], components: createCaroComponents(game.board, channelId) });
            }

            // GAME TÀI XỈU
            if (id.startsWith('tx_btn_')) {
                if (!activeGames.taixiu || activeGames.taixiu.status !== 'betting') {
                    return await interaction.reply({ content: '❌ Sòng đã đóng hoặc đang lắc!', ephemeral: true });
                }

                const choice = id.split('_')[2];
                const choiceName = choice === 'tai' ? 'Tài' : choice === 'xiu' ? 'Xỉu' : choice === 'chan' ? 'Chẵn' : 'Lẻ';
                
                const modal = new ModalBuilder().setCustomId(`modal_tx_bet_${choice}`).setTitle(`Đặt cược: ${choiceName}`);
                const input = new TextInputBuilder().setCustomId('tx_amount_input').setLabel('Nhập tiền đặt:').setStyle(TextInputStyle.Short).setRequired(true);
                
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
                return;
            }

            // GAME BẦU CUA
            if (id === 'bc_btn_join') {
                if (!activeGames.baucua || activeGames.baucua.status !== 'betting') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Sòng đã đóng hoặc đang lắc!', ephemeral: true });
                const selectMenu = new StringSelectMenuBuilder().setCustomId('bc_select_choice').setPlaceholder('Chọn linh vật đặt cược...').addOptions([
                    { label: '🍇 Bầu', value: 'Bầu' }, { label: '🦀 Cua', value: 'Cua' }, { label: '🦐 Tôm', value: 'Tôm' },
                    { label: '🐟 Cá', value: 'Cá' }, { label: '🐓 Gà', value: 'Gà' }, { label: '🦌 Nai', value: 'Nai' }
                ]);
                
                return interaction.reply({ content: '?? Bước 1: Hãy chọn linh vật muốn cược:', components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            }

            // GAME XÌ DÁCH
            if (id.startsWith('pvp_') || id.startsWith('dealer_')) {
                const xd = activeGames.xidach;
                if (!xd) return; 

                if (id === 'pvp_xd_join') {
                    if (xd.status !== 'waiting') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Sòng đã đóng đăng ký!', ephemeral: true });
                    if (userId === xd.dealerId) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Bạn là Nhà Cái!', ephemeral: true });
                    if (xd.players.some(p => p.id === userId)) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Đã có mặt trên bàn!', ephemeral: true });
                    
                    const modal = new ModalBuilder().setCustomId('modal_pvp_bet').setTitle('Tiền Cược Xì Dách');
                    const input = new TextInputBuilder().setCustomId('pvp_bet_input').setLabel('Nhập tiền cược:').setStyle(TextInputStyle.Short).setRequired(true);
                    
                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    await interaction.showModal(modal);
                    return;
                }

                if (id === 'pvp_xd_check') {
                    if (xd.status !== 'players_turn') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Sai giai đoạn thao tác!', ephemeral: true });
                    const player = xd.players.find(p => p.id === userId);
                    if (!player) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Bạn không ở trong sòng này!', ephemeral: true });
                    return sendPvpPrivateMenu(interaction, player);
                }

                if (id === 'pvp_hit') {
                    if (xd.status !== 'players_turn') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Sai giai đoạn chơi!', ephemeral: true });
                    const player = xd.players.find(p => p.id === userId);
                    if (!player || player.status !== 'playing') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Lỗi hệ thống.', ephemeral: true });
                    
                    player.cards.push(xd.deck.pop());
                    const pInfo = calculatePoints(player.cards);
                    
                    if (pInfo.points > 21) {
                        player.status = 'quac';
                        await interaction.update({ content: `💥 Bài bạn: ${formatCards(player.cards)} (${pInfo.points}đ) -> Bạn bị **QUẮC**!`, components: [] });
                        await updateMainUI(); 
                        return checkAutoSwitchToDealer();
                    } else if (player.cards.length === 5) {
                        player.status = 'stand';
                        await interaction.update({ content: `🔥 Bài bạn: ${formatCards(player.cards)} -> **Ngũ Linh**! Chờ kết quả.`, components: [] });
                        await updateMainUI(); 
                        return checkAutoSwitchToDealer();
                    }
                    return sendPvpPrivateMenu(interaction, player, true);
                }

                if (id === 'pvp_stand') {
                    const player = xd.players.find(p => p.id === userId);
                    if (!player || player.status !== 'playing') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Lỗi thao tác.', ephemeral: true });
                    player.status = 'stand';
                    await interaction.update({ content: `🔒 Bạn đã dằn bài bí mật! Chờ nhà cái xử lý.`, components: [] });
                    await updateMainUI();
                    return checkAutoSwitchToDealer();
                }

                if (id === 'dealer_hit') {
                    if (userId !== xd.dealerId) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Bạn không phải Nhà Cái!', ephemeral: true });
                    xd.dealerCards.push(xd.deck.pop());
                    
                    const dInfo = calculatePoints(xd.dealerCards);
                    if (dInfo.points > 21 || xd.dealerCards.length === 5) return finishPvpGame();
                    const dEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🃏 XÌ DÁCH PVP: LƯỢT NHÀ CÁI 🃏').setDescription(`👑 Nhà Cái <@${xd.dealerId}> vừa rút bài ẩn...`);
                    return interaction.update({ embeds: [dEmbed] });
                }

                if (id === 'dealer_stand') {
                    if (userId !== xd.dealerId) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Bạn không phải Nhà Cái!', ephemeral: true });
                    const dInfo = calculatePoints(xd.dealerCards);
                    if (dInfo.points < 15 && dInfo.special === 'Thường') return interaction.reply({ content: '⚠️ Dưới 15 điểm chưa đủ tuổi dằn bài!', ephemeral: true });
                    await interaction.deferUpdate(); 
                    return finishPvpGame();
                }
            }
        }
        // --- 3. MENU DROP-DOWN ---
        if (interaction.isStringSelectMenu()) {
            
            if (id === 'bc_select_choice') {
                if (!activeGames.baucua || activeGames.baucua.status !== 'betting') return interaction.update({ content: '<a:emoji_76:1524195723996823612> Ván đã đóng cửa cược!', components: [] });
                const choice = interaction.values[0];
                const modal = new ModalBuilder().setCustomId(`modal_bc_bet_${choice}`).setTitle(`Đặt cược: ${choice}`);
                const input = new TextInputBuilder().setCustomId('bc_amount_input').setLabel('Nhập tiền đặt:').setStyle(TextInputStyle.Short).setRequired(true);
                
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
                return;
            }

            // BỘ LẮNG NGHE KỸ NĂNG ĐÊM (MA SÓI MENU)
            if (id.includes('_')) {
                const parts = id.split('_');
                const action = parts[0];
                const guildId = parts.length === 3 ? parts[2] : parts[1]; 
                
                if (['wolf', 'seer', 'guard', 'witch', 'cupid'].includes(action)) {
                    const game = activeGames.masoi.get(guildId);
                    
                    if (!game || game.status !== 'night') {
                        return interaction.reply({ content: '❌ Giai đoạn ban đêm đã kết thúc, bạn thao tác quá chậm!', ephemeral: true }).catch(()=>{});
                    }

                    const targetId = interaction.values[0];
                    
                    try {
                        if (action === 'wolf') {
                            game.nightActions.wolfVotes[targetId] = (game.nightActions.wolfVotes[targetId] || 0) + 1;
                            await interaction.update({ content: `🐺 Đã ghi nhận! Bạn đã bầu cắn <@${targetId}>.`, embeds: [], components: [] });
                        } else if (action === 'seer') {
                            const role = game.playerRoles[targetId].role;
                            const team = (role === 'Sói') ? 'Sói 🐺' : 'Dân Làng 🧑‍🌾';
                            await interaction.update({ content: `👁️ **Kết quả soi:** <@${targetId}> thuộc phe **${team}**!`, embeds: [], components: [] });
                        } else if (action === 'guard') {
                            game.nightActions.guardTarget = targetId;
                            await interaction.update({ content: `🛡️ Đã ghi nhận! Bạn đang bảo vệ <@${targetId}>.`, embeds: [], components: [] });
                        } else if (action === 'witch') {
                            const targetId = interaction.values[0];
                            
                            if (parts[1] === 'poison') {
                                if (targetId === 'skip_poison') {
                                    await interaction.update({ content: `🧪 Bạn đã không dùng Bình Độc đêm nay.`, embeds: [], components: [] });
                                } else {
                                    game.nightActions.poisonTarget = targetId;
                                    game.witchPoisonUsed = true;
                                    await interaction.update({ content: `🧪 Đã ghi nhận! Bạn tạt Bình Độc vào <@${targetId}>.\n*(Nếu muốn dùng tiếp Bình Cứu, hãy nhấn lại nút Xem Vai Trò ở kênh chat)*`, embeds: [], components: [] });
                                }
                            } else if (parts[1] === 'save') {
                                if (targetId === 'skip_save') {
                                    await interaction.update({ content: `🧬 Bạn đã không dùng Bình Cứu đêm nay.`, embeds: [], components: [] });
                                } else {
                                    game.nightActions.saveTarget = targetId;
                                    game.witchSaveUsed = true;
                                    await interaction.update({ content: `🧬 Đã ghi nhận! Bạn dùng Bình Cứu bảo vệ <@${targetId}>.\n*(Nếu muốn dùng tiếp Bình Độc, hãy nhấn lại nút Xem Vai Trò ở kênh chat)*`, embeds: [], components: [] });
                                }
                            }
                    } else if (action === 'cupid') {
                            const t1 = interaction.values[0];
                            const t2 = interaction.values[1];
                            game.nightActions.cupidTargets = [t1, t2];
                            await interaction.update({ content: `💘 Bạn đã ghép đôi <@${t1}> và <@${t2}>. Nếu 1 người chết, người kia sẽ chết theo!`, embeds: [], components: [] });
                        }
                    } catch (e) {}
                    return;
                }
            }
        }

        // --- 4. SUBMIT MODAL (GỬI THÔNG TIN) ---
        if (interaction.isModalSubmit()) {
        if (id && id.startsWith('modalveso_')) {
    const index = parseInt(id.split('_')[1]);
    if (!guildData.lotteryConfig || !guildData.lotteryConfig.dais || !guildData.lotteryConfig.dais[index]) {
        return interaction.reply({ content: '⚠️ Không tìm thấy thông tin đài xổ số hợp lệ!', ephemeral: true });
    }
    if (guildData.lotteryConfig.saleOpen === false) {
        return interaction.reply({ content: '🔒 **Đại lý vé số đã đóng cửa!** Kết quả đã được thông báo và phát thưởng xong, vui lòng chờ Admin dùng lệnh `/vesomoi` để mở bán cho ngày tiếp theo.', ephemeral: true });
    }
    const daiName = guildData.lotteryConfig.dais[index];
    const qtyStr = interaction.fields.getTextInputValue('veso_qty');
    const qty = parseInt(qtyStr);

    if (isNaN(qty) || qty <= 0) {
        return interaction.reply({ content: '❌ Số lượng vé nhập vào không hợp lệ!', ephemeral: true });
    }

    const totalCost = qty * 10000;
    const currentBal = getBalance(userId, guildId);

    if (currentBal < totalCost) {
        return interaction.reply({ 
            content: `❌ Bạn không đủ tiền! Cần **${totalCost.toLocaleString()} VNĐ** để mua ${qty} tờ đài **${daiName}**. Hiện tại bạn chỉ có ${currentBal.toLocaleString()} VNĐ.`, 
            ephemeral: true 
        });
    }

    // Trừ tiền thông qua hàm có sẵn của hệ thống bot
    addBalance(userId, -totalCost, guildId);

    // Lưu trữ vé phân tách theo đài
    if (!guildData.lotteryUsers) guildData.lotteryUsers = {};
    if (!guildData.lotteryUsers[userId]) guildData.lotteryUsers[userId] = {};
    if (!guildData.lotteryUsers[userId][daiName]) guildData.lotteryUsers[userId][daiName] = [];

    let newTickets = [];
    for (let i = 0; i < qty; i++) {
        const ticketStr = randDigits(6);
        newTickets.push(ticketStr);
        guildData.lotteryUsers[userId][daiName].push(ticketStr);
    }
    saveData();

    return interaction.reply({ 
        content: `🎉 Bạn đã đặt mua thành công **${qty}** tờ vé số đài **${daiName}**!\n💸 Tổng chi phí: **${totalCost.toLocaleString()} VNĐ**.\n🎫 Danh sách dãy số kiểm tra: \`${newTickets.join('`, `')}\``, 
        ephemeral: true 
    });
}

                        // MODAL NHẬP TIỀN SLOT MACHINE VÀ XỬ LÝ QUAY
            if (id === 'modal_slot_bet') {
                const amountStr = interaction.fields.getTextInputValue('slot_bet_amount');
                const amount = parseInt(amountStr);

                // 1. Kiểm tra số tiền hợp lệ
                if (isNaN(amount) || amount <= 0) {
                    return interaction.reply({ content: '❌ Số tiền cược không hợp lệ! Phải là một con số lớn hơn 0.', ephemeral: true });
                }

                if (getBalance(userId, guildId) < amount) {
                    return interaction.reply({ content: '❌ Bạn không có đủ tiền trong ví để cược số tiền này!', ephemeral: true });
                }

                // 2. Trừ tiền cược ngay lập tức để tránh bug spam
                addBalance(userId, -amount, guildId);

                // 3. Xóa nút bấm của menu cược và bắt đầu hiệu ứng quay
                const spinningEmbed = new EmbedBuilder()
                    .setColor('#e67e22')
                    .setTitle('🎰 MÁY ĐANG QUAY... 🎰')
                    .setDescription(`Tiền cược: **${amount.toLocaleString()} VNĐ💸**\n\n**[ 🔄 | 🔄 | 🔄 ]**\n\n*Đang chờ kết quả...*`);

                await interaction.update({ embeds: [spinningEmbed], components: [] });

                // 4. Đợi 2 giây để tạo cảm giác hồi hộp rồi tính kết quả
                setTimeout(async () => {
                    // Danh sách 10 loại trái cây
                    const fruits = ['🍎', '🍊', '🍇', '🍉', '🍓', '🍒', '🍍', '🥝', '🍌', '🍑'];
                    
                    // Random ra 3 kết quả
                    // Mẹo nhỏ: Để game không quá khó nhằn, tôi đã chỉnh tỉ lệ xíu. Nếu bạn muốn random ngẫu nhiên 100%, hãy dùng fruits[Math.floor(Math.random() * fruits.length)] cho cả 3.
                    const slot1 = fruits[Math.floor(Math.random() * fruits.length)];
                    const slot2 = fruits[Math.floor(Math.random() * fruits.length)];
                    
                    // Giúp dễ trúng hơn 1 chút: Có 15% cơ hội ô thứ 3 sẽ trùng luôn với ô 1 và 2 nếu ô 1 và 2 đã trùng nhau.
                    let slot3;
                    if (slot1 === slot2 && Math.random() < 0.15) {
                        slot3 = slot1;
                    } else {
                        slot3 = fruits[Math.floor(Math.random() * fruits.length)];
                    }

                    const isWin = (slot1 === slot2 && slot2 === slot3);
                    let resultText = '';

                    // 5. Cộng thưởng (nếu trúng)
                    if (isWin) {
                        const winAmount = amount * 2;
                        addBalance(userId, winAmount, guildId); // Cộng lại tiền x2
                        resultText = `🎉 **JACKPOT! ĐỘC ĐẮC!** 🎉\nBạn đã nhận được **${winAmount.toLocaleString()} VNĐ💸** (Tiền thưởng x2)!`;
                    } else {
                        resultText = `💥 **TRƯỢT RỒI!** 💥\nBạn đã mất **${amount.toLocaleString()} VNĐ💸**. Chúc may mắn lần sau!`;
                    }

                    // 6. Chỉnh sửa tin nhắn thành kết quả cuối cùng
                    const resultEmbed = new EmbedBuilder()
                        .setColor(isWin ? '#2ecc71' : '#e74c3c')
                        .setTitle('🎰 KẾT QUẢ SLOT MACHINE 🎰')
                        .setDescription(`Tiền cược: **${amount.toLocaleString()} VNĐ💸**\n\n**[ ${slot1} | ${slot2} | ${slot3} ]**\n\n${resultText}`);

                    await interaction.message.edit({ embeds: [resultEmbed] });
                }, 2000); // 2000ms = 2 giây
                return;
            }
            
            // Xử Lý Mua Role Trong Shop
            if (id === 'modal_rolebuy') {
                const code = interaction.fields.getTextInputValue('buy_code_input');
                const guildId = interaction.guildId;
                const serverShop = db.shop[guildId] || {};
                const item = serverShop[code];

                if (!item) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Giao dịch thất bại: Mã số không tồn tại trong cửa hàng của server này!', ephemeral: true });
                const price = item.price;
                
                if (getBalance(userId, guildId) < price) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Giao dịch thất bại: Số dư trong tài khoản bạn không đủ.', ephemeral: true });
                
                const role = interaction.guild.roles.cache.get(item.roleId);
                if (!role) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Giao dịch thất bại: Role này không còn tồn tại trên server, vui lòng báo Admin!', ephemeral: true });

                const member = await interaction.guild.members.fetch(userId).catch(() => interaction.member);
                if (member.roles.cache.has(role.id)) {
                    return interaction.reply({ 
                        content: `<a:emoji_75:1524039622668189806>  Giao dịch hoàn tất: Bạn đã có sẵn role <@&${role.id}> rồi nên bot không cấp lại và không trừ tiền.`, 
                        ephemeral: true 
                    });
                }

                try {
                    await member.roles.add(role);
                    addBalance(userId, -price, guildId);
                    return interaction.reply({ 
                        content: `<a:emoji_75:1524039622668189806>  Giao dịch thành công! Bạn đã mua thành công role <@&${role.id}> với giá **${price.toLocaleString()} VNĐ💸**.`, 
                        ephemeral: true 
                    });
                } catch (err) {
                    console.error('Lỗi khi cấp role:', err);
                    return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Giao dịch thất bại: Bot không có đủ quyền ưu tiên để cấp role này. Vui lòng liên hệ Admin!', ephemeral: true });
                }
            }

            // MODAL TÀI XỈU
            if (id.startsWith('modal_tx_bet_')) {                          
                if (!activeGames.taixiu || activeGames.taixiu.status !== 'betting') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Đã hết giờ!', ephemeral: true });
                const hasBetted = activeGames.taixiu.bets.some(b => b.userId === userId);
                if (hasBetted) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Bạn đã đặt cược trong ván này rồi, mỗi ván chỉ được chọn 1 cửa!', ephemeral: true });

                const choice = id.replace('modal_tx_bet_', '');
                const amount = parseInt(interaction.fields.getTextInputValue('tx_amount_input'));                                                                           
                if (isNaN(amount) || amount < 10) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Tối thiểu 10 VNĐ!', ephemeral: true });
                if (getBalance(userId, guildId) < amount) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Số dư tài khoản không đủ!', ephemeral: true });
                
                const choiceMap = { tai: 'Tài', xiu: 'Xỉu', chan: 'Chẵn', le: 'Lẻ' };                                                 
                const choiceName = choiceMap[choice];
                // ESCROW: trừ tiền cược ngay lúc đặt, không chờ đến lúc tổng kết ván
                // (chặn kiểu khai thác: đặt cược -> chuyển/rút tiền qua acc khác trong lúc chờ -> thua thì
                // addBalance bị kẹp sàn ở 0 nên coi như thua miễn phí, thắng vẫn được cộng thưởng bình thường)
                addBalance(userId, -amount, guildId);
                activeGames.taixiu.bets.push({ userId, choice, amount, choiceName });                                                 
                
                const listStr = activeGames.taixiu.bets.map(b => `• <@${b.userId}> đặt cửa **${b.choiceName}**: **[ ${b.amount}💸 ]**`).join('\n');
                const updateEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🎲 SÒNG BẠC TÀI XỈU 🎲').setDescription(`Vui lòng click các nút bên dưới để chọn cửa và đặt cược!\n\n**Danh sách đặt cược:**\n${listStr}`);
                
                await interaction.reply({ content: `<a:emoji_75:1524039622668189806>  Đặt cược thành công **${amount}💸** vào cửa **${choiceName}**!`, ephemeral: true });
                return activeGames.taixiu.mainMessage.edit({ embeds: [updateEmbed] }).catch(()=>{});
            }

            // MODAL BẦU CUA
            if (id.startsWith('modal_bc_bet_')) {
                if (!activeGames.baucua || activeGames.baucua.status !== 'betting') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Đã hết giờ!', ephemeral: true });
                const choice = id.replace('modal_bc_bet_', '');
                const amount = parseInt(interaction.fields.getTextInputValue('bc_amount_input'));
                
                if (isNaN(amount) || amount < 10) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Tối thiểu 10 VNĐ!', ephemeral: true });
                if (getBalance(userId, guildId) < amount) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Số dư tài khoản không đủ!', ephemeral: true });
                
                // ESCROW: trừ tiền cược ngay lúc đặt, không chờ đến lúc tổng kết ván (cùng lỗi/cùng cách vá như Tài Xỉu)
                addBalance(userId, -amount, guildId);
                activeGames.baucua.bets.push({ userId, choice, amount });
                const listStr = activeGames.baucua.bets.map(b => `• <@${b.userId}> đặt cửa **${b.choice}**: **[ ${b.amount}💸 ]**`).join('\n');
                const updateEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🎲 SÒNG BẦU CUA TÔM CÁ 🎲').setDescription(`Vui lòng click nút **Đặt Cược** để chọn linh vật và nhập số tiền cược!\n\n**Danh sách đặt cược:**\n${listStr}`);
                
                await interaction.reply({ content: `<a:emoji_75:1524039622668189806>  Đặt cược thành công **${amount}💸** vào **${choice}**!`, ephemeral: true });
                return activeGames.baucua.mainMessage.edit({ embeds: [updateEmbed] }).catch(()=>{});
            }
            // MODAL XÌ DÁCH
            if (id === 'modal_pvp_bet') {
                const game = activeGames.xidach;
                if (!game || game.status !== 'waiting') return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Đã đóng cửa sòng!', ephemeral: true });
                
                const bet = parseInt(interaction.fields.getTextInputValue('pvp_bet_input'));
                if (isNaN(bet) || bet < 10) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Tối thiểu 10 VNĐ!', ephemeral: true });
                if (getBalance(userId, guildId) < bet) return interaction.reply({ content: '<a:emoji_76:1524195723996823612> Tài khoản không đủ!', ephemeral: true });
                
                // ESCROW: trừ tiền cược ngay lúc đặt, không chờ đến lúc tổng kết ván
                addBalance(userId, -bet, guildId);
                game.players.push({ id: userId, bet: bet, cards: [], status: 'playing' });
                const listStr = game.players.map(p => `• <@${p.id}> đặt cược: **[ ${p.bet}💸 ]**`).join('\n');
                const updateEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🃏 SÒNG XÌ DÁCH TRUYỀN THỐNG (PVP) 🃏').setDescription(`👑 Nhà Cái: <@${game.dealerId}>\n\nBấm nút **Tham Gia** bên dưới để đặt cược.\n\n**Bàn cược:**\n${listStr}`);
                
                await interaction.reply({ content: `<a:emoji_75:1524039622668189806>  Vô cược **${bet}💸** thành công!`, ephemeral: true });
                return game.mainMessage.edit({ embeds: [updateEmbed] }).catch(()=>{});
            }
        }
    } catch (error) {
        console.error('Lỗi khi xử lý tương tác:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '<a:emoji_76:1524195723996823612> Đã xảy ra lỗi hệ thống khi xử lý tương tác này.', ephemeral: true }).catch(() => {});
        }
    }
});

// ==========================================
// CÁC HÀM PHỤ TRỢ (HELPER FUNCTIONS)
// ==========================================
function createCaroComponents(board, channelId, disableAll = false) {
    const rows = [];
    for (let i = 0; i < 3; i++) { 
        const row = new ActionRowBuilder();
        for (let j = 0; j < 3; j++) { 
            const index = i * 3 + j;
            const cell = board[index];
            let style = ButtonStyle.Secondary;
            
            if (cell === '❌') style = ButtonStyle.Primary;
            else if (cell === '⭕') style = ButtonStyle.Danger;
            
            row.addComponents(new ButtonBuilder().setCustomId(`caro_${channelId}_${index}`).setLabel(cell).setStyle(style).setDisabled(disableAll || cell !== '⬜'));
        }
        rows.push(row);
    }
    return rows;
}

function checkWin(board, symbol) {
    const size = 3; 
    const winTarget = 3;
    const checkLine = (x, y, dx, dy) => {
        let count = 0;
        for (let i = 0; i < winTarget; i++) {
            const nx = x + i * dx;
            const ny = y + i * dy;
            if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[ny * size + nx] === symbol) count++;
            else break;
        }
        return count === winTarget;
    };
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (checkLine(x, y, 1, 0) || checkLine(x, y, 0, 1) || checkLine(x, y, 1, 1) || checkLine(x, y, 1, -1)) return true;
        }
    }
    return false;
}

async function updateMainUI() {
    const game = activeGames.xidach;
    if (!game || game.status !== 'players_turn') return;
    const listStatus = game.players.map(p => p.status === 'playing' ? `• <@${p.id}>: *Đang suy nghĩ...*` : `• <@${p.id}>: **Đã hoàn thành lượt** (Bài ẩn)`).join('\n');
    const playEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🃏 XÌ DÁCH PVP: LƯỢT NHÀ CON RÚT BÀI 🃏').setDescription(`👑 Nhà Cái: <@${game.dealerId}> [ Đang giấu bài ]\n\n**Bàn cược:**\n${listStatus}`);
    await game.mainMessage.edit({ embeds: [playEmbed] }).catch(()=>{});
}

async function checkAutoSwitchToDealer() {
    const game = activeGames.xidach;
    if (!game) return;
    if (!game.players.some(p => p.status === 'playing')) await startDealerTurn();
}

async function startDealerTurn() {
    const game = activeGames.xidach;
    if (!game || game.status !== 'players_turn') return;
    
    game.status = 'dealer_turn';
    const dInfo = calculatePoints(game.dealerCards);
    if (dInfo.special === 'Xì Dách' || dInfo.special === 'Xì Bàng') return finishPvpGame();
    
    const dEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🃏 XÌ DÁCH PVP: LƯỢT NHÀ CÁI 🃏').setDescription(`👑 Đến lượt Nhà Cái <@${game.dealerId}> kiểm soát sòng!\n\nHãy chọn Rút bài hoặc Dừng.`);
    const dRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dealer_hit').setLabel('🃏 Rút Bài').setStyle(ButtonStyle.Primary), 
        new ButtonBuilder().setCustomId('dealer_stand').setLabel('🔒 Dừng Bài (So điểm)').setStyle(ButtonStyle.Danger)
    );
    await game.mainMessage.edit({ embeds: [dEmbed], components: [dRow] }).catch(()=>{});
}

async function finishPvpGame() {
    const game = activeGames.xidach;
    if (!game || game.status === 'finished') return;
    const guildId = game.guildId; // Lấy từ game object (biến guildId ngoài scope trước đây sẽ gây lỗi ReferenceError)
    
    game.status = 'finished';
    // Hoàn lại toàn bộ tiền bảo hiểm đã escrow của Nhà Cái, sau đó cộng/trừ net như logic gốc bên dưới
    addBalance(game.dealerId, game.escrowedDealerTotal || 0, guildId);
    const dInfo = calculatePoints(game.dealerCards);
    let finalLog = `👑 **NHÀ CÁI <@${game.dealerId}> LẬT BÀI:**\n${formatCards(game.dealerCards)} (Tổng: **${dInfo.points}**đ — *${dInfo.special}*)\n\n🏁 **KẾT QUẢ TOÀN BÀN:**\n`;
    
    game.players.forEach(p => {
        const pInfo = calculatePoints(p.cards); 
        let win = false; 
        let tie = false; 
        let reason = '';
        
        if (p.status === 'quac') { win = false; reason = 'Nhà Con Quắc'; }
        else if (dInfo.points > 21) { win = true; reason = 'Nhà Cái Quắc'; }
        else {
            const pPower = { 'Xì Bàng': 4, 'Xì Dách': 3, 'Ngũ Linh': 2, 'Thường': 1 }[pInfo.special];
            const dPower = { 'Xì Bàng': 4, 'Xì Dách': 3, 'Ngũ Linh': 2, 'Thường': 1 }[dInfo.special];
            
            if (pPower > dPower) { win = true; reason = `Thắng bằng ${pInfo.special}`; }
            else if (pPower < dPower) { win = false; reason = `Thua do Cái có ${dInfo.special}`; }
            else {
                if (pInfo.points > dInfo.points) { win = true; reason = 'Điểm cao hơn'; }
                else if (pInfo.points < dInfo.points) { win = false; reason = 'Điểm thấp hơn'; }
                else { tie = true; reason = 'Hòa điểm'; }
            }
        }

        if (tie) {
            // Hòa: hoàn lại đúng số tiền cược đã escrow, không lãi không lỗ
            addBalance(p.id, p.bet, guildId);
            finalLog += `• <@${p.id}>: **HÒA VỐN** 🤝 | Bài: ${formatCards(p.cards)} (${reason})\n`;
        } else if (win) { 
            // Thắng: hoàn lại cược đã escrow + tiền thắng (net vẫn là +bet như logic gốc)
            addBalance(p.id, p.bet * 2, guildId);
            addBalance(game.dealerId, -p.bet, guildId); 
            finalLog += `• <@${p.id}>: **THẮNG** 🎉 **+${p.bet}💸** | Bài: ${formatCards(p.cards)} (${reason})\n`;
        } else { 
            // Thua: KHÔNG hoàn gì (tiền đã bị trừ/escrow từ lúc đặt cược) -> chặn đường thua "miễn phí"
            addBalance(game.dealerId, p.bet, guildId);
            finalLog += `• <@${p.id}>: **THUA** 💸 **-${p.bet}💸** | Bài: ${formatCards(p.cards)} (${reason})\n`; 
        }
    });
    
    const endEmbed = new EmbedBuilder().setColor('#2f3136').setTitle('🏆 TỔNG KẾT VÁN XÌ DÁCH 🏆').setDescription(finalLog).setTimestamp();
    await game.mainMessage.edit({ embeds: [endEmbed], components: [] }).catch(()=>{});
    activeGames.xidach = null;
}

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = [
        { name: '2', val: 2 }, { name: '3', val: 3 }, { name: '4', val: 4 }, 
        { name: '5', val: 5 }, { name: '6', val: 6 }, { name: '7', val: 7 }, 
        { name: '8', val: 8 }, { name: '9', val: 9 }, { name: '10', val: 10 }, 
        { name: 'J', val: 10 }, { name: 'Q', val: 10 }, { name: 'K', val: 10 }, 
        { name: 'A', val: 11 }
    ];
    let deck = []; 
    for (let s of suits) {
        for (let r of ranks) {
            deck.push({ name: `${r.name}${s}`, rankName: r.name, value: r.val });
        }
    }
    
    for (let i = deck.length - 1; i > 0; i--) { 
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; 
    }
    return deck;
}

function calculatePoints(cards) {
    let total = 0;
    let aces = 0;
    cards.forEach(c => { 
        total += c.value; 
        if (c.rankName === 'A') aces++; 
    });
    
    if (cards.length === 2 && aces === 2) return { points: 21, special: 'Xì Bàng' };
    if (cards.length === 2 && total === 21) return { points: 21, special: 'Xì Dách' };
    
    while (total > 21 && aces > 0) { 
        total -= 10;
        aces--; 
    }
    
    if (cards.length === 5 && total <= 21) return { points: total, special: 'Ngũ Linh' };
    return { points: total, special: 'Thường' };
}

function formatCards(cards) { 
    return cards.map(c => `\`[ ${c.name} ]\``).join(' ');
}

function sendPvpPrivateMenu(interaction, player, isUpdate = false) {
    const info = calculatePoints(player.cards);
    if (info.special === 'Xì Dách' || info.special === 'Xì Bàng') {
        player.status = 'stand';
        const txt = `✨ Bài đặc biệt: **${info.special}**! Bài: ${formatCards(player.cards)}`;
        return isUpdate ? interaction.update({ content: txt, components: [] }) : interaction.reply({ content: txt, ephemeral: true });
    }
    
    const data = {
        content: `🃏 **Bài của bạn:** ${formatCards(player.cards)}\n🧮 Điểm: **${info.points}**`,                             
        components: [new ActionRowBuilder().addComponents(             
            new ButtonBuilder().setCustomId('pvp_hit').setLabel('🃏 Rút Thêm Lá').setStyle(ButtonStyle.Primary).setDisabled(player.cards.length >= 5),    
            new ButtonBuilder().setCustomId('pvp_stand').setLabel('🔒 Dừng Bài').setStyle(ButtonStyle.Danger)                 
        )], 
        ephemeral: true                          
    };
    
    return isUpdate ? interaction.update(data) : interaction.reply(data);
}

// ==========================================
// ENGINE TRÒ CHƠI XẾP GẠCH (TETRIS CORE)
// ==========================================
const TETROMINOES = {
    I: { shape: [[1,1,1,1]], color: '🟦' },
    J: { shape: [[1,0,0],[1,1,1]], color: '🟫' },
    L: { shape: [[0,0,1],[1,1,1]], color: '🟧' },
    O: { shape: [[1,1],[1,1]], color: '🟨' },
    S: { shape: [[0,1,1],[1,1,0]], color: '🟩' },
    T: { shape: [[0,1,0],[1,1,1]], color: '🟪' },
    Z: { shape: [[1,1,0],[0,1,1]], color: '🟥' }
};

class TetrisGame {
    constructor(userId, message) {
        this.userId = userId;
        this.message = message;
        this.guildId = message.guild?.id || 'global';
        this.width = 10;
        this.height = 15;
        this.board = Array(this.height).fill().map(() => Array(this.width).fill('⬛'));
        
        this.score = 0;
        this.linesCleared = 0;
        this.level = 1;
        this.combo = 1;
        this.isGameOver = false;
        
        this.currentPiece = null;
        this.nextPiece = this.getRandomPiece();
        this.tickTimer = null;
    }

    getRandomPiece() {
        let pool = ['I', 'O', 'T', 'J', 'L', 'S', 'Z'];
        if (this.level < 3) pool.push('I', 'O', 'I'); 
        if (this.level >= 5) pool.push('S', 'Z', 'S', 'Z');

        const randKey = pool[Math.floor(Math.random() * pool.length)];
        return { 
            shape: TETROMINOES[randKey].shape, 
            color: TETROMINOES[randKey].color,
            x: 3, y: 0 
        };
    }

    start() {
        this.spawnPiece();
        this.render();
        this.resetTick();
    }

    spawnPiece() {
        this.currentPiece = this.nextPiece;
        this.nextPiece = this.getRandomPiece();
        if (this.checkCollision(this.currentPiece.x, this.currentPiece.y, this.currentPiece.shape)) {
            this.gameOver();
        }
    }

    getSpeed() {
        if (this.level === 1) return 1200;
        if (this.level === 2) return 1000;
        if (this.level === 3) return 800;
        if (this.level === 4) return 700;
        if (this.level === 5) return 600;
        if (this.level >= 10) return 300;
        return 600 - ((this.level - 5) * 50);
    }

    resetTick() {
        if (this.tickTimer) clearTimeout(this.tickTimer);
        if (this.isGameOver) return;
        this.tickTimer = setTimeout(() => {
            this.tick();
        }, this.getSpeed());
    }

    tick() {
        if (this.isGameOver) return;
        if (!this.move(0, 1)) {
            this.lockPiece();
        }
        this.render();
        this.resetTick();
    }

    move(dx, dy) {
        if (this.checkCollision(this.currentPiece.x + dx, this.currentPiece.y + dy, this.currentPiece.shape)) {
            return false;
        }
        this.currentPiece.x += dx;
        this.currentPiece.y += dy;
        return true;
    }

    hardDrop() {
        while (this.move(0, 1)) {} 
        this.lockPiece();
    }

    rotate() {
        const shape = this.currentPiece.shape;
        const newShape = shape[0].map((val, index) => shape.map(row => row[index]).reverse());
        if (!this.checkCollision(this.currentPiece.x, this.currentPiece.y, newShape)) {
            this.currentPiece.shape = newShape;
        }
    }

    checkCollision(x, y, shape) {
        for (let row = 0; row < shape.length; row++) {
            for (let col = 0; col < shape[row].length; col++) {
                if (shape[row][col]) {
                    let newX = x + col;
                    let newY = y + row;
                    if (newX < 0 || newX >= this.width || newY >= this.height || (newY >= 0 && this.board[newY][newX] !== '⬛')) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    
    lockPiece() {
        for (let row = 0; row < this.currentPiece.shape.length; row++) {
            for (let col = 0; col < this.currentPiece.shape[row].length; col++) {
                if (this.currentPiece.shape[row][col]) {
                    if (this.currentPiece.y + row >= 0) {
                        this.board[this.currentPiece.y + row][this.currentPiece.x + col] = this.currentPiece.color;
                    }
                }
            }
        }
        this.clearLines();
        this.spawnPiece();
    }

    clearLines() {
        let linesClearedNow = 0;
        for (let row = this.height - 1; row >= 0; row--) {
            if (this.board[row].every(cell => cell !== '⬛')) {
                this.board.splice(row, 1);
                this.board.unshift(Array(this.width).fill('⬛'));
                linesClearedNow++;
                row++; 
            }
        }

        if (linesClearedNow > 0) {
            this.linesCleared += linesClearedNow;
            this.combo++;
            const points = linesClearedNow * 100 * this.level * this.combo;
            this.score += points;
            this.checkLevelUp();
        } else {
            this.combo = 1;
        }
    }

    checkLevelUp() {
        if (this.score >= 1500) this.level = Math.max(this.level, 5);
        else if (this.score >= 700) this.level = Math.max(this.level, 4);
        else if (this.score >= 300) this.level = Math.max(this.level, 3);
        else if (this.score >= 100) this.level = Math.max(this.level, 2);

        const lineLevel = Math.floor(this.linesCleared / 10) + 1;
        if (lineLevel > this.level) this.level = lineLevel;
    }

    async render(interaction = null) {
        if (this.isGameOver) return;
        const renderBoard = this.board.map(row => [...row]);
        if (this.currentPiece) {
            for (let row = 0; row < this.currentPiece.shape.length; row++) {
                for (let col = 0; col < this.currentPiece.shape[row].length; col++) {
                    if (this.currentPiece.shape[row][col] && this.currentPiece.y + row >= 0) {
                        renderBoard[this.currentPiece.y + row][this.currentPiece.x + col] = this.currentPiece.color;
                    }
                }
            }
        }

        let boardStr = renderBoard.map(row => row.join('')).join('\n');
        let nextPieceStr = this.nextPiece.shape.map(row => 
            row.map(cell => cell ? this.nextPiece.color : '⬛').join('')
        ).join('\n');
        
        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle(`🎮 Xếp Gạch - Level: ${this.level}`)
            .setDescription(`Điểm: **${this.score}** | Combo: **x${this.combo}**\n\n${boardStr}\n\n**Block kế tiếp:**\n${nextPieceStr}`);
            
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tetris_left').setLabel('◀').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tetris_right').setLabel('▶').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tetris_rotate').setLabel('🔄').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tetris_down').setLabel('⏬ Rơi').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('tetris_stop').setLabel('⏹').setStyle(ButtonStyle.Secondary)
        );
        
        try {
            if (interaction) {
                await interaction.update({ embeds: [embed], components: [row] }).catch(()=>{});
            } else {
                await this.message.edit({ embeds: [embed], components: [row] }).catch(()=>{});
            }
        } catch (e) {}
    }

    async gameOver(interaction = null) {
        this.isGameOver = true;
        if (this.tickTimer) clearTimeout(this.tickTimer);
        activeGames.xepgach.delete(this.userId);

        const moneyEarned = Math.floor(this.score / 10);
        if (moneyEarned > 0) {
            addBalance(this.userId, moneyEarned, this.guildId);
        }

        const embed = new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle('💀 GAME OVER 💀')
            .setDescription(`Người chơi: <@${this.userId}>\n📊 Cấp độ đạt được: **Level ${this.level}**\n⭐ Tổng điểm: **${this.score}**\n\n💸 Tiền thưởng nhận được: **+${moneyEarned.toLocaleString()} VNĐ💸**`)
            .setTimestamp();
            
        try {
            if (interaction) {
                await interaction.update({ embeds: [embed], components: [] }).catch(()=>{});
            } else {
                await this.message.edit({ embeds: [embed], components: [] }).catch(()=>{});
            }
        } catch (e) {}
    }
}
// ==========================================
// ENGINE TRÒ CHƠI MA SÓI (CÓ KỸ NĂNG ĐÊM)
// ==========================================
async function startGame(guildId, game) {
    game.status = 'playing';
    game.day = 0;
    const roles = getRoleConfig(game.players.length);
    shuffleArray(roles);

    for (let i = 0; i < game.players.length; i++) {
        let hp = roles[i] === 'Già làng' ? 2 : 1;
        game.playerRoles[game.players[i]] = { role: roles[i], alive: true, hp: hp };
    }

    await game.channel.send(`🐺 **Trò chơi bắt đầu với ${game.players.length} người!**\nHệ thống sẽ tự động chuyển sang Ban Đêm ngay bây giờ...`);
    setTimeout(() => startNight(guildId, game), 3000); 
}

const MASOI_TIMERS = {
    PRE_NIGHT: 3000,
    NIGHT: 40000,
    DISCUSS: 30000,
    VOTE: 30000,
    NEXT_NIGHT: 30000
};

async function startNight(guildId, game) {
    game.status = 'night';
    game.nightActions = { wolfVotes: {}, guardTarget: null, seerTarget: null, poisonTarget: null, saveTarget: null, cupidTargets: [] };
    game.nightActionUsedUsers = new Set();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`masoi_panel_${guildId}`)
            .setLabel('🌙 Xem Vai Trò & Dùng Kỹ Năng')
            .setStyle(ButtonStyle.Primary)
    );

    await game.channel.send({ 
        content: '🌙 **TRỜI ĐÃ TỐI... MỌI NGƯỜI ĐI NGỦ.**\nTất cả người chơi hãy nhấn vào nút bên dưới để xem vai trò và hành động (Tin nhắn sẽ được ẩn với người khác).\n⏳ Các bạn có **40 giây**!', 
        components: [row] 
    });

    setTimeout(() => processNight(guildId, game), MASOI_TIMERS.NIGHT);
}

function processNight(guildId, game) {
    let highestVote = 0;
    let killedByWolf = null;
    let deadThisNight = new Set();

    for (const [target, count] of Object.entries(game.nightActions.wolfVotes)) {
        if (count > highestVote) {
            highestVote = count;
            killedByWolf = String(target);
        }
    }

    // ĐIỀU KIỆN CHẾT DO SÓI: Bị sói cắn VÀ Không được Bảo vệ VÀ Không được Phù Thủy cứu
    if (killedByWolf) {
        const isProtected = String(game.nightActions.guardTarget) === killedByWolf;
        const isSaved = String(game.nightActions.saveTarget) === killedByWolf;

        if (!isProtected && !isSaved) {
            if (game.playerRoles[killedByWolf].role === 'Già làng') {
                game.playerRoles[killedByWolf].hp -= 1;
                if (game.playerRoles[killedByWolf].hp <= 0) deadThisNight.add(killedByWolf);
            } else {
                deadThisNight.add(killedByWolf);
            }
        }
    }

    // ĐIỀU KIỆN CHẾT DO BÌNH ĐỘC
    const pt = game.nightActions.poisonTarget;
    if (pt && pt !== 'skip_poison' && game.playerRoles[pt] && game.playerRoles[pt].alive) {
        deadThisNight.add(pt);
    }

    if (game.nightActions.cupidTargets.length === 2) {
        const [t1, t2] = game.nightActions.cupidTargets;
        if (deadThisNight.has(t1) && !deadThisNight.has(t2)) deadThisNight.add(t2);
        else if (deadThisNight.has(t2) && !deadThisNight.has(t1)) deadThisNight.add(t1);
    }

    for (let id of deadThisNight) {
        game.playerRoles[id].alive = false;
    }

    const thosanArray = Array.from(deadThisNight);
    for (const deadId of thosanArray) {
        if (game.playerRoles[deadId].role === 'Thợ săn') {
            const aliveOthers = game.players.filter(id => game.playerRoles[id].alive);
            if (aliveOthers.length > 0) {
                const randomTarget = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
                game.playerRoles[randomTarget].alive = false;
                deadThisNight.add(randomTarget);
                game.channel.send(`🔫 **Bằng!!!** Thợ săn <@${deadId}> trước khi chết đã nổ súng kéo theo <@${randomTarget}>!`);
            }
        }
    }

    startMorning(guildId, game, Array.from(deadThisNight));
}

async function startMorning(guildId, game, deadPlayers) {
    game.status = 'morning';
    game.day = (game.day || 0) + 1;
    let desc = 'Mặt trời đã lên. Mọi người thức dậy.';
    if (deadPlayers.length > 0) {
        desc += `\nĐêm qua, có **${deadPlayers.length} người** đã mất mạng: ` + deadPlayers.map(id => `<@${id}>`).join(', ');
    } else {
        desc += `\nMột đêm vô cùng bình yên, không có ai chết!`;
    }

    const morningEmbed = new EmbedBuilder()
        .setTitle('🌅 TRỜI SÁNG 🌅')
        .setDescription(`${desc}\n\nCác bạn có **30 giây** để thảo luận tìm ra Ma Sói trước khi bỏ phiếu treo cổ.`)
        .setColor('#f1c40f');
    await game.channel.send({ embeds: [morningEmbed] });

    if (!checkWinCondition(guildId, game)) {
        setTimeout(() => startVote(guildId, game), MASOI_TIMERS.DISCUSS);
    }
}

async function startVote(guildId, game) {
    game.status = 'voting';
    const alivePlayers = game.players.filter(id => game.playerRoles[id].alive);
    const options = alivePlayers.map(id => {
        const u = client.users.cache.get(id);
        return { label: u ? u.username : `Người chơi`, value: id };
    });
    options.push({ label: 'Bỏ qua (Skip)', value: 'skip' });

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('vote_menu').setPlaceholder('Chọn người để treo cổ...').addOptions(options)
    );
    const voteMsg = await game.channel.send({ 
        content: '⚖️ **THỜI GIAN BỎ PHIẾU (30 giây):** Hãy chọn người bạn nghi ngờ nhất!', 
        components: [row] 
    });

    const votes = {}; 
    const votedUsers = new Set();
    const collector = voteMsg.createMessageComponentCollector({ time: MASOI_TIMERS.VOTE });

    collector.on('collect', async i => {
        if (i.replied || i.deferred) return;
        if (!game.playerRoles[i.user.id]?.alive) return i.reply({ content: 'Người chết không được vote!', ephemeral: true });
        if (votedUsers.has(i.user.id)) return i.reply({ content: 'Bạn đã bỏ phiếu rồi!', ephemeral: true });

        const target = i.values[0];
        votedUsers.add(i.user.id);
        votes[target] = (votes[target] || 0) + 1;
        await i.reply({ content: `Bạn đã khóa phiếu bầu của mình!`, ephemeral: true });
    });

    collector.on('end', () => processVoteResult(guildId, game, votes, voteMsg));
}


async function processVoteResult(guildId, game, votes, voteMsg = null) {
    try {
        if (voteMsg) {
            await voteMsg.edit({ components: [] }).catch(() => {});
        }
    } catch (e) {}

    let highestVoteCount = 0;
    let hangedUser = null;
    let tie = false;

    for (const [target, count] of Object.entries(votes)) {
        if (count > highestVoteCount) {
            highestVoteCount = count;
            hangedUser = target;
            tie = false;
        } else if (count === highestVoteCount) {
            tie = true;
        }
    }

    const resultLines = [];
    const voteEntries = Object.entries(votes).sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return String(a[0]).localeCompare(String(b[0]));
    });

    if (voteEntries.length === 0) {
        resultLines.push('• Chưa có phiếu hợp lệ nào được ghi nhận.');
    } else {
        for (const [target, count] of voteEntries) {
            if (target === 'skip') {
                resultLines.push(`• Bỏ phiếu trống: **${count} phiếu**`);
            } else {
                resultLines.push(`• <@${target}>: **${count} phiếu**`);
            }
        }
    }

    const revealLines = [];

    if (tie || hangedUser === 'skip' || hangedUser === null) {
        revealLines.push('⚖️ Không ai bị treo cổ hôm nay do hòa phiếu hoặc đa số chọn Skip!');
    } else if (game.playerRoles[hangedUser]) {
        game.playerRoles[hangedUser].alive = false;
        revealLines.push(`⚖️ <@${hangedUser}> đã bị treo cổ!`);
        revealLines.push(`🎭 Vai trò công khai: **${game.playerRoles[hangedUser].role.toUpperCase()}**`);

        if (game.playerRoles[hangedUser].role === 'Thợ săn') {
            const aliveOthers = game.players.filter(id => game.playerRoles[id].alive);
            if (aliveOthers.length > 0) {
                const randomTarget = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
                game.playerRoles[randomTarget].alive = false;

                revealLines.push(`🔫 **Thợ săn** <@${hangedUser}> đã kéo theo <@${randomTarget}>!`);
                revealLines.push(`🎭 Vai trò công khai của <@${randomTarget}>: **${game.playerRoles[randomTarget].role.toUpperCase()}**`);
            }
        }
    }

    const resultEmbed = new EmbedBuilder()
        .setTitle('📊 KẾT QUẢ BỎ PHIẾU')
        .setColor('#e74c3c')
        .setDescription(
            `**Kết quả bỏ phiếu:**\n${resultLines.join('\n')}\n\n` +
            `**Diễn biến sau bỏ phiếu:**\n${revealLines.join('\n')}`
        )
        .setTimestamp();

    await game.channel.send({ embeds: [resultEmbed] }).catch(() => {});

    if (!checkWinCondition(guildId, game)) {
        const statusEmbed = buildMasoiStatusEmbed(game);
        await game.channel.send({ embeds: [statusEmbed] }).catch(() => {});
        setTimeout(() => startNight(guildId, game), MASOI_TIMERS.NEXT_NIGHT);
    }
}

function buildMasoiStatusEmbed(game) {
    const alivePlayers = game.players.filter(id => game.playerRoles[id]?.alive);
    const deadPlayers = game.players.filter(id => game.playerRoles[id] && !game.playerRoles[id].alive);

    const aliveText = alivePlayers.length > 0
        ? alivePlayers.map(id => `<@${id}>`).join(', ')
        : 'Không có ai';
    const deadText = deadPlayers.length > 0
        ? deadPlayers.map(id => `<@${id}>`).join(', ')
        : 'Không có ai';

    return new EmbedBuilder()
        .setTitle('📊 Trạng thái game')
        .setColor('#9b59b6')
        .addFields(
            { name: 'Ngày', value: String(game.day || 1), inline: false },
            { name: 'Người sống', value: String(alivePlayers.length), inline: false },
            { name: 'Người chết', value: String(deadPlayers.length), inline: false },
            { name: 'Còn sống', value: aliveText, inline: false },
            { name: 'Đã chết', value: deadText, inline: false }
        )
        .setTimestamp();
}
function checkWinCondition(guildId, game) {
    let wolves = 0, villagers = 0;
    let winningTeam = null;

    // Đếm số lượng Sói và Dân Làng còn sống
    for (const data of Object.values(game.playerRoles)) {
        if (data.alive) {
            if (data.role === 'Sói') wolves++;
            else villagers++;
        }
    }

    // Kiểm tra điều kiện thắng
    if (wolves === 0) winningTeam = 'Dân Làng';
    else if (wolves >= villagers) winningTeam = 'Ma Sói';

    // Xử lý khi có phe chiến thắng
    if (winningTeam) {
        let roleRevealText = "\n\n**🎭 CÔNG BỐ VAI TRÒ NGƯỜI CHƠI 🎭**\n";
        // Lấy tất cả danh sách để hiển thị, bao gồm cả Sói
        for (const [id, data] of Object.entries(game.playerRoles)) {
            const statusIcon = data.alive ? "🟢 Sống" : "💀 Đã chết";
            roleRevealText += `• <@${id}>: **${data.role.toUpperCase()}** (${statusIcon})\n`;
        }

        const winEmbed = new EmbedBuilder()
            .setTitle('🏆 TRÒ CHƠI KẾT THÚC 🏆')
            .setDescription(`Phe chiến thắng: **${winningTeam}**\n\nMỗi người sống sót thuộc phe thắng nhận được **100,000 VNĐ** 💸!${roleRevealText}`)
            .setColor(winningTeam === 'Dân Làng' ? '#3498db' : '#e74c3c');
            
        game.channel.send({ embeds: [winEmbed] });

        // CHỈ trả thưởng cho người chơi thuộc phe thắng VÀ còn sống
        for (const [id, data] of Object.entries(game.playerRoles)) {
            const isWolf = data.role === 'Sói';
            if (data.alive && ((winningTeam === 'Dân Làng' && !isWolf) || (winningTeam === 'Ma Sói' && isWolf))) {
                try { addBalance(id, 100000, guildId); } catch (e) {}
            }
        }
        
        // Xóa game khỏi bộ nhớ sau khi kết thúc
        activeGames.masoi.delete(guildId);
        return true;
    }
    return false;
}



// ==========================================
// CÂU CÁ - TƯƠNG TÁC RIÊNG (GHÉP THÊM)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        const userId = interaction.user.id;
        const guildId = interaction.guildId || 'global';
        const user = fishingGetUser(userId, guildId);

        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'update') {
                const options = [];
                for (const [name, stats] of Object.entries(RODS)) {
                    if (!stats.req) continue;
                    if (options.length < 25) {
                        options.push({
                            label: name.slice(0, 100),
                            description: `Độ bền: ${stats.dur} | Lực kéo: ${stats.res}`,
                            value: `upgraderod_${name}`
                        });
                    }
                }
                const selectMenu = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId('menu_update_rod').setPlaceholder('⚒️ Chọn bản vẽ để tiến hành rèn đúc').addOptions(options)
                );
                return interaction.reply({ content: '⚒️ **LÒ RÈN CẦN CÂU (CHẾ TẠO BẰNG NGUYÊN LIỆU)**\nHãy chọn loại cần câu bạn muốn chế tạo (Nếu đủ đồ, thợ rèn sẽ chế ngay lập tức):', components: [selectMenu] });
            }

            if (interaction.commandName === 'nangcap') {
                const currentPlus = user.equip.rodPlus;
                const upgradeCost = 50000 + (currentPlus * 100000);
                const failChance = Math.min(80, currentPlus * 10);

                if (user.balance < upgradeCost) return interaction.reply({ content: `❌ Phí bảo kê lò rèn để đập lên +${currentPlus + 1} là **${upgradeCost.toLocaleString()} VNĐ**. Bạn không đủ tiền!`, ephemeral: true });

                user.balance -= upgradeCost;
                if (Math.random() * 100 < failChance) {
                    let dropText = '';
                    if (currentPlus >= 3) {
                        user.equip.rodPlus -= 1;
                        dropText = `\n⚠️ Cần câu bị mẻ và giáng cấp xuống thành +${user.equip.rodPlus}.`;
                    }
                    saveFishingData();
                    return interaction.reply({ content: `💥 ẦM M... Bùm!! Cường hóa xịt. Tiêu hao **${upgradeCost.toLocaleString()} VNĐ** mà chẳng được gì.${dropText}` });
                }

                user.equip.rodPlus += 1;
                saveFishingData();
                return interaction.reply({ content: `✨ **TING TING! CƯỜNG HÓA THÀNH CÔNG!** Cần câu tỏa hào quang. Trạng thái hiện tại: **${user.equip.rod} (+${user.equip.rodPlus})**` });
            }

            if (interaction.commandName === 'rest') {
                if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: '❌ Chỉ Admin tối cao mới có quyền dùng lệnh này!', ephemeral: true });
                const targetUser = interaction.options.getUser('user');
                const amount = interaction.options.getInteger('money');
                const tUser = fishingGetUser(targetUser.id, guildId);

                tUser.balance -= amount;
                if (tUser.balance < 0) tUser.balance = 0;
                saveFishingData();
                return interaction.reply({ content: `🚓 **[THU HỒI TÀI SẢN]** Đã tịch thu **${amount.toLocaleString()} VNĐ** của <@${targetUser.id}>!\nSố dư còn lại của họ: \`${tUser.balance.toLocaleString()} VNĐ\`` });
            }

            if (interaction.commandName === 'broadcast') {
                if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: '❌ Chỉ Admin tối cao mới có quyền dùng lệnh này!', ephemeral: true });
                const targetRole = interaction.options.getRole('role');
                const amount = interaction.options.getInteger('money');

                await interaction.deferReply();

                try {
                    const guildMembers = await interaction.guild.members.fetch();
                    const roleMembers = guildMembers.filter(m => m.roles.cache.has(targetRole.id) && !m.user.bot);
                    let count = 0;

                    roleMembers.forEach(member => {
                        const u = fishingGetUser(member.id, guildId);
                        u.balance += amount;
                        count++;
                    });
                    saveFishingData();

                    return interaction.editReply({ content: `🎉 **[PHÚC LỢI SERVER]** Đã phát thành công gói trợ cấp **${amount.toLocaleString()} VNĐ** cho **${count}** thành viên sở hữu role **${targetRole.name}**!` });
                } catch (e) {
                    return interaction.editReply({ content: `❌ Lỗi khi lấy danh sách thành viên! Hãy chắc chắn bạn đã bật "SERVER MEMBERS INTENT" trong Developer Portal. Chi tiết lỗi: ${e.message}` });
                }
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('modal_buy_')) {
                const itemName = interaction.customId.replace('modal_buy_', '');

                let price = 0;
                for (let cat of Object.values(COMPONENTS)) { if (cat[itemName]) price = cat[itemName]; }

                // Không phải mã linh kiện câu cá hợp lệ (là modal của hệ thống khác như rương/role) -> bỏ qua, không xử lý
                if (price <= 0) return;

                const rawQuantity = interaction.fields.getTextInputValue('quantity');
                const quantity = parseInt(rawQuantity);

                if (isNaN(quantity) || quantity <= 0) {
                    return interaction.reply({ content: '❌ Số lượng nhập không hợp lệ!', ephemeral: true });
                }

                const totalPrice = price * quantity;

                if (user.balance < totalPrice) {
                    return interaction.reply({ content: `❌ Bạn cần **${totalPrice.toLocaleString()} VNĐ** để mua ${quantity}x ${itemName}!`, ephemeral: true });
                }

                if (!user.inventory[itemName] && Object.keys(user.inventory).length >= user.maxInv) {
                    return interaction.reply({ content: '🎒 Kho đồ của bạn đã ĐẦY!', ephemeral: true });
                }

                user.balance -= totalPrice;
                user.inventory[itemName] = (user.inventory[itemName] || 0) + quantity;

                if (itemName === 'Bùa May Mắn' || itemName === 'Thuốc Rớt Đồ') {
                    const buffType = itemName === 'Bùa May Mắn' ? 'luck' : 'drop';
                    if (user.buffs[buffType] < Date.now()) user.buffs[buffType] = Date.now();
                    user.buffs[buffType] += 3600000 * quantity;
                    user.inventory[itemName] -= quantity;
                    if (user.inventory[itemName] <= 0) delete user.inventory[itemName];
                }

                saveFishingData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Mua thành công **${quantity}x ${itemName}** với tổng giá **${totalPrice.toLocaleString()} VNĐ**!`, ephemeral: true });
            }
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'menu_trangbi') {
                const items = interaction.values.map(v => v.replace('equip_', ''));
                let equippedLog = [];

                for (const item of items) {
                    if (!user.inventory[item] || user.inventory[item] <= 0) continue;

                    let type = null;
                    if (COMPONENTS.lines[item]) type = 'line';
                    if (COMPONENTS.hooks[item]) type = 'hook';
                    if (COMPONENTS.floats[item]) type = 'float';
                    if (COMPONENTS.reels[item]) type = 'reel';
                    if (COMPONENTS.baits[item]) type = 'bait';
                    if (!type) continue;

                    if (user.equip[type] && type !== 'bait') {
                        user.inventory[user.equip[type]] = (user.inventory[user.equip[type]] || 0) + 1;
                    }

                    user.equip[type] = item;
                    if (type !== 'bait') {
                        user.inventory[item] -= 1;
                        if (user.inventory[item] <= 0) delete user.inventory[item];
                    }

                    equippedLog.push(`**${item}**`);
                }

                saveFishingData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Bạn đã lắp thành công các trang bị sau vào cần câu:\n${equippedLog.join(', ')}`, ephemeral: true });
            }

            if (interaction.customId.startsWith('menu_linhkien')) {
                const itemName = interaction.values[0].replace('buy_', '');
                const modal = new ModalBuilder().setCustomId(`modal_buy_${itemName}`).setTitle(`Mua ${itemName}`);
                const quantityInput = new TextInputBuilder()
                    .setCustomId('quantity')
                    .setLabel('Nhập số lượng muốn mua:')
                    .setStyle(TextInputStyle.Short)
                    .setValue('1')
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(quantityInput));
                await interaction.showModal(modal);
                return;
            }

            if (interaction.customId === 'menu_ruong') {
                const type = interaction.values[0];
                let price = 0; let addSlot = 0;
                if (type === 'buy_ruong_50') { price = 500000; addSlot = 50; }
                if (type === 'buy_ruong_100') { price = 2000000; addSlot = 100; }
                if (type === 'buy_ruong_200') { price = 10000000; addSlot = 200; }

                if (user.balance < price) return interaction.reply({ content: `❌ Bạn không đủ **${price.toLocaleString()} VNĐ** để mua Rương này!`, ephemeral: true });

                user.balance -= price;
                user.maxInv += addSlot;
                saveFishingData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Nâng cấp thành công! Kho hiện tại chứa được tối đa **${user.maxInv}** slots.`, ephemeral: true });
            }

            if (interaction.customId === 'menu_doikhuvuc') {
                const zoneName = interaction.values[0].replace('zone_', '');
                const zoneData = ZONES[zoneName];

                if (user.level < zoneData.level) return interaction.reply({ content: `❌ Bạn cần Level **${zoneData.level}** để ra ${zoneName}!`, ephemeral: true });
                if (user.balance < zoneData.fee) return interaction.reply({ content: `❌ Bạn cần **${zoneData.fee.toLocaleString()} VNĐ** nộp phí bến bãi!`, ephemeral: true });

                user.balance -= zoneData.fee;
                user.zone = zoneName;
                saveFishingData();
                return interaction.reply({ content: `🚤 Căng buồm! Bạn đã di chuyển đến **${zoneName}**. Bắt đầu câu cá thôi!`, ephemeral: true });
            }

            if (interaction.customId === 'menu_shopcan_buy') {
                const rodName = interaction.values[0].replace('buyrod_', '');
                const rodData = RODS[rodName];

                if (user.balance < rodData.price) return interaction.reply({ content: `❌ Bạn cần **${rodData.price.toLocaleString()} VNĐ** để tậu ${rodName}!`, ephemeral: true });

                user.balance -= rodData.price;
                user.equip.rod = rodName; user.equip.rodPlus = 0; user.equip.dur = rodData.dur;
                saveFishingData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Bạn đã mua sắm và trang bị lập tức **${rodName}** với giá **${rodData.price.toLocaleString()} VNĐ**! Cần cũ đã bị vứt bỏ.`, ephemeral: true });
            }

            if (interaction.customId === 'menu_update_rod') {
                const rodName = interaction.values[0].replace('upgraderod_', '');
                const targetRod = RODS[rodName];

                let missingInfo = '';
                for (const [mat, qty] of Object.entries(targetRod.req)) {
                    const has = user.inventory[mat] || 0;
                    if (has < qty) missingInfo += `• ${mat}: Đang có ${has}/${qty} cái\n`;
                }

                if (missingInfo !== '') {
                    const embed = new EmbedBuilder().setColor('#e74c3c').setTitle('❌ KHÔNG ĐỦ NGUYÊN LIỆU').setDescription(`Để chế tạo **${rodName}**, kho đồ của bạn đang thiếu:\n${missingInfo}`);
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }

                for (const [mat, qty] of Object.entries(targetRod.req)) {
                    user.inventory[mat] -= qty;
                    if (user.inventory[mat] <= 0) delete user.inventory[mat];
                }

                user.equip.rod = rodName; user.equip.rodPlus = 0; user.equip.dur = targetRod.dur;
                saveFishingData();
                return interaction.reply({ content: `⚒️ Vang dội tiếng búa! Bạn đã rèn và tự động khoác lên người thần binh: 🎉 **${rodName}**!`, ephemeral: true });
            }
        }
    } catch (error) {
        console.error('Lỗi khi xử lý câu cá:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '<a:emoji_76:1524195723996823612> Đã xảy ra lỗi hệ thống khi xử lý câu cá.', ephemeral: true }).catch(() => {});
        }
    }
});

// ==========================================
// HỆ THỐNG TU TIÊN - LOGIC & GIAO DIỆN
// ==========================================
function ttGetUser(userId, guildId) {
    const gd = getGuildData(guildId);
    if (!gd.tuTien[userId]) {
        gd.tuTien[userId] = {
            realmIndex: 0,      // Chỉ số trong mảng CANH_GIOI (0 = Luyện Khí)
            tang: 1,            // Tầng 1 -> 10
            tuVi: 0,
            linhThach: 100,
            bag: {},            // { itemId: soLuong }
            equip: { phapBao: null },
            status: 'normal',   // normal | afk | injured
            injuredUntil: 0,
            afkSince: 0,
            lastNhiemVu: 0,
            lastBiCanh: 0,
            lastDiemDanh: 0,
            pendingTiLeBonus: 0 // Cộng dồn từ đan dược, tiêu hao khi Đột Phá
        };
        saveData();
    }
    return gd.tuTien[userId];
}

function ttIsInjured(entry) {
    return entry.status === 'injured' && entry.injuredUntil > Date.now();
}

function ttTuViMax(entry) {
    const n = entry.realmIndex * 10 + (entry.tang - 1);
    return Math.floor(100 * Math.pow(1.22, n));
}

function ttStats(entry) {
    const n = entry.realmIndex * 10 + entry.tang;
    let hp = 100 + n * 40;
    let atk = 10 + n * 5;
    let def = 5 + n * 3;
    if (entry.equip.phapBao) { atk = Math.floor(atk * 1.15); def = Math.floor(def * 1.15); }
    return { hp, atk, def };
}

function ttGlobalMultiplier(gd) {
    if (gd.tuTienConfig.globalBuff && gd.tuTienConfig.globalBuff.until > Date.now()) {
        return gd.tuTienConfig.globalBuff.multiplier || 1;
    }
    return 1;
}

function ttProgressBar(tuVi, tuViMax) {
    const ratio = Math.max(0, Math.min(1, tuViMax > 0 ? tuVi / tuViMax : 0));
    const filled = Math.round(ratio * 10);
    return '🟩'.repeat(filled) + '⬛'.repeat(10 - filled);
}

function ttBuildEmbed(entry, member) {
    const tuViMax = ttTuViMax(entry);
    const stats = ttStats(entry);
    const realmName = CANH_GIOI[entry.realmIndex];

    let trangThai = '🟢 Bình thường';
    if (entry.status === 'afk') trangThai = '🧘 Đang Bế Quan';
    if (ttIsInjured(entry)) trangThai = `🩸 Trọng Thương (còn ${Math.ceil((entry.injuredUntil - Date.now()) / 60000)} phút)`;

    return new EmbedBuilder()
        .setColor(TT_COLORS[entry.realmIndex] || '#ffffff')
        .setAuthor({ name: `${member.displayName || member.user.username} - Đạo Hữu`, iconURL: member.user.displayAvatarURL() })
        .setTitle(`${realmName} - Tầng ${entry.tang}${entry.tang === 10 ? ' (Viên Mãn)' : ''}`)
        .setDescription(`${ttProgressBar(entry.tuVi, tuViMax)}\nTu Vi: **${entry.tuVi.toLocaleString()} / ${tuViMax.toLocaleString()}**`)
        .addFields(
            { name: '💎 Linh Thạch', value: entry.linhThach.toLocaleString(), inline: true },
            { name: '❤️ Khí Huyết', value: `${stats.hp}`, inline: true },
            { name: '⚔️ ATK / 🛡️ DEF', value: `${stats.atk} / ${stats.def}`, inline: true },
            { name: '📿 Trạng thái', value: trangThai, inline: false }
        )
        .setFooter({ text: entry.pendingTiLeBonus > 0 ? `Đang có +${entry.pendingTiLeBonus}% tỉ lệ Đột Phá từ đan dược` : 'Tu Tiên Chi Lộ - Con đường vạn dặm bắt đầu từ một bước chân' });
}

function ttBuildComponents(entry) {
    const tuViMax = ttTuViMax(entry);
    const canDotPha = entry.tuVi >= tuViMax && !ttIsInjured(entry);

    const selectTraCuu = new StringSelectMenuBuilder()
        .setCustomId('tt_menu_tracuu')
        .setPlaceholder('📜 Bảng Tra Cứu')
        .addOptions([
            { label: 'Túi Càn Khôn', value: 'tt_tui', emoji: '🎒' },
            { label: 'Thương Các', value: 'tt_shop', emoji: '🏪' },
            { label: 'Bảng Phong Thần', value: 'tt_bxh', emoji: '🏆' },
            { label: 'Tông Môn', value: 'tt_tongmon', emoji: '⛩️' }
        ]);

    const selectHanhDong = new StringSelectMenuBuilder()
        .setCustomId('tt_menu_hanhdong')
        .setPlaceholder('⚔️ Hành Động')
        .addOptions([
            { label: 'Bế Quan Tu Luyện', value: 'tt_bequan', emoji: '🧘' },
            { label: 'Vãn Cảnh / Làm Nhiệm Vụ', value: 'tt_nhiemvu', emoji: '📜' },
            { label: 'Bí Cảnh', value: 'tt_bicanh', emoji: '🗺️' },
            { label: 'Thách Đấu PK', value: 'tt_pk', emoji: '🥊' },
            { label: 'Chuyển Linh Thạch', value: 'tt_chuyen', emoji: '💸' }
        ]);

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tt_diemdanh').setLabel('Điểm Danh').setEmoji('🎁').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('tt_dandu').setLabel('Dùng Đan Dược').setEmoji('💊').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tt_dotpha').setLabel('ĐỘT PHÁ').setEmoji('⚡').setStyle(ButtonStyle.Danger).setDisabled(!canDotPha),
        new ButtonBuilder().setCustomId('tt_lammoi').setLabel('Làm Mới').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    );

    return [
        new ActionRowBuilder().addComponents(selectTraCuu),
        new ActionRowBuilder().addComponents(selectHanhDong),
        row3
    ];
}

async function ttRenderPanel(interaction, entry) {
    const embed = ttBuildEmbed(entry, interaction.member);
    const components = ttBuildComponents(entry);
    const payload = { embeds: [embed], components, flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await interaction.update(payload);
    } else {
        await interaction.reply(payload);
    }
}

// Xử lý một lần Đột Phá (Lôi Kiếp) hoặc lên tầng thường
async function ttDoDotPha(interaction, entry, guildData) {
    const tuViMax = ttTuViMax(entry);
    if (entry.tuVi < tuViMax) return interaction.reply({ content: '❌ Tu Vi của bạn chưa đầy, không thể Đột Phá!', ephemeral: true });
    if (ttIsInjured(entry)) return interaction.reply({ content: '🩸 Bạn đang Trọng Thương, không thể Đột Phá lúc này!', ephemeral: true });

    if (entry.tang < 10) {
        // Đột phá nhỏ trong cùng cảnh giới: tỉ lệ thành công 100%
        entry.tang += 1;
        entry.tuVi = 0;
        saveData();
        return interaction.reply({ content: `✨ Chúc mừng! Bạn đã đột phá lên **${CANH_GIOI[entry.realmIndex]} - Tầng ${entry.tang}**!`, ephemeral: false });
    }

    // Tầng 10 -> Đại Cảnh Giới mới: Lôi Kiếp
    const baseRate = 30;
    const tiLe = Math.min(95, baseRate + (entry.pendingTiLeBonus || 0));
    const roll = Math.random() * 100;
    const success = roll <= tiLe;
    entry.pendingTiLeBonus = 0;

    if (success) {
        entry.realmIndex = Math.min(CANH_GIOI.length - 1, entry.realmIndex + 1);
        entry.tang = 1;
        entry.tuVi = 0;
        saveData();

        // Trao role tương ứng nếu Admin đã bind
        const realmName = CANH_GIOI[entry.realmIndex];
        const roleId = guildData.tuTienConfig.roleBind[realmName];
        if (roleId && interaction.member) {
            const role = interaction.guild.roles.cache.get(roleId);
            if (role) await interaction.member.roles.add(role).catch(() => {});
        }

        const embed = new EmbedBuilder()
            .setColor('#f1c40f')
            .setTitle('⚡ ĐỘ KIẾP THÀNH CÔNG ⚡')
            .setDescription(`<@${interaction.user.id}> đã vượt qua Lôi Kiếp (Tỉ lệ ${tiLe}%) và bước vào cảnh giới **${realmName}**!`);

        const notifyChannelId = guildData.tuTienConfig.channelId;
        if (notifyChannelId) {
            const ch = interaction.guild.channels.cache.get(notifyChannelId);
            if (ch) ch.send({ embeds: [embed] }).catch(() => {});
        }
        return interaction.reply({ embeds: [embed], ephemeral: false });
    } else {
        entry.tuVi = Math.floor(tuViMax * 0.5);
        entry.status = 'injured';
        entry.injuredUntil = Date.now() + 2 * 60 * 60 * 1000; // 2 tiếng
        saveData();
        return interaction.reply({ content: `💥 Lôi Kiếp thất bại! (Tỉ lệ vừa roll: ${tiLe}%) Bạn mất 50% Tu Vi và rơi vào trạng thái **Trọng Thương** trong 2 giờ.`, ephemeral: false });
    }
}

client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.guildId) return; // Tu Tiên chỉ hoạt động trong server
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const guildData = getGuildData(guildId);

        // Chặn user đã bị /tudev ban khỏi hệ thống Tu Tiên
        if (guildData.tuTienConfig.banned.includes(userId)) {
            const isTtInteraction = (interaction.isChatInputCommand() && ['tutien'].includes(interaction.commandName)) ||
                (interaction.customId && interaction.customId.startsWith('tt_'));
            if (isTtInteraction) {
                return interaction.reply({ content: '🚫 Bạn đã bị cấm vĩnh viễn khỏi hệ thống Tu Tiên.', ephemeral: true });
            }
        }

        // --- SLASH COMMAND: /tutien ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'tutien') {
            const entry = ttGetUser(userId, guildId);
            return ttRenderPanel(interaction, entry);
        }

        // --- SLASH COMMAND: /tudev (Chủ Bot) ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'tudev') {
            if (!TT_OWNER_IDS.includes(userId)) {
                return interaction.reply({ content: '❌ Chỉ Chủ Bot mới được dùng lệnh này!', ephemeral: true });
            }
            const sub = interaction.options.getSubcommand();

            if (sub === 'give_item') {
                const target = interaction.options.getUser('user');
                const itemId = interaction.options.getString('item_id');
                const amount = interaction.options.getInteger('amount');
                const targetEntry = ttGetUser(target.id, guildId);
                targetEntry.bag[itemId] = (targetEntry.bag[itemId] || 0) + amount;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã cấp **${amount}x ${itemId}** cho <@${target.id}>.`, ephemeral: true });
            }

            if (sub === 'set_stats') {
                const target = interaction.options.getUser('user');
                const loai = interaction.options.getString('loai');
                const amount = interaction.options.getInteger('amount');
                const targetEntry = ttGetUser(target.id, guildId);
                if (loai === 'tuvi') targetEntry.tuVi = amount; else targetEntry.linhThach = amount;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã set **${loai}** của <@${target.id}> thành **${amount.toLocaleString()}**.`, ephemeral: true });
            }

            if (sub === 'global_buff') {
                const mult = interaction.options.getInteger('exp_multiplier');
                const minutes = interaction.options.getInteger('time');
                guildData.tuTienConfig.globalBuff = { multiplier: mult, until: Date.now() + minutes * 60000 };
                saveData();
                return interaction.reply({ content: `🔥 Đã bật sự kiện **Nhân ${mult} Tu Vi** trong **${minutes} phút** cho toàn server!`, ephemeral: false });
            }

            if (sub === 'ban') {
                const target = interaction.options.getUser('user');
                if (!guildData.tuTienConfig.banned.includes(target.id)) guildData.tuTienConfig.banned.push(target.id);
                saveData();
                return interaction.reply({ content: `🚫 Đã trục xuất vĩnh viễn <@${target.id}> khỏi hệ thống Tu Tiên.`, ephemeral: true });
            }
        }

        // --- SLASH COMMAND: /tuconfig (Admin) ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'tuconfig') {
            const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.guild.ownerId === userId;
            if (!isAdmin) return interaction.reply({ content: '❌ Bạn cần quyền Manage Server để dùng lệnh này!', ephemeral: true });
            const sub = interaction.options.getSubcommand();

            if (sub === 'bind_channel') {
                const channel = interaction.options.getChannel('channel');
                guildData.tuTienConfig.channelId = channel.id;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Thông báo Đột Phá/PK Tu Tiên sẽ được gửi vào <#${channel.id}>.`, ephemeral: true });
            }

            if (sub === 'bind_role') {
                const canhGioi = interaction.options.getString('canh_gioi');
                const role = interaction.options.getRole('role');
                guildData.tuTienConfig.roleBind[canhGioi] = role.id;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Member đột phá lên **${canhGioi}** sẽ tự động nhận role <@&${role.id}>.`, ephemeral: true });
            }

            if (sub === 'reset_cooldown') {
                const target = interaction.options.getUser('user');
                const targetEntry = ttGetUser(target.id, guildId);
                targetEntry.lastNhiemVu = 0;
                targetEntry.lastBiCanh = 0;
                if (targetEntry.status === 'afk') targetEntry.status = 'normal';
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã reset cooldown Tu Tiên cho <@${target.id}>.`, ephemeral: true });
            }
        }

        // --- BUTTONS ---
        if (interaction.isButton() && interaction.customId.startsWith('tt_')) {
            const entry = ttGetUser(userId, guildId);

            if (interaction.customId === 'tt_lammoi') {
                return ttRenderPanel(interaction, entry);
            }

            if (interaction.customId === 'tt_diemdanh') {
                const today = new Date().toDateString();
                const last = entry.lastDiemDanh ? new Date(entry.lastDiemDanh).toDateString() : null;
                if (last === today) return interaction.reply({ content: '⏳ Bạn đã Điểm Danh hôm nay rồi, quay lại vào ngày mai nhé!', ephemeral: true });
                const mult = ttGlobalMultiplier(guildData);
                const tuViGain = Math.floor((20 + entry.realmIndex * 10) * mult);
                const linhThachGain = 50 + entry.realmIndex * 20;
                entry.tuVi += tuViGain;
                entry.linhThach += linhThachGain;
                entry.lastDiemDanh = Date.now();
                saveData();
                return interaction.reply({ content: `🎁 Điểm danh thành công! Nhận **+${tuViGain} Tu Vi** và **+${linhThachGain} Linh Thạch**.`, ephemeral: true });
            }

            if (interaction.customId === 'tt_dandu') {
                const bagItems = Object.entries(entry.bag).filter(([id, qty]) => DAN_DUOC[id] && qty > 0);
                if (bagItems.length === 0) return interaction.reply({ content: '🎒 Bạn không có đan dược nào trong túi!', ephemeral: true });
                const menu = new StringSelectMenuBuilder()
                    .setCustomId('tt_menu_dandu')
                    .setPlaceholder('Chọn đan dược muốn dùng')
                    .addOptions(bagItems.map(([id, qty]) => ({ label: `${DAN_DUOC[id].name} (x${qty})`, value: id, description: DAN_DUOC[id].desc.slice(0, 90) })));
                return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
            }

            if (interaction.customId === 'tt_dotpha') {
                return ttDoDotPha(interaction, entry, guildData);
            }
        }

        // --- SELECT MENUS ---
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('tt_menu_')) {
            const entry = ttGetUser(userId, guildId);
            const value = interaction.values[0];

            if (interaction.customId === 'tt_menu_tracuu') {
                if (value === 'tt_tui') {
                    const list = Object.entries(entry.bag).filter(([, qty]) => qty > 0);
                    const desc = list.length ? list.map(([id, qty]) => `• ${DAN_DUOC[id]?.name || id}: **${qty}**`).join('\n') : 'Túi Càn Khôn trống rỗng.';
                    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('🎒 Túi Càn Khôn').setDescription(desc)], ephemeral: true });
                }
                if (value === 'tt_shop') {
                    const desc = Object.entries(DAN_DUOC).map(([id, d]) => `**${d.name}** - ${d.price.toLocaleString()} Linh Thạch\n_${d.desc}_`).join('\n\n');
                    const menu = new StringSelectMenuBuilder().setCustomId('tt_menu_muahang').setPlaceholder('Chọn vật phẩm muốn mua (x1)')
                        .addOptions(Object.entries(DAN_DUOC).map(([id, d]) => ({ label: `${d.name} - ${d.price.toLocaleString()} LT`, value: id })));
                    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#f39c12').setTitle('🏪 Thương Các').setDescription(desc)], components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
                }
                if (value === 'tt_bxh') {
                    const ranking = Object.entries(guildData.tuTien)
                        .sort((a, b) => (b[1].realmIndex * 10 + b[1].tang) - (a[1].realmIndex * 10 + a[1].tang))
                        .slice(0, 10)
                        .map(([id, e], i) => `**#${i + 1}** <@${id}> - ${CANH_GIOI[e.realmIndex]} Tầng ${e.tang}`)
                        .join('\n') || 'Chưa có Đạo Hữu nào tu luyện!';
                    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#e67e22').setTitle('🏆 Bảng Phong Thần').setDescription(ranking)], ephemeral: true });
                }
                if (value === 'tt_tongmon') {
                    return interaction.reply({ content: '⛩️ Hệ thống Tông Môn đang được xây dựng, hẹn gặp lại Đạo Hữu ở bản cập nhật sau!', ephemeral: true });
                }
            }

            if (interaction.customId === 'tt_menu_hanhdong') {
                const mult = ttGlobalMultiplier(guildData);

                if (value === 'tt_bequan') {
                    if (ttIsInjured(entry)) return interaction.reply({ content: '🩸 Bạn đang Trọng Thương, không thể Bế Quan!', ephemeral: true });
                    if (entry.status === 'afk') {
                        const elapsedMin = Math.min(480, Math.floor((Date.now() - entry.afkSince) / 60000));
                        const gain = Math.floor(elapsedMin * (5 + entry.realmIndex * 2) * mult);
                        entry.tuVi += gain;
                        entry.status = 'normal';
                        saveData();
                        return interaction.reply({ content: `🧘 Xuất Quan! Sau **${elapsedMin} phút** bế quan, bạn nhận được **+${gain} Tu Vi**.`, ephemeral: true });
                    } else {
                        entry.status = 'afk';
                        entry.afkSince = Date.now();
                        saveData();
                        return interaction.reply({ content: '🧘 Bạn bắt đầu Bế Quan Tu Luyện. Hãy mở lại bảng Hành Động và chọn lại mục này để Xuất Quan nhận thưởng!', ephemeral: true });
                    }
                }

                if (value === 'tt_nhiemvu') {
                    if (entry.status !== 'normal') return interaction.reply({ content: '❌ Bạn cần ở trạng thái Bình thường để làm việc này!', ephemeral: true });
                    const cd = 5 * 60000;
                    if (Date.now() - entry.lastNhiemVu < cd) {
                        return interaction.reply({ content: `⏳ Còn **${Math.ceil((cd - (Date.now() - entry.lastNhiemVu)) / 1000)}s** nữa mới có thể Vãn Cảnh tiếp!`, ephemeral: true });
                    }
                    const linhThachGain = Math.floor((50 + Math.random() * 150) * (1 + entry.realmIndex * 0.3));
                    entry.linhThach += linhThachGain;
                    entry.lastNhiemVu = Date.now();
                    saveData();
                    return interaction.reply({ content: `📜 Hoàn thành nhiệm vụ! Nhận được **+${linhThachGain} Linh Thạch**.`, ephemeral: true });
                }

                if (value === 'tt_bicanh') {
                    if (entry.status !== 'normal') return interaction.reply({ content: '❌ Bạn cần ở trạng thái Bình thường để vào Bí Cảnh!', ephemeral: true });
                    const cd = 30 * 60000;
                    if (Date.now() - entry.lastBiCanh < cd) {
                        return interaction.reply({ content: `⏳ Còn **${Math.ceil((cd - (Date.now() - entry.lastBiCanh)) / 60000)} phút** nữa mới có thể vào lại Bí Cảnh!`, ephemeral: true });
                    }
                    entry.lastBiCanh = Date.now();
                    const tuViGain = Math.floor((100 + Math.random() * 200) * (1 + entry.realmIndex * 0.4) * mult);
                    const linhThachGain = Math.floor(100 + Math.random() * 300);
                    entry.tuVi += tuViGain;
                    entry.linhThach += linhThachGain;
                    let dropText = '';
                    if (Math.random() < 0.25) {
                        const ids = Object.keys(DAN_DUOC);
                        const dropId = ids[Math.floor(Math.random() * ids.length)];
                        entry.bag[dropId] = (entry.bag[dropId] || 0) + 1;
                        dropText = `\n🎁 Nhặt được: **${DAN_DUOC[dropId].name}**!`;
                    }
                    let injuredText = '';
                    if (Math.random() < 0.1) {
                        entry.status = 'injured';
                        entry.injuredUntil = Date.now() + 30 * 60000;
                        injuredText = '\n⚠️ Bạn bị thương nhẹ khi giao chiến với yêu thú, Trọng Thương trong 30 phút!';
                    }
                    saveData();
                    return interaction.reply({ content: `🗺️ Thám hiểm Bí Cảnh thành công! Nhận **+${tuViGain} Tu Vi**, **+${linhThachGain} Linh Thạch**.${dropText}${injuredText}`, ephemeral: true });
                }

                if (value === 'tt_pk') {
                    if (ttIsInjured(entry)) return interaction.reply({ content: '🩸 Bạn đang Trọng Thương, không thể PK!', ephemeral: true });
                    const modal = new ModalBuilder().setCustomId('tt_modal_pk').setTitle('Thách Đấu PK');
                    const input = new TextInputBuilder().setCustomId('target_id').setLabel('Nhập ID Discord của đối thủ').setStyle(TextInputStyle.Short).setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    return interaction.showModal(modal);
                }

                if (value === 'tt_chuyen') {
                    const modal = new ModalBuilder().setCustomId('tt_modal_chuyen').setTitle('Chuyển Linh Thạch');
                    const idInput = new TextInputBuilder().setCustomId('target_id').setLabel('ID Discord người nhận').setStyle(TextInputStyle.Short).setRequired(true);
                    const amountInput = new TextInputBuilder().setCustomId('amount').setLabel('Số Linh Thạch muốn chuyển').setStyle(TextInputStyle.Short).setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(idInput), new ActionRowBuilder().addComponents(amountInput));
                    return interaction.showModal(modal);
                }
            }

            if (interaction.customId === 'tt_menu_dandu') {
                const itemId = value;
                if (!entry.bag[itemId] || entry.bag[itemId] <= 0) return interaction.reply({ content: '❌ Bạn không còn vật phẩm này!', ephemeral: true });
                const item = DAN_DUOC[itemId];
                entry.bag[itemId] -= 1;
                if (entry.bag[itemId] <= 0) delete entry.bag[itemId];

                if (item.heal) {
                    entry.status = 'normal';
                    entry.injuredUntil = 0;
                    saveData();
                    return interaction.reply({ content: `💊 Đã dùng **${item.name}**, trạng thái Trọng Thương được chữa khỏi ngay lập tức!`, ephemeral: true });
                } else {
                    entry.pendingTiLeBonus = (entry.pendingTiLeBonus || 0) + item.tiLe;
                    saveData();
                    return interaction.reply({ content: `💊 Đã dùng **${item.name}**, tỉ lệ Đột Phá lần tới +${item.tiLe}% (tổng cộng dồn: +${entry.pendingTiLeBonus}%).`, ephemeral: true });
                }
            }

            if (interaction.customId === 'tt_menu_muahang') {
                const itemId = value;
                const item = DAN_DUOC[itemId];
                if (entry.linhThach < item.price) return interaction.reply({ content: `❌ Bạn cần **${item.price.toLocaleString()} Linh Thạch** để mua ${item.name}!`, ephemeral: true });
                entry.linhThach -= item.price;
                entry.bag[itemId] = (entry.bag[itemId] || 0) + 1;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mua **1x ${item.name}** với giá **${item.price.toLocaleString()} Linh Thạch**.`, ephemeral: true });
            }
        }

        // --- MODALS ---
        if (interaction.isModalSubmit() && interaction.customId.startsWith('tt_modal_')) {
            const entry = ttGetUser(userId, guildId);

            if (interaction.customId === 'tt_modal_pk') {
                const targetId = interaction.fields.getTextInputValue('target_id').trim();
                if (targetId === userId) return interaction.reply({ content: '❌ Bạn không thể tự thách đấu chính mình!', ephemeral: true });
                if (!guildData.tuTien[targetId]) return interaction.reply({ content: '❌ Không tìm thấy Đạo Hữu này trong hệ thống Tu Tiên!', ephemeral: true });

                const targetEntry = guildData.tuTien[targetId];
                if (ttIsInjured(targetEntry)) return interaction.reply({ content: '❌ Đối thủ đang Trọng Thương, không thể PK lúc này!', ephemeral: true });

                const myStats = ttStats(entry);
                const targetStats = ttStats(targetEntry);
                const winChance = myStats.atk / (myStats.atk + targetStats.def + targetStats.atk * 0.3);
                const win = Math.random() < winChance;
                const stolen = Math.floor(Math.min(win ? targetEntry.linhThach : entry.linhThach, 50 + Math.random() * 150) * 0.1) || 10;

                if (win) {
                    targetEntry.linhThach = Math.max(0, targetEntry.linhThach - stolen);
                    entry.linhThach += stolen;
                } else {
                    entry.linhThach = Math.max(0, entry.linhThach - stolen);
                    targetEntry.linhThach += stolen;
                }
                saveData();

                const embed = new EmbedBuilder()
                    .setColor(win ? '#2ecc71' : '#e74c3c')
                    .setTitle('🥊 KẾT QUẢ THÁCH ĐẤU')
                    .setDescription(`<@${userId}> ${win ? 'đã đánh bại' : 'đã thất bại trước'} <@${targetId}>!\n💰 Linh Thạch cược: **${stolen.toLocaleString()}**`);
                return interaction.reply({ embeds: [embed], ephemeral: false });
            }

            if (interaction.customId === 'tt_modal_chuyen') {
                const targetId = interaction.fields.getTextInputValue('target_id').trim();
                const amount = parseInt(interaction.fields.getTextInputValue('amount'));
                if (targetId === userId) return interaction.reply({ content: '❌ Bạn không thể tự chuyển cho chính mình!', ephemeral: true });
                if (isNaN(amount) || amount <= 0) return interaction.reply({ content: '❌ Số Linh Thạch không hợp lệ!', ephemeral: true });
                if (entry.linhThach < amount) return interaction.reply({ content: '❌ Bạn không đủ Linh Thạch để chuyển!', ephemeral: true });

                const targetEntry = ttGetUser(targetId, guildId);
                entry.linhThach -= amount;
                targetEntry.linhThach += amount;
                saveData();
                return interaction.reply({ content: `💸 Đã chuyển **${amount.toLocaleString()} Linh Thạch** cho <@${targetId}>.`, ephemeral: true });
            }
        }
    } catch (error) {
        console.error('Lỗi khi xử lý Tu Tiên:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ Đã xảy ra lỗi hệ thống khi xử lý Tu Tiên.', ephemeral: true }).catch(() => {});
        }
    }
});
// ==========================================
// KẾT THÚC HỆ THỐNG TU TIÊN
// ==========================================

// ==========================================
// HỆ THỐNG NÔNG TRẠI (FARM) - HẰNG SỐ CẤU HÌNH
// ==========================================
const FARM_MAX_PLOTS = 50; // Giới hạn tối đa số ô đất mỗi người chơi có thể mở
const CROPS = {
    lua: { name: 'Lúa', emoji: '🌾', seedPrice: 2000, growTime: 5 * 60000, sellPrice: 3500 },
    carot: { name: 'Cà Rốt', emoji: '🥕', seedPrice: 5000, growTime: 10 * 60000, sellPrice: 8000 },
    ngo: { name: 'Ngô', emoji: '🌽', seedPrice: 10000, growTime: 15 * 60000, sellPrice: 16000 },
    cachua: { name: 'Cà Chua', emoji: '🍅', seedPrice: 20000, growTime: 20 * 60000, sellPrice: 32000 },
    khoaitay: { name: 'Khoai Tây', emoji: '🥔', seedPrice: 35000, growTime: 30 * 60000, sellPrice: 55000 },
    duahau: { name: 'Dưa Hấu', emoji: '🍉', seedPrice: 80000, growTime: 45 * 60000, sellPrice: 120000 },
    nho: { name: 'Nho', emoji: '🍇', seedPrice: 150000, growTime: 60 * 60000, sellPrice: 230000 },
    tao: { name: 'Táo', emoji: '🍎', seedPrice: 300000, growTime: 120 * 60000, sellPrice: 450000 },
    xoai: { name: 'Xoài', emoji: '🥭', seedPrice: 600000, growTime: 240 * 60000, sellPrice: 900000 },
    saurieng: { name: 'Sầu Riêng', emoji: '🟢', seedPrice: 2000000, growTime: 480 * 60000, sellPrice: 3000000 }
};

const ANIMALS = {
    ga: { name: 'Gà', emoji: '🐔', price: 100000, prodTime: 2 * 3600000, product: 'trung_ga', productName: 'Trứng', productEmoji: '🥚', productPrice: 15000 },
    vit: { name: 'Vịt', emoji: '🦆', price: 180000, prodTime: 3 * 3600000, product: 'trung_vit', productName: 'Trứng Vịt', productEmoji: '🥚', productPrice: 30000 },
    de: { name: 'Dê', emoji: '🐐', price: 500000, prodTime: 6 * 3600000, product: 'sua_de', productName: 'Sữa Dê', productEmoji: '🥛', productPrice: 120000 },
    cuu: { name: 'Cừu', emoji: '🐑', price: 800000, prodTime: 8 * 3600000, product: 'len', productName: 'Len', productEmoji: '🧶', productPrice: 200000 },
    bo_vatnuoi: { name: 'Bò', emoji: '🐄', price: 1500000, prodTime: 10 * 3600000, product: 'sua_bo', productName: 'Sữa Bò', productEmoji: '🥛', productPrice: 350000 },
    heo: { name: 'Heo', emoji: '🐖', price: 2000000, prodTime: 12 * 3600000, product: 'thit', productName: 'Thịt', productEmoji: '🥩', productPrice: 600000 }
};
const CAM_PRICE = 5000; // Giá 1 phần Cám thức ăn chăn nuôi

// Vật phẩm chế biến (thành phẩm) - tiêu thụ nguyên liệu từ Kho, cho ra thức ăn dùng !an để hồi năng lượng
// LƯU Ý: "energy" tính theo kcal, dùng chung thang đo với thanh Năng Lượng 3.000kcal (xem ENERGY_CONFIG bên dưới)
const RECIPES = {
    banh_mi: { name: 'Bánh Mì', emoji: '🍞', need: { lua: 3 }, time: 5 * 60000, sellPrice: 18000, energy: 250 },
    khoaitay_chien: { name: 'Khoai Tây Chiên', emoji: '🍟', need: { khoaitay: 2 }, time: 8 * 60000, sellPrice: 50000, energy: 400 },
    nuoc_ep_carot: { name: 'Nước Ép Cà Rốt', emoji: '🥤', need: { carot: 3 }, time: 6 * 60000, sellPrice: 35000, energy: 120 },
    mut_tao: { name: 'Mứt Táo', emoji: '🍯', need: { tao: 5 }, time: 15 * 60000, sellPrice: 300000, energy: 350 },
    bo_chebien: { name: 'Bơ', emoji: '🧈', need: { sua_bo: 2 }, time: 5 * 60000, sellPrice: 120000, energy: 320 },
    pho_mai: { name: 'Phô Mai', emoji: '🧀', need: { sua_bo: 3 }, time: 10 * 60000, sellPrice: 250000, energy: 400 },
    sua_chua: { name: 'Sữa Chua', emoji: '🍦', need: { sua_bo: 2 }, time: 8 * 60000, sellPrice: 150000, energy: 150 },
    trung_chien: { name: 'Trứng Chiên', emoji: '🍳', need: { trung_ga: 2 }, time: 3 * 60000, sellPrice: 50000, energy: 200 },
    // --- 10 món mới ---
    chao_ga: { name: 'Cháo Gà', emoji: '🍲', need: { ngo: 2, trung_ga: 1 }, time: 6 * 60000, sellPrice: 60000, energy: 220 },
    banh_ngo: { name: 'Bánh Ngô', emoji: '🌽', need: { ngo: 3 }, time: 7 * 60000, sellPrice: 45000, energy: 180 },
    salad_cachua: { name: 'Salad Cà Chua', emoji: '🥗', need: { cachua: 3 }, time: 4 * 60000, sellPrice: 30000, energy: 140 },
    nuoc_ep_duahau: { name: 'Nước Ép Dưa Hấu', emoji: '🍉', need: { duahau: 2 }, time: 5 * 60000, sellPrice: 40000, energy: 100 },
    nuoc_ep_nho: { name: 'Nước Ép Nho', emoji: '🍇', need: { nho: 5 }, time: 8 * 60000, sellPrice: 90000, energy: 130 },
    banh_xoai: { name: 'Bánh Xoài', emoji: '🥭', need: { xoai: 3 }, time: 12 * 60000, sellPrice: 350000, energy: 380 },
    che_saurieng: { name: 'Chè Sầu Riêng', emoji: '🍮', need: { saurieng: 1 }, time: 18 * 60000, sellPrice: 500000, energy: 450 },
    thit_nuong: { name: 'Thịt Nướng', emoji: '🍖', need: { thit: 2 }, time: 10 * 60000, sellPrice: 700000, energy: 500 },
    sua_de_hap: { name: 'Sữa Dê Hấp', emoji: '🥛', need: { sua_de: 2 }, time: 8 * 60000, sellPrice: 150000, energy: 250 },
    banh_trung_vit: { name: 'Bánh Trứng Vịt', emoji: '🥧', need: { trung_vit: 2, lua: 2 }, time: 9 * 60000, sellPrice: 120000, energy: 300 }
};

// ==========================================
// HỆ THỐNG NĂNG LƯỢNG DÙNG CHUNG (NÔNG TRẠI <-> CÂU CÁ)
// ==========================================
// Thanh Năng Lượng 3.000kcal dùng chung cho cả 2 minigame: chăm sóc nông trại và câu cá
// đều tiêu hao từ từ cùng 1 thanh năng lượng này (lưu trong dữ liệu Nông Trại của người chơi).
const ENERGY_CONFIG = {
    max: 3000,
    costs: {
        cauca: 100,        // Mỗi lần !cauca tốn 100kcal
        cham_soc: 30,      // Tưới nước / Bón phân / Thuốc sâu (mỗi ô)
        thu_hoach: 20,     // Thu hoạch (mỗi ô)
        chanuoi: 15        // Thu hoạch sản phẩm chăn nuôi (mỗi loại)
    }
};

function fmHasEnergy(u, amount) { return u.energy >= amount; }
function fmSpendEnergy(u, amount) { u.energy = Math.max(0, u.energy - amount); }

// Nâng cấp Nông Trại (mua bằng lệnh !nangcapnongtrai)
const FARM_UPGRADE_FLAGS = {
    binh_tuoi: { name: 'Bình Tưới Tự Động', desc: 'Tự động tưới toàn bộ cây trồng, không cần tưới thủ công nữa', price: 500000, flag: 'autoWater' },
    may_thu_hoach: { name: 'Máy Thu Hoạch', desc: 'Tự động thu hoạch cây đã chín mỗi khi bạn mở !farm', price: 1000000, flag: 'autoHarvest' },
    may_tao_phan: { name: 'Máy Tạo Phân', desc: 'Tự động bón phân miễn phí cho cây mới gieo', price: 800000, flag: 'autoFertilize' },
    nha_kinh: { name: 'Nhà Kính', desc: 'Giảm 50% tỉ lệ cây bị sâu bệnh', price: 2000000, flag: 'greenhouse' },
    may_phun_thuoc: { name: 'Máy Phun Thuốc Tự Động', desc: 'Tự động bảo vệ toàn bộ cây khỏi sâu bệnh', price: 1500000, flag: 'autoPest' }
};

// Cơ chế thời tiết: mỗi giờ đổi ngẫu nhiên theo tỉ lệ %
// diseaseMult: nhân thêm vào tỉ lệ sâu bệnh | mutateBonus: cộng thêm % tỉ lệ đột biến khi thu hoạch
// fishingLuckBonus: có lợi cho !cauca (tăng tỉ lệ cá hiếm) vì thời tiết dùng chung giữa 2 minigame
const WEATHER_TYPES = [
    { id: 'nang_dep', name: 'Nắng đẹp', emoji: '☀️', chance: 32, speedMult: 1.10 },
    { id: 'mua', name: 'Mưa', emoji: '🌧️', chance: 20, speedMult: 1.20, noWaterNeeded: true },
    { id: 'am_u', name: 'Âm u', emoji: '🌥️', chance: 13, speedMult: 1.0 },
    { id: 'gio_manh', name: 'Gió mạnh', emoji: '🌬️', chance: 8, speedMult: 0.90 },
    { id: 'nang_nong', name: 'Nắng nóng', emoji: '🔥', chance: 5, speedMult: 1.0, needWaterOrSlow: true },
    { id: 'bao', name: 'Bão', emoji: '⛈️', chance: 3, speedMult: 1.0, damageChance: 0.05 },
    { id: 'sau_benh', name: 'Mùa sâu bệnh', emoji: '🐛', chance: 2, speedMult: 1.0, diseaseDoubled: true },
    // --- Thời tiết mới ---
    { id: 'suong_mu', name: 'Sương mù', emoji: '🌫️', chance: 7, speedMult: 0.95, diseaseMult: 1.3, harmful: true },
    { id: 'han_han', name: 'Hạn hán', emoji: '🏜️', chance: 4, speedMult: 0.70, needWaterOrSlow: true, harmful: true },
    { id: 'cau_vong', name: 'Cầu vồng', emoji: '🌈', chance: 4, speedMult: 1.15, mutateBonus: 0.05, diseaseMult: 0.5, beneficial: true },
    { id: 'trang_tron', name: 'Trăng tròn', emoji: '🌕', chance: 2, speedMult: 1.05, fishingLuckBonus: true, beneficial: true }
];

function ttPickWeather() {
    const roll = Math.random() * 100;
    let acc = 0;
    for (const w of WEATHER_TYPES) {
        acc += w.chance;
        if (roll <= acc) return w;
    }
    return WEATHER_TYPES[0];
}

function fmGetWeather(guildId) {
    const gd = getGuildData(guildId);
    return WEATHER_TYPES.find(w => w.id === gd.farm.weather.current) || WEATHER_TYPES[0];
}

// ==========================================
// HỆ THỐNG NÔNG TRẠI - LOGIC & DỮ LIỆU NGƯỜI CHƠI
// ==========================================
function fmGetUser(userId, guildId) {
    const gd = getGuildData(guildId);
    if (!gd.farm.users[userId]) {
        gd.farm.users[userId] = {
            plots: Array.from({ length: 5 }, () => ({ state: 'empty' })), // empty | growing | ready
            plotCount: 5,
            warehouseCap: 100,
            seeds: {},        // { cropId: soLuong }
            warehouse: {},    // { itemId: soLuong } (nông sản, sản phẩm chăn nuôi, thức ăn, thuốc)
            energy: ENERGY_CONFIG.max,
            maxEnergy: ENERGY_CONFIG.max,
            upgrades: {},     // { autoWater, autoHarvest, autoFertilize, greenhouse, autoPest }
            animals: {},      // { animalId: { count, fed:bool, lastCollect } }
            lastWatered: {},  // theo dõi tưới nước 6h cho nắng nóng (không bắt buộc theo plot)
            processingQueue: [] // [{ recipeId, qty, readyAt }]
        };
        saveData();
    }
    const u = gd.farm.users[userId];
    if (!u.warehouse) u.warehouse = {};
    if (!u.seeds) u.seeds = {};
    if (!u.animals) u.animals = {};
    if (!u.upgrades) u.upgrades = {};
    if (!u.processingQueue) u.processingQueue = [];
    if (u.energy === undefined) u.energy = ENERGY_CONFIG.max;
    if (!u.maxEnergy) u.maxEnergy = ENERGY_CONFIG.max;
    // Di chuyển dữ liệu cũ (thang 0-100) sang thang kcal mới (0-3.000) cho người chơi có sẵn dữ liệu
    if (u.maxEnergy < 1000) {
        const ratio = u.maxEnergy > 0 ? u.energy / u.maxEnergy : 1;
        u.maxEnergy = ENERGY_CONFIG.max;
        u.energy = Math.round(ratio * ENERGY_CONFIG.max);
    }
    return u;
}

function fmWhInv(u, itemId) { return u.warehouse[itemId] || 0; }
function fmAddWh(u, itemId, qty) {
    const total = Object.values(u.warehouse).reduce((a, b) => a + b, 0);
    const canAdd = Math.max(0, Math.min(qty, u.warehouseCap - total));
    if (canAdd > 0) u.warehouse[itemId] = (u.warehouse[itemId] || 0) + canAdd;
    return canAdd;
}

function fmItemMeta(itemId) {
    if (CROPS[itemId]) return { name: CROPS[itemId].name, emoji: CROPS[itemId].emoji, category: 'crop', sellPrice: CROPS[itemId].sellPrice };
    for (const a of Object.values(ANIMALS)) {
        if (a.product === itemId) return { name: a.productName, emoji: a.productEmoji, category: 'animal_product', sellPrice: a.productPrice };
    }
    if (RECIPES[itemId]) return { name: RECIPES[itemId].name, emoji: RECIPES[itemId].emoji, category: 'food', sellPrice: RECIPES[itemId].sellPrice };
    if (itemId === 'cam') return { name: 'Cám', emoji: '🌰', category: 'food', sellPrice: 0 };
    if (itemId === 'thuoc_sau') return { name: 'Thuốc Sâu', emoji: '🧴', category: 'medicine', sellPrice: 0 };
    if (itemId === 'phan_bon_cao_cap') return { name: 'Phân Bón Cao Cấp', emoji: '💩', category: 'medicine', sellPrice: 0 };
    return { name: itemId, emoji: '❓', category: 'unknown', sellPrice: 0 };
}

// Xác định tên/emoji hiển thị cho các vật phẩm bên hệ thống Câu Cá (cá, nguyên liệu chế đồ)
// để !trade có thể trao đổi được TOÀN BỘ ID vật phẩm có trong bot, không chỉ riêng đồ Nông Trại.
function fmFishItemMeta(itemId) {
    for (const r of Object.values(FISH_DATA)) {
        if (r.list.includes(itemId)) return { name: itemId, emoji: '🐟', category: 'fish' };
        if (r.drops.includes(itemId)) return { name: itemId, emoji: '🔩', category: 'fish_material' };
    }
    return { name: itemId, emoji: '📦', category: 'fish_material' };
}

// Phân giải 1 key trong phiên !trade (vd: "wh_banh_mi", "seed_lua", "fish_Cá Tra") thành { type, id, name, emoji }
// Dùng slice thay vì split('_') vì rất nhiều itemId có dấu gạch dưới bên trong (banh_mi, sua_bo, khoaitay_chien...)
function fmTradeResolveKey(key) {
    const idx = key.indexOf('_');
    const type = key.slice(0, idx);
    const id = key.slice(idx + 1);
    if (type === 'seed') return { type, id, name: `Hạt ${CROPS[id].name}`, emoji: CROPS[id].emoji };
    if (type === 'fish') { const m = fmFishItemMeta(id); return { type, id, name: m.name, emoji: m.emoji }; }
    const m = fmItemMeta(id);
    return { type, id, name: m.name, emoji: m.emoji };
}

function fmMarketPrice(itemId, guildId) {
    const gd = getGuildData(guildId);
    const meta = fmItemMeta(itemId);
    const mult = gd.farm.market[itemId] || 1;
    return Math.floor(meta.sellPrice * mult);
}

// Đồng bộ 1 ô đất: cập nhật trạng thái growing -> ready dựa theo thời gian thực + thời tiết
function fmSyncPlot(plot, guildId, u) {
    if (plot.state !== 'growing') return plot;
    const weather = fmGetWeather(guildId);
    let speedMult = weather.speedMult;
    if (weather.needWaterOrSlow && !plot.watered && (Date.now() - plot.plantedAt) > 6 * 3600000) {
        speedMult *= 0.80; // Nắng nóng/Hạn hán không tưới > 6 tiếng bị chậm 20%
    }
    const timeReduction = (plot.watered || weather.noWaterNeeded) ? 0.9 : 1; // Tưới nước giảm 10% thời gian
    const effectiveGrowTime = plot.growTime * timeReduction / speedMult;

    // Roll sâu bệnh 1 lần duy nhất khi cây đã lớn qua 30% thời gian sinh trưởng, để người chơi
    // có cơ hội phát hiện và trị bệnh (!thuocsau) trước khi thu hoạch, thay vì chỉ biết lúc thu hoạch.
    if (plot.diseased === undefined && (Date.now() - plot.plantedAt) >= plot.growTime * 0.3) {
        let diseaseChance = 0.05 * (weather.diseaseDoubled ? 2 : 1) * (weather.diseaseMult || 1) * (u && u.upgrades.greenhouse ? 0.5 : 1);
        if (plot.pestProtected || (u && u.upgrades.autoPest)) diseaseChance = 0;
        plot.diseased = Math.random() < diseaseChance;
    }

    if (Date.now() - plot.plantedAt >= effectiveGrowTime) {
        plot.state = 'ready';
    }
    return plot;
}

function fmSyncAllPlots(u, guildId) {
    u.plots.forEach(p => fmSyncPlot(p, guildId, u));
}

// Tính toán chuỗi hiển thị trạng thái 1 ô đất
function fmPlotDisplay(plot) {
    if (plot.state === 'empty') return '⬛ Trống';
    const diseaseTag = plot.diseased ? ' 🐛 **BỊ SÂU BỆNH! Dùng `!thuocsau` để trị ngay**' : '';
    if (plot.state === 'ready') return `🍎 ${CROPS[plot.cropId].emoji} ${CROPS[plot.cropId].name} (Sẵn sàng!)${diseaseTag}`;
    const elapsed = Date.now() - plot.plantedAt;
    const ratio = elapsed / plot.growTime;
    let stageIcon = '🌱';
    if (ratio > 0.66) stageIcon = '🌳';
    else if (ratio > 0.33) stageIcon = '🌿';
    const remainMin = Math.max(0, Math.ceil((plot.growTime - elapsed) / 60000));
    return `${stageIcon} ${CROPS[plot.cropId].emoji} ${CROPS[plot.cropId].name} (còn ~${remainMin} phút)${diseaseTag}`;
}

// Icon 1 ký tự (kèm cờ sâu bệnh) dùng để vẽ lưới ô đất theo hàng ngang
function fmPlotIcon(plot) {
    if (plot.state === 'empty') return '⬛';
    let icon;
    if (plot.state === 'ready') {
        icon = CROPS[plot.cropId].emoji;
    } else {
        const elapsed = Date.now() - plot.plantedAt;
        const ratio = elapsed / plot.growTime;
        icon = ratio > 0.66 ? '🌳' : ratio > 0.33 ? '🌿' : '🌱';
    }
    return plot.diseased ? `${icon}🐛` : icon;
}

// Vẽ lưới các ô đất theo hàng ngang (dạng bảng vuông) thay vì liệt kê dọc,
// giúp hiển thị được nhiều ô hơn mà không bị giới hạn số dòng của Discord.
function fmRenderPlotGrid(plots, cols = 5) {
    const rows = [];
    for (let i = 0; i < plots.length; i += cols) {
        const cells = plots.slice(i, i + cols).map((p, j) => {
            const num = String(i + j + 1).padStart(2, '0');
            return `${num}${fmPlotIcon(p)}`;
        });
        rows.push(cells.join(' '));
    }
    return '```\n' + rows.join('\n') + '\n```';
}

// Danh sách chi tiết chỉ cho những ô ĐANG có cây (bỏ qua ô trống) để giữ thông tin
// quan trọng (tên cây, thời gian còn lại, sâu bệnh) mà không làm dài phần lưới.
function fmPlotDetails(plots) {
    const lines = [];
    plots.forEach((p, i) => {
        if (p.state === 'empty') return;
        lines.push(`\`${i + 1}\` ${fmPlotDisplay(p)}`);
    });
    return lines.join('\n');
}

// Ghép lưới + chi tiết thành nội dung field, tự cắt bớt nếu vượt quá giới hạn 1024 ký tự của Discord
function fmPlotFieldValue(plots, cols = 5) {
    const grid = fmRenderPlotGrid(plots, cols);
    const details = fmPlotDetails(plots);
    let value = details ? `${grid}\n${details}` : grid;
    if (value.length > 1024) {
        value = value.substring(0, 1000) + '\n…(còn nữa)';
    }
    return value;
}

function fmResolveProcessingQueue(u) {
    if (!u.processingQueue.length) return [];
    const done = [];
    u.processingQueue = u.processingQueue.filter(job => {
        if (Date.now() >= job.readyAt) {
            fmAddWh(u, job.recipeId, job.qty);
            done.push(job);
            return false;
        }
        return true;
    });
    return done;
}

async function fmRenderPanel(interaction, u, guildId) {
    fmSyncAllPlots(u, guildId);

    // Máy thu hoạch tự động (nếu đã mua)
    if (u.upgrades.autoHarvest) {
        u.plots.forEach(p => {
            if (p.state === 'ready') {
                fmAddWh(u, p.cropId, p.yieldQty || 1);
                p.state = 'empty';
                delete p.cropId;
                delete p.diseased;
            }
        });
    }
    fmResolveProcessingQueue(u);
    saveData();

    const weather = fmGetWeather(guildId);
    const whTotal = Object.values(u.warehouse).reduce((a, b) => a + b, 0);
    const balance = getBalance(interaction.user.id, guildId);

    const diseasedPlots = u.plots.map((p, i) => ({ p, i })).filter(x => x.p.diseased).map(x => x.i + 1);
    const diseaseWarning = diseasedPlots.length ? `\n🐛 **CẢNH BÁO:** Ô ${diseasedPlots.join(', ')} đang bị sâu bệnh! Dùng \`!thuocsau\` để trị ngay kẻo giảm sản lượng.` : '';

    const embed = new EmbedBuilder()
        .setColor(diseasedPlots.length ? '#e67e22' : '#2ecc71')
        .setAuthor({ name: `Nông Trại của ${interaction.member?.displayName || interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
        .setTitle('🚜 TRANG TRẠI')
        .setDescription(`${weather.emoji} Thời tiết hiện tại: **${weather.name}**${diseaseWarning}`)
        .addFields(
            { name: '💸 Tiền', value: `${balance.toLocaleString()} VNĐ`, inline: true },
            { name: '⚡ Năng lượng', value: `${u.energy}/${u.maxEnergy} kcal${u.energy <= 0 ? ' 🍽️ ĐÓI!' : ''}`, inline: true },
            { name: '🏬 Kho', value: `${whTotal}/${u.warehouseCap}`, inline: true },
            { name: `🌱 Đất trồng (${u.plotCount} ô)`, value: u.plots.length ? fmPlotFieldValue(u.plots) : 'Chưa có ô đất nào.' }
        )
        .setFooter({ text: 'Dùng !shophatgiong, !plant, !thuhoach, !tuoinuoc, !bonphan, !thuocsau, !nangcapnongtrai, !chanuoi, !chebien, !an, !cho, !trade' });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fm_tuoinuoc').setLabel('Tưới Nước').setEmoji('💧').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fm_bonphan').setLabel('Bón Phân').setEmoji('🌱').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('fm_thuocsau').setLabel('Thuốc Sâu').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('fm_lammoi').setLabel('Làm Mới').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    );

    const payload = { embeds: [embed], components: [row1], flags: MessageFlags.Ephemeral };
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await interaction.update(payload).catch(() => interaction.reply(payload));
    } else {
        await interaction.reply(payload);
    }
}

// ==========================================
// NÔNG TRẠI - CRON THỜI TIẾT & THỊ TRƯỜNG (MỖI GIỜ)
// ==========================================
cron.schedule('0 * * * *', () => {
    try {
        for (const guildId of Object.keys(db.guilds)) {
            const gd = getGuildData(guildId);
            const newWeather = ttPickWeather();
            gd.farm.weather = { current: newWeather.id, changedAt: Date.now() };

            // Cập nhật giá thị trường: dao động ngẫu nhiên ±20%
            const allItemIds = [...Object.keys(CROPS), ...Object.values(ANIMALS).map(a => a.product)];
            for (const id of allItemIds) {
                gd.farm.market[id] = +(0.8 + Math.random() * 0.4).toFixed(2);
            }
            // Thương nhân đặc biệt: 1 mặt hàng ngẫu nhiên được mua giá cao (x1.5)
            const specialId = allItemIds[Math.floor(Math.random() * allItemIds.length)];
            gd.farm.market[specialId] = 1.5;
            gd.farm.specialTrader = specialId;

            // Bão: 5% ô đất đang trồng của mỗi người bị hư hại
            if (newWeather.id === 'bao') {
                for (const u of Object.values(gd.farm.users)) {
                    u.plots.forEach(p => {
                        if (p.state === 'growing' && Math.random() < newWeather.damageChance) {
                            p.state = 'empty';
                            delete p.cropId;
                            delete p.diseased;
                        }
                    });
                }
            }
        }
        saveData();
    } catch (e) {
        console.error('Lỗi cron thời tiết Nông Trại:', e);
    }
}, { timezone: 'Asia/Ho_Chi_Minh' });

// ==========================================
// NÔNG TRẠI - LỆNH TIN NHẮN (PREFIX COMMANDS)
// ==========================================
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot || !message.guild) return;
        if (!message.content.startsWith(PREFIX)) return;
        const args = message.content.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const userId = message.author.id;
        const guildId = message.guild.id;

        if (['farm', 'nongtrai'].includes(command)) {
            const u = fmGetUser(userId, guildId);
            fmSyncAllPlots(u, guildId);
            fmResolveProcessingQueue(u);
            saveData();
            const weather = fmGetWeather(guildId);
            const whTotal = Object.values(u.warehouse).reduce((a, b) => a + b, 0);
            const balance = getBalance(userId, guildId);
            const diseasedPlots = u.plots.map((p, i) => ({ p, i })).filter(x => x.p.diseased).map(x => x.i + 1);
            const diseaseWarning = diseasedPlots.length ? `\n🐛 **CẢNH BÁO:** Ô ${diseasedPlots.join(', ')} đang bị sâu bệnh! Dùng \`!thuocsau\` để trị ngay kẻo giảm sản lượng.` : '';
            const embed = new EmbedBuilder()
                .setColor(diseasedPlots.length ? '#e67e22' : '#2ecc71')
                .setAuthor({ name: `Nông Trại của ${message.member.displayName}`, iconURL: message.author.displayAvatarURL() })
                .setTitle('🚜 TRANG TRẠI')
                .setDescription(`${weather.emoji} Thời tiết hiện tại: **${weather.name}**${diseaseWarning}`)
                .addFields(
                    { name: '💸 Tiền', value: `${balance.toLocaleString()} VNĐ`, inline: true },
                    { name: '⚡ Năng lượng', value: `${u.energy}/${u.maxEnergy} kcal${u.energy <= 0 ? ' 🍽️ ĐÓI!' : ''}`, inline: true },
                    { name: '🏬 Kho', value: `${whTotal}/${u.warehouseCap}`, inline: true },
                    { name: `🌱 Đất trồng (${u.plotCount} ô)`, value: u.plots.length ? fmPlotFieldValue(u.plots) : 'Chưa có ô đất nào.' }
                )
                .setFooter({ text: 'Dùng !shophatgiong, !plant, !thuhoach, !tuoinuoc, !bonphan, !thuocsau, !nangcapnongtrai, !chanuoi, !chebien, !an, !cho, !trade' });
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('fm_tuoinuoc').setLabel('Tưới Nước').setEmoji('💧').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('fm_bonphan').setLabel('Bón Phân').setEmoji('🌱').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('fm_thuocsau').setLabel('Thuốc Sâu').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('fm_lammoi').setLabel('Làm Mới').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
            );
            return message.reply({ embeds: [embed], components: [row1] });
        }

        if (command === 'shophatgiong') {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_shophatgiong')
                .setPlaceholder('🌱 Chọn hạt giống muốn mua')
                .addOptions(Object.entries(CROPS).map(([id, c]) => ({
                    label: `${c.name} - ${c.seedPrice.toLocaleString()}đ/hạt`,
                    description: `Thời gian: ${Math.round(c.growTime / 60000)} phút | Bán: ${c.sellPrice.toLocaleString()}đ`,
                    value: id, emoji: c.emoji
                })));
            const embed = new EmbedBuilder().setColor('#f39c12').setTitle('🌱 CỬA HÀNG HẠT GIỐNG')
                .setDescription(Object.values(CROPS).map(c => `${c.emoji} **${c.name}** - ${c.seedPrice.toLocaleString()}đ/hạt | ⏳ ${Math.round(c.growTime / 60000)}p | 💰 Bán ${c.sellPrice.toLocaleString()}đ`).join('\n'));
            return message.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (command === 'plant') {
            const u = fmGetUser(userId, guildId);
            const owned = Object.entries(u.seeds).filter(([, qty]) => qty > 0);
            if (!owned.length) return message.reply('🎒 Bạn chưa có hạt giống nào! Dùng `!shophatgiong` để mua nhé.');
            const emptyCount = u.plots.filter(p => p.state === 'empty').length;
            if (emptyCount === 0) return message.reply('🌱 Bạn không còn ô đất trống nào! Dùng `!nangcapnongtrai` để mở thêm ô.');
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_plant')
                .setPlaceholder('🌱 Chọn hạt giống muốn gieo')
                .addOptions(owned.map(([id, qty]) => ({ label: `${CROPS[id].name} (x${qty})`, value: id, emoji: CROPS[id].emoji })));
            return message.reply({ content: `🌱 Bạn còn **${emptyCount} ô đất trống**. Chọn hạt giống muốn gieo:`, components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (command === 'thuhoach') {
            const u = fmGetUser(userId, guildId);
            fmSyncAllPlots(u, guildId);
            saveData();
            const readyCropIds = [...new Set(u.plots.filter(p => p.state === 'ready').map(p => p.cropId))];
            if (!readyCropIds.length) return message.reply('🍎 Hiện chưa có cây nào sẵn sàng thu hoạch cả!');
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_thuhoach')
                .setPlaceholder('🍎 Chọn loại cây muốn thu hoạch')
                .addOptions(readyCropIds.map(id => {
                    const count = u.plots.filter(p => p.state === 'ready' && p.cropId === id).length;
                    return { label: `${CROPS[id].name} (${count} ô sẵn sàng)`, value: id, emoji: CROPS[id].emoji };
                }));
            return message.reply({ content: '🍎 Chọn loại cây muốn thu hoạch (thu hoạch toàn bộ ô đã chín của loại đó):', components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (['tuoinuoc', 'bonphan', 'thuocsau'].includes(command)) {
            const u = fmGetUser(userId, guildId);
            fmSyncAllPlots(u, guildId);
            const growingIdx = u.plots.map((p, i) => ({ p, i })).filter(x => x.p.state === 'growing');
            if (!growingIdx.length) return message.reply('🌱 Bạn không có cây nào đang phát triển để chăm sóc cả!');
            const actionMap = { tuoinuoc: { flag: 'watered', label: 'Tưới Nước', emoji: '💧' }, bonphan: { flag: 'fertilized', label: 'Bón Phân', emoji: '🌱' }, thuocsau: { flag: 'pestProtected', label: 'Thuốc Sâu', emoji: '🛡️' } };
            const act = actionMap[command];
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`fm_menu_cham_${act.flag}`)
                .setPlaceholder(`${act.emoji} Chọn ô đất muốn ${act.label}`)
                .addOptions(growingIdx.map(x => ({ label: `Ô ${x.i + 1}: ${CROPS[x.p.cropId].name}${x.p[act.flag] ? ' (Đã dùng)' : ''}`, value: String(x.i), emoji: CROPS[x.p.cropId].emoji })));
            return message.reply({ content: `${act.emoji} Chọn ô đất muốn **${act.label}**:`, components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (command === 'nangcapnongtrai') {
            const u = fmGetUser(userId, guildId);
            const morePlotPrice = 200000 * (u.plotCount - 4);
            const khoPrice = 300000 * Math.max(1, Math.floor((u.warehouseCap - 100) / 50) + 1);
            const options = [
                ...(u.plotCount < FARM_MAX_PLOTS ? [{ label: `Mở Thêm Ô Đất - ${morePlotPrice.toLocaleString()}đ`, value: 'more_plot', emoji: '🟫' }] : []),
                { label: `Nhà Kho Lớn Hơn (+50) - ${khoPrice.toLocaleString()}đ`, value: 'kho', emoji: '🏬' },
                { label: `Phân Bón Cao Cấp (x1) - ${(20000).toLocaleString()}đ`, value: 'phan_bon_cao_cap', emoji: '💩' },
                ...Object.entries(FARM_UPGRADE_FLAGS).filter(([id, up]) => !u.upgrades[up.flag]).map(([id, up]) => ({ label: `${up.name} - ${up.price.toLocaleString()}đ`, value: id, emoji: '🚜' }))
            ];
            const menu = new StringSelectMenuBuilder().setCustomId('fm_menu_nangcap').setPlaceholder('🚜 Chọn nâng cấp muốn mua').addOptions(options);
            const desc = Object.entries(FARM_UPGRADE_FLAGS).map(([id, up]) => `**${up.name}**: ${up.desc} (${up.price.toLocaleString()}đ)${u.upgrades[up.flag] ? ' <a:emoji_75:1524039622668189806> Đã sở hữu' : ''}`).join('\n');
            const embed = new EmbedBuilder().setColor('#8e44ad').setTitle('🚜 NÂNG CẤP NÔNG TRẠI').setDescription(desc);
            return message.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (['chanuoi', 'vatnuoi'].includes(command)) {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_chanuoi_action')
                .setPlaceholder('🐄 Chọn hành động chăn nuôi')
                .addOptions([
                    { label: 'Mua Vật Nuôi', value: 'mua', emoji: '🛒' },
                    { label: 'Cho Ăn (Cám)', value: 'choan', emoji: '🌰' },
                    { label: 'Thu Hoạch Sản Phẩm', value: 'thuhoach', emoji: '🧺' },
                    { label: 'Xem Chuồng Trại', value: 'xem', emoji: '📋' }
                ]);
            return message.reply({ content: '🐄 **KHU CHĂN NUÔI** - Chọn hành động:', components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (['chebien'].includes(command)) {
            const u = fmGetUser(userId, guildId);
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_chebien')
                .setPlaceholder('🏭 Chọn công thức chế biến')
                .addOptions(Object.entries(RECIPES).map(([id, r]) => ({
                    label: `${r.name} (${Math.round(r.time / 60000)}p)`,
                    description: `Cần: ${Object.entries(r.need).map(([k, v]) => `${v}x ${fmItemMeta(k).name}`).join(', ')}`,
                    value: id, emoji: r.emoji
                })));
            const doneJobs = fmResolveProcessingQueue(u);
            saveData();
            let content = '🏭 **XƯỞNG CHẾ BIẾN** - Chọn công thức muốn chế biến:';
            if (doneJobs.length) content = `<a:emoji_75:1524039622668189806> Đã hoàn thành ${doneJobs.length} mẻ chế biến trước đó, vật phẩm đã vào Kho!\n\n` + content;
            return message.reply({ content, components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (command === 'an') {
            const u = fmGetUser(userId, guildId);
            const foodItems = Object.entries(u.warehouse).filter(([id, qty]) => qty > 0 && (RECIPES[id] || id === 'cam'));
            if (!foodItems.length) return message.reply('🍽️ Bạn không có thức ăn nào trong Kho! Hãy `!chebien` để làm thức ăn nhé.');
            if (u.energy >= u.maxEnergy) return message.reply('⚡ Năng lượng của bạn đã đầy rồi!');
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_an')
                .setPlaceholder('🍽️ Chọn món ăn')
                .addOptions(foodItems.map(([id, qty]) => {
                    const meta = fmItemMeta(id);
                    const energy = RECIPES[id]?.energy || 50;
                    return { label: `${meta.name} (x${qty}) +${energy}kcal`, value: id, emoji: meta.emoji };
                }));
            return message.reply({ content: '🍽️ Chọn món ăn để nạp năng lượng:', components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (['cho', 'thitruong'].includes(command)) {
            const gd = getGuildData(guildId);
            const weather = fmGetWeather(guildId);
            const cropLines = Object.entries(CROPS).map(([id, c]) => {
                const price = fmMarketPrice(id, guildId);
                const special = gd.farm.specialTrader === id ? ' 🔥(Thương nhân đặc biệt!)' : '';
                return `${c.emoji} **${c.name}**: ${price.toLocaleString()}đ${special}`;
            }).join('\n');
            const animalLines = Object.values(ANIMALS).map(a => {
                const price = fmMarketPrice(a.product, guildId);
                const special = gd.farm.specialTrader === a.product ? ' 🔥(Thương nhân đặc biệt!)' : '';
                return `${a.productEmoji} **${a.productName}**: ${price.toLocaleString()}đ${special}`;
            }).join('\n');
            const embed = new EmbedBuilder().setColor('#e67e22').setTitle('🛒 CHỢ NÔNG SẢN')
                .setDescription(`${weather.emoji} Thời tiết: **${weather.name}** | Giá thị trường cập nhật mỗi giờ`)
                .addFields({ name: '🌾 Nông sản', value: cropLines, inline: true }, { name: '🐄 Sản phẩm chăn nuôi', value: animalLines, inline: true })
                .setFooter({ text: 'Dùng !bannongsan để bán nông sản trong Kho của bạn' });
            return message.reply({ embeds: [embed] });
        }

        if (command === 'bannongsan') {
            const u = fmGetUser(userId, guildId);
            const sellable = Object.entries(u.warehouse).filter(([id, qty]) => qty > 0 && fmItemMeta(id).sellPrice > 0);
            if (!sellable.length) return message.reply('🏬 Kho của bạn không có nông sản nào để bán!');
            const menu = new StringSelectMenuBuilder()
                .setCustomId('fm_menu_ban')
                .setPlaceholder('💰 Chọn vật phẩm muốn bán')
                .addOptions(sellable.map(([id, qty]) => {
                    const meta = fmItemMeta(id);
                    return { label: `${meta.name} (x${qty}) - ${fmMarketPrice(id, guildId).toLocaleString()}đ/cái`, value: id, emoji: meta.emoji };
                }));
            return message.reply({ content: '💰 Chọn vật phẩm muốn bán:', components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (command === 'trade') {
            const target = message.mentions.users.first();
            if (!target || target.bot || target.id === userId) return message.reply('⚠️ Vui lòng tag một người chơi khác để trao đổi! VD: `!trade @user`');
            if (!activeGames.trade) activeGames.trade = new Map();
            const existing = [...activeGames.trade.values()].find(s => [s.userA, s.userB].includes(userId) && [s.userA, s.userB].includes(target.id));
            if (existing) return message.reply('⚠️ Đã có một phiên trao đổi đang diễn ra giữa hai người!');
            const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // Chỉ chứa chữ+số, không có dấu gạch dưới
            const tradeState = { userA: userId, userB: target.id, offers: { [userId]: {}, [target.id]: {} }, ready: { [userId]: false, [target.id]: false }, guildId };
            activeGames.trade.set(sessionId, tradeState);

            const embed = fmBuildTradeEmbed(tradeState);
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`fm_trade_add_${sessionId}`).setLabel('Thêm Vật Phẩm').setEmoji('➕').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`fm_trade_ready_${sessionId}`).setLabel('Sẵn Sàng').setEmoji('<a:emoji_75:1524039622668189806>').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`fm_trade_cancel_${sessionId}`).setLabel('Hủy').setEmoji('❌').setStyle(ButtonStyle.Danger)
            );
            return message.reply({ content: `<@${userId}> đã mời <@${target.id}> trao đổi vật phẩm!`, embeds: [embed], components: [row1] });
        }
    } catch (error) {
        console.error('Lỗi hệ thống Nông Trại (message):', error);
    }
});

function fmBuildTradeEmbed(state) {
    const line = (uid) => {
        const items = Object.entries(state.offers[uid]);
        if (!items.length) return '_Chưa thêm vật phẩm nào_';
        return items.map(([key, qty]) => {
            const r = fmTradeResolveKey(key);
            return `${r.emoji} ${r.name} x${qty}`;
        }).join('\n');
    };
    return new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('🤝 TRAO ĐỔI VẬT PHẨM')
        .addFields(
            { name: `👤 <@${state.userA}> ${state.ready[state.userA] ? '<a:emoji_75:1524039622668189806>' : '⏳'}`, value: line(state.userA), inline: true },
            { name: `👤 <@${state.userB}> ${state.ready[state.userB] ? '<a:emoji_75:1524039622668189806>' : '⏳'}`, value: line(state.userB), inline: true }
        )
        .setFooter({ text: 'Có thể trao đổi Nông sản, Hạt giống, Đồ chế biến, Sản phẩm chăn nuôi, Cá & Nguyên liệu câu cá. Không thể trao đổi Tiền, Thuốc hoặc Máy móc. Cả 2 bên bấm Sẵn Sàng để hoàn tất.' });
}

// ==========================================
// NÔNG TRẠI - XỬ LÝ TƯƠNG TÁC (BUTTON / SELECT / MODAL)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.guildId) return;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const isFarmInteraction = (interaction.customId && interaction.customId.startsWith('fm_'));
        if (!isFarmInteraction) return;

        const u = fmGetUser(userId, guildId);

        // --- NÚT BẤM CHÍNH ---
        if (interaction.isButton()) {
            if (interaction.customId === 'fm_lammoi') return fmRenderPanel(interaction, u, guildId);

            if (interaction.customId === 'fm_tuoinuoc' || interaction.customId === 'fm_bonphan' || interaction.customId === 'fm_thuocsau') {
                fmSyncAllPlots(u, guildId);
                const growingIdx = u.plots.map((p, i) => ({ p, i })).filter(x => x.p.state === 'growing');
                if (!growingIdx.length) return interaction.reply({ content: '🌱 Bạn không có cây nào đang phát triển!', ephemeral: true });
                const map = { fm_tuoinuoc: { flag: 'watered', emoji: '💧', label: 'Tưới Nước' }, fm_bonphan: { flag: 'fertilized', emoji: '🌱', label: 'Bón Phân' }, fm_thuocsau: { flag: 'pestProtected', emoji: '🛡️', label: 'Thuốc Sâu' } };
                const act = map[interaction.customId];
                const menu = new StringSelectMenuBuilder().setCustomId(`fm_menu_cham_${act.flag}`).setPlaceholder(`${act.emoji} Chọn ô đất`)
                    .addOptions(growingIdx.map(x => ({ label: `Ô ${x.i + 1}: ${CROPS[x.p.cropId].name}${x.p[act.flag] ? ' (Đã dùng)' : ''}`, value: String(x.i), emoji: CROPS[x.p.cropId].emoji })));
                return interaction.reply({ content: `${act.emoji} Chọn ô đất muốn **${act.label}**:`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
            }

            // --- NÚT TRADE ---
            if (interaction.customId.startsWith('fm_trade_')) {
                const rest = interaction.customId.replace('fm_trade_', '');
                const action = rest.split('_')[0]; // add | ready | cancel
                const tradeKey = rest.slice(action.length + 1);
                const state = activeGames.trade?.get(tradeKey);
                if (!state) return interaction.reply({ content: '⚠️ Phiên trao đổi này không còn tồn tại!', ephemeral: true });
                if (![state.userA, state.userB].includes(userId)) return interaction.reply({ content: '⚠️ Bạn không tham gia phiên trao đổi này!', ephemeral: true });

                if (action === 'cancel') {
                    activeGames.trade.delete(tradeKey);
                    return interaction.update({ content: `❌ <@${userId}> đã hủy phiên trao đổi.`, embeds: [], components: [] });
                }

                if (action === 'add') {
                    const uu = fmGetUser(userId, guildId);
                    const fu = fishingGetUser(userId, guildId);
                    // Cho phép trao đổi TOÀN BỘ ID vật phẩm trong bot: nông sản, đồ chế biến, sản phẩm chăn nuôi,
                    // hạt giống, cá câu được và nguyên liệu chế đồ câu cá. Chỉ chặn Tiền, Thuốc và Máy móc.
                    const tradeableItems = Object.entries(uu.warehouse).filter(([id, qty]) => qty > 0 && fmItemMeta(id).category !== 'medicine');
                    const tradeableSeeds = Object.entries(uu.seeds).filter(([, qty]) => qty > 0);
                    const tradeableFish = Object.entries(fu.inventory).filter(([, qty]) => qty > 0);
                    const allOptions = [
                        ...tradeableItems.map(([id, qty]) => ({ label: `${fmItemMeta(id).name} (x${qty})`, value: `wh_${id}`, emoji: fmItemMeta(id).emoji })),
                        ...tradeableSeeds.map(([id, qty]) => ({ label: `Hạt ${CROPS[id].name} (x${qty})`, value: `seed_${id}`, emoji: CROPS[id].emoji })),
                        ...tradeableFish.map(([id, qty]) => ({ label: `${id} (x${qty})`, value: `fish_${id}`, emoji: fmFishItemMeta(id).emoji }))
                    ];
                    if (!allOptions.length) return interaction.reply({ content: '🎒 Bạn không có vật phẩm nào để thêm vào trao đổi! (Tiền, thuốc và máy móc không thể trao đổi)', ephemeral: true });
                    const truncated = allOptions.length > 25;
                    const menu = new StringSelectMenuBuilder().setCustomId(`fm_trade_pick_${tradeKey}`).setPlaceholder('Chọn vật phẩm muốn thêm vào giao dịch').addOptions(allOptions.slice(0, 25));
                    const warnText = truncated ? `⚠️ Bạn có ${allOptions.length} loại vật phẩm, chỉ hiện được 25 loại đầu tiên. ` : '';
                    return interaction.reply({ content: `${warnText}Chọn vật phẩm muốn thêm vào giao dịch:`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
                }

                if (action === 'ready') {
                    state.ready[userId] = true;
                    await interaction.update({ embeds: [fmBuildTradeEmbed(state)] });
                    if (state.ready[state.userA] && state.ready[state.userB]) {
                        const chan = interaction.channel;
                        for (let s = 3; s >= 1; s--) {
                            await chan.send(`⏳ Trao đổi sẽ được thực hiện sau **${s}s**... (Ai đó bấm lại nút để hủy)`).then(m => setTimeout(() => m.delete().catch(() => {}), 2500));
                            await new Promise(r => setTimeout(r, 1000));
                            const stillExists = activeGames.trade.get(tradeKey);
                            if (!stillExists) return; // Đã bị hủy giữa chừng
                        }
                        const finalState = activeGames.trade.get(tradeKey);
                        if (!finalState) return;
                        const uA = fmGetUser(finalState.userA, guildId);
                        const uB = fmGetUser(finalState.userB, guildId);
                        const fA = fishingGetUser(finalState.userA, guildId);
                        const fB = fishingGetUser(finalState.userB, guildId);
                        // Trừ đồ 2 bên và trao cho nhau (dùng indexOf thay vì split('_') vì nhiều itemId có dấu gạch dưới bên trong)
                        for (const [key, qty] of Object.entries(finalState.offers[finalState.userA])) {
                            const sep = key.indexOf('_');
                            const type = key.slice(0, sep);
                            const id = key.slice(sep + 1);
                            if (type === 'wh') { uA.warehouse[id] = Math.max(0, (uA.warehouse[id] || 0) - qty); fmAddWh(uB, id, qty); }
                            else if (type === 'seed') { uA.seeds[id] = Math.max(0, (uA.seeds[id] || 0) - qty); uB.seeds[id] = (uB.seeds[id] || 0) + qty; }
                            else if (type === 'fish') { fA.inventory[id] = Math.max(0, (fA.inventory[id] || 0) - qty); if (fA.inventory[id] <= 0) delete fA.inventory[id]; fB.inventory[id] = (fB.inventory[id] || 0) + qty; }
                        }
                        for (const [key, qty] of Object.entries(finalState.offers[finalState.userB])) {
                            const sep = key.indexOf('_');
                            const type = key.slice(0, sep);
                            const id = key.slice(sep + 1);
                            if (type === 'wh') { uB.warehouse[id] = Math.max(0, (uB.warehouse[id] || 0) - qty); fmAddWh(uA, id, qty); }
                            else if (type === 'seed') { uB.seeds[id] = Math.max(0, (uB.seeds[id] || 0) - qty); uA.seeds[id] = (uA.seeds[id] || 0) + qty; }
                            else if (type === 'fish') { fB.inventory[id] = Math.max(0, (fB.inventory[id] || 0) - qty); if (fB.inventory[id] <= 0) delete fB.inventory[id]; fA.inventory[id] = (fA.inventory[id] || 0) + qty; }
                        }
                        saveData();
                        activeGames.trade.delete(tradeKey);
                        await chan.send(`<a:emoji_75:1524039622668189806> Trao đổi giữa <@${finalState.userA}> và <@${finalState.userB}> đã hoàn tất thành công!`);
                    }
                    return;
                }
            }
        }

        // --- SELECT MENU ---
        if (interaction.isStringSelectMenu()) {
            const value = interaction.values[0];

            if (interaction.customId === 'fm_menu_shophatgiong') {
                const modal = new ModalBuilder().setCustomId(`fm_modal_muahat_${value}`).setTitle(`Mua hạt ${CROPS[value].name}`);
                const input = new TextInputBuilder().setCustomId('qty').setLabel('Số lượng muốn mua').setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'fm_menu_plant') {
                const emptyCount = u.plots.filter(p => p.state === 'empty').length;
                const modal = new ModalBuilder().setCustomId(`fm_modal_plant_${value}`).setTitle(`Gieo hạt ${CROPS[value].name}`);
                const input = new TextInputBuilder().setCustomId('qty').setLabel(`Số lượng gieo (tối đa ${emptyCount} ô trống)`).setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'fm_menu_thuhoach') {
                fmSyncAllPlots(u, guildId);
                const cropId = value;
                const readyPlots = u.plots.filter(p => p.state === 'ready' && p.cropId === cropId);
                if (!readyPlots.length) return interaction.reply({ content: '❌ Không còn ô nào của loại cây này sẵn sàng thu hoạch!', ephemeral: true });

                const energyCost = readyPlots.length * ENERGY_CONFIG.costs.thu_hoach;
                if (!fmHasEnergy(u, energyCost)) return interaction.reply({ content: `⚡ Bạn không đủ năng lượng để thu hoạch ${readyPlots.length} ô (cần **${energyCost}kcal**, còn **${u.energy}kcal**)! Hãy dùng \`!an\` để ăn gì đó trước.`, ephemeral: true });

                let totalYield = 0, rareCount = 0, mutateCount = 0, diseasedCount = 0;
                const gd = getGuildData(guildId);
                const weather = fmGetWeather(guildId);
                const mutateChance = 0.05 + (weather.mutateBonus || 0);
                for (const p of u.plots) {
                    if (p.state !== 'ready' || p.cropId !== cropId) continue;
                    let qty = 1;
                    // Dùng trạng thái bệnh đã theo dõi từ lúc cây còn đang lớn (fmSyncPlot), không roll lại ở đây
                    const diseased = !!p.diseased;

                    if (diseased) { qty = Math.max(1, Math.floor(qty * 0.5)); diseasedCount++; }
                    else {
                        if (p.fertilized || u.upgrades.autoFertilize) qty = Math.floor(qty * 1.2) || 1;
                        if (Math.random() < 0.1) { qty *= 2; rareCount++; } // ⭐ Thu hoạch hiếm
                    }
                    let sellMult = 1;
                    if (!diseased && Math.random() < mutateChance) { sellMult = 2; mutateCount++; } // 💎 Đột biến (Cầu vồng tăng tỉ lệ)

                    const added = fmAddWh(u, cropId, qty);
                    totalYield += added;
                    if (sellMult > 1 && added > 0) {
                        // Đột biến: đánh dấu giá trị cao hơn bằng cách cộng thêm phần thưởng tiền mặt trực tiếp
                        addBalance(userId, Math.floor(CROPS[cropId].sellPrice * added * (sellMult - 1)), guildId);
                    }
                    p.state = 'empty';
                    delete p.cropId;
                    delete p.diseased;
                }
                fmSpendEnergy(u, energyCost);
                saveData();
                let extra = [];
                if (rareCount) extra.push(`⭐ ${rareCount} lần thu hoạch hiếm (x2 sản lượng)`);
                if (mutateCount) extra.push(`💎 ${mutateCount} lần đột biến (bán giá cao, đã cộng thêm tiền)`);
                if (diseasedCount) extra.push(`🐛 ${diseasedCount} ô bị sâu bệnh (giảm sản lượng)`);
                return interaction.reply({ content: `🍎 Thu hoạch thành công **${totalYield}x ${CROPS[cropId].name}** vào Kho! (-${energyCost}kcal, còn ${u.energy}/${u.maxEnergy})${extra.length ? '\n' + extra.join('\n') : ''}`, ephemeral: false });
            }

            if (interaction.customId.startsWith('fm_menu_cham_')) {
                const flag = interaction.customId.replace('fm_menu_cham_', '');
                const idx = parseInt(value);
                const plot = u.plots[idx];
                if (!plot || plot.state !== 'growing') return interaction.reply({ content: '❌ Ô đất này không còn hợp lệ!', ephemeral: true });
                if (plot[flag]) return interaction.reply({ content: '⚠️ Ô đất này đã được chăm sóc rồi!', ephemeral: true });
                if (!fmHasEnergy(u, ENERGY_CONFIG.costs.cham_soc)) return interaction.reply({ content: `⚡ Bạn không đủ năng lượng (cần **${ENERGY_CONFIG.costs.cham_soc}kcal**)! Hãy dùng \`!an\` để ăn gì đó trước.`, ephemeral: true });
                plot[flag] = true;
                fmSpendEnergy(u, ENERGY_CONFIG.costs.cham_soc);
                let curedText = '';
                if (flag === 'pestProtected' && plot.diseased) {
                    plot.diseased = false;
                    curedText = '\n🐛➡️✅ Đã trị khỏi sâu bệnh cho ô đất này!';
                }
                saveData();
                const labelMap = { watered: '💧 Tưới nước (giảm 10% thời gian sinh trưởng)', fertilized: '🌱 Bón phân (tăng sản lượng)', pestProtected: '🛡️ Thuốc sâu (tránh/trị sâu bệnh)' };
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã áp dụng **${labelMap[flag]}** cho ô ${idx + 1}! (-${ENERGY_CONFIG.costs.cham_soc}kcal, còn ${u.energy}/${u.maxEnergy})${curedText}`, ephemeral: true });
            }

            if (interaction.customId === 'fm_menu_nangcap') {
                if (value === 'more_plot') {
                    if (u.plotCount >= FARM_MAX_PLOTS) return interaction.reply({ content: `❌ Bạn đã đạt số ô đất tối đa (**${FARM_MAX_PLOTS} ô**)!`, ephemeral: true });
                    const price = 200000 * (u.plotCount - 4);
                    if (getBalance(userId, guildId) < price) return interaction.reply({ content: `❌ Bạn cần **${price.toLocaleString()}đ** để mở thêm ô đất!`, ephemeral: true });
                    addBalance(userId, -price, guildId);
                    u.plots.push({ state: 'empty' });
                    u.plotCount++;
                    saveData();
                    return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mở thêm 1 ô đất! Hiện tại bạn có **${u.plotCount} ô**.`, ephemeral: true });
                }
                if (value === 'kho') {
                    const price = 300000 * Math.max(1, Math.floor((u.warehouseCap - 100) / 50) + 1);
                    if (getBalance(userId, guildId) < price) return interaction.reply({ content: `❌ Bạn cần **${price.toLocaleString()}đ** để mở rộng kho!`, ephemeral: true });
                    addBalance(userId, -price, guildId);
                    u.warehouseCap += 50;
                    saveData();
                    return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Nhà kho đã được mở rộng! Sức chứa hiện tại: **${u.warehouseCap}**.`, ephemeral: true });
                }
                if (value === 'phan_bon_cao_cap') {
                    const modal = new ModalBuilder().setCustomId('fm_modal_phanboncc').setTitle('Mua Phân Bón Cao Cấp');
                    const qtyInput = new TextInputBuilder().setCustomId('qty').setLabel('Nhập số lượng muốn mua (20,000đ/cái):').setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
                    return interaction.showModal(modal);
                }
                const up = FARM_UPGRADE_FLAGS[value];
                if (up) {
                    if (u.upgrades[up.flag]) return interaction.reply({ content: '⚠️ Bạn đã sở hữu nâng cấp này rồi!', ephemeral: true });
                    if (getBalance(userId, guildId) < up.price) return interaction.reply({ content: `❌ Bạn cần **${up.price.toLocaleString()}đ** để mua **${up.name}**!`, ephemeral: true });
                    addBalance(userId, -up.price, guildId);
                    u.upgrades[up.flag] = true;
                    saveData();
                    return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mua **${up.name}**! ${up.desc}`, ephemeral: true });
                }
            }

            if (interaction.customId === 'fm_menu_chanuoi_action') {
                if (value === 'mua') {
                    const menu = new StringSelectMenuBuilder().setCustomId('fm_menu_muavatnuoi').setPlaceholder('🛒 Chọn vật nuôi muốn mua')
                        .addOptions(Object.entries(ANIMALS).map(([id, a]) => ({ label: `${a.name} - ${a.price.toLocaleString()}đ`, description: `Tạo ${a.productName} sau mỗi ${Math.round(a.prodTime / 3600000)} giờ`, value: id, emoji: a.emoji })));
                    return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
                }
                if (value === 'choan') {
                    const owned = Object.entries(u.animals).filter(([, a]) => a.count > 0);
                    if (!owned.length) return interaction.reply({ content: '🐄 Bạn chưa nuôi con vật nào!', ephemeral: true });
                    const totalNeed = owned.reduce((sum, [, a]) => sum + (a.fed ? 0 : a.count), 0);
                    const cost = totalNeed * CAM_PRICE;
                    if (totalNeed === 0) return interaction.reply({ content: '<a:emoji_75:1524039622668189806> Toàn bộ vật nuôi của bạn đã được cho ăn rồi!', ephemeral: true });
                    if (getBalance(userId, guildId) < cost) return interaction.reply({ content: `❌ Bạn cần **${cost.toLocaleString()}đ** để mua Cám cho ăn (${totalNeed} phần)!`, ephemeral: true });
                    addBalance(userId, -cost, guildId);
                    owned.forEach(([id, a]) => { a.fed = true; });
                    saveData();
                    return interaction.reply({ content: `🌰 Đã cho ăn toàn bộ vật nuôi với giá **${cost.toLocaleString()}đ**!`, ephemeral: true });
                }
                if (value === 'thuhoach') {
                    let collected = [];
                    for (const [id, a] of Object.entries(u.animals)) {
                        if (a.count > 0 && a.fed && Date.now() - (a.lastCollect || 0) >= ANIMALS[id].prodTime) {
                            const qty = fmAddWh(u, ANIMALS[id].product, a.count);
                            if (qty > 0) {
                                collected.push(`${ANIMALS[id].productEmoji} ${qty}x ${ANIMALS[id].productName}`);
                                a.lastCollect = Date.now();
                                a.fed = false;
                            }
                        }
                    }
                    saveData();
                    if (!collected.length) return interaction.reply({ content: '⏳ Chưa có vật nuôi nào sẵn sàng cho sản phẩm (cần cho ăn và đủ thời gian)!', ephemeral: true });
                    return interaction.reply({ content: `🧺 Đã thu hoạch:\n${collected.join('\n')}`, ephemeral: false });
                }
                if (value === 'xem') {
                    const lines = Object.entries(u.animals).filter(([, a]) => a.count > 0).map(([id, a]) => {
                        const remain = Math.max(0, Math.ceil((ANIMALS[id].prodTime - (Date.now() - (a.lastCollect || 0))) / 60000));
                        return `${ANIMALS[id].emoji} **${ANIMALS[id].name}** x${a.count} - ${a.fed ? '🍽️ Đã ăn' : '🚫 Chưa ăn'} - Sản phẩm sau: ${a.fed ? `${remain} phút` : 'chưa cho ăn'}`;
                    }).join('\n') || 'Bạn chưa nuôi con vật nào.';
                    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('📋 Chuồng Trại').setDescription(lines)], ephemeral: true });
                }
            }

            if (interaction.customId === 'fm_menu_muavatnuoi') {
                const modal = new ModalBuilder().setCustomId(`fm_modal_muavatnuoi_${value}`).setTitle(`Mua ${ANIMALS[value].name}`);
                const input = new TextInputBuilder().setCustomId('qty').setLabel('Số lượng muốn mua').setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'fm_menu_chebien') {
                const modal = new ModalBuilder().setCustomId(`fm_modal_chebien_${value}`).setTitle(`Chế biến ${RECIPES[value].name}`);
                const input = new TextInputBuilder().setCustomId('qty').setLabel('Số lượng muốn chế biến').setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'fm_menu_an') {
                const itemId = value;
                if (!u.warehouse[itemId] || u.warehouse[itemId] <= 0) return interaction.reply({ content: '❌ Bạn không còn món ăn này!', ephemeral: true });
                const energy = RECIPES[itemId]?.energy || 50;
                u.warehouse[itemId] -= 1;
                if (u.warehouse[itemId] <= 0) delete u.warehouse[itemId];
                u.energy = Math.min(u.maxEnergy, u.energy + energy);
                saveData();
                return interaction.reply({ content: `🍽️ Đã ăn **${fmItemMeta(itemId).name}**, hồi **+${energy}kcal**! (${u.energy}/${u.maxEnergy})`, ephemeral: true });
            }

            if (interaction.customId === 'fm_menu_ban') {
                const modal = new ModalBuilder().setCustomId(`fm_modal_ban_${value}`).setTitle(`Bán ${fmItemMeta(value).name}`);
                const input = new TextInputBuilder().setCustomId('qty').setLabel('Số lượng muốn bán').setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (interaction.customId.startsWith('fm_trade_pick_')) {
                const tradeKey = interaction.customId.replace('fm_trade_pick_', '');
                const state = activeGames.trade?.get(tradeKey);
                if (!state) return interaction.reply({ content: '⚠️ Phiên trao đổi không còn tồn tại!', ephemeral: true });
                const sep = value.indexOf('_');
                const type = value.slice(0, sep);
                const itemId = value.slice(sep + 1);
                const modal = new ModalBuilder().setCustomId(`fm_modal_tradeqty_${tradeKey}_${value}`).setTitle('Nhập số lượng');
                const input = new TextInputBuilder().setCustomId('qty').setLabel('Số lượng muốn đưa vào giao dịch').setStyle(TextInputStyle.Short).setRequired(true).setValue('1');
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
        }

        // --- MODAL SUBMIT ---
        if (interaction.isModalSubmit()) {
            const qtyRaw = interaction.fields.getTextInputValue('qty');
            const qty = parseInt(qtyRaw);

            if (interaction.customId === 'fm_modal_phanboncc') {
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });
                const unitPrice = 20000;
                const total = unitPrice * qty;
                if (getBalance(userId, guildId) < total) return interaction.reply({ content: `❌ Bạn cần **${total.toLocaleString()}đ** để mua ${qty}x Phân Bón Cao Cấp!`, ephemeral: true });
                addBalance(userId, -total, guildId);
                u.warehouse['phan_bon_cao_cap'] = (u.warehouse['phan_bon_cao_cap'] || 0) + qty;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mua **${qty}x Phân Bón Cao Cấp** với giá **${total.toLocaleString()}đ**, hãy dùng khi Bón Phân để tăng thêm sản lượng!`, ephemeral: true });
            }

            if (interaction.customId.startsWith('fm_modal_muahat_')) {
                const cropId = interaction.customId.replace('fm_modal_muahat_', '');
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });
                const total = CROPS[cropId].seedPrice * qty;
                if (getBalance(userId, guildId) < total) return interaction.reply({ content: `❌ Bạn cần **${total.toLocaleString()}đ** để mua ${qty}x hạt ${CROPS[cropId].name}!`, ephemeral: true });
                addBalance(userId, -total, guildId);
                u.seeds[cropId] = (u.seeds[cropId] || 0) + qty;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mua **${qty}x hạt ${CROPS[cropId].name}** với giá **${total.toLocaleString()}đ**!`, ephemeral: true });
            }

            if (interaction.customId.startsWith('fm_modal_plant_')) {
                const cropId = interaction.customId.replace('fm_modal_plant_', '');
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });
                if ((u.seeds[cropId] || 0) < qty) return interaction.reply({ content: '❌ Bạn không đủ hạt giống!', ephemeral: true });
                const emptyPlots = u.plots.filter(p => p.state === 'empty');
                if (emptyPlots.length < qty) return interaction.reply({ content: `❌ Bạn chỉ còn **${emptyPlots.length} ô đất trống**!`, ephemeral: true });
                const weather = fmGetWeather(guildId);
                for (let i = 0; i < qty; i++) {
                    const plot = emptyPlots[i];
                    plot.state = 'growing';
                    plot.cropId = cropId;
                    plot.growTime = CROPS[cropId].growTime;
                    plot.plantedAt = Date.now();
                    plot.watered = weather.noWaterNeeded || false;
                    plot.fertilized = !!u.upgrades.autoFertilize;
                    plot.pestProtected = !!u.upgrades.autoPest;
                }
                u.seeds[cropId] -= qty;
                if (u.seeds[cropId] <= 0) delete u.seeds[cropId];
                saveData();
                return interaction.reply({ content: `🌱 Đã gieo **${qty}x hạt ${CROPS[cropId].name}**!`, ephemeral: true });
            }

            if (interaction.customId.startsWith('fm_modal_muavatnuoi_')) {
                const animalId = interaction.customId.replace('fm_modal_muavatnuoi_', '');
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });
                const total = ANIMALS[animalId].price * qty;
                if (getBalance(userId, guildId) < total) return interaction.reply({ content: `❌ Bạn cần **${total.toLocaleString()}đ**!`, ephemeral: true });
                addBalance(userId, -total, guildId);
                if (!u.animals[animalId]) u.animals[animalId] = { count: 0, fed: false, lastCollect: Date.now() };
                u.animals[animalId].count += qty;
                saveData();
                return interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã mua **${qty}x ${ANIMALS[animalId].name}** với giá **${total.toLocaleString()}đ**!`, ephemeral: true });
            }

            if (interaction.customId.startsWith('fm_modal_chebien_')) {
                const recipeId = interaction.customId.replace('fm_modal_chebien_', '');
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });
                const recipe = RECIPES[recipeId];
                for (const [mat, need] of Object.entries(recipe.need)) {
                    if ((u.warehouse[mat] || 0) < need * qty) {
                        return interaction.reply({ content: `❌ Bạn thiếu nguyên liệu! Cần **${need * qty}x ${fmItemMeta(mat).name}**.`, ephemeral: true });
                    }
                }
                for (const [mat, need] of Object.entries(recipe.need)) {
                    u.warehouse[mat] -= need * qty;
                    if (u.warehouse[mat] <= 0) delete u.warehouse[mat];
                }
                u.processingQueue.push({ recipeId, qty, readyAt: Date.now() + recipe.time });
                saveData();
                return interaction.reply({ content: `🏭 Đang chế biến **${qty}x ${recipe.name}**, sẽ sẵn sàng sau **${Math.round(recipe.time / 60000)} phút** (tự động vào Kho, kiểm tra lại bằng !chebien hoặc !farm).`, ephemeral: true });
            }

            if (interaction.customId.startsWith('fm_modal_ban_')) {
                const itemId = interaction.customId.replace('fm_modal_ban_', '');
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });
                if ((u.warehouse[itemId] || 0) < qty) return interaction.reply({ content: '❌ Bạn không đủ số lượng trong Kho!', ephemeral: true });
                const unitPrice = fmMarketPrice(itemId, guildId);
                const total = unitPrice * qty;
                u.warehouse[itemId] -= qty;
                if (u.warehouse[itemId] <= 0) delete u.warehouse[itemId];
                addBalance(userId, total, guildId);
                saveData();
                return interaction.reply({ content: `💰 Đã bán **${qty}x ${fmItemMeta(itemId).name}** với giá **${total.toLocaleString()}đ**!`, ephemeral: true });
            }

            if (interaction.customId.startsWith('fm_modal_tradeqty_')) {
                const rest = interaction.customId.replace('fm_modal_tradeqty_', ''); // "${sessionId}_${value}", sessionId không chứa dấu gạch dưới
                const firstSep = rest.indexOf('_');
                const tradeKey = rest.slice(0, firstSep);
                const value = rest.slice(firstSep + 1); // "wh_itemId" hoặc "seed_itemId"
                const state = activeGames.trade?.get(tradeKey);
                if (!state) return interaction.reply({ content: '⚠️ Phiên trao đổi không còn tồn tại!', ephemeral: true });
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: '❌ Số lượng không hợp lệ!', ephemeral: true });

                const sep2 = value.indexOf('_');
                const type = value.slice(0, sep2);
                const itemId = value.slice(sep2 + 1);
                const uu = fmGetUser(userId, guildId);
                const fu = fishingGetUser(userId, guildId);
                const owned = type === 'wh' ? (uu.warehouse[itemId] || 0) : type === 'seed' ? (uu.seeds[itemId] || 0) : (fu.inventory[itemId] || 0);
                if (owned < qty) return interaction.reply({ content: '❌ Bạn không đủ số lượng vật phẩm này!', ephemeral: true });

                state.offers[userId][value] = qty;
                state.ready[state.userA] = false;
                state.ready[state.userB] = false;
                const displayName = fmTradeResolveKey(value).name;
                await interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã thêm **${qty}x ${displayName}** vào giao dịch!`, ephemeral: true });
                const chan = interaction.channel;
                chan.messages.fetch({ limit: 10 }).then(msgs => {
                    const tradeMsg = msgs.find(m => m.author.id === client.user.id && m.embeds[0]?.title === '🤝 TRAO ĐỔI VẬT PHẨM');
                    if (tradeMsg) tradeMsg.edit({ embeds: [fmBuildTradeEmbed(state)] }).catch(() => {});
                }).catch(() => {});
                return;
            }
        }
    } catch (error) {
        console.error('Lỗi hệ thống Nông Trại (interaction):', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ Đã xảy ra lỗi hệ thống ở Nông Trại.', ephemeral: true }).catch(() => {});
        }
    }
});
// ==========================================
// KẾT THÚC HỆ THỐNG NÔNG TRẠI
// ==========================================

// ==========================================
// HỆ THỐNG ĐUA NGỰA - XỬ LÝ TƯƠNG TÁC (chỉ bắt customId bắt đầu bằng 'dh_')
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.customId || !interaction.customId.startsWith('dh_')) return;
        if (!interaction.guildId) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const game = activeGames.duangua.get(channelId);

        if (interaction.isStringSelectMenu() && interaction.customId === 'dh_pick') {
            if (!game || game.status !== 'betting') {
                return interaction.reply({ content: '⚠️ Ván đua ngựa này không còn nhận cược nữa!', ephemeral: true });
            }
            if (game.bets.has(userId)) {
                return interaction.reply({ content: '❌ Bạn chỉ được đặt cược **1 con ngựa duy nhất** mỗi ván!', ephemeral: true });
            }
            const horse = interaction.values[0];
            const modal = new ModalBuilder().setCustomId(`dh_modal_bet_${horse}`).setTitle(`Đặt Cược Ngựa Số ${horse}`);
            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel(`Số tiền muốn cược (tối thiểu ${DH_MIN_BET}đ):`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('dh_modal_bet_')) {
            const horse = parseInt(interaction.customId.replace('dh_modal_bet_', ''));
            if (!game || game.status !== 'betting') {
                return interaction.reply({ content: '⚠️ Ván đua ngựa này không còn nhận cược nữa!', ephemeral: true });
            }
            if (game.bets.has(userId)) {
                return interaction.reply({ content: '❌ Bạn chỉ được đặt cược **1 con ngựa duy nhất** mỗi ván!', ephemeral: true });
            }
            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (isNaN(amount) || amount < DH_MIN_BET) {
                return interaction.reply({ content: `❌ Số tiền cược không hợp lệ (tối thiểu ${DH_MIN_BET}đ)!`, ephemeral: true });
            }
            if (getBalance(userId, guildId) < amount) {
                return interaction.reply({ content: '❌ Số dư của bạn không đủ để đặt cược!', ephemeral: true });
            }

            addBalance(userId, -amount, guildId);
            game.bets.set(userId, { horse, amount });

            await interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã cược **${amount.toLocaleString()}đ** vào ngựa số **${horse}**! Chúc may mắn 🍀`, ephemeral: true });

            const chan = interaction.channel;
            if (chan && game.messageId) {
                chan.messages.fetch(game.messageId).then(msg => {
                    msg.edit({ embeds: [dhBuildBettingEmbed(game)], components: dhBuildComponents() }).catch(() => {});
                }).catch(() => {});
            }
            return;
        }

        if (interaction.isButton() && interaction.customId === 'dh_cancel') {
            if (!game || game.status !== 'betting') {
                return interaction.reply({ content: '⚠️ Ván đua ngựa này không thể hủy lúc này!', ephemeral: true });
            }
            if (userId !== game.hostId) {
                return interaction.reply({ content: '❌ Chỉ chủ ván mới có thể hủy!', ephemeral: true });
            }
            for (const [uid, b] of game.bets) addBalance(uid, b.amount, guildId);
            game.status = 'done';
            activeGames.duangua.delete(channelId);
            return interaction.update({ content: '❌ **Ván đua ngựa đã bị hủy!** Toàn bộ tiền cược đã được hoàn lại.', embeds: [], components: [] });
        }

        if (interaction.isButton() && interaction.customId === 'dh_start') {
            if (!game || game.status !== 'betting') {
                return interaction.reply({ content: '⚠️ Ván đua ngựa này không còn ở giai đoạn cược nữa!', ephemeral: true });
            }
            if (userId !== game.hostId) {
                return interaction.reply({ content: '❌ Chỉ chủ ván mới có thể bắt đầu đua!', ephemeral: true });
            }
            if (game.bets.size === 0) {
                return interaction.reply({ content: '❌ Chưa có ai đặt cược, không thể bắt đầu!', ephemeral: true });
            }

            game.status = 'running';
            await interaction.update({ embeds: [dhBuildBettingEmbed(game)], components: dhBuildComponents(true) });

            // --- CHẠY ĐUA (mô phỏng hoạt hình) ---
            const positions = new Array(DH_HORSE_COUNT).fill(0);
            const finished = [];
            const TICKS = 9;

            for (let t = 0; t < TICKS; t++) {
                for (let i = 0; i < DH_HORSE_COUNT; i++) {
                    positions[i] = Math.min(DH_TRACK_LEN, positions[i] + 1 + Math.floor(Math.random() * 4));
                }
                await dhSleep(1300);
                const frameEmbed = new EmbedBuilder()
                    .setColor('#e67e22')
                    .setTitle('<a:emoji_77:1526180317000630384> ĐUA NGỰA ĐANG DIỄN RA... <a:emoji_77:1526180317000630384>')
                    .setDescription(dhBuildTrackFrame(positions, finished));
                await interaction.editReply({ embeds: [frameEmbed], components: [] }).catch(() => {});
            }

            // Xếp hạng theo vị trí cuối cùng (ngẫu nhiên phá vỡ hòa)
            const ranking = positions
                .map((pos, idx) => ({ idx, pos, rnd: Math.random() }))
                .sort((a, b) => (b.pos - a.pos) || (b.rnd - a.rnd));

            const firstHorse = ranking[0].idx + 1;
            const secondHorse = ranking[1].idx + 1;

            let resultDesc = `🥇 **Về Nhất:** Ngựa số **${firstHorse}** ${DH_NUMBER_EMOJI[firstHorse - 1]}\n`;
            resultDesc += `🥈 **Về Nhì:** Ngựa số **${secondHorse}** ${DH_NUMBER_EMOJI[secondHorse - 1]}\n\n`;
            resultDesc += `**Kết quả cược:**\n`;

            if (game.bets.size === 0) {
                resultDesc += '_Không có ai đặt cược._';
            } else {
                for (const [uid, b] of game.bets) {
                    if (b.horse === firstHorse) {
                        const win = b.amount * 3;
                        addBalance(uid, win, guildId);
                        resultDesc += `🏆 <@${uid}>: cược **${b.amount.toLocaleString()}đ** vào Ngựa ${b.horse} → Về Nhất! Nhận **${win.toLocaleString()}đ** (x3)\n`;
                    } else if (b.horse === secondHorse) {
                        addBalance(uid, b.amount, guildId);
                        resultDesc += `↩️ <@${uid}>: cược **${b.amount.toLocaleString()}đ** vào Ngựa ${b.horse} → Về Nhì, được hoàn lại tiền cược\n`;
                    } else {
                        resultDesc += `💀 <@${uid}>: cược **${b.amount.toLocaleString()}đ** vào Ngựa ${b.horse} → Thua cược\n`;
                    }
                }
            }

            const resultEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('🏁 KẾT QUẢ CUỘC ĐUA 🏁')
                .setDescription(dhBuildTrackFrame(positions, [ranking[0].idx, ranking[1].idx]) + '\n' + resultDesc);

            await interaction.editReply({ embeds: [resultEmbed], components: [] }).catch(() => {});

            game.status = 'done';
            activeGames.duangua.delete(channelId);
            return;
        }
    } catch (error) {
        console.error('Lỗi hệ thống Đua Ngựa:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ Đã xảy ra lỗi hệ thống ở trò Đua Ngựa.', ephemeral: true }).catch(() => {});
        }
    }
});

// ==========================================
// HỆ THỐNG CHỨNG KHOÁN (/stock-prices, !cophieu)
// ==========================================

// Thay đổi giá cổ phiếu ngẫu nhiên (dao động lên/xuống liên tục)
function stockTick(guildData) {
    const s = guildData.stock;
    const oldPrice = s.price;
    // Dao động ngẫu nhiên từ -STOCK_MAX_CHANGE_PCT% đến +STOCK_MAX_CHANGE_PCT%
    const changePct = (Math.random() * (STOCK_MAX_CHANGE_PCT * 2) - STOCK_MAX_CHANGE_PCT) / 100;
    let newPrice = Math.round(oldPrice * (1 + changePct));
    if (newPrice < STOCK_MIN_PRICE) newPrice = STOCK_MIN_PRICE;

    s.lastChange = newPrice - oldPrice;
    s.lastChangePercent = oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0;
    s.price = newPrice;

    s.history.push(newPrice);
    if (s.history.length > STOCK_HISTORY_LEN) s.history.shift();

    saveData();
}

function stockBuildEmbed(guildData) {
    const s = guildData.stock;
    const up = s.lastChange > 0;
    const down = s.lastChange < 0;
    const trendIcon = up ? '🟢▲' : down ? '🔴▼' : '⚪▬';
    const pctText = `${s.lastChangePercent >= 0 ? '+' : ''}${(s.lastChangePercent * 100).toFixed(2)}%`;
    const changeText = `${s.lastChange >= 0 ? '+' : ''}${s.lastChange.toLocaleString()}đ`;

    const sparkline = s.history.map((p, i, arr) => {
        if (i === 0) return '⬜';
        if (p > arr[i - 1]) return '🟩';
        if (p < arr[i - 1]) return '🟥';
        return '⬜';
    }).join('');

    return new EmbedBuilder()
        .setColor(down ? '#e74c3c' : up ? '#2ecc71' : '#95a5a6')
        .setTitle('📊 SÀN GIAO DỊCH CHỨNG KHOÁN')
        .setDescription(
            `💹 **Giá hiện tại:** \`${s.price.toLocaleString()}đ\` / cổ phiếu\n` +
            `${trendIcon} **Thay đổi gần nhất:** ${changeText} (${pctText})\n\n` +
            `📈 **Biến động gần đây:**\n${sparkline || '⬜'}\n\n` +
            `Bấm nút bên dưới để **Mua** hoặc **Bán** cổ phiếu.\nDùng lệnh \`!cophieu\` để xem số cổ phiếu bạn đang sở hữu.`
        )
        .setFooter({ text: `Giá tự động cập nhật` })
        .setTimestamp();
}

function stockBuildComponents() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('stock_buy').setLabel('📈 Mua').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('stock_sell').setLabel('📉 Bán').setStyle(ButtonStyle.Danger)
    )];
}

// --- /stock-prices: cài đặt kênh + đăng bảng giá, và các nút Mua/Bán ---
client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.guildId) return;
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const guildData = getGuildData(guildId);

        // Lệnh Slash: /stock-prices channel:
        if (interaction.isChatInputCommand() && interaction.commandName === 'stock-prices') {
            const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.guild.ownerId === userId;
            if (!isAdmin) {
                return interaction.reply({ content: '<a:emoji_76:1524195723996823612>  Chỉ Admin/Chủ server mới được cài đặt kênh chứng khoán!', ephemeral: true });
            }

            const channel = interaction.options.getChannel('channel');
            guildData.stock.channelId = channel.id;
            saveData();

            await interaction.reply({ content: `<a:emoji_75:1524039622668189806> Đã đặt kênh cập nhật giá chứng khoán tại ${channel}!`, ephemeral: true });

            const sentMsg = await channel.send({
                embeds: [stockBuildEmbed(guildData)],
                components: stockBuildComponents()
            }).catch(() => null);

            if (sentMsg) {
                guildData.stock.messageId = sentMsg.id;
                saveData();
            }
            return;
        }

        // Nút Mua / Bán -> hiện modal nhập số lượng
        if (interaction.isButton() && (interaction.customId === 'stock_buy' || interaction.customId === 'stock_sell')) {
            const isBuy = interaction.customId === 'stock_buy';
            const modal = new ModalBuilder()
                .setCustomId(isBuy ? 'stock_modal_buy' : 'stock_modal_sell')
                .setTitle(isBuy ? 'Mua Cổ Phiếu' : 'Bán Cổ Phiếu');

            const input = new TextInputBuilder()
                .setCustomId('quantity')
                .setLabel(`Số lượng cổ phiếu muốn ${isBuy ? 'mua' : 'bán'}`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('VD: 5')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        // Xử lý modal Mua
        if (interaction.isModalSubmit() && interaction.customId === 'stock_modal_buy') {
            const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
            if (!Number.isInteger(qty) || qty <= 0) {
                return interaction.reply({ content: '<a:emoji_76:1524195723996823612>  Số lượng không hợp lệ! Vui lòng nhập số nguyên dương.', ephemeral: true });
            }

            const price = guildData.stock.price;
            const totalCost = price * qty;
            const balance = getBalance(userId, guildId);

            if (balance < totalCost) {
                return interaction.reply({ content: `<a:emoji_76:1524195723996823612>  Số dư không đủ! Bạn cần **${totalCost.toLocaleString()}đ** nhưng chỉ có **${balance.toLocaleString()}đ**.`, ephemeral: true });
            }

            addBalance(userId, -totalCost, guildId);
            guildData.stock.holdings[userId] = (guildData.stock.holdings[userId] || 0) + qty;
            saveData();

            return interaction.reply({
                content: `<a:emoji_75:1524039622668189806> Đã mua **${qty.toLocaleString()} cổ phiếu** với giá **${price.toLocaleString()}đ/cp** (tổng **${totalCost.toLocaleString()}đ**)!\n📦 Bạn hiện đang sở hữu **${guildData.stock.holdings[userId].toLocaleString()} cổ phiếu**.`,
                ephemeral: true
            });
        }

        // Xử lý modal Bán
        if (interaction.isModalSubmit() && interaction.customId === 'stock_modal_sell') {
            const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
            if (!Number.isInteger(qty) || qty <= 0) {
                return interaction.reply({ content: '<a:emoji_76:1524195723996823612>  Số lượng không hợp lệ! Vui lòng nhập số nguyên dương.', ephemeral: true });
            }

            const owned = guildData.stock.holdings[userId] || 0;
            if (owned < qty) {
                return interaction.reply({ content: `<a:emoji_76:1524195723996823612>  Bạn chỉ đang sở hữu **${owned.toLocaleString()} cổ phiếu**, không đủ để bán **${qty.toLocaleString()}**!`, ephemeral: true });
            }

            const price = guildData.stock.price;
            const totalGain = price * qty;

            guildData.stock.holdings[userId] = owned - qty;
            if (guildData.stock.holdings[userId] <= 0) delete guildData.stock.holdings[userId];
            addBalance(userId, totalGain, guildId);
            saveData();

            return interaction.reply({
                content: `<a:emoji_75:1524039622668189806> Đã bán **${qty.toLocaleString()} cổ phiếu** với giá **${price.toLocaleString()}đ/cp**, nhận về **${totalGain.toLocaleString()}đ**!\n📦 Bạn còn lại **${(guildData.stock.holdings[userId] || 0).toLocaleString()} cổ phiếu**.`,
                ephemeral: true
            });
        }
    } catch (error) {
        console.error('Lỗi hệ thống Chứng Khoán:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ Đã xảy ra lỗi hệ thống ở Sàn Chứng Khoán.', ephemeral: true }).catch(() => {});
        }
    }
});

// --- !cophieu: xem số cổ phiếu đang sở hữu + số dư tiền ---
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot || !message.guild) return;
        if (!message.content.startsWith(PREFIX)) return;

        const args = message.content.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        if (command !== 'cophieu') return;

        const userId = message.author.id;
        const guildId = message.guild.id;
        const guildData = getGuildData(guildId);

        const owned = guildData.stock.holdings[userId] || 0;
        const price = guildData.stock.price;
        const value = owned * price;
        const balance = getBalance(userId, guildId);

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle(`📦 Danh Mục Chứng Khoán - ${message.author.username}`)
            .setThumbnail(message.author.displayAvatarURL())
            .addFields(
                { name: '📈 Số cổ phiếu đang sở hữu', value: `${owned.toLocaleString()} cổ phiếu`, inline: true },
                { name: '💹 Giá hiện tại', value: `${price.toLocaleString()}đ/cp`, inline: true },
                { name: '💎 Tổng giá trị cổ phiếu', value: `${value.toLocaleString()}đ`, inline: true },
                { name: '💰 Số dư tài khoản', value: `${balance.toLocaleString()}đ`, inline: false }
            )
            .setFooter({ text: 'Dùng lệnh /stock-prices để xem bảng giá và mua/bán' })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Lỗi lệnh !cophieu:', error);
    }
});

// --- Cứ 1 phút, giá chứng khoán thay đổi 1 lần & cập nhật bảng giá tại kênh đã cài đặt ---
setInterval(async () => {
    try {
        for (const guildId in db.guilds) {
            const guildData = getGuildData(guildId);
            if (!guildData.stock || !guildData.stock.channelId) continue;

            stockTick(guildData);

            const channel = client.channels.cache.get(guildData.stock.channelId);
            if (!channel) continue;

            const embed = stockBuildEmbed(guildData);
            const components = stockBuildComponents();

            if (guildData.stock.messageId) {
                const msg = await channel.messages.fetch(guildData.stock.messageId).catch(() => null);
                if (msg) {
                    await msg.edit({ embeds: [embed], components }).catch(() => {});
                    continue;
                }
            }

            // Không tìm thấy tin nhắn cũ (bị xóa...) -> đăng lại tin nhắn mới
            const sentMsg = await channel.send({ embeds: [embed], components }).catch(() => null);
            if (sentMsg) {
                guildData.stock.messageId = sentMsg.id;
                saveData();
            }
        }
    } catch (error) {
        console.error('Lỗi vòng lặp cập nhật giá Chứng Khoán:', error);
    }
}, STOCK_TICK_MS);
// ==========================================
// KẾT THÚC HỆ THỐNG CHỨNG KHOÁN
// ==========================================

client.login('thay token');
