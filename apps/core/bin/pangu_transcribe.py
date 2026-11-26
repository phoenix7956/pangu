#!/usr/bin/env python3
"""Local Whisper speech-to-text bridge used by Pangu."""
import json
import os
import shutil
import sys

def _load_audio(path, sr=16000):
    """Decode via the system ffmpeg selected by the Node bridge, not the local ffprobe shim."""
    import subprocess
    ffmpeg = os.environ.get("PANGU_FFMPEG") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    cmd = [ffmpeg, "-nostdin", "-threads", "0", "-i", path, "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", str(sr), "-"]
    data = subprocess.run(cmd, capture_output=True, check=True).stdout
    import numpy as np
    return np.frombuffer(data, np.int16).flatten().astype(np.float32) / 32768.0

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "NO_AUDIO"}, ensure_ascii=False))
        return 2
    model_name = os.environ.get("PANGU_STT_MODEL", "medium")
    try:
        import whisper
        import whisper.audio
        whisper.audio.load_audio = _load_audio
        model = whisper.load_model(model_name, device="cpu", download_root=os.path.expanduser("~/.cache/whisper"))
        audio = _load_audio(sys.argv[1])
        import numpy as np
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        # Whisper hallucinates subtitles on silence/background noise. Reject captures
        # with no meaningful acoustic signal before they reach the chat model.
        if audio.size < 16000 * 0.25 or (rms < 0.003 and peak < 0.02):
            print(json.dumps({"ok": False, "error": "NO_SPEECH", "message": "没有检测到清晰人声", "rms": round(rms, 6), "peak": round(peak, 6)}, ensure_ascii=False))
            return 0
        result = model.transcribe(
            audio, language="zh", task="transcribe", fp16=False, temperature=0,
            condition_on_previous_text=False, no_speech_threshold=0.6,
            logprob_threshold=-1.0, compression_ratio_threshold=2.2,
        )
        segments = result.get("segments") or []
        # A prompt biases Whisper toward inventing that phrase for tones/noise.
        # Whisper's log-probability is commonly below -1 for perfectly usable
        # Chinese speech, especially from display microphones. Keep no-speech
        # as the hard gate and use a permissive decoder threshold.
        voiced = [
            s for s in segments
            if float(s.get("no_speech_prob", 1.0)) < 0.7
            and float(s.get("avg_logprob", -99.0)) > -1.5
        ]
        text = "".join(str(s.get("text", "")) for s in voiced).strip()
        if not text and segments:
            # Do not turn a low-confidence but voiced sentence into an empty
            # submission. The RMS/no-speech gates above still reject silence.
            text = str(result.get("text", "")).strip()
        if not text:
            print(json.dumps({"ok": False, "error": "NO_SPEECH", "message": "没有检测到清晰人声", "rms": round(rms, 6), "peak": round(peak, 6)}, ensure_ascii=False))
            return 0
        print(json.dumps({"ok": True, "text": text, "model": model_name, "language": "zh", "rms": round(rms, 6), "peak": round(peak, 6)}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "STT_FAILED", "message": str(exc)}, ensure_ascii=False))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
