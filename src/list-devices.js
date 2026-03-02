/**
 * List available audio devices on PulseAudio.
 * Run: npm run list-devices
 */
const { execSync } = require('child_process');

console.log('=== PulseAudio Sources (Input) ===\n');
try {
    const sources = execSync('pactl list short sources', { encoding: 'utf-8' });
    console.log(sources);
} catch (e) {
    console.log('(Could not detect PulseAudio sources. Is pulseaudio running?)');
}

console.log('\n=== PulseAudio Sinks (Output) ===\n');
try {
    const sinks = execSync('pactl list short sinks', { encoding: 'utf-8' });
    console.log(sinks);
} catch (e) {
    console.log('(Could not detect PulseAudio sinks. Is pulseaudio running?)');
}

console.log('\n--- Ubuntu Headless Setup ---');
console.log('To set up the required virtual devices for the headless Google Meet bot:');
console.log('1. pactl load-module module-null-sink sink_name=VirtualSpeaker sink_properties=device.description="VirtualSpeaker"');
console.log('2. pactl load-module module-virtual-source source_name=VirtualMic master=VirtualSpeaker.monitor');
console.log('\nSet these names in your .env file as INPUT_DEVICE=VirtualSpeaker.monitor and OUTPUT_DEVICE=VirtualSpeaker');
