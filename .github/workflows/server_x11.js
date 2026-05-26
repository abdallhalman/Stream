const { WebcastPushConnection } = require("tiktok-live-connector");
const { spawn, execSync } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");

const TIKTOK_USER = "sl42t";
const STREAM_KEY  = process.env.STREAM_KEY;
const WIDTH       = 1280;
const HEIGHT      = 720;
const FPS         = 30;
const DISPLAY     = process.env.DISPLAY || ":99";
const YT_URL      = "https://www.youtube.com/live/mryyH3FQNAI";

let totalLikes      = 0;
let lastJoinTime    = 0;
let lastCommentTime = 0;
const EVENT_THROTTLE_MS = 1000;

// ── WebSocket للـ overlay ──────────────────────────────────
const wss = new WebSocket.Server({ port: 8080 });
let wsClient = null;
wss.on("connection", ws => {
    wsClient = ws;
    console.log("Overlay connected.");
});
function sendToOverlay(type, data) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN)
        wsClient.send(JSON.stringify({ type, data }));
}

// ── قيم عشوائية لكسر البصمة ───────────────────────────────
const rndBright = ((Math.random() * 0.06) - 0.03).toFixed(3);
const rndSpeed  = (27 + Math.random() * 6).toFixed(2);

// ── تشغيل xvfb ────────────────────────────────────────────
function startXvfb() {
    return new Promise((resolve) => {
        console.log("Starting Xvfb...");
        const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-ac"]);
        xvfb.on("error", e => console.error("Xvfb error:", e.message));
        setTimeout(resolve, 2000);
    });
}

// ── تشغيل pulseaudio ──────────────────────────────────────
function startPulseAudio() {
    return new Promise((resolve) => {
        console.log("Starting PulseAudio...");
        try {
            execSync("pulseaudio --start --exit-idle-time=-1");
        } catch(e) {}
        setTimeout(resolve, 1000);
    });
}

// ── تشغيل Chromium على YouTube ───────────────────────────
function startChromium() {
    return new Promise((resolve) => {
        console.log("Starting Chromium...");
        const chromium = spawn("chromium", [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--autoplay-policy=no-user-gesture-required",
            `--display=${DISPLAY}`,
            `--window-size=${WIDTH},${HEIGHT}`,
            "--start-fullscreen",
            "--kiosk",
            YT_URL
        ], { env: { ...process.env, DISPLAY } });
        chromium.on("error", e => console.error("Chromium error:", e.message));
        // انتظر 15 ثانية للتحميل
        setTimeout(resolve, 15000);
    });
}

// ── تشغيل overlay.html في نافذة شفافة ────────────────────
function startOverlay() {
    console.log("Starting overlay...");
    const htmlPath = path.join(__dirname, 'overlay.html');
    spawn("chromium", [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-transparent-visuals",
        "--disable-gpu",
        `--display=${DISPLAY}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        `--app=file://${htmlPath}`,
        "--window-position=0,0"
    ], { env: { ...process.env, DISPLAY } });
}

// ── تشغيل FFmpeg يصور الشاشة ─────────────────────────────
function startFFmpeg() {
    console.log("Starting FFmpeg x11grab...");
    const ffmpeg = spawn("ffmpeg", [
        "-f", "x11grab",
        "-r", rndSpeed,
        "-s", `${WIDTH}x${HEIGHT}`,
        "-i", `${DISPLAY}.0`,
        "-f", "pulse",
        "-i", "default",
        "-vf", `eq=brightness=${rndBright}:contrast=1.0`,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "2500k",
        "-g", "50",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
        "-f", "flv",
        `rtmp://live.restream.io/live/${STREAM_KEY}`
    ], { env: { ...process.env, DISPLAY: DISPLAY } });
    ffmpeg.stderr.on("data", d => process.stderr.write(d));
    ffmpeg.on("exit", code => { console.error("FFmpeg exit:", code); process.exit(code); });
    console.log("FFmpeg started.");
}

// ── بدء كل شيء بالترتيب ──────────────────────────────────
async function main() {
    await startChromium();
    startOverlay();
    await new Promise(r => setTimeout(r, 3000));
    startFFmpeg();
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });

// ── TikTok ────────────────────────────────────────────────
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
            sendToOverlay("join", { name: data.nickname || data.uniqueId, avatar: data.profilePictureUrl });
            lastJoinTime = now;
        }
    }
});

tiktok.on("like", data => {
    if (data.likeCount > 0) { totalLikes += Number(data.likeCount); sendToOverlay("like", totalLikes); }
});

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
tiktok.on("chat",    handleComment);

tiktok.on("follow", data => {
    sendToOverlay("follow", {
        name: data.nickname || data.uniqueId,
        avatar: data.profilePictureUrl,
        followerCount: data.followCount || 0
    });
});

tiktok.on("gift", data => {
    if (data.repeatEnd || data.repeatCount === 1) {
        sendToOverlay("gift", {
            name: data.nickname || data.uniqueId,
            giftName: data.giftName,
            count: data.repeatCount || 1,
            avatar: data.profilePictureUrl
        });
    }
});

setTimeout(connectTikTok, 120000);
