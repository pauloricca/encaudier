"""Shared wire format: alternating preamble, sync, length, payload, CRC32."""

import math
import struct
import zlib

SAMPLE_RATE = 48000
FREQUENCY = 2000
AMPLITUDE = 16000
MAX_BITRATE = 9600
SYNC = bytes.fromhex("d391c5a7")
TRAINING = b"\xaa" * 8  # Last 64 bits of the preamble, used for detection.
MARKER = TRAINING + SYNC


def validate_frequency(frequency, sample_rate):
    if not math.isfinite(frequency) or not 0 < frequency < sample_rate / 2:
        raise ValueError(f"Frequency must be greater than 0 and below {sample_rate / 2:g} Hz")


def frame(data, bitrate):
    header = struct.pack(">I", len(data))
    checksum = struct.pack(">I", zlib.crc32(header + data))
    preamble = b"\xaa" * max(8, (bitrate + 7) // 8)
    return preamble + SYNC + header + data + checksum
