/**
 * Joy Meeting Client — Standalone Audio Bridge (Ubuntu / PulseAudio)
 * 
 * Captures audio from a PulseAudio monitor (meeting output), streams it to
 * onebudd-realtime via WebSocket, and plays back TTS responses through
 * a PulseAudio sink (meeting input) using `paplay`.
 * Launches Google Meet in headless Chrome via Puppeteer.
 * 
 * Prerequisites:
 *   1. pulseaudio and Xvfb installed
 *   2. VirtualPulse audio devices configured
 *   3. onebudd-realtime server running
 * 
 * Usage: npm start
 */

require('dotenv').config();
const WebSocket = require('ws');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

// ============================================================================
// Configuration (from .env)
// ============================================================================
const config = {
    wsUrl: process.env.PIPELINE_WS_URL || 'ws://localhost:8080',
    apiKey: process.env.API_KEY || '',
    meetUrl: process.env.MEET_URL || '',
    inputDevice: process.env.INPUT_DEVICE || 'VirtualSpeaker.monitor', // parec capture
    outputDevice: process.env.OUTPUT_DEVICE || 'VirtualSpeaker',       // paplay injection
    sampleRate: parseInt(process.env.SAMPLE_RATE || '16000'),
    channels: parseInt(process.env.CHANNELS || '1'),
    bitsPerSample: parseInt(process.env.BITS_PER_SAMPLE || '16'),
    wakeWord: process.env.WAKE_WORD || 'hey joy',
    language: process.env.LANGUAGE || 'en-US',
    // Client-side control
    cancelPhrases: (process.env.CANCEL_PHRASES || 'never mind,cancel,stop,ignore that')
        .split(',')
        .map(p => p.trim().toLowerCase())
        .filter(Boolean),
    interruptOnSpeech: (process.env.INTERRUPT_ON_SPEECH || 'true').toLowerCase() === 'true',
    interruptOnCancel: (process.env.INTERRUPT_ON_CANCEL || 'true').toLowerCase() === 'true',
    vadThreshold: parseFloat(process.env.VAD_THRESHOLD || '0.02'),
    interruptCooldownMs: parseInt(process.env.INTERRUPT_COOLDOWN_MS || '1200'),
    minQueryChars: parseInt(process.env.MIN_QUERY_CHARS || '3'),
    minQueryWords: parseInt(process.env.MIN_QUERY_WORDS || '4'),
    activationTimeoutMs: parseInt(process.env.ACTIVATION_TIMEOUT_MS || '1500')
};

// ============================================================================
// State
// ============================================================================
let ws = null;
let recordingProcess = null;
let paplayProcess = null;
let isConnected = false;
let reconnectTimer = null;
let audioChunkCount = 0;
let ttsChunkCount = 0;
let isBotSpeaking = false;
let lastInterruptAt = 0;
let ignoreTtsUntil = 0;
let activationTimer = null;
let activationTimedOut = false;
let browser = null;

// ============================================================================
// Puppeteer Headless Launch (Google Meet)
// ============================================================================
async function launchBrowser() {
    console.log('\n🚀 Starting headless Chrome via Puppeteer...');
    try {
        browser = await puppeteer.launch({
            headless: false, // Run in Xvfb display
            env: {
                ...process.env,
                DISPLAY: ':99'
            },
            args: [
                '--use-fake-ui-for-media-stream',
                '--disable-gpu',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--display=:99'
            ]
        });

        const page = await browser.newPage();

        if (config.meetUrl) {
            console.log(`🌐 Navigating to Google Meet: ${config.meetUrl}`);
            await page.goto(config.meetUrl, { waitUntil: 'networkidle2' });
            console.log('✅ Google Meet loaded (Mic/Camera access automatically allowed)');
        } else {
            console.log('⚠️ No MEET_URL specified in .env. Browser launched successfully.');
        }

    } catch (err) {
        console.error('❌ Failed to launch Puppeteer:', err.message);
    }
}

// ============================================================================
// WebSocket Connection
// ============================================================================
function buildWsUrl() {
    const url = new URL(config.wsUrl);
    url.searchParams.set('meetingMode', 'true');
    url.searchParams.set('wakeWord', config.wakeWord);
    url.searchParams.set('clientId', 'joy-meeting-client-ubuntu');
    if (config.apiKey) url.searchParams.set('apiKey', config.apiKey);
    return url.toString();
}

function connect() {
    const wsUrl = buildWsUrl();
    console.log(`\n🔌 Connecting to: ${wsUrl}`);

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        isConnected = true;
        console.log('✅ Connected to onebudd-realtime pipeline');

        // Send initial config
        const configMsg = {
            type: 'config',
            sampleRate: config.sampleRate,
            encoding: 'pcm_s16le',
            language: config.language,
            meetingMode: true,
            wakeWord: config.wakeWord,
        };
        ws.send(JSON.stringify(configMsg));
        console.log('📤 Sent config:', JSON.stringify(configMsg));

        // Start capturing audio
        startAudioCapture();
    });

    ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            handleTTSAudio(data);
            return;
        }

        try {
            const msg = JSON.parse(data.toString());
            handleServerMessage(msg);
        } catch (e) {
            // Ignore non-JSON
        }
    });

    ws.on('close', (code, reason) => {
        isConnected = false;
        console.log(`\n❌ Disconnected (code: ${code}, reason: ${reason || 'none'})`);
        stopAudioCapture();
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        console.error('⚠️ WebSocket error:', err.message);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log('🔄 Reconnecting in 3 seconds...');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 3000);
}

function sendControl(type) {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type }));
    }
}

// ============================================================================
// Audio Capture (PulseAudio parec → Pipeline)
// ============================================================================
function startAudioCapture() {
    console.log('\n🎙️  Starting audio capture via parec...');
    console.log(`   Capture source: "${config.inputDevice}"`);

    try {
        recordingProcess = spawn('parec', [
            '--device=' + config.inputDevice,
            '--raw',
            '--channels=' + config.channels,
            '--rate=' + config.sampleRate,
            '--format=s16le'
        ]);

        recordingProcess.stdout.on('data', (chunk) => {
            if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
                if (config.interruptOnSpeech && isBotSpeaking) {
                    maybeInterruptOnSpeech(chunk);
                }
                ws.send(chunk);
                audioChunkCount++;
                if (audioChunkCount % 100 === 0) {
                    process.stdout.write(`\r📡 Audio chunks sent: ${audioChunkCount} | TTS chunks received: ${ttsChunkCount}`);
                }
            }
        });

        recordingProcess.on('error', (err) => {
            console.error('\n⚠️ Audio capture error:', err.message);
            console.log('   Make sure PulseAudio is running and parecord is available.');
        });

        recordingProcess.on('close', (code) => {
            console.log(`\n🛑 parec process exited with code ${code}`);
        });

        console.log('🟢 Audio capture active (parec running)');
    } catch (err) {
        console.error('❌ Failed to start audio capture:', err.message);
    }
}

function stopAudioCapture() {
    if (recordingProcess) {
        try {
            recordingProcess.kill('SIGTERM');
        } catch (e) { /* ignore */ }
        recordingProcess = null;
        console.log('🛑 Audio capture stopped');
    }
}

// ============================================================================
// TTS Playback (Pipeline → PulseAudio paplay)
// ============================================================================
function ensurePaplay() {
    if (!paplayProcess) {
        paplayProcess = spawn('paplay', [
            '--device=' + config.outputDevice,
            '--raw',
            '--channels=' + config.channels,
            '--rate=' + config.sampleRate,
            '--format=s16le'
        ]);

        paplayProcess.stdin.on('error', (err) => {
            // Usually happens if process closes prematurely
            console.error('\n⚠️ paplay stdin write error:', err.message);
        });

        paplayProcess.on('close', () => {
            paplayProcess = null;
        });

        paplayProcess.on('error', (err) => {
            console.error('\n⚠️ paplay spawn error:', err.message);
            paplayProcess = null;
        });
    }
    return paplayProcess;
}

function handleTTSAudio(audioBuffer) {
    ttsChunkCount++;

    if (Date.now() < ignoreTtsUntil) return;
    if (activationTimedOut) return;

    if (activationTimer) {
        clearTimeout(activationTimer);
        activationTimer = null;
    }

    const proc = ensurePaplay();
    if (proc && proc.stdin && proc.stdin.writable) {
        try {
            proc.stdin.write(audioBuffer);
        } catch (err) {
            console.error('paplay write error:', err.message);
        }
    }
}

// ============================================================================
// Server Message Handling
// ============================================================================
function handleServerMessage(msg) {
    switch (msg.type) {
        case 'transcript':
            if (msg.is_final) {
                console.log(`\n📝 [${msg.source || 'user'}]: ${msg.text}`);
                if (config.interruptOnCancel && msg.source === 'user') {
                    if (containsCancelPhrase(msg.text)) {
                        triggerInterrupt('cancel_phrase');
                    }
                }
            }
            break;

        case 'meeting_transcript':
            console.log(`\n📝 [${msg.speaker}] ${msg.text}`);
            break;

        case 'meeting_activation':
            if (msg.status === 'activated') {
                console.log(`\n🎤 ✨ JOY ACTIVATED! Query: "${msg.query || ''}"`);
                const queryText = (msg.query || '').trim();
                const wordCount = queryText.length === 0 ? 0 : queryText.split(/\s+/).filter(Boolean).length;
                if (queryText.length < config.minQueryChars || wordCount < config.minQueryWords) {
                    console.log('🚫 Ignoring activation: query too short');
                    triggerInterrupt('empty_query');
                    isBotSpeaking = false;
                    break;
                }
                activationTimedOut = false;
                if (activationTimer) clearTimeout(activationTimer);
                activationTimer = setTimeout(() => {
                    activationTimedOut = true;
                    console.log('🚫 Activation timed out (late query)');
                    triggerInterrupt('activation_timeout');
                }, config.activationTimeoutMs);
                isBotSpeaking = true;
            } else if (msg.status === 'idle') {
                console.log('🔇 Joy is idle (listening)');
                isBotSpeaking = false;
            }
            break;

        case 'status':
            console.log(`ℹ️  Status: ${msg.message || JSON.stringify(msg)}`);
            if (msg.status === 'speaking') {
                isBotSpeaking = true;
            } else if (msg.status === 'listening' || msg.status === 'idle') {
                isBotSpeaking = false;
            }
            break;

        case 'error':
            console.error(`❌ Server error: ${msg.message || JSON.stringify(msg)}`);
            break;

        case 'audio_end':
            // Can optionally close paplay stdin to flush audio accurately
            if (paplayProcess) {
                try { paplayProcess.stdin.end(); } catch (e) { /* ignore */ }
                paplayProcess = null;
            }
            isBotSpeaking = false;
            activationTimedOut = false;
            if (activationTimer) {
                clearTimeout(activationTimer);
                activationTimer = null;
            }
            break;

        default:
            break;
    }
}

function containsCancelPhrase(text) {
    const lower = (text || '').toLowerCase();
    return config.cancelPhrases.some(p => lower.includes(p));
}

function triggerInterrupt(reason) {
    const now = Date.now();
    if (now - lastInterruptAt < config.interruptCooldownMs) return;
    lastInterruptAt = now;
    ignoreTtsUntil = now + 1500;
    console.log(`\n⛔ Interrupt sent (${reason})`);
    sendControl('interrupt');

    if (paplayProcess) {
        try { paplayProcess.kill('SIGTERM'); } catch (e) { /* ignore */ }
        paplayProcess = null;
    }
}

function maybeInterruptOnSpeech(chunk) {
    const sampleCount = Math.floor(chunk.length / 2);
    if (sampleCount <= 0) return;
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
        const sample = chunk.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    if (rms >= config.vadThreshold) {
        triggerInterrupt('barge_in');
    }
}

// ============================================================================
// Startup
// ============================================================================
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║          🤖 Joy Meeting Client (Ubuntu/PulseAudio)     ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Pipeline URL : ${config.wsUrl}`);
console.log(`Wake Word    : "${config.wakeWord}"`);
console.log(`Sample Rate  : ${config.sampleRate} Hz`);
console.log(`Input Device : ${config.inputDevice}`);
console.log(`Output Device: ${config.outputDevice}`);

// Launch Puppeteer then connect to WS
launchBrowser().then(() => {
    connect();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down Joy Meeting Client...');
    stopAudioCapture();
    if (paplayProcess) {
        try { paplayProcess.kill('SIGTERM'); } catch (e) { /* ignore */ }
    }
    if (ws) ws.close();
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
});
