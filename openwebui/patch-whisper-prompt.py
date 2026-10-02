from pathlib import Path
import sys


audio_file = Path(sys.argv[1] if len(sys.argv) > 1 else '/app/backend/open_webui/routers/audio.py')
source = audio_file.read_text()

# 1. Patch Whisper transcription (VAD + anti-hallucination + no_speech_prob filter)
before_whisper = '''        segments, info = model.transcribe(
            file_path,
            beam_size=5,
            vad_filter=WHISPER_VAD_FILTER,
            language=languages[0],
            multilingual=WHISPER_MULTILINGUAL,
        )'''

after_whisper = '''        import re
        initial_prompt = os.getenv('WHISPER_INITIAL_PROMPT', '').strip()
        transcribe_kwargs = {
            'beam_size': 5,
            'vad_filter': WHISPER_VAD_FILTER,
            'language': languages[0],
            'multilingual': WHISPER_MULTILINGUAL,
            'condition_on_previous_text': False,
        }
        if initial_prompt:
            transcribe_kwargs['initial_prompt'] = initial_prompt
        segments, info = model.transcribe(file_path, **transcribe_kwargs)
        log.info("Detected language '%s' with probability %f", info.language, info.language_probability)

        hallucinations = {
            'obrigado por assistir',
            'obrigada por assistir',
            'legendas pela comunidade',
            'subtitles by',
            'thank you for watching',
            'inscreva-se no canal',
            'deixe seu like',
            'deixe o seu like',
            'curta e compartilhe',
        }
        clean_prompt = re.sub(r'[^\w\s]', '', initial_prompt.lower()).strip() if initial_prompt else ''

        valid_parts = []
        for s in segments:
            if getattr(s, 'no_speech_prob', 0) > 0.5:
                continue
            clean_s = re.sub(r'[^\w\s]', '', s.text.lower()).strip()
            if not clean_s:
                continue
            if (clean_prompt and clean_s in clean_prompt) or any(h in clean_s for h in hallucinations):
                continue
            valid_parts.append(s.text)
        return ''.join(valid_parts)'''

occurrences_whisper = source.count(before_whisper)
if occurrences_whisper == 1:
    source = source.replace(before_whisper, after_whisper)
elif 'transcribe_kwargs' not in source:
    raise RuntimeError(
        f'Patch incompatível com {audio_file}: esperado 1 trecho de model.transcribe, encontrado {occurrences_whisper}.'
    )

# 2. Patch TTS speech endpoint to strip citation markers [1], [2], etc.
before_tts = '''    try:
        payload = JSONCodec.loads(body)
    except Exception as exc:
        log.exception(exc)
        raise HTTPException(status_code=400, detail='Invalid JSON payload')'''

after_tts = '''    try:
        payload = JSONCodec.loads(body)
    except Exception as exc:
        log.exception(exc)
        raise HTTPException(status_code=400, detail='Invalid JSON payload')

    import re
    if isinstance(payload, dict) and 'input' in payload and isinstance(payload['input'], str):
        payload['input'] = re.sub(r'\s*\[\s*\d+(\s*,\s*\d+)*\s*\]', '', payload['input'])'''

occurrences_tts = source.count(before_tts)
if occurrences_tts == 1:
    source = source.replace(before_tts, after_tts)
elif "payload['input'] = re.sub" not in source:
    raise RuntimeError(
        f'Patch TTS incompatível com {audio_file}: esperado 1 trecho de JSONCodec.loads, encontrado {occurrences_tts}.'
    )

# 3. Patch Faster-Whisper initialization to support WHISPER_DEVICE and WHISPER_CPU_THREADS
before_device = """        faster_whisper_kwargs = {
            'model_size_or_path': model,
            'device': DEVICE_TYPE if DEVICE_TYPE and DEVICE_TYPE == 'cuda' else 'cpu',
            'compute_type': WHISPER_COMPUTE_TYPE,
            'download_root': WHISPER_MODEL_DIR,
            'local_files_only': not auto_update,
        }"""

after_device = """        whisper_dev = os.getenv('WHISPER_DEVICE', 'cpu')
        faster_whisper_kwargs = {
            'model_size_or_path': model,
            'device': whisper_dev,
            'compute_type': WHISPER_COMPUTE_TYPE,
            'download_root': WHISPER_MODEL_DIR,
            'local_files_only': not auto_update,
        }
        if whisper_dev == 'cpu':
            faster_whisper_kwargs['cpu_threads'] = int(os.getenv('WHISPER_CPU_THREADS', '6'))"""

occurrences_device = source.count(before_device)
if occurrences_device == 1:
    source = source.replace(before_device, after_device)
elif "os.getenv('WHISPER_DEVICE'" not in source:
    raise RuntimeError(
        f'Patch device incompatível com {audio_file}: esperado 1 trecho de device, encontrado {occurrences_device}.'
    )

audio_file.write_text(source)
print(f'Successfully patched {audio_file}')
