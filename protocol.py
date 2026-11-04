"""Shared wire format: alternating preamble, sync, length, filename, payload, CRC32."""

import math
import struct
import zlib

SAMPLE_RATE = 48000
FREQUENCY = 2000
AMPLITUDE = 16000
MAX_BITRATE = 9600
SYNC = bytes.fromhex("d391c5a8")
TRAINING = b"\xaa" * 8  # Last 64 bits of the preamble, used for detection.
MARKER = TRAINING + SYNC


def validate_frequency(frequency, sample_rate):
    if not math.isfinite(frequency) or not 0 < frequency < sample_rate / 2:
        raise ValueError(f"Frequency must be greater than 0 and below {sample_rate / 2:g} Hz")


def safe_filename(name, fallback="decoded.bin"):
    """Keep only a portable basename; never accept a sender's directory path."""
    name = name.replace("\\", "/").split("/")[-1]
    name = "".join("_" if ord(char) < 32 or ord(char) == 127 or char in '<>:"|?*' else char
                   for char in name).strip().rstrip(". ")
    return name if name and name not in (".", "..") else fallback


def frame(data, bitrate, filename=""):
    name = safe_filename(filename, "").encode("utf-8")
    if len(name) > 65535:
        raise ValueError("Filename exceeds 65535 UTF-8 bytes")
    header = struct.pack(">IH", len(data), len(name)) + name
    checksum = struct.pack(">I", zlib.crc32(header + data))
    preamble = b"\xaa" * max(8, (bitrate + 7) // 8)
    return preamble + SYNC + header + data + checksum
