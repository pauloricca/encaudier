import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from decoder import decode
from encoder import generate
from protocol import AMPLITUDE, SAMPLE_RATE, frame


class ModemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.audio = Path(self.temp.name) / "transmission.wav"
        self.rng = np.random.default_rng(42)

    def read_audio(self):
        with wave.open(str(self.audio), "rb") as wav:
            return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").copy()

    def write_audio(self, samples, rate=SAMPLE_RATE, channels=1):
        with wave.open(str(self.audio), "wb") as wav:
            wav.setparams((channels, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes(np.clip(samples, -32768, 32767).astype("<i2").tobytes())

    def test_round_trips(self):
        for data in (b"", b"\x00\xff", bytes(range(256))):
            for bitrate in (100, 137, 999, 1000, 4000):
                with self.subTest(size=len(data), bitrate=bitrate):
                    generate(data, bitrate, self.audio)
                    self.assertEqual(decode(self.audio, bitrate), data)

    def test_noise_volume_and_arbitrary_start(self):
        data = bytes(range(256))
        for bitrate in (100, 137, 1000):
            generate(data, bitrate, self.audio)
            clean = self.read_audio()
            for gain, noise in ((0.05, 100), (0.5, 2000)):
                with self.subTest(bitrate=bitrate, gain=gain):
                    samples = np.r_[np.zeros(12347), clean * gain, np.zeros(5317)]
                    samples += self.rng.normal(0, noise, len(samples))
                    # A strong unrelated tone should not be interpreted as data.
                    samples += 3000 * np.sin(2 * np.pi * 3500 * np.arange(len(samples)) / SAMPLE_RATE)
                    self.write_audio(samples)
                    self.assertEqual(decode(self.audio, bitrate), data)

    def test_configurable_carrier_and_9600_bitrate(self):
        for bitrate, frequency in ((137, 7321.5), (4000, 8000), (9600, 8000),
                                   (9600, 12000), (9600, 16000)):
            for data in (b"", bytes(range(256))):
                with self.subTest(bitrate=bitrate, frequency=frequency, size=len(data)):
                    generate(data, bitrate, self.audio, frequency=frequency)
                    samples = np.r_[np.zeros(12347), self.read_audio() * 0.5, np.zeros(5317)]
                    samples += self.rng.normal(0, 100, len(samples))
                    self.write_audio(samples)
                    self.assertEqual(decode(self.audio, bitrate, frequency=frequency), data)

    def test_invalid_carrier_frequency(self):
        generate(b"test", 100, self.audio)
        for frequency in (0, -1, 24000, 48000, float("nan"), float("inf")):
            with self.subTest(frequency=frequency):
                with self.assertRaisesRegex(ValueError, "Frequency"):
                    generate(b"test", 100, self.audio, frequency=frequency)
                with self.assertRaisesRegex(ValueError, "Frequency"):
                    decode(self.audio, 100, frequency=frequency)
        self.write_audio(np.zeros(100), rate=44100)
        with self.assertRaisesRegex(ValueError, "22050"):
            decode(self.audio, 100, frequency=23000)

    def test_other_sample_rate(self):
        data = b"Microphone sample rate"
        generate(data, 137, self.audio)
        samples = self.read_audio()
        resampled = np.interp(np.arange(0, len(samples), SAMPLE_RATE / 44100),
                              np.arange(len(samples)), samples)
        self.write_audio(np.r_[np.zeros(1739), resampled, np.zeros(300)], rate=44100)
        self.assertEqual(decode(self.audio, 137), data)

    def test_corruption_truncation_and_wrong_bitrate(self):
        generate(b"\xff" * 10, 100, self.audio)
        clean = self.read_audio()
        # Erase an entire payload bit, leaving the preamble and header intact.
        payload_bit = (len(frame(b"", 100)) - 4) * 8
        damaged = clean.copy()
        damaged[payload_bit * 480:(payload_bit + 1) * 480] = 0
        for samples, bitrate in ((damaged, 100), (clean[:-4800], 100), (clean, 137)):
            self.write_audio(samples)
            with self.assertRaisesRegex(ValueError, "valid CRC"):
                decode(self.audio, bitrate)

    def test_noise_silence_and_wrong_carrier(self):
        generate(b"hello", 100, self.audio)
        bits = np.unpackbits(np.frombuffer(frame(b"hello", 100), dtype=np.uint8))
        n = np.arange(len(bits) * 480)
        wrong_carrier = AMPLITUDE * np.sin(2 * np.pi * 3500 * n / SAMPLE_RATE) * bits[n // 480]
        for samples in ([], np.zeros(96000), self.rng.normal(0, 1000, 96000), wrong_carrier):
            self.write_audio(samples)
            with self.assertRaises(ValueError):
                decode(self.audio, 100)

    def test_skips_broken_frame_and_finds_next(self):
        generate(b"\xff" * 10, 100, self.audio)
        broken = self.read_audio()
        payload_bit = (len(frame(b"", 100)) - 4) * 8
        broken[payload_bit * 480:(payload_bit + 1) * 480] = 0
        generate(b"second frame", 100, self.audio)
        self.write_audio(np.r_[broken, np.zeros(1237), self.read_audio()])
        self.assertEqual(decode(self.audio, 100), b"second frame")

    def test_cli_and_failed_decode_preserves_output(self):
        root = Path(__file__).resolve().parent
        source = Path(self.temp.name) / "source.bin"
        output = source.with_name("restored.bin")
        source.write_bytes(b"\x00\xffCLI test")
        for options in ([], ["--bitrate", "9600", "--frequency", "12000"]):
            for script, args in (("encoder.py", [source.name]),
                                 ("decoder.py", ["ook.wav", "--output", output.name])):
                result = subprocess.run([sys.executable, str(root / script), *args, *options],
                                        cwd=self.temp.name, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_bytes(), source.read_bytes())
        self.write_audio(np.zeros(48000))
        result = subprocess.run([sys.executable, str(root / "decoder.py"), str(self.audio),
                                 "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(output.read_bytes(), source.read_bytes())


if __name__ == "__main__":
    unittest.main()
