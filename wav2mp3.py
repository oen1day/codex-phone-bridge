"""从 stdin 读 WAV，用 lameenc 编码成 64kbps MP3 写到 stdout。"""
import io
import sys
import wave

import lameenc


def main():
    data = sys.stdin.buffer.read()
    if not data:
        return
    wav = wave.open(io.BytesIO(data), "rb")
    rate = wav.getframerate()
    channels = wav.getnchannels()
    frames = wav.readframes(wav.getnframes())
    wav.close()
    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(rate)
    enc.set_channels(channels)
    enc.set_quality(2)
    mp3 = enc.encode(frames)
    mp3 += enc.flush()
    sys.stdout.buffer.write(mp3)


if __name__ == "__main__":
    main()
