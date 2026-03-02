# 🤖 Joy Meeting Client (Ubuntu Headless)

A standalone headless Chrome (Puppeteer) bot that connects Google Meet to the **onebudd-realtime** pipeline, enabling Joy (the AI meeting assistant) to listen, transcribe, and respond in your meetings.

## Architecture

```
Google Meet (Chrome) audio output → VirtualSpeaker.monitor (PulseAudio) → parec → WebSocket → onebudd-realtime
Google Meet (Chrome) mic input  ← VirtualMic (PulseAudio) ← paplay ← WebSocket ← onebudd-realtime
```
- Chrome runs headlessly using `Xvfb` on display `:99`.
- It uses a virtual microphone (`VirtualMic`) for its input, injected with Joy's text-to-speech audio via `paplay`.
- It uses a virtual speaker (`VirtualSpeaker`) for output. The bot captures this through `parec` on `VirtualSpeaker.monitor` to send to the real-time server for speech-to-text.

## Prerequisites

1. **Ubuntu 20.04/22.04+** 
2. **Node.js 18+**
3. **Puppeteer dependencies (Chrome & Xvfb)**
   ```bash
   sudo apt update
   sudo apt install -y xvfb pulseaudio libnss3 libasound2 libatk-bridge2.0-0 libgtk-3-0
   ```

### Audio Routing Setup (PulseAudio)

Start PulseAudio and create the virtual devices:

```bash
pulseaudio --start

# Create the virtual speaker sink (Chrome's audio output and TTS playback destination)
pactl load-module module-null-sink sink_name=VirtualSpeaker sink_properties=device.description="VirtualSpeaker"

# Create the virtual microphone (Chrome's input, bound to VirtualSpeaker)
pactl load-module module-virtual-source source_name=VirtualMic master=VirtualSpeaker.monitor
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and edit config
cp .env.example .env
# Edit .env with your pipeline URL, MEET_URL, API keys

# 3. Verify PulseAudio devices exist
npm run list-devices

# 4. Start Xvfb (Virtual Display)
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# 5. Start the bridge
npm start
```

## Configuration (.env)

| Variable | Description |
|----------|-------------|
| `PIPELINE_WS_URL` | URL of the onebudd-realtime server |
| `API_KEY` | Your API key for authentication |
| `MEET_URL` | The Google Meet link to automatically join |
| `INPUT_DEVICE` | `VirtualSpeaker.monitor` (Audio capture target) |
| `OUTPUT_DEVICE` | `VirtualSpeaker` (TTS output target for paplay) |
