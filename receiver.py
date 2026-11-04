"""Frame detection and incremental microphone reception."""

import struct
import sys
import zlib

import numpy as np

from protocol import FREQUENCY, MARKER, SAMPLE_RATE, validate_frequency

OVERSAMPLE = 8
MAX_BYTES = 64 * 1024 * 1024
MARKER_BITS = np.unpackbits(np.frombuffer(MARKER, dtype=np.uint8))


def find_candidates(levels, threshold=None, progress=None):
    """Return (confidence, first header window, threshold) for possible frames."""
    pattern = MARKER_BITS.astype(float) - MARKER_BITS.mean()
    width = len(pattern)
    candidates = []
    for phase in range(OVERSAMPLE):
        if progress is not None:
            progress(80 + 15 * phase / OVERSAMPLE)
        values = levels[phase::OVERSAMPLE]
        if len(values) < width:
            continue
        sums = np.r_[0., np.cumsum(values)]
        squares = np.r_[0., np.cumsum(values ** 2)]
        variance = np.maximum(squares[width:] - squares[:-width]
                              - (sums[width:] - sums[:-width]) ** 2 / width, 0)
        scale = np.sqrt(variance * np.dot(pattern, pattern))
        correlation = np.correlate(values, pattern, mode="valid")
        scores = np.divide(correlation, scale, out=np.zeros_like(scale), where=scale > 1e-6)
        for offset in np.flatnonzero(scores > 0.85):
            training = values[offset:offset + width]
            low, high = (np.median(training[MARKER_BITS == bit]) for bit in (0, 1))
            cutoff = (low + high) / 2 if threshold is None else threshold
            if high - low >= 20 and low < cutoff < high:
                candidates.append((scores[offset], int((offset + width) * OVERSAMPLE + phase), cutoff))
    return sorted(candidates, reverse=True)


class ToneStream:
    """Incremental version of the file decoder's carrier measurement."""

    def __init__(self, bitrate, frequency=FREQUENCY, sample_rate=SAMPLE_RATE):
        validate_frequency(frequency, sample_rate)
        if not 1 <= bitrate <= sample_rate:
            raise ValueError("Bitrate must be positive and not exceed the sample rate")
        self.frequency = frequency
        self.sample_rate = sample_rate
        self.samples_per_bit = sample_rate / bitrate
        self.samples = self.bin_offset = self.next_window = 0
        self.bins = np.empty(0, dtype=complex)

    def feed(self, samples):
        if not len(samples):
            return np.empty(0)
        n = np.arange(self.samples, self.samples + len(samples))
        indices = (n * OVERSAMPLE / self.samples_per_bit).astype(int)
        self.samples += len(samples)
        complete_bins = int(self.samples * OVERSAMPLE / self.samples_per_bit)
        needed = max(int(indices[-1]) + 1, complete_bins) - self.bin_offset
        self.bins = np.pad(self.bins, (0, max(0, needed - len(self.bins))))
        edges = np.r_[0, np.flatnonzero(np.diff(indices)) + 1]
        mixed = samples * np.exp(-2j * np.pi * self.frequency * n / self.sample_rate)
        self.bins[indices[edges] - self.bin_offset] += np.add.reduceat(mixed, edges)
        # A full bit window plus two future bins for the symmetric smoothing filter.
        stop = complete_bins - OVERSAMPLE - 1
        if stop <= self.next_window:
            return np.empty(0)
        smoothed = np.convolve(self.bins, np.ones(5) / 5, mode="same")
        sums = np.r_[0j, np.cumsum(smoothed)]
        start = self.next_window - self.bin_offset
        end = stop - self.bin_offset
        levels = 2 * np.abs(sums[start + OVERSAMPLE:end + OVERSAMPLE]
                            - sums[start:end]) / self.samples_per_bit
        self.next_window = stop
        keep = max(0, stop - 2)
        self.bins = self.bins[keep - self.bin_offset:]
        self.bin_offset = keep
        return levels


class IncomingFrame:
    def __init__(self, start, threshold, max_bytes):
        self.start = self.next_window = start
        self.threshold = threshold
        self.max_bytes = max_bytes
        self.pending = np.empty(0, dtype=bool)
        self.data = bytearray()
        self.size = None
        self.error = None

    def feed(self, levels, offset):
        start = self.next_window - offset
        if start >= len(levels):
            return None
        bits = levels[start::OVERSAMPLE] > self.threshold
        self.next_window += len(bits) * OVERSAMPLE
        bits = np.r_[self.pending, bits]
        whole = len(bits) // 8 * 8
        self.data.extend(np.packbits(bits[:whole]).tobytes())
        self.pending = bits[whole:]
        if self.size is None and len(self.data) >= 4:
            self.size = struct.unpack(">I", self.data[:4])[0]
            if self.size > self.max_bytes:
                self.error = "File length exceeds the microphone receive limit"
                return None
        if self.size is not None and len(self.data) >= self.size + 8:
            packet = self.data[:self.size + 8]
            if zlib.crc32(packet[:-4]) == struct.unpack(">I", packet[-4:])[0]:
                return bytes(packet[4:-4])
            self.error = "CRC check failed"
        return None


class LiveDecoder:
    """Feed mono PCM blocks; returns bytes only when an entire frame passes CRC."""

    def __init__(self, bitrate, frequency=FREQUENCY, threshold=None, sample_rate=SAMPLE_RATE,
                 max_bytes=MAX_BYTES, progress=None, status=None):
        self.tones = ToneStream(bitrate, frequency, sample_rate)
        self.threshold = threshold
        self.max_bytes = max_bytes
        self.progress = progress or (lambda percent: None)
        self.status = status or (lambda message: None)
        self.history = np.empty(0)
        self.offset = 0
        self.active = []
        self.seen = set()
        self.last_start = self.last_header = -1000

    def feed(self, samples):
        levels = self.tones.feed(samples)
        if not len(levels):
            return None
        self.history = np.r_[self.history, levels]
        for _, start, cutoff in find_candidates(self.history, self.threshold):
            absolute = self.offset + start
            if absolute in self.seen:
                continue
            self.seen.add(absolute)
            if len(self.active) >= 32:
                oldest = min(self.active, key=lambda packet: packet.start)
                if absolute <= oldest.start:
                    continue
                self.active.remove(oldest)
            self.active.append(IncomingFrame(absolute, cutoff, self.max_bytes))
            if absolute > self.last_start + 2 * OVERSAMPLE:
                self.status("Start marker detected; reading file length...")
                self.last_start = absolute
        receiving = []
        errors = []
        for packet in self.active:
            payload = packet.feed(self.history, self.offset)
            if payload is not None:
                self.progress(99)
                return payload
            if packet.error:
                errors.append(packet.error)
                continue
            if packet.size is not None:
                if packet.start > self.last_header + 2 * OVERSAMPLE:
                    self.status(f"Receiving {packet.size} bytes...")
                    self.last_header = packet.start
                self.progress(min(99, 100 * max(0, len(packet.data) - 4) / max(1, packet.size + 4)))
            receiving.append(packet)
        self.active = receiving
        if errors and not self.active:
            self.status(f"{errors[0]}; listening for another start marker...")
        # Only the marker and a partial header must survive between audio blocks.
        keep = (len(MARKER_BITS) + 40) * OVERSAMPLE
        trim = max(0, len(self.history) - keep)
        self.history = self.history[trim:]
        self.offset += trim
        self.seen = {start for start in self.seen if start >= self.offset}
        return None


def listen(bitrate, frequency=FREQUENCY, threshold=None, sample_rate=SAMPLE_RATE,
           device=None, max_bytes=MAX_BYTES, progress=None):
    """Listen until one valid frame arrives. Ctrl+C stops without saving a file."""
    try:
        import sounddevice as sd
    except (ImportError, OSError) as exc:
        raise ValueError("Microphone mode needs sounddevice and PortAudio; install requirements.txt") from exc

    def announce(message):
        prefix = "\n" if sys.stderr.isatty() else ""
        print(prefix + message, file=sys.stderr, flush=True)
        if "listening for another" in message and hasattr(progress, "restart"):
            progress.restart()

    def receiver():
        return LiveDecoder(bitrate, frequency, threshold, sample_rate, max_bytes, progress, announce)

    live = receiver()
    blocksize = max(1, sample_rate // 10)
    try:
        with sd.RawInputStream(samplerate=sample_rate, channels=1, dtype="int16",
                               device=device, blocksize=blocksize, latency="high") as stream:
            announce("Listening to microphone; Ctrl+C to stop.")
            while True:
                raw, overflowed = stream.read(blocksize)
                if overflowed:
                    announce("Microphone audio dropped; listening for another start marker...")
                    live = receiver()
                payload = live.feed(np.frombuffer(raw, dtype=np.int16))
                if payload is not None:
                    announce("Complete frame received; CRC32 verified.")
                    return payload
    except sd.PortAudioError as exc:
        raise ValueError(f"Cannot capture microphone audio: {exc}. Check the input device and microphone permission.") from exc
