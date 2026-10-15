# TODO: Local Voice Pipeline (Kokoro TTS + Whisper STT)

## Missing Local Voice Pipeline

The current AI pipeline has:
- ✅ LLM: Ollama + OpenAI-compatible
- ✅ RAG/Embeddings: Local neural (Xenova/all-MiniLM-L6-v2) + Ollama + OpenAI-compatible
- ✅ Realtime API (OpenAI Realtime compatible)
- ✅ Browser Web Speech API (client-side STT/TTS for testing)
- ❌ **Local Kokoro TTS** - lightweight ONNX TTS model
- ❌ **Local Whisper STT** - faster-whisper / whisper.cpp server
- ❌ **Piper TTS** - lightweight multi-voice ONNX TTS
- ❌ **Voice pipeline integration** in `src/lib/ai/speech.ts`

## Implementation Plan

### 1. Kokoro TTS (Lightweight, ~80MB ONNX)
- Model: `hexgrad/Kokoro-82M` or `onnx-community/Kokoro-82M-v1.0-ONNX`
- Integration: `src/lib/ai/speech.ts` → new provider kind `'kokoro'`
- Use `transformers.js` for ONNX inference (already in deps)
- Voices: 50+ voices, multiple languages

### 2. Whisper STT (Local)
- Option A: `faster-whisper` server (Python) + REST wrapper
- Option B: `whisper.cpp` + `whisper-node` native binding
- Option C: ONNX Whisper via transformers.js (larger model)
- Integration: new provider kind `'whisper'`

### 3. Piper TTS (Alternative lightweight)
- Model: `rhasspy/piper` ONNX models (~30-50MB each)
- Many voices, very fast
- Integration: new provider kind `'piper'`

### 3. Integration Points
- `src/lib/ai/speech.ts`:
  - Add `'kokoro'`, `'piper'`, `'whisper'` to `ProviderKind`
  - Add to `CAPABILITY_INFO` kinds for `stt`/`tts`
  - Implement `transcribeAudio` / `synthesizeSpeech` branches
  - Add to `dataFlowLabel` (local inference)
- `src/lib/ai/providers.ts`:
  - Add kinds to `CAPABILITY_INFO`
  - Add test logic in `testProvider`
- UI: AI Providers section + Setup Wizard step 5

### 4. Model Management
- Download models on first use (cache in `.models/`)
- Configurable model selection per org
- Health check endpoint per provider

## Priority
1. **Kokoro TTS** (highest impact - full local TTS)
2. **Whisper STT** (local transcription)
3. **Piper TTS** (additional voices)

## Notes
- Models should be downloaded on-demand (first use) to `.models/`
- No external API keys required for local inference
- Works in `local_only` data mode
- GPU optional (CPU inference OK for Kokoro/Piper)
