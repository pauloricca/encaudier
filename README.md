# Encaudier

Transmit a file as an on/off audio tone, or through an animated black-and-white grid in the browser.

## Browser app

Open `web/index.html` for a self-contained HTML/JavaScript encoder and decoder.
The **play** tab accepts a dragged or selected file, generates a compatible
WAV with progress, and offers an audio player and download. It works offline,
including when opened directly from disk.

The **listen** tab listens through the microphone after you click Start and
grant access. It detects the frame, shows receiving progress, checks CRC32, and
offers the original bytes with their transmitted filename (or `received.bin` if
unnamed). Microphone capture stops after a successful reception, when you click Stop, or when you leave the listen tab.

For browser microphone or camera access, serve the page on localhost:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

Open `http://localhost:8000` in a modern browser. HTTPS also supports microphone
and camera access. The local server only serves the page: file data, camera video, and microphone audio
stay in the browser. There are no uploads, external scripts, fonts, analytics,
or network calls from the app. A content security policy blocks network
connections; workers and audio use local blobs.

Both settings must match the sender. Defaults match the Python scripts; the
fast preset uses 9,600 bits/sec and a 12 kHz carrier. The browser limits generated
WAVs to 512 MiB and received files to 64 MiB to control memory use. Reception has
the same clock-drift and audio-channel limitations as the Python decoder.

The bundled HTML has no runtime dependencies or build requirement. After editing
`web/app.js`, `web/modem-worker.js`, `web/visual-codec.js`,
`web/visual-app.js`, or `web/index.template.html`, rebuild it with
`python3 web/build.py`. Browser/Python compatibility tests run with
`node --test web/test-modem.mjs` (Node.js and the Python requirements below).

## Screen-to-camera transfer (web only)

On the sending computer, open **show**, choose a file, and click **show file**.
On the receiving computer, open **scan**, click **start camera**, and allow camera
access. Aim at the sending screen with all four corner markers in view. Use
**expand** on the sender to make the grid larger. After reception, download the
original file with its filename and a verified checksum. Camera capture stops
automatically on success, when stopped, or when leaving the scan tab.

The sender has two numeric settings, styled like the audio controls:

| Setting | Default | Range |
| --- | --- | --- |
| Density (boxes per side) | 48 × 48 | 32–96 |
| Rate (frames per second) | 15 fps | 1–30 fps |

The receiver reads the density from a fixed stripe in the grid and automatically
finds the corner markers, orientation, and perspective. No matching receiver
settings or manual corner clicks are needed. Density is locked while transmitting;
stop to change it. Rate can change during transmission. The arrow resets both
settings to their defaults. An estimate shows payload capacity before retries.
Higher density needs a larger, sharper camera image; higher frame rates need a
shorter exposure and faster processing. Lower either setting if reception stalls.

Frames loop continuously. The receiver accepts numbered chunks in any order,
ignores duplicates, and collects missed chunks on later loops. Every frame has a
CRC32 to reject corruption and mixed frames from screen/camera timing; a second
CRC32 covers the complete filename and file. There is no return channel or error
correction: stop the sender after the receiver finishes. To receive a different
file, stop and restart the camera. Visual files are limited to 16 MiB. Screen glare,
blur, rolling shutter, and camera resolution affect practical speed; start with a
small file. The animation flashes black and white, with a notice before starting.

The optical protocol is separate from the Python/audio protocol. It runs entirely
in the page, without external libraries or network calls. Run its synthetic camera
and packet tests with `node --test web/test-visual.mjs`; these cover perspective,
rotation, mirroring, blur, noise, density detection, missed frames, corruption,
and complete file recovery. Real screen-to-camera performance needs hardware testing.

## Python scripts

```sh
python3 -m pip install -r requirements.txt
python3 encoder.py ./input.bin --bitrate 100 --output transmission.wav
python3 decoder.py ./recording.wav --bitrate 100 --output restored.bin
```

The encoder transmits the input file's basename, including its extension and
Unicode characters. Omit `--output` on the decoder to save under that name in the
current directory; an explicit `--output` takes precedence. Unnamed frames use
`decoded.bin`. Received names have directory components removed and unsafe
filename characters replaced.

Both commands print progress percentages to stderr, updating one line in a
terminal. The decoder's percentage covers audio scanning and frame detection;
100% means the CRC was verified and the recovered file was written.

## Receive from a microphone

Omit the WAV filename to listen to the system's default microphone:

```sh
python3 decoder.py --bitrate 100 --output received.bin
python3 decoder.py --bitrate 9600 --frequency 12000 --output received.bin
```

Start the decoder before playing the transmission. It prints a message when it
detects the start marker, receives the file, checks CRC32, saves it, and exits.
The file length and CRC identify the end; no end marker or silence is required.
Corrupted frames are discarded while the decoder continues listening. Press
Ctrl+C to stop without saving a partial file.

Microphone mode uses `sounddevice`, included in `requirements.txt`. Allow your
terminal microphone access if the operating system asks. Use `--device NAME`
or `--device INDEX` to select an input, and `--sample-rate 44100` if needed
(default: 48000). On systems without PortAudio, install it through your system
package manager before using microphone mode.

While waiting, the decoder keeps a short search buffer rather than recording
indefinitely. After the file length arrives it displays receiving progress.
Microphone reception defaults to a 64 MiB file limit to reject implausible
headers; change it with `--max-bytes`. Dropped audio resets reception and the
decoder waits for a new start marker. The clock-drift limitations below still
apply to live reception.

## Audio settings

Use the same bitrate at both ends (default: 100; supported: 1–9,600 bits/sec).
Set `--frequency` in Hz on both scripts to choose the carrier (default: 2000).
For example:

```sh
python3 encoder.py ./input.bin --bitrate 9600 --frequency 12000 --output transmission.wav
python3 decoder.py ./recording.wav --bitrate 9600 --frequency 12000 --output restored.bin
```

Paths are relative to the current directory. The encoder produces mono, 16-bit
PCM at 48 kHz. The decoder accepts mono, 16-bit PCM recordings at other sample
rates, including 44.1 kHz. The carrier must be positive and below half the sample
rate at both ends (below 24 kHz for the encoder). High bitrates and carriers need
testing with your audio hardware; accepting a setting does not guarantee decoding.

## Transmission format

| Field | Format |
| --- | --- |
| Preamble | Repeated `0xAA` (`10101010`), at least 64 bits and about one second or longer |
| Start marker | Four bytes: `D3 91 C5 A8` |
| File length | Unsigned 32-bit byte count, big-endian |
| Filename length | Unsigned 16-bit UTF-8 byte count, big-endian |
| Filename | UTF-8 basename (may be empty; maximum 65,535 bytes) |
| File | Original bytes, most significant bit first |
| Checksum | CRC32 of both length fields, filename bytes, and file bytes, unsigned 32-bit big-endian |

The length identifies the end; no end marker or escaping of file contents is
needed. CRC detects corruption; it does not repair it. The filename format uses a new start marker; both sender and receiver must be
updated, and WAV files from earlier encoders must be regenerated.

The decoder searches the recording for the preamble and start marker, estimates
the signal level and bit alignment, and checks the CRC before writing output.
It measures the selected carrier rather than treating any loud sample as a bit.
Leading/trailing silence and unrelated sound outside the transmission are allowed.
`--threshold 1000` overrides automatic tone amplitude threshold selection if needed.

This is a basic audio modem: it does not continuously track clock drift, correct
errors, or request retransmissions. Start with short files and 100 bits/sec for
speaker-to-microphone experiments. Long recordings, echoes, changing volume, or
different playback/recording clock speeds can still prevent decoding. When a
recording contains multiple transmissions, the decoder returns one valid frame.

Run the tests with:

```sh
python3 -m unittest -v
```
