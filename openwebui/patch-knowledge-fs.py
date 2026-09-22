from pathlib import Path
import sys


knowledge_fs_file = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else '/app/backend/open_webui/tools/knowledge_fs.py'
)
source = knowledge_fs_file.read_text()


def replace_exact(before, after, expected, description):
    occurrences = source.count(before)
    if occurrences != expected:
        raise RuntimeError(
            f'Patch incompatível com {knowledge_fs_file}: esperado {expected} trecho(s) '
            f'para {description}, encontrado {occurrences}.'
        )
    return source.replace(before, after)


source = replace_exact(
    'import time\nfrom collections.abc import Callable\n',
    'import time\nimport unicodedata\nfrom collections.abc import Callable\n',
    1,
    'import da normalização Unicode',
)

source = replace_exact(
    'from fastapi import Request\n',
    'from fastapi import Request\n\n'
    'from open_webui.google_drive_citations import get_file_citation_metadata\n',
    1,
    'helper de citações canônicas',
)

source = replace_exact(
    "# =============================================================================\n# DIRECTORY TREE & PATH RESOLUTION\n# =============================================================================\n\n\nasync def _build_directory_tree",
    "# =============================================================================\n# DIRECTORY TREE & PATH RESOLUTION\n# =============================================================================\n\n\ndef _normalize_path(value: str) -> str:\n    \"\"\"Normalize user/model paths without weakening KB access controls.\"\"\"\n    return unicodedata.normalize('NFC', value.strip('/'))\n\n\nasync def _build_directory_tree",
    1,
    'helper de normalização de caminhos',
)

source = replace_exact(
    "        match = next((d for d in dirs if d.name == part), None)",
    "        normalized_part = _normalize_path(part)\n"
    "        match = next((d for d in dirs if _normalize_path(d.name) == normalized_part), None)",
    1,
    'resolução Unicode de diretórios',
)

source = replace_exact(
    "    ref_clean = ref.strip('/')",
    "    ref_clean = _normalize_path(ref)",
    1,
    'normalização da referência do arquivo',
)

suffix_resolution = '''    # A tree view can lead a model to omit ancestor directories. Resolve a
    # shortened path only when its normalized suffix identifies one accessible file.
    if '/' in ref_clean:
        ref_parts = ref_clean.split('/')
        suffix_matches = []
        kb_ids = {fi['knowledge_id'] for fi in accessible if fi.get('knowledge_id')}
        for kb_id in kb_ids:
            tree = await _build_directory_tree(kb_id)
            for candidate in tree['files']:
                candidate_path = _normalize_path(candidate['path'])
                candidate_refs = {ref_clean}
                if candidate['id'] in ref_parts:
                    candidate_refs.add('/'.join(part for part in ref_parts if part != candidate['id']))
                if (
                    candidate['id'] in accessible_ids
                    and any(
                        candidate_path == candidate_ref or candidate_path.endswith(f'/{candidate_ref}')
                        for candidate_ref in candidate_refs
                    )
                ):
                    suffix_matches.append(candidate)

        unique_matches = {candidate['id']: candidate for candidate in suffix_matches}
        if len(unique_matches) == 1:
            candidate = next(iter(unique_matches.values()))
            f = await Files.get_file_by_id(candidate['id'])
            if f and f.data:
                access_info = next(fi for fi in accessible if fi['id'] == candidate['id'])
                return {
                    'id': f.id,
                    'filename': f.filename,
                    'content': f.data.get('content', ''),
                    'meta': f.meta,
                    'updated_at': f.updated_at,
                    'created_at': f.created_at,
                    'knowledge_id': access_info.get('knowledge_id'),
                    'knowledge_name': access_info.get('knowledge_name'),
                }
        if len(unique_matches) > 1:
            return {
                'error': f'Ambiguous path "{ref}". Use the file ID or full path:\\n'
                + '\\n'.join(
                    f'  {candidate["id"]}  {candidate["path"]}'
                    for candidate in unique_matches.values()
                )
            }

'''

source = replace_exact(
    '    # Try filename match within accessible files\n'
    "    matches = [fi for fi in accessible if fi['filename'] == ref]\n",
    suffix_resolution
    + '    # Try filename match within accessible files\n'
    "    matches = [fi for fi in accessible if _normalize_path(fi['filename']) == _normalize_path(ref)]\n",
    1,
    'resolução segura por sufixo e nome normalizado',
)

source = replace_exact(
    '''async def _get_file_content(file_id: str) -> str | None:
    """Get file content by ID."""''',
    '''def _get_file_references_from_command(command: str) -> list[str]:
    """Return explicit file references from kb_exec commands that read content."""
    references = []
    for tokens in _parse_pipeline(command):
        command_name = tokens[0].lower()
        flags, args = _extract_flags(tokens[1:])
        if command_name in ('head', 'tail'):
            _, args = _extract_numeric_flag(args)

        if command_name in ('cat', 'head', 'tail', 'wc', 'stat') and args:
            references.append(args[0])
        elif command_name == 'sed':
            for arg in reversed(args):
                if not re.match(r"^'?(\\d+),(\\d+)p?'?$", arg):
                    references.append(arg)
                    break
        elif command_name == 'grep' and len(args) > 1:
            references.extend(arg for arg in args[1:] if '*' not in arg)

    return list(dict.fromkeys(references))


async def get_kb_exec_citation_sources(
    command: str,
    user: dict,
    model_knowledge: list[dict] | None,
) -> list[dict]:
    """Resolve files actually read by kb_exec into Open WebUI citation sources."""
    sources = []
    seen_file_ids = set()
    for reference in _get_file_references_from_command(command):
        resolved = await _resolve_file(reference, user, model_knowledge)
        if not resolved or 'error' in resolved or resolved['id'] in seen_file_ids:
            continue

        seen_file_ids.add(resolved['id'])
        citation = get_file_citation_metadata(
            type(
                'CitationFile',
                (),
                {'filename': resolved['filename'], 'meta': resolved.get('meta')},
            )()
        )
        source = {
            'id': resolved['id'],
            'name': citation['name'],
            'type': 'file',
        }
        if isinstance(citation['source'], str) and citation['source'].startswith(('http://', 'https://')):
            source['url'] = citation['source']

        sources.append(
            {
                'source': source,
                'document': [resolved.get('content', '')[:KB_EXEC_MAX_OUTPUT_CHARS]],
                'metadata': [
                    {
                        'file_id': resolved['id'],
                        'name': citation['name'],
                        'source': citation['source'],
                    }
                ],
            }
        )
    return sources


async def _get_file_content(file_id: str) -> str | None:
    """Get file content by ID."""''',
    1,
    'proveniência dos arquivos lidos pelo kb_exec',
)

source = replace_exact(
    "                    items.append(f'{prefix}{connector}{entry[\"filename\"]}')",
    "                    if 'a' in flags:\n"
    "                        items.append(f'{prefix}{connector}path=\"{entry[\"path\"]}\"  file_id=\"{entry[\"id\"]}\"')\n"
    "                    else:\n"
    "                        items.append(f'{prefix}{connector}{entry[\"filename\"]}')",
    1,
    'ID e caminho canônico no tree -a',
)

source = replace_exact(
    "            output.append(f'  {connector}{f[\"filename\"]}')",
    "            if 'a' in flags:\n"
    "                output.append(f'  {connector}path=\"{f[\"filename\"]}\"  file_id=\"{f[\"id\"]}\"')\n"
    "            else:\n"
    "                output.append(f'  {connector}{f[\"filename\"]}')",
    1,
    'ID dos arquivos anexados no tree -a',
)

knowledge_fs_file.write_text(source)
