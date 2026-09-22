from pathlib import Path
import sys


main_file = Path(sys.argv[1] if len(sys.argv) > 1 else '/app/backend/open_webui/main.py')
source = main_file.read_text()

before = '''    # Access-filter first so the per-model payload work below only runs for
    # models the caller can actually see.
    models = await get_filtered_models(models, user)
'''
after = before + '''
    # Keep Ollama/base models available for internal resolution and direct calls,
    # but do not expose them in the model picker/API catalog. The list is
    # intentionally configured outside the image so model aliases can change
    # without changing this patch.
    hidden_model_ids = {
        model_id.strip()
        for model_id in os.getenv('OPENWEBUI_HIDDEN_BASE_MODEL_IDS', '').split(',')
        if model_id.strip()
    }
    if hidden_model_ids:
        models = [model for model in models if model.get('id') not in hidden_model_ids]
'''

occurrences = source.count(before)
if occurrences != 1:
    raise RuntimeError(
        f'Patch incompatível com {main_file}: esperado 1 trecho do endpoint /api/models, encontrado {occurrences}.'
    )

main_file.write_text(source.replace(before, after))
