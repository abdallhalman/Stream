const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "sl42t";
const STREAM_KEY = process.env.STREAM_KEY;
const WIDTH       = 1280;
const HEIGHT      = 720;
const FPS         = 30;
const BUFFER_SIZE = 60;

let totalLikes = 0;
let lastJoinTime = 0;
let lastCommentTime = 0;
const EVENT_THROTTLE_MS = 1000;

const wss = new WebSocket.Server({ port: 8080 });
let wsClient = null;

wss.on("connection", (ws) => {
    wsClient = ws;
    console.log("Overlay interface connected local.");
});

function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type, data }));
    }
}

const videoPath = path.join(__dirname, '../../video.mp4');
const audioPath = path.join(__dirname, '../../merged_audio.mp3');
const framesDir = path.join(__dirname, '../../frames');
const tmpPath   = path.join(__dirname, '../../overlay_tmp.png');

function getFramePath(index) {
    return path.join(framesDir, `frame_${String(index % BUFFER_SIZE).padStart(3,'0')}.png`);
}

let ffmpegStarted = false;
const rndCrop   = Math.floor(Math.random() * 20);
const rndX      = Math.floor(Math.random() * (rndCrop + 1));
const rndY      = Math.floor(Math.random() * (rndCrop + 1));
const rndBright = ((Math.random() * 0.06) - 0.03).toFixed(3);
const rndSpeed  = (27 + Math.random() * 6).toFixed(2);
function startFFmpeg() {
    if (ffmpegStarted) return;
    ffmpegStarted = true;
const ffmpeg = spawn("ffmpeg", [
    "-re",                      // لضبط سرعة القراءة متزامنة مع الوقت الفعلي
    "-loop", "1",
    "-f", "image2",
    "-i", mainFramePath,        // المدخل [0] الأوفرلاي الشفاف القادم من المتصفح
    
    "-stream_loop", "-1",
    "-i", videoPath,            // المدخل [1] فيديو الخلفية الأساسي
    
    "-i", audioPath,            // المدخل [2] ملف الصوت المدمج
    
    "-filter_complex", 
    // 1. تثبيت فريمات وأبعاد فيديو الخلفية الخاص بك
    `[1:v]fps=30,scale=${WIDTH}:${HEIGHT}[bg];` +
    
    // 2. تحويل الصوت الفعلي إلى موجة نيون متحركة (تتفاعل تلقائياً مع مستوى الصوت)
    // العرض 700 والارتفاع 180، بلون ذهبي نيون متناسق مع تصميمك (0xFFBC00) وبشفافية 85%
    `[2:a]showwaves=s=700x180:mode=line:rate=30:colors=0xFFBC00@0.85:scale=sqrt[audio_wave];` +
    
    // 3. تركيب موجة الصوت فوق فيديو الخلفية بالمنتصف تماماً بالثلث السفلي (X=290, Y=480)
    `[bg][audio_wave]overlay=290:480:shortest=1[bg_with_waves];` +
    
    // 4. دمج طبقة الأوفرلاي الشفاف (تفاعلات التيك توك اللحظية) في المقدمة فوق كل شيء
    `[bg_with_waves][0:v]overlay=0:0[out_v]`,
    
    "-map", "[out_v]",          // توجيه الفيديو النهائي المدمج للبث
    "-map", "2:a",              // توجيه الصوت الأصلي للبث
    
    // الحفاظ على كامل إعدادات الجودة والثبات الأصلية الخاصة بك:
    "-c:v", "libx264",
    "-r", "30",
    "-profile:v", "baseline",
    "-g", "60",                 
    "-b:v", "2500k",            
    "-maxrate", "2500k",
    "-bufsize", "5000k",
    "-pix_fmt", "yuv420p",
    
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    
    "-f", "flv",
    `rtmp://localhost/live/${STREAM_KEY}` // رابط مسار البث النهائي الخاص بك
]);

    ffmpeg.stderr.on("data", d => process.stderr.write(d));
    console.log("FFmpeg started.");
}

let writeIndex = 0;
let puppeteerStarted = false;

async function fillBuffer(page) {
    console.log(`Filling buffer: ${BUFFER_SIZE} frames...`);
    for (let i = 0; i < BUFFER_SIZE; i++) {
        const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
        fs.writeFileSync(tmpPath, screenshot);
        fs.renameSync(tmpPath, getFramePath(i));
    }
    writeIndex = BUFFER_SIZE;
    console.log("Buffer ready, starting FFmpeg...");
}

async function startPuppeteer() {
    if (puppeteerStarted) return;
    puppeteerStarted = true;

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });

    const htmlPath = path.join(__dirname, 'overlay.html');
    await page.goto(`file://${htmlPath}`);

    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

    await fillBuffer(page);
    startFFmpeg();

    setInterval(async () => {
        try {
            const screenshot = await page.screenshot({ type: 'png', omitBackground: true });
            fs.writeFileSync(tmpPath, screenshot);
            fs.renameSync(tmpPath, getFramePath(writeIndex));
            writeIndex++;
        } catch (e) {
            console.error("Screenshot error:", e.message);
        }
    }, 1000 / FPS);
}

const tiktok = new WebcastPushConnection(TIKTOK_USER);

function connectTikTok() {
    tiktok.connect()
        .then(() => console.log("TikTok connected: " + TIKTOK_USER))
        .catch(e => {
            console.error("TikTok failed:", e.message, "- retrying in 20s...");
            setTimeout(connectTikTok, 20000);
        });
}

tiktok.on("disconnected", () => {
    console.log("TikTok disconnected, retrying in 20s...");
    setTimeout(connectTikTok, 20000);
});

tiktok.on("roomUser", data => {
    if (data?.viewerCount !== undefined) sendToOverlay("viewerCount", data.viewerCount);
});

tiktok.on("member", data => {
    const now = Date.now();
    if (now - lastJoinTime >= EVENT_THROTTLE_MS) {
        if (data?.nickname || data?.uniqueId) {
            sendToOverlay("join", {
                name: data.nickname || data.uniqueId,
                avatar: data.profilePictureUrl
            });
            lastJoinTime = now;
        }
    }
});

tiktok.on("like", data => {
    if (data.likeCount > 0) {
        totalLikes += Number(data.likeCount);
        sendToOverlay("like", totalLikes);
    }
});

// ← comment + chat معاً
function handleComment(data) {
    const now = Date.now();
    if (now - lastCommentTime >= EVENT_THROTTLE_MS) {
        const text = data.comment || data.text || "";
        if (text) {
            sendToOverlay("comment", {
                name: data.nickname || data.uniqueId,
                text: text.replace(/\[heart\]/g, "❤️"),
                avatar: data.profilePictureUrl,
                badges: data.badges || []
            });
            lastCommentTime = now;
        }
    }
}

tiktok.on("comment", handleComment);
tiktok.on("chat",    handleComment); // ← الناقص في الكود القديم

tiktok.on("follow", data => {
    sendToOverlay("follow", {
        name: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl,
        followerCount: data.followCount || 0
    });
});

tiktok.on("gift", (data) => {
    // نقرأ الحدث عندما ينتهي التكرار أو إذا كانت الهدية فردية
    if (data.repeatEnd || data.repeatCount === 1) {
        
        // 🛠️ فحص شامل وتأمين كل الاحتمالات لروابط صور الهدايا من تيك توك
        let officialGiftIcon = "";
        if (data.giftPictureUrl) {
            officialGiftIcon = data.giftPictureUrl;
        } else if (data.image && data.image.url_list && data.image.url_list[0]) {
            officialGiftIcon = data.image.url_list[0];
        } else if (data.extendedGiftInfo && data.extendedGiftInfo.image && data.extendedGiftInfo.image.url_list) {
            officialGiftIcon = data.extendedGiftInfo.image.url_list[0];
        }

        sendToOverlay("gift", {
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount || 1,
            avatar: data.profilePictureUrl,
            giftIcon: officialGiftIcon // تمرير الرابط المضمون للأوفرلاي
        });
    }
});


setTimeout(connectTikTok, 120000);
startPuppeteer();
  
