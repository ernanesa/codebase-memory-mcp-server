from pathlib import Path
import re
import sys


retrieval_file = Path(
    sys.argv[1] if len(sys.argv) > 1 else '/app/backend/open_webui/routers/retrieval.py'
)
utils_file = Path(
    sys.argv[2] if len(sys.argv) > 2 else '/app/backend/open_webui/retrieval/utils.py'
)
builtin_file = Path(
    sys.argv[3] if len(sys.argv) > 3 else '/app/backend/open_webui/tools/builtin.py'
)
middleware_file = Path(
    sys.argv[4] if len(sys.argv) > 4 else '/app/backend/open_webui/utils/middleware.py'
)


def replace_exact(source, before, after, expected, description, target):
    occurrences = source.count(before)
    if occurrences != expected:
        raise RuntimeError(
            f'Patch incompatível com {target}: esperado {expected} trecho(s) para '
            f'{description}, encontrado {occurrences}.'
        )
    return source.replace(before, after)


def replace_regex(source, pattern, replacement, expected, description, target):
    source, occurrences = re.subn(pattern, replacement, source)
    if occurrences != expected:
        raise RuntimeError(
            f'Patch incompatível com {target}: esperado {expected} trecho(s) para '
            f'{description}, encontrado {occurrences}.'
        )
    return source


retrieval = retrieval_file.read_text()
retrieval = replace_exact(
    retrieval,
    'from open_webui.models.files import FileModel, Files, FileUpdateForm\n',
    'from open_webui.models.files import FileModel, Files, FileUpdateForm\n'
    'from open_webui.google_drive_citations import get_file_citation_metadata\n',
    1,
    'import do metadata canônico',
    retrieval_file,
)
retrieval = replace_regex(
    retrieval,
    r"(?P<indent> +)'name': file\.filename,\n(?P=indent)'created_by': file\.user_id,\n(?P=indent)'file_id': file\.id,\n(?P=indent)'source': file\.filename,",
    lambda match: (
        f"{match.group('indent')}**get_file_citation_metadata(file),\n"
        f"{match.group('indent')}'created_by': file.user_id,\n"
        f"{match.group('indent')}'file_id': file.id,"
    ),
    5,
    'metadata dos documentos processados',
    retrieval_file,
)
retrieval = replace_exact(
    retrieval,
    "metadata={\n                                'file_id': file.id,\n                                'name': file.filename,\n                                'hash': hash,\n                            },",
    "metadata={\n                                'file_id': file.id,\n                                **get_file_citation_metadata(file),\n                                'hash': hash,\n                            },",
    1,
    'metadata final salvo no banco vetorial',
    retrieval_file,
)
retrieval_file.write_text(retrieval)

utils = utils_file.read_text()
utils = replace_exact(
    utils,
    'from open_webui.models.files import Files\n',
    'from open_webui.models.files import Files\n'
    'from open_webui.google_drive_citations import get_file_citation_metadata\n',
    1,
    'import do metadata canônico',
    utils_file,
)
utils = replace_exact(
    utils,
    "'file_id': item.get('id'),\n                                        'name': file_object.filename,\n                                        'source': file_object.filename,",
    "'file_id': item.get('id'),\n                                        **get_file_citation_metadata(file_object),",
    1,
    'fonte de arquivo em contexto completo',
    utils_file,
)
utils = replace_exact(
    utils,
    "'file_id': file.id,\n                                        'name': file.filename,\n                                        'source': file.filename,",
    "'file_id': file.id,\n                                        **get_file_citation_metadata(file),",
    1,
    'fonte de Knowledge Base em contexto completo',
    utils_file,
)
utils_file.write_text(utils)

builtin = builtin_file.read_text()
builtin = replace_exact(
    builtin,
    'from open_webui.tools.knowledge_fs import kb_exec  # noqa: F401 — re-exported\n',
    'from open_webui.tools.knowledge_fs import kb_exec  # noqa: F401 — re-exported\n'
    'from open_webui.google_drive_citations import get_file_citation_metadata\n',
    1,
    'import do metadata canônico nas ferramentas nativas',
    builtin_file,
)
builtin = replace_exact(
    builtin,
    '        chunks = []\n\n        # Add note results first',
    '''        chunks = []
        citation_metadata_by_file_id = {}

        async def get_chunk_citation_metadata(metadata):
            file_id = metadata.get('file_id')
            fallback_name = metadata.get('name', metadata.get('source', 'Unknown'))
            fallback_source = metadata.get('source', fallback_name)
            if not file_id:
                return {'name': fallback_name, 'source': fallback_source}
            if file_id not in citation_metadata_by_file_id:
                file = await Files.get_file_by_id(file_id)
                citation_metadata_by_file_id[file_id] = (
                    get_file_citation_metadata(file)
                    if file
                    else {'name': fallback_name, 'source': fallback_source}
                )
            return citation_metadata_by_file_id[file_id]

        # Add note results first''',
    1,
    'cache de nomes canônicos por arquivo',
    builtin_file,
)
builtin = replace_exact(
    builtin,
    '''            for idx, doc in enumerate(documents):
                metadata = metadatas[idx] if idx < len(metadatas) and isinstance(metadatas[idx], dict) else {}
                chunk = {
                    **filter_source_metadata(metadata),
                    'content': doc,
                    'source': metadata.get('source', metadata.get('name', source_info.get('name', 'Unknown'))),
                    'file_id': metadata.get('file_id', source_info.get('id', '')),
                }''',
    '''            for idx, doc in enumerate(documents):
                metadata = metadatas[idx] if idx < len(metadatas) and isinstance(metadatas[idx], dict) else {}
                citation_metadata = await get_chunk_citation_metadata({**source_info, **metadata})
                chunk = {
                    **filter_source_metadata(metadata),
                    'content': doc,
                    'source': citation_metadata['source'],
                    'name': citation_metadata['name'],
                    'file_id': metadata.get('file_id', source_info.get('id', '')),
                }''',
    1,
    'nome separado da URL no resultado semântico',
    builtin_file,
)
builtin_file.write_text(builtin)

middleware = middleware_file.read_text()
middleware = replace_exact(
    middleware,
    "                source_name = chunk.get('source', 'Unknown')\n"
    "                file_id = chunk.get('file_id', '')",
    "                source_name = chunk.get('source', 'Unknown')\n"
    "                display_name = chunk.get('name') or source_name\n"
    "                file_id = chunk.get('file_id', '')",
    1,
    'nome visual dos resultados da ferramenta',
    middleware_file,
)
middleware = replace_exact(
    middleware,
    "                            'name': source_name,",
    "                            'name': display_name,",
    1,
    'nome visual da fonte agrupada',
    middleware_file,
)
middleware = replace_exact(
    middleware,
    "                        'name': source_name,\n                        'source': source_name,",
    "                        'name': display_name,\n                        'source': source_name,",
    1,
    'nome visual no metadata da fonte',
    middleware_file,
)
middleware = replace_exact(
    middleware,
    "                                'query_knowledge_files',\n",
    "                                'query_knowledge_files',\n"
    "                                'kb_exec',\n",
    1,
    'kb_exec na extração de fontes',
    middleware_file,
)
middleware = replace_exact(
    middleware,
    '''                                citation_sources = get_citation_source_from_tool_result(
                                    tool_name=tool_function_name,
                                    tool_params=tool_function_params,
                                    tool_result=tool_result,
                                    tool_id=tool.get('tool_id', '') if tool else '',
                                )
                                tool_call_sources.extend(citation_sources)''',
    '''                                if tool_function_name == 'kb_exec':
                                    from open_webui.tools.knowledge_fs import get_kb_exec_citation_sources

                                    model_knowledge = list(
                                        model.get('info', {}).get('meta', {}).get('knowledge', []) or []
                                    )
                                    folder_knowledge = metadata.get('folder_knowledge')
                                    if folder_knowledge:
                                        model_knowledge.extend(folder_knowledge)
                                    citation_sources = await get_kb_exec_citation_sources(
                                        command=tool_function_params.get('command', ''),
                                        user=user.model_dump() if isinstance(user, UserModel) else {},
                                        model_knowledge=model_knowledge,
                                    )
                                else:
                                    citation_sources = get_citation_source_from_tool_result(
                                        tool_name=tool_function_name,
                                        tool_params=tool_function_params,
                                        tool_result=tool_result,
                                        tool_id=tool.get('tool_id', '') if tool else '',
                                    )
                                tool_call_sources.extend(citation_sources)''',
    1,
    'fontes dos arquivos lidos pelo kb_exec',
    middleware_file,
)
middleware_file.write_text(middleware)
