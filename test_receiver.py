import contextlib
import io
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

from decoder import main, tone_levels
from encoder import generate
from protocol import MARKER, SAMPLE_RATE, frame
from receiver import LiveDecoder, ToneStream, listen


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test.wav"
        self.rng = np.random.default_rng(123)

    def audio(self, data, bitrate=100, frequency=2000):
        generate(data, bitrate, self.path, frequency)
        with wave.open(str(self.path), "rb") as wav:
            return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").copy()

    def feed(self, receiver, samples):
        start = 0
        for index in range(100000):
            size = (17, 4800, 4093)[index % 3]
            result = receiver.feed(samples[start:start + size])
            start += size
            if result is not None:
                return result, min(start, len(samples))
            if start >= len(samples):
                return None, len(samples)
        self.fail("Receiver did not make progress")

    def test_streamed_tone_measurements_match_file(self):
        for bitrate, frequency in ((137, 2000), (9600, 12000)):
            with self.subTest(bitrate=bitrate):
                audio = self.audio(bytes(range(256)), bitrate, frequency)
                expected, _ = tone_levels(self.path, bitrate, frequency)
                detector = ToneStream(bitrate, frequency)
                actual = np.concatenate([detector.feed(audio[i:i + 4093])
                                         for i in range(0, len(audio), 4093)])
                np.testing.assert_allclose(actual, expected[:len(actual)], atol=1e-5)
                self.assertLess(len(detector.bins), 16)

    def test_live_round_trips_with_noise_and_arbitrary_blocks(self):
        for bitrate, frequency in ((100, 2000), (137, 7321.5), (9600, 12000)):
            for data in (b"", bytes(range(256))):
                with self.subTest(bitrate=bitrate, size=len(data)):
                    clean = self.audio(data, bitrate, frequency)
                    samples = np.r_[np.zeros(12347), clean * 0.5, np.zeros(48000)]
                    samples += self.rng.normal(0, 100, len(samples))
                    samples = samples.astype(np.int16)
                    statuses, percentages = [], []
                    receiver = LiveDecoder(bitrate, frequency, status=statuses.append,
                                           progress=percentages.append)
                    result, consumed = self.feed(receiver, samples)
                    self.assertEqual(result, data)
                    self.assertLess(consumed, len(samples))
                    self.assertTrue(any("Start marker" in message for message in statuses))
                    self.assertTrue(percentages)

    def test_corrupt_frame_then_valid_frame(self):
        corrupt = self.audio(b"\xff" * 10)
        payload_bit = (len(frame(b"", 100)) - 4) * 8
        corrupt[payload_bit * 480:(payload_bit + 1) * 480] = 0
        good = self.audio(b"good second frame")
        receiver = LiveDecoder(100)
        result, _ = self.feed(receiver, np.r_[corrupt, np.zeros(4800), good, np.zeros(4800)])
        self.assertEqual(result, b"good second frame")

    def test_idle_search_buffer_is_bounded(self):
        receiver = LiveDecoder(9600, 12000)
        for _ in range(150):
            self.assertIsNone(receiver.feed(self.rng.normal(0, 100, 4800)))
        self.assertLessEqual(len(receiver.history), (len(MARKER) * 8 + 40) * 8)
        self.assertLess(len(receiver.tones.bins), 16)
        self.assertEqual(receiver.active, [])

    def test_oversized_header_does_not_block_next_frame(self):
        rejected = self.audio(b"X" * 100)
        good = self.audio(b"OK")
        receiver = LiveDecoder(100, max_bytes=10)
        result, _ = self.feed(receiver, np.r_[rejected, np.zeros(4800), good, np.zeros(4800)])
        self.assertEqual(result, b"OK")

    def fake_audio_module(self, audio, overflow_at=None):
        blocks = [audio[i:i + 4800].astype(np.int16).tobytes()
                  for i in range(0, len(audio), 4800)]
        owner = self

        class Stream:
            closed = False

            def __init__(self, **kwargs):
                self.index = 0
                self.options = kwargs

            def __enter__(self):
                return self

            def __exit__(self, *args):
                Stream.closed = True

            def read(self, size):
                owner.assertLess(self.index, len(blocks), "Receiver did not stop after a valid frame")
                index = self.index
                self.index += 1
                return blocks[index], index == overflow_at

        return types.SimpleNamespace(RawInputStream=Stream, PortAudioError=RuntimeError)

    def test_microphone_cli_saves_and_stops(self):
        data = b"Microphone CLI\x00\xff"
        samples = np.r_[np.zeros(1234), self.audio(data, 9600, 12000), np.zeros(48000)]
        module = self.fake_audio_module(samples)
        output = Path(self.temp.name) / "received.bin"
        argv = ["decoder.py", "--bitrate", "9600", "--frequency", "12000", "--output", str(output)]
        messages = io.StringIO()
        with patch.dict(sys.modules, sounddevice=module), patch.object(sys, "argv", argv):
            with contextlib.redirect_stderr(messages), contextlib.redirect_stdout(io.StringIO()):
                self.assertIsNone(main())
        self.assertEqual(output.read_bytes(), data)
        self.assertTrue(module.RawInputStream.closed)
        self.assertIn("Listening to microphone", messages.getvalue())
        self.assertIn("CRC32 verified", messages.getvalue())
        self.assertIn("100%", messages.getvalue())

    def test_microphone_overflow_resets_reception(self):
        partial = self.audio(b"incomplete")[:60000]
        good = self.audio(b"after overflow")
        samples = np.r_[partial, np.zeros(4800), good, np.zeros(4800)]
        module = self.fake_audio_module(samples, overflow_at=12)
        messages = io.StringIO()
        with patch.dict(sys.modules, sounddevice=module), contextlib.redirect_stderr(messages):
            self.assertEqual(listen(100), b"after overflow")
        self.assertIn("audio dropped", messages.getvalue())
        self.assertTrue(module.RawInputStream.closed)

    def test_ctrl_c_preserves_existing_output(self):
        output = Path(self.temp.name) / "received.bin"
        output.write_bytes(b"existing output")
        with patch.object(sys, "argv", ["decoder.py", "--output", str(output)]):
            with patch("decoder.listen", side_effect=KeyboardInterrupt):
                messages = io.StringIO()
                with contextlib.redirect_stderr(messages):
                    self.assertEqual(main(), 130)
        self.assertEqual(output.read_bytes(), b"existing output")
        self.assertNotIn("100%", messages.getvalue())


if __name__ == "__main__":
    unittest.main()
