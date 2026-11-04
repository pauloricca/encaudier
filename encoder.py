import argparse
import wave
from pathlib import Path

import numpy as np

from progress import Progress
from protocol import AMPLITUDE, FREQUENCY, MAX_BITRATE, SAMPLE_RATE, frame, validate_frequency


def generate(data, bitrate, output, frequency=FREQUENCY, progress=None):
    validate_frequency(frequency, SAMPLE_RATE)
    bits = np.unpackbits(np.frombuffer(frame(data, bitrate), dtype=np.uint8))
    samples_per_bit = SAMPLE_RATE / bitrate
    total_samples = round(len(bits) * samples_per_bit)
    with wave.open(str(output), "wb") as wav:
        wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        for start in range(0, total_samples, 65536):
            n = np.arange(start, min(start + 65536, total_samples))
            indices = np.minimum((n / samples_per_bit).astype(int), len(bits) - 1)
            samples = AMPLITUDE * np.sin(2 * np.pi * frequency * n / SAMPLE_RATE)
            wav.writeframesraw((samples * bits[indices]).astype("<i2").tobytes())
            if progress is not None:
                progress(100 * (start + len(n)) / total_samples)
    return total_samples / SAMPLE_RATE


def main():
    parser = argparse.ArgumentParser(description="Encode a file as framed OOK audio.")
    parser.add_argument("file", type=Path, help="Input file path")
    parser.add_argument("--bitrate", type=int, default=100)
    parser.add_argument("--frequency", type=float, default=FREQUENCY,
                        help="Carrier frequency in Hz (default: 2000)")
    parser.add_argument("--output", default="ook.wav")
    args = parser.parse_args()
    if not 1 <= args.bitrate <= MAX_BITRATE:
        parser.error(f"Bitrate must be between 1 and {MAX_BITRATE}")
    try:
        with Progress("Encoding") as progress:
            duration = generate(args.file.read_bytes(), args.bitrate, args.output,
                                args.frequency, progress=progress)
    except (OSError, wave.Error, ValueError) as exc:
        parser.error(str(exc))
    print(f"Created {args.output} ({duration:.2f}s)")


if __name__ == "__main__":
    main()
