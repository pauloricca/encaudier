import argparse
import struct
import sys
import wave
import zlib
from pathlib import Path

import numpy as np

from progress import Progress
from protocol import FREQUENCY, MAX_BITRATE, SAMPLE_RATE, safe_filename, validate_frequency
from receiver import MAX_BYTES, OVERSAMPLE, find_candidates, listen


def tone_levels(source, bitrate, frequency=FREQUENCY, progress=None):
    """Measure the carrier in overlapping bit windows, eight offsets per bit."""
    with wave.open(str(source), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("Expected a mono, 16-bit PCM WAV file")
        validate_frequency(frequency, wav.getframerate())
        if bitrate > wav.getframerate():
            raise ValueError("Bitrate must not exceed the recording sample rate")
        samples_per_bit = wav.getframerate() / bitrate
        bins = np.zeros(int(np.ceil(wav.getnframes() * OVERSAMPLE / samples_per_bit))
                        + OVERSAMPLE, dtype=complex)
        start = 0
        while raw := wav.readframes(65536):
            samples = np.frombuffer(raw, dtype="<i2")
            n = np.arange(start, start + len(samples))
            indices = (n * OVERSAMPLE / samples_per_bit).astype(int)
            edges = np.r_[0, np.flatnonzero(np.diff(indices)) + 1]
            mixed = samples * np.exp(-2j * np.pi * frequency * n / wav.getframerate())
            bins[indices[edges]] += np.add.reduceat(mixed, edges)
            start += len(samples)
            if progress is not None:
                progress(75 * start / wav.getnframes())
        if start != wav.getnframes():
            raise ValueError("WAV audio is truncated")
    # Smooth before bit integration to reduce nearby tones leaking into the carrier.
    bins = np.convolve(bins, np.ones(5) / 5, mode="same")
    sums = np.r_[0j, np.cumsum(bins)]
    levels = 2 * np.abs(sums[OVERSAMPLE:] - sums[:-OVERSAMPLE]) / samples_per_bit
    return levels, start / samples_per_bit


def decode(source, bitrate, threshold=None, frequency=FREQUENCY, progress=None, with_filename=False):
    """Return verified bytes, or (bytes, safe filename) when with_filename is true."""
    report = progress if progress is not None else lambda percent: None
    levels, duration_bits = tone_levels(source, bitrate, frequency, progress=report)
    report(80)
    candidates = find_candidates(levels, threshold, report)
    report(95)
    for index, (_, begin, cutoff) in enumerate(candidates):
        report(95 + 4 * index / len(candidates))
        values = levels[begin::OVERSAMPLE]
        if len(values) < 48:
            continue
        header = np.packbits(values[:48] > cutoff).tobytes()
        size, name_size = struct.unpack(">IH", header)
        bit_count = (size + name_size + 10) * 8
        if bit_count > len(values) or begin / OVERSAMPLE + bit_count > duration_bits + 1 / OVERSAMPLE:
            continue
        packet = np.packbits(values[:bit_count] > cutoff).tobytes()
        if zlib.crc32(packet[:-4]) == struct.unpack(">I", packet[-4:])[0]:
            try:
                filename = safe_filename(packet[6:6 + name_size].decode("utf-8"))
            except UnicodeDecodeError:
                continue
            data = packet[6 + name_size:-4]
            return (data, filename) if with_filename else data
    raise ValueError("No complete frame with a valid CRC found; check bitrate, signal, or recording length")


def main():
    parser = argparse.ArgumentParser(description="Find and decode a framed OOK transmission.")
    parser.add_argument("file", nargs="?", help="Input WAV path; omit to listen to the microphone")
    parser.add_argument("--bitrate", type=int, default=100, help="Must match the encoder (default: 100)")
    parser.add_argument("--frequency", type=float, default=FREQUENCY,
                        help="Carrier frequency in Hz; must match the encoder (default: 2000)")
    parser.add_argument("--output", type=Path, help="Output path (default: transmitted filename, or decoded.bin)")
    parser.add_argument("--threshold", type=float, help="Override the automatic tone amplitude threshold")
    parser.add_argument("--device", help="Microphone device name or index (default: system input)")
    parser.add_argument("--sample-rate", type=int, default=SAMPLE_RATE,
                        help="Microphone sample rate (default: 48000)")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES,
                        help="Maximum file size in microphone mode (default: 67108864)")
    args = parser.parse_args()
    if not 1 <= args.bitrate <= MAX_BITRATE:
        parser.error(f"Bitrate must be between 1 and {MAX_BITRATE}")
    if args.threshold is not None and not 0 <= args.threshold < 32768:
        parser.error("Threshold must be between 0 and 32767")
    if args.sample_rate <= 0 or args.max_bytes < 0:
        parser.error("Sample rate must be positive and maximum file size must be nonnegative")
    try:
        with Progress("Decoding") as progress:
            if args.file is None:
                device = int(args.device) if args.device and args.device.isdecimal() else args.device
                data, filename = listen(args.bitrate, args.frequency, args.threshold, args.sample_rate,
                                        device, args.max_bytes, progress=progress, with_filename=True)
            else:
                data, filename = decode(args.file, args.bitrate, args.threshold, args.frequency,
                                        progress=progress, with_filename=True)
            output = args.output or Path(filename)
            output.write_bytes(data)
    except KeyboardInterrupt:
        print("Stopped; no file saved.", file=sys.stderr)
        return 130
    except (OSError, EOFError, wave.Error, ValueError) as exc:
        parser.error(str(exc))
    print(f"Created {output} ({len(data)} bytes; CRC32 verified)")


if __name__ == "__main__":
    raise SystemExit(main())
