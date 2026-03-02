/**
 * Joy Meeting Client — Standalone Audio Bridge (Ubuntu / PulseAudio)
 *
 * Captures audio from a PulseAudio monitor (meeting output), streams it to
 * onebudd-realtime via WebSocket, and plays back TTS responses through
 * a PulseAudio sink (meeting input) using `paplay`.
 * Launches Google Meet in headless Chrome via Puppeteer.
 *
 * Prerequisites:
 *   1. pulseaudio and Xvfb installed and running
 *   2. VirtualSpeaker (null sink) and VirtualMic (virtual source) configured
 *   3. onebudd-realtime server running
 *   4. DISPLAY=:99 exported in environment
 *
 * Usage: node bot.js
 */

require('dotenv').config();
const WebSocket = require('ws');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

// ============================================================================
// Configuration (from .env)
// ============================================================================
const config = {
    wsUrl:               process.env.PIPELINE_WS_URL  || 'ws://localhost:8080',
    apiKey:              process.env.API_KEY           || '',
    meetUrl:             process.env.MEET_URL          || '',
    botName:             process.env.BOT_NAME          || 'Joy',
    inputDevice:         process.env.INPUT_DEVICE      || 'VirtualSpeaker.monitor',
    outputDevice:        process.env.OUTPUT_DEVICE     || 'VirtualSpeaker',
    sampleRate:          parseInt(process.env.SAMPLE_RATE     || '16000'),
    channels:            parseInt(process.env.CHANNELS        || '1'),
    bitsPerSample:       parseInt(process.env.BITS_PER_SAMPLE || '16'),
    wakeWord:            process.env.WAKE_WORD         || 'hey joy',
    language:            process.env.LANGUAGE          || 'en-US',
    cancelPhrases:       (process.env.CANCEL_PHRASES   || 'never mind,cancel,stop,ignore that')
                            .split(',').map(p => p.trim().toLowerCase()).filter(Boolean),
    interruptOnSpeech:   (process.env.INTERRUPT_ON_SPEECH  || 'true').toLowerCase() === 'true',
    interruptOnCancel:   (process.env.INTERRUPT_ON_CANCEL  || 'true').toLowerCase() === 'true',
    vadThreshold:        parseFloat(process.env.VAD_THRESHOLD        || '0.02'),
    interruptCooldownMs: parseInt(process.env.INTERRUPT_COOLDOWN_MS  || '1200'),
    minQueryChars:       parseInt(process.env.MIN_QUERY_CHARS        || '3'),
    minQueryWords:       parseInt(process.env.MIN_QUERY_WORDS        || '4'),
    activationTimeoutMs: parseInt(process.env.ACTIVATION_TIMEOUT_MS  || '1500'),
    admitTimeoutMs:      parseInt(process.env.ADMIT_TIMEOUT_MS       || '120000'),
};

// ============================================================================
// State
// ============================================================================
let ws                 = null;
let recordingProcess   = null;
let paplayProcess      = null;
let isConnected        = false;
let reconnectTimer     = null;
let audioChunkCount    = 0;
let ttsChunkCount      = 0;
let isBotSpeaking      = false;
let lastInterruptAt    = 0;
let ignoreTtsUntil     = 0;
let activationTimer    = null;
let activationTimedOut = false;
let browser            = null;

// ============================================================================
// Puppeteer — Launch Chrome + Join Google Meet
// ============================================================================
async function launchBrowser() {
    console.log('\n🚀 Starting headless Chrome via Puppeteer...');

    try {
        browser = await puppeteer.launch({
            headless: false, // must be false for WebRTC audio to work in Xvfb
            env: {
                ...process.env,
                DISPLAY: process.env.DISPLAY || ':99',
            },
            args: [
                '--use-fake-ui-for-media-stream',   // auto-grant mic/cam permissions
                '--disable-gpu',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-features=VizDisplayCompositor',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                `--display=${process.env.DISPLAY || ':99'}`,
            ],
            ignoreDefaultArgs: ['--mute-audio'],
        });

        const page = await browser.newPage();

        // Grant permissions at context level
        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://meet.google.com', [
            'microphone',
            'camera',
            'notifications',
        ]);

        // Set a realistic user agent so Google doesn't block headless
        await page.setUserAgent(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        if (!config.meetUrl) {
            console.log('⚠️  No MEET_URL set in .env — browser launched but not joining any meeting.');
            return;
        }

        console.log(`🌐 Navigating to Google Meet: ${config.meetUrl}`);
        await page.goto(config.meetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('✅ Page loaded');

        // ── Step 1: Dismiss "Sign in" / "Continue as guest" prompt ──────────
        try {
            await page.waitForFunction(
                () => {
                    const btns = [...document.querySelectorAll('button')];
                    return btns.some(b =>
                        b.innerText.includes('without') ||
                        b.innerText.includes('guest')   ||
                        b.innerText.includes('Continue')
                    );
                },
                { timeout: 8000 }
            );

            const buttons = await page.$$('button');
            for (const btn of buttons) {
                const text = await btn.evaluate(el => el.innerText.trim());
                if (
                    text.toLowerCase().includes('without') ||
                    text.toLowerCase().includes('guest')   ||
                    text.toLowerCase().includes('continue')
                ) {
                    await btn.click();
                    console.log(`✅ Dismissed sign-in prompt ("${text}")`);
                    await sleep(1500);
                    break;
                }
            }
        } catch (_) {
            console.log('ℹ️  No sign-in prompt detected, continuing...');
        }

        // ── Step 2: Enter bot name ───────────────────────────────────────────
        try {
            await page.waitForSelector('input[placeholder="Your name"]', { timeout: 10000 });
            await page.click('input[placeholder="Your name"]');
            await page.keyboard.type(config.botName);
            console.log(`✅ Name entered: "${config.botName}"`);
            await sleep(500);
        } catch (_) {
            console.log('ℹ️  No name input field found, skipping...');
        }

        // ── Step 3: Turn off camera (if not already off) ─────────────────────
        try {
            const camButtons = await page.$$('[aria-label*="camera"], [aria-label*="Camera"]');
            for (const btn of camButtons) {
                const muted = await btn.evaluate(el => el.getAttribute('data-is-muted'));
                if (muted === 'false') {
                    await btn.click();
                    console.log('✅ Camera turned off');
                    await sleep(300);
                }
            }
        } catch (_) {
            console.log('ℹ️  Could not toggle camera, skipping...');
        }

        // ── Step 4: Click "Ask to join" / "Join now" ─────────────────────────
        try {
            console.log('⏳ Waiting for join button...');
            await page.waitForFunction(
                () => {
                    const btns = [...document.querySelectorAll('button')];
                    return btns.some(b =>
                        b.innerText.includes('Ask to join')    ||
                        b.innerText.includes('Join now')       ||
                        b.innerText.includes('Request to join')
                    );
                },
                { timeout: 15000 }
            );

            const buttons = await page.$$('button');
            for (const btn of buttons) {
                const text = await btn.evaluate(el => el.innerText.trim());
                if (
                    text.includes('Ask to join')    ||
                    text.includes('Join now')        ||
                    text.includes('Request to join')
                ) {
                    await btn.click();
                    console.log(`✅ Clicked join button: "${text}"`);
                    break;
                }
            }
        } catch (e) {
            console.error('❌ Could not find join button:', e.message);
        }

        // ── Step 5: Wait to be admitted into the meeting ──────────────────────
        console.log('⏳ Waiting in lobby — please admit Joy from your Google Meet...');
        try {
            await page.waitForFunction(
                () =>
                    document.querySelector('[aria-label*="Chat"]')        ||
                    document.querySelector('[aria-label*="chat"]')        ||
                    document.querySelector('[aria-label*="participant"]') ||
                    document.querySelector('[data-call-ended]'),
                { timeout: config.admitTimeoutMs }
            );
            console.log('🎉 Joy is now inside the meeting! Audio pipeline starting...');
        } catch (_) {
            console.log('⚠️  Timed out waiting to be admitted. Bot is still running — admit manually if needed.');
        }

    } catch (err) {
        console.error('❌ Failed to launch browser:', err.message);
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
    console.log(`\n🔌 Connecting to pipeline: ${wsUrl}`);

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        isConnected = true;
        console.log('✅ Connected to onebudd-realtime pipeline');

        const configMsg = {
            type:        'config',
            sampleRate:  config.sampleRate,
            encoding:    'pcm_s16le',
            language:    config.language,
            meetingMode: true,
            wakeWord:    config.wakeWord,
        };
        ws.send(JSON.stringify(configMsg));
        console.log('📤 Sent config:', JSON.stringify(configMsg));

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
        } catch (_) {}
    });

    ws.on('close', (code, reason) => {
        isConnected = false;
        console.log(`\n❌ Disconnected (code: ${code}, reason: ${reason || 'none'})`);
        stopAudioCapture();
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        console.error('⚠️  WebSocket error:', err.message);
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
// Audio Capture — PulseAudio parec → WebSocket
// ============================================================================
function startAudioCapture() {
    console.log('\n🎙️  Starting audio capture via parec...');
    console.log(`   Source device: "${config.inputDevice}"`);

    try {
        recordingProcess = spawn('parec', [
            `--device=${config.inputDevice}`,
            '--raw',
            `--channels=${config.channels}`,
            `--rate=${config.sampleRate}`,
            '--format=s16le',
        ]);

        recordingProcess.stdout.on('data', (chunk) => {
            if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
                if (config.interruptOnSpeech && isBotSpeaking) {
                    maybeInterruptOnSpeech(chunk);
                }
                ws.send(chunk);
                audioChunkCount++;
                if (audioChunkCount % 100 === 0) {
                    process.stdout.write(
                        `\r📡 Audio sent: ${audioChunkCount} chunks | TTS received: ${ttsChunkCount} chunks`
                    );
                }
            }
        });

        recordingProcess.stderr.on('data', (data) => {
            console.error('\n⚠️  parec stderr:', data.toString().trim());
        });

        recordingProcess.on('error', (err) => {
            console.error('\n⚠️  Audio capture error:', err.message);
        });

        recordingProcess.on('close', (code) => {
            console.log(`\n🛑 parec exited with code ${code}`);
        });

        console.log('🟢 Audio capture active');
    } catch (err) {
        console.error('❌ Failed to start audio capture:', err.message);
    }
}

function stopAudioCapture() {
    if (recordingProcess) {
        try { recordingProcess.kill('SIGTERM'); } catch (_) {}
        recordingProcess = null;
        console.log('🛑 Audio capture stopped');
    }
}

// ============================================================================
// TTS Playback — WebSocket audio → paplay → VirtualSpeaker → Meet mic
// ============================================================================
function ensurePaplay() {
    if (!paplayProcess) {
        paplayProcess = spawn('paplay', [
            `--device=${config.outputDevice}`,
            '--raw',
            `--channels=${config.channels}`,
            `--rate=${config.sampleRate}`,
            '--format=s16le',
        ]);

        paplayProcess.stdin.on('error', (err) => {
            console.error('\n⚠️  paplay stdin error:', err.message);
        });

        paplayProcess.stderr.on('data', (data) => {
            console.error('\n⚠️  paplay stderr:', data.toString().trim());
        });

        paplayProcess.on('close', () => {
            paplayProcess = null;
        });

        paplayProcess.on('error', (err) => {
            console.error('\n⚠️  paplay spawn error:', err.message);
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
            console.log(`\n📝 [${msg.speaker || 'speaker'}]: ${msg.text}`);
            break;

        case 'meeting_activation':
            if (msg.status === 'activated') {
                console.log(`\n🎤 ✨ JOY ACTIVATED! Query: "${msg.query || ''}"`);
                const queryText = (msg.query || '').trim();
                const wordCount = queryText.length === 0
                    ? 0
                    : queryText.split(/\s+/).filter(Boolean).length;

                if (queryText.length < config.minQueryChars || wordCount < config.minQueryWords) {
                    console.log('🚫 Ignoring: query too short');
                    triggerInterrupt('empty_query');
                    isBotSpeaking = false;
                    break;
                }

                activationTimedOut = false;
                if (activationTimer) clearTimeout(activationTimer);
                activationTimer = setTimeout(() => {
                    activationTimedOut = true;
                    console.log('🚫 Activation timed out');
                    triggerInterrupt('activation_timeout');
                }, config.activationTimeoutMs);

                isBotSpeaking = true;
            } else if (msg.status === 'idle') {
                console.log('🔇 Joy is idle (listening for wake word)');
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
            if (paplayProcess) {
                try { paplayProcess.stdin.end(); } catch (_) {}
                paplayProcess = null;
            }
            isBotSpeaking = false;
            activationTimedOut = false;
            if (activationTimer) {
                clearTimeout(activationTimer);
                activationTimer = null;
            }
            console.log('\n🔇 TTS finished — Joy is listening again');
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
    console.log(`\n⛔ Interrupt triggered (${reason})`);
    sendControl('interrupt');

    if (paplayProcess) {
        try { paplayProcess.kill('SIGTERM'); } catch (_) {}
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
// Utility
// ============================================================================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Startup
// ============================================================================
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║         🤖  Joy Meeting Client  (Ubuntu / PulseAudio)  ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Pipeline URL  : ${config.wsUrl}`);
console.log(`Wake Word     : "${config.wakeWord}"`);
console.log(`Bot Name      : "${config.botName}"`);
console.log(`Sample Rate   : ${config.sampleRate} Hz`);
console.log(`Input Device  : ${config.inputDevice}`);
console.log(`Output Device : ${config.outputDevice}`);
console.log(`Meet URL      : ${config.meetUrl || '(not set)'}`);
console.log('');

// Launch browser first, then connect WebSocket
launchBrowser().then(() => {
    connect();
});

// ============================================================================
// Graceful Shutdown
// ============================================================================
process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down Joy Meeting Client...');
    stopAudioCapture();
    if (paplayProcess) {
        try { paplayProcess.kill('SIGTERM'); } catch (_) {}
    }
    if (ws) ws.close();
    if (browser) await browser.close();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
});